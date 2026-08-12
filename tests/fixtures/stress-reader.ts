import { readFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

const { path, stopFlag } = workerData as {
  path: string;
  stopFlag: SharedArrayBuffer;
};
const flag = new Int32Array(stopFlag);
const errors: string[] = [];
let reads = 0;

if (!parentPort) throw new Error("reader worker requires a parent port");
parentPort.postMessage({ ready: true });
while (Atomics.load(flag, 0) === 0) {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      errors.push("parsed state file was not an object");
    } else if (!Array.isArray((parsed as { messages?: unknown }).messages)) {
      errors.push("parsed state file had no messages array");
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") errors.push(String(error));
  }
  reads += 1;
}
parentPort.postMessage({ errors, reads });
