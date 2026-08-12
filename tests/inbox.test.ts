import { readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import test from "node:test";
import assert from "node:assert/strict";
import {
  INBOX_MAX_BYTES,
  INBOX_MAX_MESSAGES,
  addMessage,
  emptyInbox,
  encodedInboxSize,
  readInboxFile,
  recordMessage,
  writeInboxFile,
  type Inbox,
  type InboxMessage,
} from "../src/inbox.js";
import {
  claimLease,
  hashScope,
  sessionDir,
  workspaceKey,
  type LeaseClaimInput,
} from "../src/state.js";
import { StateError } from "../src/errors.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "inter-agent-opencode-phase3-inbox-"));
}

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "inter-agent-opencode-inbox-ws-"));
}

function claimInput(workspace: string, sessionID: string): LeaseClaimInput {
  return {
    workspacePath: workspace,
    workspaceHash: workspaceKey(workspace),
    openCodeSessionID: sessionID,
    sessionHash: hashScope(sessionID),
    name: "opencode-a",
    label: null,
    host: "127.0.0.1",
    port: 16837,
    tls: false,
  };
}

function message(
  id: string,
  text = "hello",
  overrides: Partial<InboxMessage> = {},
): InboxMessage {
  return {
    id,
    receivedAt: "2025-01-01T00:00:00.000Z",
    from: "peer-a",
    fromName: "Peer A",
    kind: "direct",
    to: "opencode-a",
    text,
    notificationTruncated: false,
    ...overrides,
  };
}

test("append and duplicate message-ID suppression", () => {
  let inbox = emptyInbox();
  const first = addMessage(inbox, message("m1"));
  assert.equal(first.added, true);
  inbox = first.inbox;
  assert.equal(inbox.messages.length, 1);
  const duplicate = addMessage(inbox, message("m1"));
  assert.equal(duplicate.added, false);
  assert.deepEqual(duplicate.inbox, inbox);
  const second = addMessage(duplicate.inbox, message("m2"));
  assert.equal(second.added, true);
  assert.deepEqual(
    second.inbox.messages.map((entry) => entry.id),
    ["m1", "m2"],
  );
});

test("count bound evicts the oldest records", () => {
  let inbox = emptyInbox();
  for (let index = 0; index < 105; index += 1) {
    inbox = addMessage(inbox, message(`m${index}`)).inbox;
  }
  assert.equal(inbox.messages.length, INBOX_MAX_MESSAGES);
  assert.equal(inbox.messages[0].id, "m5");
  assert.equal(inbox.messages[inbox.messages.length - 1].id, "m104");
});

test("encoded size bound evicts the oldest records", () => {
  const big = "x".repeat(100_000);
  let inbox = emptyInbox();
  for (let index = 0; index < 200; index += 1) {
    inbox = addMessage(inbox, message(`m${index}`, big)).inbox;
  }
  assert.equal(inbox.messages.length <= INBOX_MAX_MESSAGES, true);
  assert(encodedInboxSize(inbox) <= INBOX_MAX_BYTES);
  assert.equal(inbox.messages[inbox.messages.length - 1].id, "m199");
  assert.notEqual(inbox.messages[0].id, "m0");
});

test("a single over-large message is retained as the sole record", () => {
  const huge = "x".repeat(20 * 1024 * 1024);
  const inbox = addMessage(emptyInbox(), message("huge", huge)).inbox;
  assert.equal(inbox.messages.length, 1);
  assert(encodedInboxSize(inbox) > INBOX_MAX_BYTES);
  assert.equal(inbox.messages[0].id, "huge");
});

test("inbox read/write round trip through the session scope", () => {
  const root = tempRoot();
  const workspace = tempWorkspace();
  try {
    const dataDir = join(root, "state");
    const sessionID = "inbox-session";
    const lease = claimLease(dataDir, claimInput(workspace, sessionID));
    const inbox = addMessage(emptyInbox(), message("m1")).inbox;
    writeInboxFile(dataDir, lease.workspaceHash, lease.sessionHash, inbox);
    assert.deepEqual(
      readInboxFile(dataDir, lease.workspaceHash, lease.sessionHash),
      inbox,
    );
    assert.deepEqual(
      readInboxFile(dataDir, lease.workspaceHash, hashScope("other-session")),
      emptyInbox(),
    );
    const dir = sessionDir(dataDir, lease.workspaceHash, lease.sessionHash);
    const before = readFileSync(join(dir, "inbox.json"), "utf8");
    readInboxFile(dataDir, lease.workspaceHash, lease.sessionHash);
    const after = readFileSync(join(dir, "inbox.json"), "utf8");
    assert.equal(after, before);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("two distinct session IDs cannot read each other's inbox", () => {
  const root = tempRoot();
  const workspace = tempWorkspace();
  try {
    const dataDir = join(root, "state");
    const sessionA = "session-a";
    const sessionB = "session-b";
    const leaseA = claimLease(dataDir, claimInput(workspace, sessionA));
    const leaseB = claimLease(dataDir, claimInput(workspace, sessionB));
    recordMessage(
      dataDir,
      leaseA.workspaceHash,
      leaseA.sessionHash,
      message("m1"),
    );
    assert.equal(
      readInboxFile(dataDir, leaseA.workspaceHash, leaseA.sessionHash).messages
        .length,
      1,
    );
    assert.deepEqual(
      readInboxFile(dataDir, leaseB.workspaceHash, leaseB.sessionHash),
      emptyInbox(),
    );
    recordMessage(
      dataDir,
      leaseB.workspaceHash,
      leaseB.sessionHash,
      message("m2"),
    );
    assert.deepEqual(
      readInboxFile(
        dataDir,
        leaseA.workspaceHash,
        leaseA.sessionHash,
      ).messages.map((entry) => entry.id),
      ["m1"],
    );
    assert.deepEqual(
      readInboxFile(
        dataDir,
        leaseB.workspaceHash,
        leaseB.sessionHash,
      ).messages.map((entry) => entry.id),
      ["m2"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("recordMessage persists and suppresses duplicate IDs", () => {
  const root = tempRoot();
  const workspace = tempWorkspace();
  try {
    const dataDir = join(root, "state");
    const sessionID = "record-session";
    const lease = claimLease(dataDir, claimInput(workspace, sessionID));
    const first = recordMessage(
      dataDir,
      lease.workspaceHash,
      lease.sessionHash,
      message("m1"),
    );
    assert.equal(first.added, true);
    const duplicate = recordMessage(
      dataDir,
      lease.workspaceHash,
      lease.sessionHash,
      message("m1"),
    );
    assert.equal(duplicate.added, false);
    const read = readInboxFile(dataDir, lease.workspaceHash, lease.sessionHash);
    assert.equal(read.messages.length, 1);
    assert.equal(read.messages[0].id, "m1");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("malformed inbox fails visibly and an atomic write recovers it", () => {
  const root = tempRoot();
  const workspace = tempWorkspace();
  try {
    const dataDir = join(root, "state");
    const sessionID = "broken-session";
    const lease = claimLease(dataDir, claimInput(workspace, sessionID));
    const dir = sessionDir(dataDir, lease.workspaceHash, lease.sessionHash);
    writeFileSync(join(dir, "inbox.json"), "{ not valid json");
    assert.throws(
      () => readInboxFile(dataDir, lease.workspaceHash, lease.sessionHash),
      StateError,
    );
    assert.throws(
      () =>
        recordMessage(
          dataDir,
          lease.workspaceHash,
          lease.sessionHash,
          message("m1"),
        ),
      StateError,
    );
    writeFileSync(
      join(dir, "inbox.json"),
      JSON.stringify({ version: 2, messages: [] }),
    );
    assert.throws(
      () => readInboxFile(dataDir, lease.workspaceHash, lease.sessionHash),
      StateError,
    );
    writeInboxFile(
      dataDir,
      lease.workspaceHash,
      lease.sessionHash,
      emptyInbox(),
    );
    assert.deepEqual(
      readInboxFile(dataDir, lease.workspaceHash, lease.sessionHash),
      emptyInbox(),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("inbox files use restrictive permissions", (t) => {
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
    writeInboxFile(
      dataDir,
      lease.workspaceHash,
      lease.sessionHash,
      emptyInbox(),
    );
    const dir = sessionDir(dataDir, lease.workspaceHash, lease.sessionHash);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    for (const parent of [dirname(dir), dirname(dirname(dir))]) {
      assert.equal(statSync(parent).mode & 0o777, 0o700);
    }
    assert.equal(statSync(join(dir, "inbox.json")).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("concurrent readers see complete files during atomic replacement", async (t) => {
  if (process.platform === "win32") {
    t.skip("worker stress relies on POSIX rename semantics");
    return;
  }
  const root = tempRoot();
  const workspace = tempWorkspace();
  try {
    const dataDir = join(root, "state");
    const sessionID = "stress-session";
    const lease = claimLease(dataDir, claimInput(workspace, sessionID));
    const inboxPath = join(
      sessionDir(dataDir, lease.workspaceHash, lease.sessionHash),
      "inbox.json",
    );
    const stopFlag = new SharedArrayBuffer(4);
    const worker = new Worker(
      new URL("./fixtures/stress-reader.js", import.meta.url),
      { workerData: { path: inboxPath, stopFlag } },
    );
    await new Promise<void>((resolve, reject) => {
      worker.once("message", (value: unknown) => {
        if (
          typeof value === "object" &&
          value !== null &&
          (value as { ready?: unknown }).ready === true
        ) {
          resolve();
        } else {
          reject(new Error("unexpected worker startup message"));
        }
      });
      worker.once("error", reject);
    });
    let inbox: Inbox = emptyInbox();
    for (let index = 0; index < 100; index += 1) {
      inbox = addMessage(inbox, message(`s${index}`, "y".repeat(64_000))).inbox;
      writeInboxFile(dataDir, lease.workspaceHash, lease.sessionHash, inbox);
    }
    Atomics.store(new Int32Array(stopFlag), 0, 1);
    const result = await new Promise<{ errors: string[]; reads: number }>(
      (resolve, reject) => {
        worker.once("message", (value) =>
          resolve(value as { errors: string[]; reads: number }),
        );
        worker.once("error", reject);
        worker.once("exit", (code) => {
          if (code !== 0)
            reject(new Error(`reader worker exited with code ${code}`));
        });
      },
    );
    assert.deepEqual(result.errors, []);
    assert(result.reads > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});
