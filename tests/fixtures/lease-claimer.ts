import { parentPort, workerData } from "node:worker_threads";
import type { LeaseClaimInput } from "../../src/state.js";

const {
  dataDir,
  input,
  barrier,
  now,
  invocation,
  workerID,
  hangAfterBarrier,
  barrierTimeoutMs,
} = workerData as {
  dataDir: string;
  input: LeaseClaimInput;
  barrier: SharedArrayBuffer;
  now: number;
  invocation: string;
  workerID: number;
  hangAfterBarrier?: boolean;
  barrierTimeoutMs: number;
};

if (!parentPort) throw new Error("lease claimer requires a parent port");
const gate = new Int32Array(barrier);
const barrierDeadline = Date.now() + barrierTimeoutMs;
parentPort.postMessage({
  kind: "lifecycle",
  phase: "started",
  invocation,
  workerID,
});
Atomics.add(gate, 0, 1);
Atomics.notify(gate, 0);
while (Atomics.load(gate, 0) < gate[1]) {
  const remaining = barrierDeadline - Date.now();
  if (remaining <= 0) {
    parentPort.postMessage({
      kind: "result",
      invocation,
      workerID,
      ok: false,
      error: `barrier timed out after ${barrierTimeoutMs}ms`,
    });
    process.exitCode = 1;
    throw new Error("barrier timed out");
  }
  Atomics.wait(gate, 0, Atomics.load(gate, 0), Math.min(remaining, 50));
}
parentPort.postMessage({
  kind: "lifecycle",
  phase: "barrier-arrived",
  invocation,
  workerID,
});
if (hangAfterBarrier)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);

const { claimLease } = await import("../../src/state.js");
try {
  const lease = claimLease(dataDir, input, now);
  parentPort.postMessage({
    kind: "result",
    invocation,
    workerID,
    ok: true,
    ownerToken: lease.ownerToken,
  });
} catch (error) {
  parentPort.postMessage({
    kind: "result",
    invocation,
    workerID,
    ok: false,
    error: String(error),
  });
}
