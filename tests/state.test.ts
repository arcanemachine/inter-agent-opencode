import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import test from "node:test";
import assert from "node:assert/strict";
import {
  LEASE_EXPIRY_ALLOWANCE_MS,
  claimLease,
  commitJsonWrite,
  ensureSessionDir,
  hashScope,
  readJsonFile,
  readLeaseFile,
  readPreferences,
  refreshLease,
  releaseLease,
  resolveLease,
  sessionDir,
  stageJsonWrite,
  writeJsonAtomic,
  writePreferences,
  workspaceKey,
  type LeaseClaimInput,
} from "../src/state.js";
import { StateError } from "../src/errors.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "inter-agent-opencode-phase3-"));
}

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "inter-agent-opencode-ws-"));
}

function claimInput(
  workspace: string,
  sessionID: string,
  overrides: Partial<LeaseClaimInput> = {},
): LeaseClaimInput {
  const workspacePath = workspace;
  return {
    workspacePath,
    workspaceHash: workspaceKey(workspacePath),
    openCodeSessionID: sessionID,
    sessionHash: hashScope(sessionID),
    name: "opencode-a",
    label: "OpenCode A",
    host: "127.0.0.1",
    port: 16837,
    tls: false,
    ...overrides,
  };
}

type BarrierClaimResult = {
  kind?: "result";
  ok: boolean;
  ownerToken?: string;
  error?: string;
  invocation?: string;
  workerID?: number;
};

type BarrierLifecycle = {
  kind: "lifecycle";
  phase: "started" | "barrier-arrived";
  invocation: string;
  workerID: number;
};

type BarrierOptions = {
  timeoutMs?: number;
  hangWorkerID?: number;
};

const BARRIER_TIMEOUT_MS = 30_000;
const WORKER_TERMINATION_TIMEOUT_MS = 2_000;
let barrierInvocation = 0;

function timeoutAfter<T>(
  promise: Promise<T>,
  timeout: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeout);
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function runCleanupRace<T>(
  lockPath: string,
  operation: () => T,
): Promise<T> {
  const worker = new Worker(
    new URL("./fixtures/lease-cleanup-racer.js", import.meta.url),
    { workerData: { lockPath } },
  );
  let ready = false;
  let raced = false;
  let stopped = false;
  let resolveReady!: () => void;
  let resolveRaced!: () => void;
  let resolveStopped!: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const racedPromise = new Promise<void>((resolve) => {
    resolveRaced = resolve;
  });
  const stoppedPromise = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });
  worker.on("message", (value: { kind?: string }) => {
    if (value.kind === "ready") {
      ready = true;
      resolveReady();
    } else if (value.kind === "raced") {
      raced = true;
      resolveRaced();
    } else if (value.kind === "stopped") {
      stopped = true;
      resolveStopped();
    }
  });
  try {
    await timeoutAfter(readyPromise, 2_000, "cleanup racer did not start");
    const result = operation();
    await timeoutAfter(
      racedPromise,
      2_000,
      `cleanup racer did not observe lock (ready=${ready}, raced=${raced})`,
    );
    worker.postMessage({ stop: true });
    await timeoutAfter(
      stoppedPromise,
      2_000,
      `cleanup racer did not stop (raced=${raced}, stopped=${stopped})`,
    );
    return result;
  } finally {
    worker.postMessage({ stop: true });
    try {
      await timeoutAfter(
        worker.terminate(),
        WORKER_TERMINATION_TIMEOUT_MS,
        "cleanup racer termination timed out",
      );
    } catch (error) {
      worker.unref();
      throw error;
    }
  }
}

async function barrierClaims(
  dataDir: string,
  input: LeaseClaimInput,
  count: number,
  options: BarrierOptions = {},
): Promise<BarrierClaimResult[]> {
  const invocation = `barrier-${++barrierInvocation}`;
  const workers: Worker[] = [];
  const diagnostics = Array.from({ length: count }, (_, workerID) => ({
    workerID,
    phases: [] as string[],
    result: undefined as string | undefined,
  }));
  const barrier = new SharedArrayBuffer(8);
  new Int32Array(barrier)[1] = count;
  const formatDiagnostics = () =>
    diagnostics
      .map(
        ({ workerID, phases, result }) =>
          `worker=${workerID} phases=${phases.join(",")} result=${result ?? "none"}`,
      )
      .join("; ");
  const results = Array.from(
    { length: count },
    (_, workerID) =>
      new Promise<BarrierClaimResult>((resolve, reject) => {
        let settled = false;
        const worker = new Worker(
          new URL("./fixtures/lease-claimer.js", import.meta.url),
          {
            workerData: {
              dataDir,
              input,
              barrier,
              now: Date.now(),
              invocation,
              workerID,
              hangAfterBarrier: options.hangWorkerID === workerID,
              barrierTimeoutMs: options.timeoutMs ?? BARRIER_TIMEOUT_MS,
            },
          },
        );
        workers.push(worker);
        diagnostics[workerID]?.phases.push("created");
        worker.on("message", (value: BarrierClaimResult | BarrierLifecycle) => {
          if (value.kind === "lifecycle") {
            diagnostics[workerID]?.phases.push(value.phase);
            return;
          }
          if (settled) return;
          settled = true;
          diagnostics[workerID]!.result = value.ok
            ? "success"
            : (value.error ?? "failure");
          resolve(value);
        });
        worker.once("error", (error) => {
          if (settled) return;
          settled = true;
          diagnostics[workerID]!.result = `error:${String(error)}`;
          reject(
            new Error(
              `${invocation} worker=${workerID} error; ${formatDiagnostics()}`,
            ),
          );
        });
        worker.once("exit", (code) => {
          if (settled) return;
          settled = true;
          diagnostics[workerID]!.result = `exit:${code}`;
          reject(
            new Error(
              `${invocation} worker=${workerID} exited code=${code} without a result; ${formatDiagnostics()}`,
            ),
          );
        });
      }),
  );
  try {
    return await timeoutAfter(
      Promise.all(results),
      options.timeoutMs ?? BARRIER_TIMEOUT_MS,
      `${invocation} timed out after ${options.timeoutMs ?? BARRIER_TIMEOUT_MS}ms; ${formatDiagnostics()}`,
    );
  } finally {
    const termination = await Promise.allSettled(
      workers.map((worker, workerID) =>
        timeoutAfter(
          worker.terminate(),
          WORKER_TERMINATION_TIMEOUT_MS,
          `${invocation} worker=${workerID} termination timed out`,
        )
          .then(() => {
            diagnostics[workerID]?.phases.push("terminated");
          })
          .catch((error) => {
            worker.unref();
            throw error;
          }),
      ),
    );
    const failedTermination = termination.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failedTermination)
      throw new Error(
        `${invocation} worker cleanup failed: ${String(failedTermination.reason)}; ${formatDiagnostics()}`,
      );
  }
}

function assertBarrierClaims(results: BarrierClaimResult[]): void {
  const successful = results.filter((result) => result.ok);
  if (successful.length !== 1) {
    const categories = new Map<string, number>();
    for (const result of results) {
      if (!result.ok) {
        const category = result.error ?? "missing worker error";
        categories.set(category, (categories.get(category) ?? 0) + 1);
      }
    }
    assert.fail(
      `expected one successful lease claimant; worker categories: ${JSON.stringify(
        Object.fromEntries(categories),
      )}`,
    );
  }
  assert.equal(successful.length, 1);
  assert.equal(new Set(successful.map((result) => result.ownerToken)).size, 1);
  for (const result of results) {
    if (!result.ok) assert.match(result.error ?? "", /held by another|busy/);
  }
}

test("scope hashing is deterministic, distinct, and lowercase hex", () => {
  assert.equal(hashScope("session-a"), hashScope("session-a"));
  assert.notEqual(hashScope("session-a"), hashScope("session-b"));
  assert.equal(hashScope("workspace-x"), workspaceKey("workspace-x"));
  assert.match(hashScope("anything"), /^[a-f0-9]{64}$/);
});

test("two distinct session IDs cannot read each other's lease", () => {
  const root = tempRoot();
  const workspace = tempWorkspace();
  try {
    const dataDir = join(root, "state");
    const sessionA = "session-a-id";
    const sessionB = "session-b-id";
    const lease = claimLease(dataDir, claimInput(workspace, sessionA));
    assert.equal(lease.openCodeSessionID, sessionA);

    const forB = resolveLease(dataDir, {
      workspacePath: workspace,
      openCodeSessionID: sessionB,
    });
    assert.equal(forB.present, false);
    assert.equal(forB.check, "missing");
    assert.equal(forB.sessionHash, hashScope(sessionB));
    assert.notEqual(forB.sessionHash, hashScope(sessionA));
    assert.equal(
      readLeaseFile(dataDir, forB.workspaceHash, forB.sessionHash).present,
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("server-style reader resolves the exact session record", () => {
  const root = tempRoot();
  const workspace = tempWorkspace();
  try {
    const dataDir = join(root, "state");
    const sessionID = "exact-session";
    claimLease(
      dataDir,
      claimInput(workspace, sessionID, { name: "opencode-exact" }),
    );
    const resolved = resolveLease(dataDir, {
      workspacePath: workspace,
      openCodeSessionID: sessionID,
    });
    assert.equal(resolved.present, true);
    assert.equal(resolved.check, "fresh");
    assert.equal(resolved.lease?.name, "opencode-exact");
    assert.equal(resolved.lease?.openCodeSessionID, sessionID);
    assert.equal(resolved.lease?.workspaceHash, workspaceKey(workspace));

    const otherWorkspace = tempWorkspace();
    try {
      const wrong = resolveLease(dataDir, {
        workspacePath: otherWorkspace,
        openCodeSessionID: sessionID,
      });
      assert.equal(wrong.present, false);
      assert.equal(wrong.check, "missing");
    } finally {
      rmSync(otherWorkspace, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("lease claim, refresh, and release round trip", () => {
  const root = tempRoot();
  const workspace = tempWorkspace();
  try {
    const dataDir = join(root, "state");
    const sessionID = "roundtrip-session";
    const now = 1_000_000;
    const lease = claimLease(dataDir, claimInput(workspace, sessionID), now);
    assert.equal(lease.version, 1);
    assert.equal(lease.connectedAt, new Date(now).toISOString());
    assert.equal(lease.heartbeatAt, new Date(now).toISOString());
    assert.equal(
      lease.expiresAt,
      new Date(now + LEASE_EXPIRY_ALLOWANCE_MS).toISOString(),
    );

    const refreshed = refreshLease(
      dataDir,
      lease.workspaceHash,
      lease.sessionHash,
      lease.ownerToken,
      now + 5_000,
    );
    assert.equal(refreshed.connectedAt, new Date(now).toISOString());
    assert.equal(refreshed.heartbeatAt, new Date(now + 5_000).toISOString());
    assert.equal(
      refreshed.expiresAt,
      new Date(now + 5_000 + LEASE_EXPIRY_ALLOWANCE_MS).toISOString(),
    );

    releaseLease(
      dataDir,
      lease.workspaceHash,
      lease.sessionHash,
      lease.ownerToken,
    );
    assert.equal(
      readLeaseFile(dataDir, lease.workspaceHash, lease.sessionHash).present,
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("lease outcomes survive simulated cleanup races", async () => {
  const root = tempRoot();
  const workspace = tempWorkspace();
  try {
    const dataDir = join(root, "state");
    const input = claimInput(workspace, "cleanup-race-session");
    const dir = ensureSessionDir(
      dataDir,
      input.workspaceHash,
      input.sessionHash,
    );
    const lockPath = join(dir, ".connection.lock");

    const claimed = await runCleanupRace(lockPath, () =>
      claimLease(dataDir, input, 1_000),
    );
    assert.equal(claimed.ownerToken.length > 0, true);
    assert.equal(
      readLeaseFile(dataDir, claimed.workspaceHash, claimed.sessionHash)
        .present,
      true,
    );
    assert.equal(existsSync(lockPath), true);
    rmSync(lockPath, { recursive: true, force: true });

    const refreshed = await runCleanupRace(lockPath, () =>
      refreshLease(
        dataDir,
        claimed.workspaceHash,
        claimed.sessionHash,
        claimed.ownerToken,
        2_000,
      ),
    );
    assert.equal(refreshed.ownerToken, claimed.ownerToken);
    assert.equal(
      readLeaseFile(dataDir, claimed.workspaceHash, claimed.sessionHash).record
        ?.heartbeatAt,
      new Date(2_000).toISOString(),
    );
    assert.equal(existsSync(lockPath), true);
    rmSync(lockPath, { recursive: true, force: true });

    await assert.rejects(
      runCleanupRace(lockPath, () =>
        refreshLease(
          dataDir,
          claimed.workspaceHash,
          claimed.sessionHash,
          "wrong-owner",
          2_500,
        ),
      ),
      /owned by another/,
    );
    assert.equal(existsSync(lockPath), true);
    rmSync(lockPath, { recursive: true, force: true });

    await runCleanupRace(lockPath, () =>
      releaseLease(
        dataDir,
        claimed.workspaceHash,
        claimed.sessionHash,
        claimed.ownerToken,
        3_000,
      ),
    );
    assert.equal(
      readLeaseFile(dataDir, claimed.workspaceHash, claimed.sessionHash)
        .present,
      false,
    );
    assert.equal(existsSync(lockPath), true);
    rmSync(lockPath, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("expired leases can be taken over by a new owner", () => {
  const root = tempRoot();
  const workspace = tempWorkspace();
  try {
    const dataDir = join(root, "state");
    const sessionID = "takeover-session";
    const first = claimLease(
      dataDir,
      claimInput(workspace, sessionID, { name: "opencode-first" }),
      1_000,
    );
    const takeover = claimLease(
      dataDir,
      claimInput(workspace, sessionID, { name: "opencode-second" }),
      1_000 + LEASE_EXPIRY_ALLOWANCE_MS + 1,
    );
    assert.notEqual(takeover.ownerToken, first.ownerToken);
    assert.equal(takeover.name, "opencode-second");
    const resolved = resolveLease(dataDir, {
      workspacePath: workspace,
      openCodeSessionID: sessionID,
    });
    assert.equal(resolved.lease?.ownerToken, takeover.ownerToken);
    assert.throws(
      () =>
        refreshLease(
          dataDir,
          first.workspaceHash,
          first.sessionHash,
          first.ownerToken,
        ),
      StateError,
    );
    assert.throws(
      () =>
        releaseLease(
          dataDir,
          first.workspaceHash,
          first.sessionHash,
          first.ownerToken,
        ),
      StateError,
    );
    releaseLease(
      dataDir,
      takeover.workspaceHash,
      takeover.sessionHash,
      takeover.ownerToken,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a fresh lease owned by another controller is rejected", () => {
  const root = tempRoot();
  const workspace = tempWorkspace();
  try {
    const dataDir = join(root, "state");
    const sessionID = "conflict-session";
    claimLease(dataDir, claimInput(workspace, sessionID), 1_000);
    assert.throws(
      () => claimLease(dataDir, claimInput(workspace, sessionID), 2_000),
      (error: unknown) => {
        assert(error instanceof StateError);
        assert.match(String(error), /held by another/);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("concurrent claims permit only one live lease owner", async (t) => {
  if (process.platform === "win32") {
    t.skip("worker barrier relies on POSIX lease locking");
    return;
  }
  const root = tempRoot();
  const workspace = tempWorkspace();
  try {
    const dataDir = join(root, "state");
    const sessionID = "barrier-session";
    const input = claimInput(workspace, sessionID);
    const results = await barrierClaims(dataDir, input, 12);
    assertBarrierClaims(results);
    const ownerToken = results.find((result) => result.ok)?.ownerToken;
    assert.equal(typeof ownerToken, "string");
    const resolved = resolveLease(dataDir, {
      workspacePath: workspace,
      openCodeSessionID: sessionID,
    });
    assert.equal(resolved.check, "fresh");
    assert.equal(resolved.lease?.ownerToken, ownerToken);
    assert.throws(
      () =>
        refreshLease(
          dataDir,
          resolved.workspaceHash,
          resolved.sessionHash,
          "wrong-owner",
        ),
      StateError,
    );
    assert.throws(
      () =>
        releaseLease(
          dataDir,
          resolved.workspaceHash,
          resolved.sessionHash,
          "wrong-owner",
        ),
      StateError,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("barrier worker lifecycle is bounded and diagnostic", async () => {
  const root = tempRoot();
  const workspace = tempWorkspace();
  try {
    const dataDir = join(root, "state");
    const input = claimInput(workspace, "bounded-barrier-session");
    await assert.rejects(
      barrierClaims(dataDir, input, 1, {
        timeoutMs: 1_000,
        hangWorkerID: 0,
      }),
      /timed out.*worker=0 phases=created/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("stale lock recovery serializes concurrent claimants", async (t) => {
  if (process.platform === "win32") {
    t.skip("worker barrier relies on POSIX lease locking");
    return;
  }
  const root = tempRoot();
  const workspace = tempWorkspace();
  try {
    const dataDir = join(root, "state");
    const input = claimInput(workspace, "stale-barrier-session");
    const dir = ensureSessionDir(
      dataDir,
      input.workspaceHash,
      input.sessionHash,
    );
    const staleLock = join(dir, ".connection.lock");
    mkdirSync(staleLock, { mode: 0o700 });
    const old = new Date(Date.now() - 120_000);
    utimesSync(staleLock, old, old);
    const results = await barrierClaims(dataDir, input, 24);
    assertBarrierClaims(results);
    assert.equal(existsSync(staleLock), false);
    assert.equal(existsSync(join(dir, ".connection.lock.coordinator")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("stale coordinator recovery serializes concurrent claimants", async (t) => {
  if (process.platform === "win32") {
    t.skip("worker barrier relies on POSIX lease locking");
    return;
  }
  const root = tempRoot();
  const workspace = tempWorkspace();
  try {
    const dataDir = join(root, "state");
    const input = claimInput(workspace, "stale-coordinator-session");
    const dir = ensureSessionDir(
      dataDir,
      input.workspaceHash,
      input.sessionHash,
    );
    const coordinator = join(dir, ".connection.lock.coordinator");
    mkdirSync(coordinator, { mode: 0o700 });
    const old = new Date(Date.now() - 120_000);
    utimesSync(coordinator, old, old);
    const results = await barrierClaims(dataDir, input, 24);
    assertBarrierClaims(results);
    assert.equal(existsSync(join(dir, ".connection.lock")), false);
    assert.equal(existsSync(coordinator), false);
    assert.equal(
      existsSync(join(dir, ".connection.lock.coordinator.recovery")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("stale coordinator and lease locks recover together", async (t) => {
  if (process.platform === "win32") {
    t.skip("worker barrier relies on POSIX lease locking");
    return;
  }
  const root = tempRoot();
  const workspace = tempWorkspace();
  try {
    const dataDir = join(root, "state");
    const input = claimInput(workspace, "combined-stale-session");
    const dir = ensureSessionDir(
      dataDir,
      input.workspaceHash,
      input.sessionHash,
    );
    const coordinator = join(dir, ".connection.lock.coordinator");
    const leaseLock = join(dir, ".connection.lock");
    mkdirSync(coordinator, { mode: 0o700 });
    mkdirSync(leaseLock, { mode: 0o700 });
    const old = new Date(Date.now() - 120_000);
    utimesSync(coordinator, old, old);
    utimesSync(leaseLock, old, old);
    const results = await barrierClaims(dataDir, input, 24);
    assertBarrierClaims(results);
    assert.equal(existsSync(leaseLock), false);
    assert.equal(existsSync(coordinator), false);
    assert.equal(
      existsSync(join(dir, ".connection.lock.coordinator.recovery")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("stale recovery guard alone is reclaimed", async (t) => {
  if (process.platform === "win32") {
    t.skip("worker barrier relies on POSIX lease locking");
    return;
  }
  const root = tempRoot();
  const workspace = tempWorkspace();
  try {
    const dataDir = join(root, "state");
    const input = claimInput(workspace, "stale-recovery-session");
    const dir = ensureSessionDir(
      dataDir,
      input.workspaceHash,
      input.sessionHash,
    );
    const recovery = join(dir, ".connection.lock.coordinator.recovery");
    mkdirSync(recovery, { mode: 0o700 });
    writeFileSync(join(recovery, "owner"), "abandoned-recovery-owner");
    const old = new Date(Date.now() - 120_000);
    utimesSync(recovery, old, old);
    const results = await barrierClaims(dataDir, input, 24);
    assertBarrierClaims(results);
    assert.equal(existsSync(join(dir, ".connection.lock")), false);
    assert.equal(existsSync(join(dir, ".connection.lock.coordinator")), false);
    assert.equal(existsSync(recovery), false);
    const resolved = resolveLease(dataDir, {
      workspacePath: workspace,
      openCodeSessionID: input.openCodeSessionID,
    });
    assert.equal(resolved.check, "fresh");
    assert(resolved.lease);
    releaseLease(
      dataDir,
      resolved.workspaceHash,
      resolved.sessionHash,
      resolved.lease.ownerToken,
    );
    const retry = claimLease(dataDir, input);
    releaseLease(
      dataDir,
      retry.workspaceHash,
      retry.sessionHash,
      retry.ownerToken,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("stale recovery and coordinator guards recover together", async (t) => {
  if (process.platform === "win32") {
    t.skip("worker barrier relies on POSIX lease locking");
    return;
  }
  const root = tempRoot();
  const workspace = tempWorkspace();
  try {
    const dataDir = join(root, "state");
    const input = claimInput(workspace, "stale-recovery-coordinator-session");
    const dir = ensureSessionDir(
      dataDir,
      input.workspaceHash,
      input.sessionHash,
    );
    const recovery = join(dir, ".connection.lock.coordinator.recovery");
    const coordinator = join(dir, ".connection.lock.coordinator");
    mkdirSync(recovery, { mode: 0o700 });
    mkdirSync(coordinator, { mode: 0o700 });
    writeFileSync(join(recovery, "owner"), "abandoned-recovery-owner");
    writeFileSync(join(coordinator, "owner"), "abandoned-coordinator-owner");
    const old = new Date(Date.now() - 120_000);
    utimesSync(recovery, old, old);
    utimesSync(coordinator, old, old);
    const results = await barrierClaims(dataDir, input, 24);
    assertBarrierClaims(results);
    assert.equal(existsSync(join(dir, ".connection.lock")), false);
    assert.equal(existsSync(coordinator), false);
    assert.equal(existsSync(recovery), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("stale recovery, coordinator, and lease guards recover after a crash window", async (t) => {
  if (process.platform === "win32") {
    t.skip("worker barrier relies on POSIX lease locking");
    return;
  }
  const root = tempRoot();
  const workspace = tempWorkspace();
  try {
    const dataDir = join(root, "state");
    const input = claimInput(workspace, "crash-window-session");
    const dir = ensureSessionDir(
      dataDir,
      input.workspaceHash,
      input.sessionHash,
    );
    const recovery = join(dir, ".connection.lock.coordinator.recovery");
    const coordinator = join(dir, ".connection.lock.coordinator");
    const leaseLock = join(dir, ".connection.lock");
    mkdirSync(recovery, { mode: 0o700 });
    mkdirSync(coordinator, { mode: 0o700 });
    mkdirSync(leaseLock, { mode: 0o700 });
    writeFileSync(join(recovery, "owner"), "abandoned-recovery-owner");
    writeFileSync(join(coordinator, "owner"), "abandoned-coordinator-owner");
    writeFileSync(join(leaseLock, "owner"), "abandoned-lease-owner");
    const old = new Date(Date.now() - 120_000);
    utimesSync(recovery, old, old);
    utimesSync(coordinator, old, old);
    utimesSync(leaseLock, old, old);
    const results = await barrierClaims(dataDir, input, 24);
    assertBarrierClaims(results);
    assert.equal(existsSync(leaseLock), false);
    assert.equal(existsSync(coordinator), false);
    assert.equal(existsSync(recovery), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("repeated mixed stale-state rounds preserve progress", async (t) => {
  if (process.platform === "win32") {
    t.skip("worker barrier relies on POSIX lease locking");
    return;
  }
  for (let round = 0; round < 4; round += 1) {
    const root = tempRoot();
    const workspace = tempWorkspace();
    try {
      const dataDir = join(root, "state");
      const input = claimInput(workspace, `repeated-mixed-${round}`);
      const dir = ensureSessionDir(
        dataDir,
        input.workspaceHash,
        input.sessionHash,
      );
      const recovery = join(dir, ".connection.lock.coordinator.recovery");
      const reclaim = join(recovery, ".reclaim");
      const coordinator = join(dir, ".connection.lock.coordinator");
      const leaseLock = join(dir, ".connection.lock");
      for (const path of [recovery, reclaim, coordinator, leaseLock])
        mkdirSync(path, { mode: 0o700 });
      writeFileSync(join(recovery, "owner"), "abandoned-recovery-owner");
      writeFileSync(join(reclaim, "owner"), "abandoned-reclaim-owner");
      writeFileSync(join(coordinator, "owner"), "abandoned-coordinator-owner");
      writeFileSync(join(leaseLock, "owner"), "abandoned-lease-owner");
      const old = new Date(Date.now() - 120_000);
      for (const path of [recovery, reclaim, coordinator, leaseLock])
        utimesSync(path, old, old);

      assertBarrierClaims(await barrierClaims(dataDir, input, 12));
      const resolved = resolveLease(dataDir, {
        workspacePath: workspace,
        openCodeSessionID: input.openCodeSessionID,
      });
      assert(resolved.lease);
      releaseLease(
        dataDir,
        resolved.workspaceHash,
        resolved.sessionHash,
        resolved.lease.ownerToken,
      );
      const retry = claimLease(dataDir, input);
      releaseLease(
        dataDir,
        retry.workspaceHash,
        retry.sessionHash,
        retry.ownerToken,
      );
      assert.equal(existsSync(leaseLock), false);
      assert.equal(existsSync(coordinator), false);
      assert.equal(existsSync(recovery), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

test("stale nested recovery claims are reclaimed", async (t) => {
  if (process.platform === "win32") {
    t.skip("worker barrier relies on POSIX lease locking");
    return;
  }
  const root = tempRoot();
  const workspace = tempWorkspace();
  try {
    const dataDir = join(root, "state");
    const input = claimInput(workspace, "stale-nested-recovery-session");
    const dir = ensureSessionDir(
      dataDir,
      input.workspaceHash,
      input.sessionHash,
    );
    const recovery = join(dir, ".connection.lock.coordinator.recovery");
    const reclaim = join(recovery, ".reclaim");
    mkdirSync(recovery, { mode: 0o700 });
    mkdirSync(reclaim, { mode: 0o700 });
    writeFileSync(join(recovery, "owner"), "abandoned-recovery-owner");
    writeFileSync(join(reclaim, "owner"), "abandoned-reclaim-owner");
    const old = new Date(Date.now() - 120_000);
    utimesSync(recovery, old, old);
    utimesSync(reclaim, old, old);
    const results = await barrierClaims(dataDir, input, 24);
    assertBarrierClaims(results);
    assert.equal(existsSync(join(dir, ".connection.lock")), false);
    assert.equal(existsSync(join(dir, ".connection.lock.coordinator")), false);
    assert.equal(existsSync(recovery), false);
    const resolved = resolveLease(dataDir, {
      workspacePath: workspace,
      openCodeSessionID: input.openCodeSessionID,
    });
    assert(resolved.lease);
    releaseLease(
      dataDir,
      resolved.workspaceHash,
      resolved.sessionHash,
      resolved.lease.ownerToken,
    );
    const retry = claimLease(dataDir, input);
    releaseLease(
      dataDir,
      retry.workspaceHash,
      retry.sessionHash,
      retry.ownerToken,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("repeated nested recovery rounds preserve progress", async (t) => {
  if (process.platform === "win32") {
    t.skip("worker barrier relies on POSIX lease locking");
    return;
  }
  for (let round = 0; round < 4; round += 1) {
    const root = tempRoot();
    const workspace = tempWorkspace();
    try {
      const dataDir = join(root, "state");
      const input = claimInput(workspace, `repeated-nested-${round}`);
      const dir = ensureSessionDir(
        dataDir,
        input.workspaceHash,
        input.sessionHash,
      );
      const recovery = join(dir, ".connection.lock.coordinator.recovery");
      const reclaim = join(recovery, ".reclaim");
      mkdirSync(recovery, { mode: 0o700 });
      mkdirSync(reclaim, { mode: 0o700 });
      writeFileSync(join(recovery, "owner"), "abandoned-recovery-owner");
      writeFileSync(join(reclaim, "owner"), "abandoned-reclaim-owner");
      const old = new Date(Date.now() - 120_000);
      utimesSync(recovery, old, old);
      utimesSync(reclaim, old, old);
      assertBarrierClaims(await barrierClaims(dataDir, input, 24));
      const resolved = resolveLease(dataDir, {
        workspacePath: workspace,
        openCodeSessionID: input.openCodeSessionID,
      });
      assert(resolved.lease);
      releaseLease(
        dataDir,
        resolved.workspaceHash,
        resolved.sessionHash,
        resolved.lease.ownerToken,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

test("stale nested recovery claims recover with stale outer guards", async (t) => {
  if (process.platform === "win32") {
    t.skip("worker barrier relies on POSIX lease locking");
    return;
  }
  const root = tempRoot();
  const workspace = tempWorkspace();
  try {
    const dataDir = join(root, "state");
    const input = claimInput(workspace, "stale-nested-outer-session");
    const dir = ensureSessionDir(
      dataDir,
      input.workspaceHash,
      input.sessionHash,
    );
    const recovery = join(dir, ".connection.lock.coordinator.recovery");
    const reclaim = join(recovery, ".reclaim");
    const coordinator = join(dir, ".connection.lock.coordinator");
    for (const path of [recovery, reclaim, coordinator])
      mkdirSync(path, { mode: 0o700 });
    writeFileSync(join(recovery, "owner"), "abandoned-recovery-owner");
    writeFileSync(join(reclaim, "owner"), "abandoned-reclaim-owner");
    writeFileSync(join(coordinator, "owner"), "abandoned-coordinator-owner");
    const old = new Date(Date.now() - 120_000);
    for (const path of [recovery, reclaim, coordinator])
      utimesSync(path, old, old);
    const results = await barrierClaims(dataDir, input, 24);
    assertBarrierClaims(results);
    assert.equal(existsSync(join(dir, ".connection.lock")), false);
    assert.equal(existsSync(coordinator), false);
    assert.equal(existsSync(recovery), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("stale nested recovery claims recover the full crash-window state", async (t) => {
  if (process.platform === "win32") {
    t.skip("worker barrier relies on POSIX lease locking");
    return;
  }
  const root = tempRoot();
  const workspace = tempWorkspace();
  try {
    const dataDir = join(root, "state");
    const input = claimInput(workspace, "stale-nested-crash-window-session");
    const dir = ensureSessionDir(
      dataDir,
      input.workspaceHash,
      input.sessionHash,
    );
    const recovery = join(dir, ".connection.lock.coordinator.recovery");
    const reclaim = join(recovery, ".reclaim");
    const coordinator = join(dir, ".connection.lock.coordinator");
    const leaseLock = join(dir, ".connection.lock");
    for (const path of [recovery, reclaim, coordinator, leaseLock])
      mkdirSync(path, { mode: 0o700 });
    writeFileSync(join(recovery, "owner"), "abandoned-recovery-owner");
    writeFileSync(join(reclaim, "owner"), "abandoned-reclaim-owner");
    writeFileSync(join(coordinator, "owner"), "abandoned-coordinator-owner");
    writeFileSync(join(leaseLock, "owner"), "abandoned-lease-owner");
    const old = new Date(Date.now() - 120_000);
    for (const path of [recovery, reclaim, coordinator, leaseLock])
      utimesSync(path, old, old);
    const results = await barrierClaims(dataDir, input, 24);
    assertBarrierClaims(results);
    assert.equal(existsSync(leaseLock), false);
    assert.equal(existsSync(coordinator), false);
    assert.equal(existsSync(recovery), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("cleanup cannot delete or refresh another owner's lease", () => {
  const root = tempRoot();
  const workspace = tempWorkspace();
  try {
    const dataDir = join(root, "state");
    const sessionID = "owner-session";
    const lease = claimLease(dataDir, claimInput(workspace, sessionID));
    const before = readFileSync(
      join(
        sessionDir(dataDir, lease.workspaceHash, lease.sessionHash),
        "connection.json",
      ),
      "utf8",
    );
    assert.throws(
      () =>
        releaseLease(
          dataDir,
          lease.workspaceHash,
          lease.sessionHash,
          "foreign-token",
        ),
      StateError,
    );
    assert.throws(
      () =>
        refreshLease(
          dataDir,
          lease.workspaceHash,
          lease.sessionHash,
          "foreign-token",
        ),
      StateError,
    );
    const after = readFileSync(
      join(
        sessionDir(dataDir, lease.workspaceHash, lease.sessionHash),
        "connection.json",
      ),
      "utf8",
    );
    assert.equal(after, before);
    assert.equal(
      resolveLease(dataDir, {
        workspacePath: workspace,
        openCodeSessionID: sessionID,
      }).check,
      "fresh",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("malformed and mismatched lease records are unavailable state", () => {
  const root = tempRoot();
  const workspace = tempWorkspace();
  try {
    const dataDir = join(root, "state");
    const sessionID = "malformed-session";
    const lease = claimLease(dataDir, claimInput(workspace, sessionID));
    const dir = sessionDir(dataDir, lease.workspaceHash, lease.sessionHash);

    writeFileSync(join(dir, "connection.json"), "{ not valid json");
    assert.throws(
      () => readLeaseFile(dataDir, lease.workspaceHash, lease.sessionHash),
      StateError,
    );
    assert.throws(
      () => claimLease(dataDir, claimInput(workspace, sessionID)),
      StateError,
    );
    assert.throws(
      () =>
        releaseLease(
          dataDir,
          lease.workspaceHash,
          lease.sessionHash,
          lease.ownerToken,
        ),
      StateError,
    );

    writeFileSync(join(dir, "connection.json"), JSON.stringify({ version: 1 }));
    assert.equal(
      resolveLease(dataDir, {
        workspacePath: workspace,
        openCodeSessionID: sessionID,
      }).check,
      "malformed",
    );

    const wrongScope = { ...lease, workspaceHash: "0".repeat(64) };
    writeFileSync(join(dir, "connection.json"), JSON.stringify(wrongScope));
    assert.equal(
      resolveLease(dataDir, {
        workspacePath: workspace,
        openCodeSessionID: sessionID,
      }).check,
      "workspaceMismatch",
    );

    const wrongSession = { ...lease, sessionHash: "1".repeat(64) };
    writeFileSync(join(dir, "connection.json"), JSON.stringify(wrongSession));
    assert.equal(
      resolveLease(dataDir, {
        workspacePath: workspace,
        openCodeSessionID: sessionID,
      }).check,
      "sessionMismatch",
    );

    writeFileSync(
      join(dir, "connection.json"),
      JSON.stringify({ ...lease, version: 2 }),
    );
    assert.equal(
      resolveLease(dataDir, {
        workspacePath: workspace,
        openCodeSessionID: sessionID,
      }).check,
      "unsupportedVersion",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("tampered unhashed lease and preference identities are unavailable", () => {
  const root = tempRoot();
  const workspace = tempWorkspace();
  const otherWorkspace = tempWorkspace();
  try {
    const dataDir = join(root, "state");
    const sessionID = "identity-session";
    const lease = claimLease(dataDir, claimInput(workspace, sessionID));
    const dir = sessionDir(dataDir, lease.workspaceHash, lease.sessionHash);
    const leasePath = join(dir, "connection.json");
    writeFileSync(
      leasePath,
      JSON.stringify({ ...lease, workspacePath: otherWorkspace }),
    );
    const wrongWorkspace = resolveLease(dataDir, {
      workspacePath: workspace,
      openCodeSessionID: sessionID,
    });
    assert.equal(wrongWorkspace.check, "workspaceMismatch");
    assert.equal(wrongWorkspace.lease, undefined);
    assert.throws(
      () => readLeaseFile(dataDir, lease.workspaceHash, lease.sessionHash),
      StateError,
    );

    writeFileSync(
      leasePath,
      JSON.stringify({ ...lease, openCodeSessionID: "different-session" }),
    );
    const wrongSession = resolveLease(dataDir, {
      workspacePath: workspace,
      openCodeSessionID: sessionID,
    });
    assert.equal(wrongSession.check, "sessionMismatch");
    assert.equal(wrongSession.lease, undefined);

    writeFileSync(leasePath, JSON.stringify(lease));
    const preferences = {
      version: 1 as const,
      workspacePath: workspace,
      workspaceHash: lease.workspaceHash,
      openCodeSessionID: sessionID,
      sessionHash: lease.sessionHash,
      name: "opencode-a",
      label: null,
      autoConnect: true,
    };
    writePreferences(
      dataDir,
      lease.workspaceHash,
      lease.sessionHash,
      preferences,
    );
    const preferencesPath = join(dir, "preferences.json");
    writeFileSync(
      preferencesPath,
      JSON.stringify({ ...preferences, workspacePath: otherWorkspace }),
    );
    assert.throws(
      () =>
        readPreferences(dataDir, lease.workspaceHash, lease.sessionHash, {
          workspacePath: workspace,
          openCodeSessionID: sessionID,
        }),
      StateError,
    );
    writeFileSync(
      preferencesPath,
      JSON.stringify({
        ...preferences,
        openCodeSessionID: "different-session",
      }),
    );
    assert.throws(
      () => readPreferences(dataDir, lease.workspaceHash, lease.sessionHash),
      StateError,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
    rmSync(otherWorkspace, { recursive: true, force: true });
  }
});

test("an expired lease can be refreshed by its owner", () => {
  const root = tempRoot();
  const workspace = tempWorkspace();
  try {
    const dataDir = join(root, "state");
    const sessionID = "stale-session";
    const lease = claimLease(dataDir, claimInput(workspace, sessionID), 1_000);
    const renewed = refreshLease(
      dataDir,
      lease.workspaceHash,
      lease.sessionHash,
      lease.ownerToken,
      1_000 + LEASE_EXPIRY_ALLOWANCE_MS + 1,
    );
    assert.equal(renewed.ownerToken, lease.ownerToken);
    assert.equal(
      resolveLease(
        dataDir,
        { workspacePath: workspace, openCodeSessionID: sessionID },
        1_000 + LEASE_EXPIRY_ALLOWANCE_MS + 1,
      ).check,
      "fresh",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("state directories and files use restrictive permissions", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX mode bits are not enforced on Windows");
    return;
  }
  const root = tempRoot();
  const workspace = tempWorkspace();
  try {
    const dataDir = join(root, "state");
    const sessionID = "perms-session";
    const lease = claimLease(dataDir, claimInput(workspace, sessionID));
    writePreferences(dataDir, lease.workspaceHash, lease.sessionHash, {
      version: 1,
      workspacePath: workspace,
      workspaceHash: lease.workspaceHash,
      openCodeSessionID: sessionID,
      sessionHash: lease.sessionHash,
      name: "opencode-a",
      label: null,
      autoConnect: false,
    });
    const dir = sessionDir(dataDir, lease.workspaceHash, lease.sessionHash);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    for (const parent of [dirname(dir), dirname(dirname(dir))]) {
      assert.equal(statSync(parent).mode & 0o777, 0o700);
    }
    assert.equal(statSync(join(dir, "connection.json")).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "preferences.json")).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("symlinked session paths that escape the data directory are rejected", (t) => {
  if (process.platform === "win32") {
    t.skip("symlink semantics differ on Windows");
    return;
  }
  const root = tempRoot();
  const workspace = tempWorkspace();
  const outside = tempRoot();
  try {
    const dataDir = join(root, "state");
    const sessionID = "symlink-session";
    const lease = claimLease(dataDir, claimInput(workspace, sessionID));
    const dir = sessionDir(dataDir, lease.workspaceHash, lease.sessionHash);

    rmSync(dir, { recursive: true, force: true });
    symlinkSync(outside, dir);
    assert.throws(
      () => readLeaseFile(dataDir, lease.workspaceHash, lease.sessionHash),
      (error: unknown) => {
        assert(error instanceof StateError);
        assert.match(String(error), /not contained/);
        return true;
      },
    );
    rmSync(dir, { recursive: true, force: true });

    const workspacesDir = dirname(dir);
    rmSync(workspacesDir, { recursive: true, force: true });
    symlinkSync(outside, workspacesDir);
    const outsideBefore = {
      entries: statSync(outside).mode & 0o777,
      names: statSync(outside).isDirectory(),
    };
    assert.throws(
      () => ensureSessionDir(dataDir, lease.workspaceHash, lease.sessionHash),
      (error: unknown) => {
        assert(error instanceof StateError);
        assert.match(String(error), /not contained/);
        return true;
      },
    );
    assert.deepEqual(
      {
        entries: statSync(outside).mode & 0o777,
        names: statSync(outside).isDirectory(),
      },
      outsideBefore,
    );
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("invalid scope hashes are rejected before path use", () => {
  const root = tempRoot();
  try {
    for (const bad of ["../escape", "ABCD", "", "a".repeat(63)]) {
      assert.throws(
        () => sessionDir(join(root, "state"), bad, "b".repeat(64)),
        StateError,
      );
      assert.throws(
        () => sessionDir(join(root, "state"), "a".repeat(64), bad),
        StateError,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readers see a complete file during atomic replacement", () => {
  const root = tempRoot();
  try {
    const session = ensureSessionDir(
      join(root, "state"),
      "a".repeat(64),
      "b".repeat(64),
    );
    const path = join(session, "connection.json");
    const first = {
      version: 1,
      workspaceHash: "a".repeat(64),
      sessionHash: "b".repeat(64),
      ownerToken: "token-one",
    };
    writeJsonAtomic(path, first);
    const staged = stageJsonWrite(path, {
      version: 1,
      workspaceHash: "a".repeat(64),
      sessionHash: "b".repeat(64),
      ownerToken: "token-two",
    });
    assert.deepEqual(readJsonFile(path), first);
    commitJsonWrite(staged, path);
    assert.equal(
      (readJsonFile(path) as { ownerToken: string }).ownerToken,
      "token-two",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preferences round trip and scope validation", () => {
  const root = tempRoot();
  const workspace = tempWorkspace();
  try {
    const dataDir = join(root, "state");
    const sessionID = "prefs-session";
    const lease = claimLease(dataDir, claimInput(workspace, sessionID));
    const prefs = {
      version: 1 as const,
      workspacePath: workspace,
      workspaceHash: lease.workspaceHash,
      openCodeSessionID: sessionID,
      sessionHash: lease.sessionHash,
      name: "opencode-a",
      label: "Label A",
      autoConnect: false,
    };
    writePreferences(dataDir, lease.workspaceHash, lease.sessionHash, prefs);
    assert.deepEqual(
      readPreferences(dataDir, lease.workspaceHash, lease.sessionHash),
      prefs,
    );
    assert.equal(
      readPreferences(dataDir, lease.workspaceHash, hashScope("other-session")),
      undefined,
    );
    assert.throws(
      () =>
        writePreferences(dataDir, lease.workspaceHash, lease.sessionHash, {
          ...prefs,
          sessionHash: "f".repeat(64),
        }),
      StateError,
    );
    writeFileSync(
      join(
        sessionDir(dataDir, lease.workspaceHash, lease.sessionHash),
        "preferences.json",
      ),
      "{ bad",
    );
    assert.throws(
      () => readPreferences(dataDir, lease.workspaceHash, lease.sessionHash),
      StateError,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("no shared secret or proof appears in state files or errors", () => {
  const root = tempRoot();
  const workspace = tempWorkspace();
  try {
    const dataDir = join(root, "state");
    const sessionID = "secret-session";
    const secret = "phase3-shared-secret-9f3k";
    const lease = claimLease(dataDir, claimInput(workspace, sessionID));
    writePreferences(dataDir, lease.workspaceHash, lease.sessionHash, {
      version: 1,
      workspacePath: workspace,
      workspaceHash: lease.workspaceHash,
      openCodeSessionID: sessionID,
      sessionHash: lease.sessionHash,
      name: "opencode-a",
      label: null,
      autoConnect: false,
    });
    const dir = sessionDir(dataDir, lease.workspaceHash, lease.sessionHash);
    for (const name of ["connection.json", "preferences.json"]) {
      const content = readFileSync(join(dir, name), "utf8");
      assert.equal(content.includes(secret), false);
      assert.equal(/"secret"|"proof"|"nonce"|"hmac"/.test(content), false);
    }
    assert.throws(
      () => claimLease(dataDir, claimInput(workspace, sessionID)),
      (error: unknown) => {
        assert(error instanceof StateError);
        assert.equal(String(error).includes(secret), false);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});
