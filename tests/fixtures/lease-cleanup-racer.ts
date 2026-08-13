import { dirname, join } from "node:path";
import {
  existsSync,
  mkdirSync,
  unlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

const { lockPath, mode = "blocker" } = workerData as {
  lockPath: string;
  mode?: "blocker" | "replace-owner" | "replace-after-inspection";
};
if (!parentPort) throw new Error("lease cleanup racer requires a parent port");
const port = parentPort;

const blocker = join(lockPath, ".cleanup-race");
const owner = join(lockPath, "owner");
let raced = false;
let stopped = false;
let observedLock = false;
const tryRace = () => {
  if (stopped || raced) return;
  if (mode === "replace-after-inspection") {
    if (!observedLock) {
      if (existsSync(lockPath)) observedLock = true;
      return;
    }
    if (existsSync(lockPath)) return;
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      writeFileSync(owner, "foreign-owner", {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      raced = true;
      port.postMessage({ kind: "raced" });
    } catch {
      // The lock may reappear or another attempt may have won the race.
    }
    return;
  }
  if (!existsSync(lockPath) || (mode === "replace-owner" && !existsSync(owner)))
    return;
  try {
    if (mode === "replace-owner")
      writeFileSync(owner, "foreign-owner", { encoding: "utf8", flag: "w" });
    else writeFileSync(blocker, "race", { encoding: "utf8", flag: "wx" });
    raced = true;
    port.postMessage({ kind: "raced" });
  } catch {
    // The lock may disappear or another attempt may have won the race.
  }
};
const watcher = watch(dirname(lockPath), () => tryRace());
const interval = setInterval(tryRace, 1);
parentPort.on("message", (value: { stop?: boolean }) => {
  if (!value.stop) return;
  stopped = true;
  clearInterval(interval);
  watcher.close();
  try {
    unlinkSync(blocker);
  } catch {
    // The operation may already have removed the simulated race file.
  }
  port.postMessage({ kind: "stopped" });
});
port.postMessage({ kind: "ready" });
