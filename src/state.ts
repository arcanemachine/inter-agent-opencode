import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { StateError } from "./errors.js";

export const LEASE_VERSION = 1;
export const LEASE_REFRESH_INTERVAL_MS = 10_000;
export const LEASE_EXPIRY_ALLOWANCE_MS = 30_000;
export const PREFERENCES_VERSION = 1;
export const OPENCODE_STATE_DIRNAME = "opencode";
const CONNECTION_FILENAME = "connection.json";
const PREFERENCES_FILENAME = "preferences.json";
const LEASE_LOCK_DIRNAME = ".connection.lock";
const LEASE_COORDINATOR_DIRNAME = ".connection.lock.coordinator";
const LEASE_COORDINATOR_RECOVERY_DIRNAME =
  ".connection.lock.coordinator.recovery";
const LEASE_COORDINATOR_RECLAIM_DIRNAME = ".reclaim";
const LEASE_COORDINATOR_RECLAIM_QUARANTINE_PREFIX = ".reclaim.quarantine.";
const LEASE_COORDINATOR_QUARANTINE_PREFIX =
  ".connection.lock.coordinator.quarantine.";
const LEASE_LOCK_MARKER = "owner";
const LEASE_LOCK_TIMEOUT_MS = 10_000;
const LEASE_LOCK_STALE_MS = 60_000;
const LEASE_COORDINATOR_STALE_MS = 60_000;
const LEASE_RECOVERY_ABANDONED_MS = 1_000;
const SCOPE_HASH_PATTERN = /^[a-f0-9]{64}$/;

export type JsonObject = Record<string, unknown>;

export type ConnectionLease = {
  version: 1;
  workspacePath: string;
  workspaceHash: string;
  openCodeSessionID: string;
  sessionHash: string;
  ownerToken: string;
  name: string;
  label: string | null;
  host: string;
  port: number;
  tls: boolean;
  connectedAt: string;
  heartbeatAt: string;
  expiresAt: string;
};

export type SessionPreferences = {
  version: 1;
  workspacePath: string;
  workspaceHash: string;
  openCodeSessionID: string;
  sessionHash: string;
  name: string | null;
  label: string | null;
  autoConnect: boolean;
};

export type LeaseCheck =
  | "fresh"
  | "expired"
  | "missing"
  | "malformed"
  | "unsupportedVersion"
  | "workspaceMismatch"
  | "sessionMismatch";

export type LeaseClaimInput = {
  workspacePath: string;
  workspaceHash: string;
  openCodeSessionID: string;
  sessionHash: string;
  name: string;
  label: string | null;
  host: string;
  port: number;
  tls: boolean;
};

export type LeaseFileRead = {
  present: boolean;
  record?: JsonObject;
};

export type LeaseResolution = {
  workspacePath: string;
  workspaceHash: string;
  sessionHash: string;
  present: boolean;
  lease?: ConnectionLease;
  check: LeaseCheck;
};

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hashScope(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function workspaceKey(canonicalWorkspacePath: string): string {
  return hashScope(canonicalWorkspacePath);
}

export function sessionKey(openCodeSessionID: string): string {
  return hashScope(openCodeSessionID);
}

export function canonicalWorkspacePath(workspacePath: string): string {
  try {
    return realpathSync(workspacePath);
  } catch {
    return resolve(workspacePath);
  }
}

export function generateOwnerToken(): string {
  return randomBytes(32).toString("base64url");
}

export function assertScopeHashes(
  workspaceHash: string,
  sessionHash: string,
): void {
  if (!SCOPE_HASH_PATTERN.test(workspaceHash))
    throw new StateError("invalid workspace scope hash");
  if (!SCOPE_HASH_PATTERN.test(sessionHash))
    throw new StateError("invalid session scope hash");
}

function resolveReal(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function validateDirectoryPath(path: string): void {
  const absolute = resolve(path);
  let current = dirname(absolute);
  const components: string[] = [];
  let child = absolute;
  while (child !== current) {
    components.unshift(basename(child));
    child = current;
    current = dirname(current);
  }
  components.unshift(child);
  let candidate = components[0] ?? absolute;
  for (const component of components.slice(1)) {
    candidate = join(candidate, component);
    try {
      const stat = lstatSync(candidate);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new StateError(
          "session state path is not contained within the data directory",
        );
    } catch (error) {
      if (error instanceof StateError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw new StateError("unable to inspect inter-agent state path");
    }
  }
}

function ensureDirectoryTree(path: string): void {
  const absolute = resolve(path);
  let current = dirname(absolute);
  const components: string[] = [];
  let child = absolute;
  while (child !== current) {
    components.unshift(basename(child));
    child = current;
    current = dirname(current);
  }
  components.unshift(child);
  let candidate = components[0] ?? absolute;
  for (const component of components.slice(1)) {
    candidate = join(candidate, component);
    let created = false;
    try {
      mkdirSync(candidate, { mode: 0o700 });
      created = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST")
        throw new StateError("unable to create session state directory");
    }
    try {
      const stat = lstatSync(candidate);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new StateError(
          "session state path is not contained within the data directory",
        );
      if (created) chmodSync(candidate, 0o700);
    } catch (error) {
      if (error instanceof StateError) throw error;
      throw new StateError("unable to create session state directory");
    }
  }
}

function stateDir(
  dataDir: string,
  workspaceHash: string,
  sessionHash: string,
): string {
  return join(
    dataDir,
    OPENCODE_STATE_DIRNAME,
    "workspaces",
    workspaceHash,
    "sessions",
    sessionHash,
  );
}

export function sessionDir(
  dataDir: string,
  workspaceHash: string,
  sessionHash: string,
): string {
  assertScopeHashes(workspaceHash, sessionHash);
  validateDirectoryPath(dataDir);
  const realData = resolveReal(dataDir);
  const dir = stateDir(realData, workspaceHash, sessionHash);
  validateDirectoryPath(dir);
  return dir;
}

export function ensureSessionDir(
  dataDir: string,
  workspaceHash: string,
  sessionHash: string,
): string {
  assertScopeHashes(workspaceHash, sessionHash);
  validateDirectoryPath(dataDir);
  try {
    ensureDirectoryTree(dataDir);
    chmodSync(resolve(dataDir), 0o700);
  } catch (error) {
    if (error instanceof StateError) throw error;
    throw new StateError("unable to prepare inter-agent state directory");
  }
  const realData = resolveReal(dataDir);
  const expected = stateDir(realData, workspaceHash, sessionHash);
  validateDirectoryPath(expected);
  try {
    ensureDirectoryTree(expected);
    chmodSync(expected, 0o700);
  } catch (error) {
    if (error instanceof StateError) throw error;
    throw new StateError("unable to create session state directory");
  }
  return expected;
}

export function ensurePrivateDir(dir: string): void {
  try {
    const existing = lstatSync(dir);
    if (existing.isSymbolicLink() || !existing.isDirectory())
      throw new StateError("state directory is not a private directory");
  } catch (error) {
    if (error instanceof StateError) throw error;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      throw new StateError("unable to create private state directory");
    }
  }
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Windows may not support POSIX mode bits.
  }
}

export function readJsonFile(path: string): JsonObject {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new StateError("state file is not a regular file");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new StateError("state file is not valid JSON");
  }
  if (!isRecord(parsed))
    throw new StateError("state file must contain a JSON object");
  return parsed;
}

export function stageJsonWrite(path: string, value: JsonObject): string {
  const temp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
    });
  } catch {
    try {
      closeSync(fd);
    } catch {
      // Best effort close of the failed write.
    }
    try {
      unlinkSync(temp);
    } catch {
      // Best effort cleanup of this process's private temporary file.
    }
    throw new StateError("unable to write state file");
  }
  try {
    closeSync(fd);
  } catch {
    // Best effort close; the file content is already durable.
  }
  try {
    chmodSync(temp, 0o600);
  } catch {
    // Windows may not support POSIX mode bits.
  }
  return temp;
}

export function commitJsonWrite(tempPath: string, path: string): void {
  try {
    renameSync(tempPath, path);
  } catch {
    try {
      unlinkSync(tempPath);
    } catch {
      // Best effort cleanup of this process's private temporary file.
    }
    throw new StateError("unable to replace state file");
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows may not support POSIX mode bits.
  }
}

export function writeJsonAtomic(path: string, value: JsonObject): void {
  ensurePrivateDir(dirname(path));
  const temp = stageJsonWrite(path, value);
  commitJsonWrite(temp, path);
}

function sleepForLeaseLock(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}

function isTransientLockRace(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  if (
    code === "ENOENT" ||
    code === "ENOTDIR" ||
    code === "ENOTEMPTY" ||
    code === "EEXIST" ||
    code === "EBUSY"
  )
    return true;
  if (error instanceof StateError)
    return (
      error.message === "connection lease is busy; retry later" ||
      error.message === "connection lease recovery owner changed" ||
      /^unable to (?:acquire|claim(?: stale)?|reclaim|recover|remove|release|inspect) connection lease (?:lock|recovery|coordinator)(?: owner)?(?:$|:)/.test(
        error.message,
      )
    );
  return false;
}

function removeLockDirectory(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new StateError("connection lease lock is not a private directory");
    try {
      unlinkSync(join(path, LEASE_LOCK_MARKER));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (isTransientLockRace(error))
          throw new StateError("connection lease is busy; retry later");
        throw new StateError("unable to recover connection lease lock");
      }
    }
    try {
      rmdirSync(path);
    } catch (error) {
      if (isTransientLockRace(error))
        throw new StateError("connection lease is busy; retry later");
      throw new StateError("unable to recover connection lease lock");
    }
  } catch (error) {
    if (error instanceof StateError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    if (isTransientLockRace(error))
      throw new StateError("connection lease is busy; retry later");
    throw new StateError("unable to recover connection lease lock");
  }
}

function readLockMarker(path: string): string | undefined {
  try {
    return readFileSync(join(path, LEASE_LOCK_MARKER), "utf8");
  } catch (error) {
    if (isTransientLockRace(error)) return undefined;
    throw new StateError("unable to inspect connection lease lock");
  }
}

function removeRecoveryDirectory(path: string, reclaimToken?: string): void {
  let entries: string[];
  try {
    entries = readdirSync(path);
  } catch (error) {
    if (isTransientLockRace(error)) return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.startsWith(LEASE_COORDINATOR_RECLAIM_QUARANTINE_PREFIX))
      continue;
    const quarantine = join(path, entry);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(quarantine);
    } catch (error) {
      if (isTransientLockRace(error)) continue;
      throw error;
    }
    if (Date.now() - stat.mtimeMs <= LEASE_COORDINATOR_STALE_MS)
      throw new StateError("connection lease is busy; retry later");
    removeLockDirectory(quarantine);
  }
  const reclaimPath = join(path, LEASE_COORDINATOR_RECLAIM_DIRNAME);
  try {
    const reclaimMarker = readLockMarker(reclaimPath);
    if (reclaimToken !== undefined && reclaimMarker !== reclaimToken)
      throw new StateError("connection lease recovery owner changed");
    if (reclaimMarker !== undefined) removeLockDirectory(reclaimPath);
  } catch (error) {
    if (error instanceof StateError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new StateError("unable to remove connection lease recovery owner");
  }
  try {
    removeLockDirectory(path);
  } catch (error) {
    if (error instanceof StateError) {
      if (error.message.includes("unable to recover connection lease lock"))
        throw new StateError("connection lease is busy; retry later");
      throw error;
    }
    throw error;
  }
}

function removeOwnedRecoveryClaim(path: string, token: string): void {
  const reclaimPath = join(path, LEASE_COORDINATOR_RECLAIM_DIRNAME);
  try {
    if (readLockMarker(reclaimPath) === token) removeLockDirectory(reclaimPath);
  } catch (error) {
    if (!isTransientLockRace(error)) throw error;
  }
}

function hasFreshRecoveryClaimQuarantine(
  recoveryPath: string,
  staleThreshold = LEASE_COORDINATOR_STALE_MS,
): boolean {
  let names: string[];
  try {
    names = readdirSync(recoveryPath);
  } catch (error) {
    if (isTransientLockRace(error)) return false;
    throw new StateError("unable to inspect connection lease recovery claims");
  }
  let fresh = false;
  for (const name of names) {
    if (!name.startsWith(LEASE_COORDINATOR_RECLAIM_QUARANTINE_PREFIX)) continue;
    const quarantine = join(recoveryPath, name);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(quarantine);
    } catch (error) {
      if (isTransientLockRace(error)) continue;
      throw new StateError(
        "unable to inspect connection lease recovery claims",
      );
    }
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new StateError("connection lease recovery claim is not private");
    if (Date.now() - stat.mtimeMs > staleThreshold) {
      try {
        removeLockDirectory(quarantine);
      } catch (error) {
        if (!isTransientLockRace(error)) throw error;
      }
    } else fresh = true;
  }
  return fresh;
}

function reclaimStaleRecoveryClaim(
  recoveryPath: string,
  observedMarker: string,
  observedMtime: number,
  staleThreshold = LEASE_COORDINATOR_STALE_MS,
): string | undefined {
  if (hasFreshRecoveryClaimQuarantine(recoveryPath, staleThreshold))
    return undefined;
  const reclaimPath = join(recoveryPath, LEASE_COORDINATOR_RECLAIM_DIRNAME);
  const token = generateOwnerToken();
  const quarantine = join(
    recoveryPath,
    `${LEASE_COORDINATOR_RECLAIM_QUARANTINE_PREFIX}${token}`,
  );
  let moved = false;
  try {
    const current = lstatSync(reclaimPath);
    if (current.isSymbolicLink() || !current.isDirectory())
      throw new StateError("connection lease recovery claim is not private");
    const currentMarker = readLockMarker(reclaimPath);
    if (observedMarker === "" && currentMarker === undefined) {
      rmdirSync(reclaimPath);
      mkdirSync(reclaimPath, { mode: 0o700 });
      writeFileSync(join(reclaimPath, LEASE_LOCK_MARKER), token, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      return token;
    }
    if (
      currentMarker !== observedMarker ||
      Date.now() - observedMtime <= staleThreshold
    )
      return undefined;
    try {
      renameSync(reclaimPath, quarantine);
      moved = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new StateError("unable to reclaim connection lease recovery claim");
    }
    if (readLockMarker(quarantine) !== observedMarker) {
      renameSync(quarantine, reclaimPath);
      moved = false;
      return undefined;
    }
    removeLockDirectory(quarantine);
    mkdirSync(reclaimPath, { mode: 0o700 });
    writeFileSync(join(reclaimPath, LEASE_LOCK_MARKER), token, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return token;
  } finally {
    if (moved) {
      try {
        removeLockDirectory(quarantine);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

function createRecoveryGuard(dir: string): (() => void) | undefined {
  const recoveryPath = join(dir, LEASE_COORDINATOR_RECOVERY_DIRNAME);
  const markerPath = join(recoveryPath, LEASE_LOCK_MARKER);
  const token = generateOwnerToken();
  let created = false;
  try {
    mkdirSync(recoveryPath, { mode: 0o700 });
    created = true;
    writeFileSync(markerPath, token, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (created && readLockMarker(recoveryPath) === token)
      removeRecoveryDirectory(recoveryPath, token);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw new StateError("unable to acquire connection lease recovery guard");
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const reclaimPath = join(recoveryPath, LEASE_COORDINATOR_RECLAIM_DIRNAME);
    let reclaimToken = generateOwnerToken();
    let claimed = false;
    const claimStartedAt = Date.now();
    while (!claimed) {
      let claimCreated = false;
      try {
        mkdirSync(reclaimPath, { mode: 0o700 });
        claimCreated = true;
        writeFileSync(join(reclaimPath, LEASE_LOCK_MARKER), reclaimToken, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        claimed = true;
      } catch (error) {
        if (claimCreated) {
          try {
            rmdirSync(reclaimPath);
          } catch {
            // Best effort cleanup of this process's empty claim.
          }
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          if (isTransientLockRace(error)) return;
          throw new StateError(
            "unable to release connection lease recovery guard",
          );
        }
        if (readLockMarker(recoveryPath) !== token) return;
        try {
          const claimMarker = readLockMarker(reclaimPath);
          if (claimMarker === undefined) {
            rmdirSync(reclaimPath);
            continue;
          }
          const claimStat = lstatSync(reclaimPath);
          if (
            Date.now() - Number(claimStat.mtimeMs) >
            LEASE_COORDINATOR_STALE_MS
          ) {
            const replacement = reclaimStaleRecoveryClaim(
              recoveryPath,
              claimMarker,
              Number(claimStat.mtimeMs),
            );
            if (replacement) {
              reclaimToken = replacement;
              claimed = true;
              break;
            }
          }
        } catch (claimError) {
          if (!isTransientLockRace(claimError)) throw claimError;
        }
        if (Date.now() - claimStartedAt >= LEASE_LOCK_TIMEOUT_MS) return;
        sleepForLeaseLock();
      }
    }
    const quarantine = join(
      dir,
      `${LEASE_COORDINATOR_QUARANTINE_PREFIX}${reclaimToken}`,
    );
    try {
      if (readLockMarker(recoveryPath) !== token) return;
      try {
        renameSync(recoveryPath, quarantine);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw new StateError(
          "unable to release connection lease recovery guard",
        );
      }
      if (
        readLockMarker(quarantine) === token &&
        readLockMarker(join(quarantine, LEASE_COORDINATOR_RECLAIM_DIRNAME)) ===
          reclaimToken
      ) {
        try {
          removeRecoveryDirectory(quarantine, reclaimToken);
        } catch (error) {
          if (!isTransientLockRace(error)) throw error;
        }
      } else renameSync(quarantine, recoveryPath);
    } finally {
      if (claimed) removeOwnedRecoveryClaim(recoveryPath, reclaimToken);
    }
  };
}

function reclaimStaleRecoveryGuard(
  dir: string,
  observedMarker: string | undefined,
  observedMtime: number,
  staleThreshold = LEASE_COORDINATOR_STALE_MS,
): (() => void) | undefined {
  const recoveryPath = join(dir, LEASE_COORDINATOR_RECOVERY_DIRNAME);
  const reclaimPath = join(recoveryPath, LEASE_COORDINATOR_RECLAIM_DIRNAME);
  let reclaimToken = generateOwnerToken();
  let claimed = false;
  try {
    let existing: ReturnType<typeof lstatSync> | undefined;
    try {
      existing = lstatSync(reclaimPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isDirectory())
        throw new StateError("connection lease recovery claim is not private");
      const existingMarker = readLockMarker(reclaimPath);
      if (
        existingMarker !== undefined &&
        Date.now() - Number(existing.mtimeMs) <= staleThreshold
      )
        return undefined;
      const replacement = reclaimStaleRecoveryClaim(
        recoveryPath,
        existingMarker ?? "",
        Number(existing.mtimeMs),
        staleThreshold,
      );
      if (!replacement) return undefined;
      reclaimToken = replacement;
      claimed = true;
    } else {
      mkdirSync(reclaimPath, { mode: 0o700 });
      claimed = true;
      writeFileSync(join(reclaimPath, LEASE_LOCK_MARKER), reclaimToken, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    }
  } catch (error) {
    if (isTransientLockRace(error)) return undefined;
    throw new StateError("unable to claim stale connection lease recovery");
  }
  const quarantine = join(
    dir,
    `${LEASE_COORDINATOR_QUARANTINE_PREFIX}${reclaimToken}`,
  );
  try {
    let current: ReturnType<typeof lstatSync>;
    try {
      current = lstatSync(recoveryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (current.isSymbolicLink() || !current.isDirectory())
      throw new StateError("connection lease recovery guard is not private");
    if (
      readLockMarker(recoveryPath) !== observedMarker ||
      Date.now() - observedMtime <= staleThreshold
    )
      return undefined;
    try {
      renameSync(recoveryPath, quarantine);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new StateError("unable to reclaim connection lease recovery guard");
    }
    if (
      readLockMarker(quarantine) !== observedMarker ||
      readLockMarker(join(quarantine, LEASE_COORDINATOR_RECLAIM_DIRNAME)) !==
        reclaimToken
    ) {
      renameSync(quarantine, recoveryPath);
      return undefined;
    }
    try {
      removeRecoveryDirectory(quarantine, reclaimToken);
    } catch (error) {
      if (!isTransientLockRace(error)) throw error;
      return undefined;
    }
    return createRecoveryGuard(dir);
  } finally {
    if (claimed) removeOwnedRecoveryClaim(recoveryPath, reclaimToken);
  }
}

function acquireCoordinatorRecovery(dir: string): () => void {
  const recoveryPath = join(dir, LEASE_COORDINATOR_RECOVERY_DIRNAME);
  const startedAt = Date.now();
  while (true) {
    const created = createRecoveryGuard(dir);
    if (created) return created;
    try {
      const stat = lstatSync(recoveryPath);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new StateError("connection lease recovery guard is not private");
      let coordinatorStale = false;
      try {
        const coordinator = lstatSync(join(dir, LEASE_COORDINATOR_DIRNAME));
        coordinatorStale =
          Date.now() - Number(coordinator.mtimeMs) > LEASE_COORDINATOR_STALE_MS;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        coordinatorStale = true;
      }
      if (
        Date.now() - stat.mtimeMs > LEASE_COORDINATOR_STALE_MS ||
        (coordinatorStale &&
          Date.now() - stat.mtimeMs > LEASE_RECOVERY_ABANDONED_MS)
      ) {
        const replacement = reclaimStaleRecoveryGuard(
          dir,
          readLockMarker(recoveryPath),
          stat.mtimeMs,
          coordinatorStale &&
            Date.now() - Number(stat.mtimeMs) > LEASE_RECOVERY_ABANDONED_MS
            ? LEASE_RECOVERY_ABANDONED_MS
            : LEASE_COORDINATOR_STALE_MS,
        );
        if (replacement) return replacement;
      }
    } catch (error) {
      if (error instanceof StateError) {
        if (!isTransientLockRace(error)) throw error;
      } else if (!isTransientLockRace(error)) {
        throw new StateError(
          "unable to inspect connection lease recovery guard",
        );
      }
    }
    if (Date.now() - startedAt >= LEASE_LOCK_TIMEOUT_MS)
      throw new StateError("connection lease is busy; retry later");
    sleepForLeaseLock();
  }
}

function createCoordinator(
  dir: string,
  allowRecoveryGuard: boolean,
): (() => void) | undefined {
  const coordinatorPath = join(dir, LEASE_COORDINATOR_DIRNAME);
  const markerPath = join(coordinatorPath, LEASE_LOCK_MARKER);
  if (!allowRecoveryGuard) {
    try {
      const recovery = lstatSync(join(dir, LEASE_COORDINATOR_RECOVERY_DIRNAME));
      if (recovery.isSymbolicLink() || !recovery.isDirectory())
        throw new StateError("connection lease recovery guard is not private");
      return undefined;
    } catch (error) {
      if (error instanceof StateError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR")
        throw new StateError(
          "unable to inspect connection lease recovery guard",
        );
    }
  }
  const token = generateOwnerToken();
  let created = false;
  try {
    mkdirSync(coordinatorPath, { mode: 0o700 });
    created = true;
    writeFileSync(markerPath, token, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (created) {
      try {
        unlinkSync(markerPath);
      } catch {
        // Best effort cleanup of this process's private marker.
      }
      try {
        rmdirSync(coordinatorPath);
      } catch {
        // Best effort cleanup of this process's private coordinator.
      }
      throw new StateError("unable to acquire connection lease coordinator");
    }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw new StateError("unable to acquire connection lease coordinator");
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const recoveryRelease = acquireCoordinatorRecovery(dir);
    try {
      const marker = readLockMarker(coordinatorPath);
      if (marker !== token) return;
      removeLockDirectory(coordinatorPath);
    } finally {
      recoveryRelease();
    }
  };
}

function acquireCoordinator(dir: string): () => void {
  const coordinatorPath = join(dir, LEASE_COORDINATOR_DIRNAME);
  const startedAt = Date.now();
  while (true) {
    const created = createCoordinator(dir, false);
    if (created) return created;
    try {
      const stat = lstatSync(coordinatorPath);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new StateError("connection lease coordinator is not private");
      const observedMarker = readLockMarker(coordinatorPath);
      if (Date.now() - stat.mtimeMs > LEASE_COORDINATOR_STALE_MS) {
        const recoveryRelease = acquireCoordinatorRecovery(dir);
        try {
          let currentStat: ReturnType<typeof lstatSync>;
          try {
            currentStat = lstatSync(coordinatorPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw error;
          }
          if (currentStat.isSymbolicLink() || !currentStat.isDirectory())
            throw new StateError("connection lease coordinator is not private");
          const currentMarker = readLockMarker(coordinatorPath);
          if (
            currentMarker !== observedMarker ||
            Date.now() - currentStat.mtimeMs <= LEASE_COORDINATOR_STALE_MS
          )
            continue;
          removeLockDirectory(coordinatorPath);
          const replacement = createCoordinator(dir, true);
          if (replacement) return replacement;
        } finally {
          recoveryRelease();
        }
        continue;
      }
    } catch (error) {
      if (error instanceof StateError) {
        if (!isTransientLockRace(error)) throw error;
      } else if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        try {
          const recoveryPath = join(dir, LEASE_COORDINATOR_RECOVERY_DIRNAME);
          const recoveryStat = lstatSync(recoveryPath);
          const recoveryAge = Date.now() - recoveryStat.mtimeMs;
          if (recoveryAge > LEASE_COORDINATOR_STALE_MS) {
            const recovery = acquireCoordinatorRecovery(dir);
            recovery();
          }
        } catch (recoveryError) {
          if (!isTransientLockRace(recoveryError)) throw recoveryError;
        }
      } else if (!isTransientLockRace(error)) {
        throw new StateError("unable to inspect connection lease coordinator");
      }
    }
    if (Date.now() - startedAt >= LEASE_LOCK_TIMEOUT_MS)
      throw new StateError("connection lease is busy; retry later");
    sleepForLeaseLock();
  }
}

function acquireLeaseLock(dir: string): () => void {
  const lockPath = join(dir, LEASE_LOCK_DIRNAME);
  const markerPath = join(lockPath, LEASE_LOCK_MARKER);
  const startedAt = Date.now();
  while (true) {
    const coordinatorRelease = acquireCoordinator(dir);
    let coordinatorReleased = false;
    try {
      let created = false;
      try {
        mkdirSync(lockPath, { mode: 0o700 });
        created = true;
        const token = generateOwnerToken();
        writeFileSync(markerPath, token, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        coordinatorRelease();
        coordinatorReleased = true;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          let marker: string;
          try {
            marker = readFileSync(markerPath, "utf8");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw new StateError("unable to inspect connection lease lock");
          }
          if (marker !== token) return;
          removeLockDirectory(lockPath);
        };
      } catch (error) {
        if (created) {
          try {
            unlinkSync(markerPath);
          } catch {
            // Best effort cleanup of this process's private marker.
          }
          try {
            rmdirSync(lockPath);
          } catch {
            // Best effort cleanup of this process's private lock.
          }
          if (isTransientLockRace(error))
            throw new StateError("connection lease is busy; retry later");
          throw new StateError("unable to acquire connection lease lock");
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST")
          throw new StateError("unable to acquire connection lease lock");
        try {
          const stat = lstatSync(lockPath);
          if (stat.isSymbolicLink() || !stat.isDirectory())
            throw new StateError(
              "connection lease lock is not a private directory",
            );
          if (Date.now() - stat.mtimeMs > LEASE_LOCK_STALE_MS) {
            removeLockDirectory(lockPath);
            continue;
          }
        } catch (statError) {
          if (statError instanceof StateError) throw statError;
          if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw new StateError("unable to inspect connection lease lock");
        }
      }
    } finally {
      if (!coordinatorReleased) coordinatorRelease();
    }
    if (Date.now() - startedAt >= LEASE_LOCK_TIMEOUT_MS)
      throw new StateError("connection lease is busy; retry later");
    sleepForLeaseLock();
  }
}

function isoTime(now: number): string {
  return new Date(now).toISOString();
}

type LeaseScopeExpectation = {
  workspaceHash: string;
  sessionHash: string;
  workspacePath?: string;
  openCodeSessionID?: string;
};

export function checkLease(
  lease: unknown,
  expected: LeaseScopeExpectation,
  now: number = Date.now(),
): LeaseCheck {
  if (lease === undefined) return "missing";
  if (!isRecord(lease)) return "malformed";
  if (lease.version !== LEASE_VERSION) return "unsupportedVersion";
  if (
    typeof lease.workspaceHash !== "string" ||
    typeof lease.sessionHash !== "string"
  )
    return "malformed";
  if (lease.workspaceHash !== expected.workspaceHash)
    return "workspaceMismatch";
  if (lease.sessionHash !== expected.sessionHash) return "sessionMismatch";
  if (
    typeof lease.workspacePath !== "string" ||
    typeof lease.openCodeSessionID !== "string" ||
    typeof lease.ownerToken !== "string" ||
    lease.ownerToken.length === 0 ||
    typeof lease.name !== "string" ||
    (lease.label !== null && typeof lease.label !== "string") ||
    typeof lease.host !== "string" ||
    typeof lease.port !== "number" ||
    !Number.isSafeInteger(lease.port) ||
    typeof lease.tls !== "boolean" ||
    typeof lease.connectedAt !== "string" ||
    typeof lease.heartbeatAt !== "string" ||
    typeof lease.expiresAt !== "string"
  )
    return "malformed";

  const canonicalLeaseWorkspace = canonicalWorkspacePath(lease.workspacePath);
  if (
    canonicalLeaseWorkspace !== lease.workspacePath ||
    workspaceKey(canonicalLeaseWorkspace) !== lease.workspaceHash
  )
    return "workspaceMismatch";
  if (sessionKey(lease.openCodeSessionID) !== lease.sessionHash)
    return "sessionMismatch";
  if (expected.workspacePath !== undefined) {
    const canonicalExpectedWorkspace = canonicalWorkspacePath(
      expected.workspacePath,
    );
    if (lease.workspacePath !== canonicalExpectedWorkspace)
      return "workspaceMismatch";
  }
  if (
    expected.openCodeSessionID !== undefined &&
    lease.openCodeSessionID !== expected.openCodeSessionID
  )
    return "sessionMismatch";

  const expiresAt = Date.parse(lease.expiresAt);
  const connectedAt = Date.parse(lease.connectedAt);
  const heartbeatAt = Date.parse(lease.heartbeatAt);
  if (
    Number.isNaN(expiresAt) ||
    Number.isNaN(connectedAt) ||
    Number.isNaN(heartbeatAt)
  )
    return "malformed";
  if (expiresAt <= now) return "expired";
  return "fresh";
}

function buildLease(
  input: LeaseClaimInput,
  ownerToken: string,
  now: number,
): ConnectionLease {
  return {
    version: LEASE_VERSION,
    workspacePath: input.workspacePath,
    workspaceHash: input.workspaceHash,
    openCodeSessionID: input.openCodeSessionID,
    sessionHash: input.sessionHash,
    ownerToken,
    name: input.name,
    label: input.label ?? null,
    host: input.host,
    port: input.port,
    tls: input.tls,
    connectedAt: isoTime(now),
    heartbeatAt: isoTime(now),
    expiresAt: isoTime(now + LEASE_EXPIRY_ALLOWANCE_MS),
  };
}

function readLeaseRecord(
  dataDir: string,
  workspaceHash: string,
  sessionHash: string,
): LeaseFileRead {
  const dir = sessionDir(dataDir, workspaceHash, sessionHash);
  const path = join(dir, CONNECTION_FILENAME);
  if (!existsSync(path)) return { present: false };
  return { present: true, record: readJsonFile(path) };
}

export function readLeaseFile(
  dataDir: string,
  workspaceHash: string,
  sessionHash: string,
): LeaseFileRead {
  const file = readLeaseRecord(dataDir, workspaceHash, sessionHash);
  if (file.present) {
    const check = checkLease(file.record, { workspaceHash, sessionHash });
    if (check === "workspaceMismatch" || check === "sessionMismatch")
      throw new StateError("connection record does not match its scope");
  }
  return file;
}

function finishLeaseOperation(
  releaseLock: () => void,
  operationFailed: boolean,
): void {
  try {
    releaseLock();
  } catch (error) {
    if (operationFailed || isTransientLockRace(error)) return;
    throw error;
  }
}

function normalizeClaimInput(input: LeaseClaimInput): LeaseClaimInput {
  const workspacePath = canonicalWorkspacePath(input.workspacePath);
  const workspaceHash = workspaceKey(workspacePath);
  const sessionHash = sessionKey(input.openCodeSessionID);
  if (input.workspaceHash !== workspaceHash)
    throw new StateError("workspace scope hash does not match its path");
  if (input.sessionHash !== sessionHash)
    throw new StateError("session scope hash does not match its ID");
  return { ...input, workspacePath, workspaceHash, sessionHash };
}

export function claimLease(
  dataDir: string,
  input: LeaseClaimInput,
  now: number = Date.now(),
): ConnectionLease {
  const normalized = normalizeClaimInput(input);
  const dir = ensureSessionDir(
    dataDir,
    normalized.workspaceHash,
    normalized.sessionHash,
  );
  const releaseLock = acquireLeaseLock(dir);
  let operationFailed = false;
  try {
    const { present, record } = readLeaseRecord(
      dataDir,
      normalized.workspaceHash,
      normalized.sessionHash,
    );
    if (present) {
      const check = checkLease(
        record,
        {
          workspaceHash: normalized.workspaceHash,
          sessionHash: normalized.sessionHash,
          workspacePath: normalized.workspacePath,
          openCodeSessionID: normalized.openCodeSessionID,
        },
        now,
      );
      if (check === "fresh")
        throw new StateError(
          "connection lease is held by another process or controller",
        );
      if (
        check === "malformed" ||
        check === "unsupportedVersion" ||
        check === "workspaceMismatch" ||
        check === "sessionMismatch"
      )
        throw new StateError(
          "existing connection record is malformed or mismatched; remove it before reconnecting",
        );
    }
    const lease = buildLease(normalized, generateOwnerToken(), now);
    writeJsonAtomic(join(dir, CONNECTION_FILENAME), lease);
    return lease;
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    finishLeaseOperation(releaseLock, operationFailed);
  }
}

export function refreshLease(
  dataDir: string,
  workspaceHash: string,
  sessionHash: string,
  ownerToken: string,
  now: number = Date.now(),
): ConnectionLease {
  const dir = ensureSessionDir(dataDir, workspaceHash, sessionHash);
  const releaseLock = acquireLeaseLock(dir);
  let operationFailed = false;
  try {
    const { present, record } = readLeaseRecord(
      dataDir,
      workspaceHash,
      sessionHash,
    );
    if (!present)
      throw new StateError("connection lease is missing; reconnect first");
    const check = checkLease(record, { workspaceHash, sessionHash }, now);
    if (check === "malformed" || check === "unsupportedVersion")
      throw new StateError("connection record is malformed");
    if (check === "workspaceMismatch" || check === "sessionMismatch")
      throw new StateError(
        "connection record does not match this session scope",
      );
    const existing = record as ConnectionLease;
    if (existing.ownerToken !== ownerToken)
      throw new StateError("connection lease is owned by another process");
    const updated: ConnectionLease = {
      ...existing,
      heartbeatAt: isoTime(now),
      expiresAt: isoTime(now + LEASE_EXPIRY_ALLOWANCE_MS),
    };
    writeJsonAtomic(join(dir, CONNECTION_FILENAME), updated);
    return updated;
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    finishLeaseOperation(releaseLock, operationFailed);
  }
}

export function releaseLease(
  dataDir: string,
  workspaceHash: string,
  sessionHash: string,
  ownerToken: string,
  now: number = Date.now(),
): void {
  const dir = sessionDir(dataDir, workspaceHash, sessionHash);
  const { present } = readLeaseRecord(dataDir, workspaceHash, sessionHash);
  if (!present) return;
  const releaseLock = acquireLeaseLock(dir);
  let operationFailed = false;
  try {
    const { present: stillPresent, record } = readLeaseRecord(
      dataDir,
      workspaceHash,
      sessionHash,
    );
    if (!stillPresent) return;
    const check = checkLease(record, { workspaceHash, sessionHash }, now);
    if (
      check === "malformed" ||
      check === "unsupportedVersion" ||
      check === "workspaceMismatch" ||
      check === "sessionMismatch"
    )
      throw new StateError("connection record is malformed or mismatched");
    const existing = record as ConnectionLease;
    if (existing.ownerToken !== ownerToken)
      throw new StateError("connection lease is owned by another process");
    try {
      unlinkSync(join(dir, CONNECTION_FILENAME));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new StateError("unable to remove connection lease");
    }
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    finishLeaseOperation(releaseLock, operationFailed);
  }
}

export function resolveLease(
  dataDir: string,
  input: { workspacePath: string; openCodeSessionID: string },
  now: number = Date.now(),
): LeaseResolution {
  const workspacePath = canonicalWorkspacePath(input.workspacePath);
  const workspaceHash = workspaceKey(workspacePath);
  const sessionHash = sessionKey(input.openCodeSessionID);
  const { present, record } = readLeaseRecord(
    dataDir,
    workspaceHash,
    sessionHash,
  );
  if (!present)
    return {
      workspacePath,
      workspaceHash,
      sessionHash,
      present: false,
      check: "missing",
    };
  const check = checkLease(
    record,
    {
      workspaceHash,
      sessionHash,
      workspacePath,
      openCodeSessionID: input.openCodeSessionID,
    },
    now,
  );
  return {
    workspacePath,
    workspaceHash,
    sessionHash,
    present: true,
    ...(check !== "workspaceMismatch" &&
    check !== "sessionMismatch" &&
    check !== "malformed" &&
    check !== "unsupportedVersion"
      ? { lease: record as ConnectionLease }
      : {}),
    check,
  };
}

function isPreferences(value: unknown): value is SessionPreferences {
  if (!isRecord(value)) return false;
  if (value.version !== PREFERENCES_VERSION) return false;
  if (typeof value.workspacePath !== "string") return false;
  if (typeof value.workspaceHash !== "string") return false;
  if (typeof value.openCodeSessionID !== "string") return false;
  if (typeof value.sessionHash !== "string") return false;
  if (value.name !== null && typeof value.name !== "string") return false;
  if (value.label !== null && typeof value.label !== "string") return false;
  if (typeof value.autoConnect !== "boolean") return false;
  return true;
}

function validatePreferencesScope(
  preferences: SessionPreferences,
  expected: { workspaceHash: string; sessionHash: string },
  identity?: { workspacePath: string; openCodeSessionID: string },
): void {
  if (preferences.workspaceHash !== expected.workspaceHash)
    throw new StateError(
      "session preferences do not match the workspace scope",
    );
  if (preferences.sessionHash !== expected.sessionHash)
    throw new StateError("session preferences do not match the session scope");
  const canonicalPath = canonicalWorkspacePath(preferences.workspacePath);
  if (
    canonicalPath !== preferences.workspacePath ||
    workspaceKey(canonicalPath) !== preferences.workspaceHash
  )
    throw new StateError(
      "session preferences do not match their workspace path",
    );
  if (sessionKey(preferences.openCodeSessionID) !== preferences.sessionHash)
    throw new StateError("session preferences do not match their session ID");
  if (
    identity &&
    (preferences.workspacePath !==
      canonicalWorkspacePath(identity.workspacePath) ||
      preferences.openCodeSessionID !== identity.openCodeSessionID)
  )
    throw new StateError(
      "session preferences do not match this session identity",
    );
}

export function readPreferences(
  dataDir: string,
  workspaceHash: string,
  sessionHash: string,
  identity?: { workspacePath: string; openCodeSessionID: string },
): SessionPreferences | undefined {
  const dir = sessionDir(dataDir, workspaceHash, sessionHash);
  const path = join(dir, PREFERENCES_FILENAME);
  if (!existsSync(path)) return undefined;
  const record = readJsonFile(path);
  if (!isPreferences(record))
    throw new StateError("session preferences are malformed");
  validatePreferencesScope(record, { workspaceHash, sessionHash }, identity);
  return record;
}

export function writePreferences(
  dataDir: string,
  workspaceHash: string,
  sessionHash: string,
  preferences: SessionPreferences,
): void {
  validatePreferencesScope(preferences, { workspaceHash, sessionHash });
  writeJsonAtomic(
    join(
      ensureSessionDir(dataDir, workspaceHash, sessionHash),
      PREFERENCES_FILENAME,
    ),
    preferences,
  );
}
