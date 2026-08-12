import { dirname, join } from "node:path";
import {
  existsSync,
  mkdirSync,
  unlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

const { lockPath } = workerData as { lockPath: string };
if (!parentPort) throw new Error("lease cleanup racer requires a parent port");
const port = parentPort;

const blocker = join(lockPath, ".cleanup-race");
let raced = false;
let stopped = false;
const tryRace = () => {
  if (stopped || raced || !existsSync(lockPath)) return;
  try {
    writeFileSync(blocker, "race", { encoding: "utf8", flag: "wx" });
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
