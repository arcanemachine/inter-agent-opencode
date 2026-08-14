import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { ControlConnection } from "../src/client.js";
import { TuiManager } from "../src/tui.js";
import { readInboxFile } from "../src/inbox.js";
import { hashScope, workspaceKey } from "../src/state.js";

const coreRoot =
  process.env.INTER_AGENT_CORE_ROOT ??
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../inter-agent-core");
const coreServerScript =
  "import asyncio, os\nfrom inter_agent.core.server import run_server\nasyncio.run(run_server(os.environ['INTER_AGENT_HOST'], int(os.environ['INTER_AGENT_PORT'])))";

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise())),
  );
  return port;
}

async function waitForPort(
  port: number,
  process: ChildProcessWithoutNullStreams,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 5_000) {
    if (process.exitCode !== null)
      throw new Error("isolated Core server exited");
    try {
      await new Promise<void>((resolvePromise, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        socket.once("connect", () => {
          socket.end();
          resolvePromise();
        });
        socket.once("error", reject);
      });
      return;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
  }
  throw new Error("timed out waiting for isolated Core server");
}

async function stopProcess(
  process: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (process.exitCode !== null) return;
  process.kill("SIGTERM");
  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(() => {
      if (process.exitCode === null) process.kill("SIGKILL");
      resolvePromise();
    }, 2_000);
    process.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

function apiFor(workspace: string) {
  let sessionID = "session-a";
  const api = {
    route: {
      get current() {
        return { name: "session", params: { sessionID } };
      },
      register: () => () => {},
      navigate: () => {},
    },
    state: {
      path: { worktree: workspace, directory: workspace },
      session: { get: (id: string) => ({ id }) },
    },
    keymap: { registerLayer: () => () => {} },
    event: { on: () => () => {} },
    lifecycle: {
      signal: new AbortController().signal,
      onDispose: () => () => {},
    },
    attention: {
      notify: async () => ({ ok: true, notification: true, sound: false }),
    },
    ui: { toast: () => {} },
    setSession(id: string) {
      sessionID = id;
    },
  };
  return api;
}

test("two TUI listeners route inboxes and isolate disconnect", async (t) => {
  if (typeof WebSocket !== "function") {
    t.skip("native WebSocket unavailable");
    return;
  }
  const root = mkdtempSync(join("/tmp", "inter-agent-opencode-phase4-live-"));
  const workspace = mkdtempSync(
    join("/tmp", "inter-agent-opencode-phase4-live-ws-"),
  );
  const state = join(root, "state");
  const config = join(root, "missing-config.json");
  const port = await unusedPort();
  const secret = randomBytes(32).toString("base64url");
  const previous = {
    data: process.env.INTER_AGENT_DATA_DIR,
    config: process.env.INTER_AGENT_CONFIG,
    host: process.env.INTER_AGENT_HOST,
    port: process.env.INTER_AGENT_PORT,
    secret: process.env.INTER_AGENT_SECRET,
  };
  process.env.INTER_AGENT_DATA_DIR = state;
  process.env.INTER_AGENT_CONFIG = config;
  process.env.INTER_AGENT_HOST = "127.0.0.1";
  process.env.INTER_AGENT_PORT = String(port);
  process.env.INTER_AGENT_SECRET = secret;
  let server = spawn(
    "uv",
    ["run", "--project", coreRoot, "python", "-c", coreServerScript],
    {
      cwd: coreRoot,
      env: {
        ...process.env,
        INTER_AGENT_DATA_DIR: state,
        INTER_AGENT_CONFIG: config,
        INTER_AGENT_HOST: "127.0.0.1",
        INTER_AGENT_PORT: String(port),
        INTER_AGENT_SECRET: secret,
        PYTHONUNBUFFERED: "1",
      },
      stdio: "pipe",
    },
  );
  const api = apiFor(workspace);
  let manager: TuiManager | undefined;
  let control: ControlConnection | undefined;
  try {
    await waitForPort(port, server);
    manager = new TuiManager(api as never);
    await manager.connect("agent-a");
    api.setSession("session-b");
    await manager.connect("agent-b");
    control = await ControlConnection.open({
      connectTimeoutMs: 2_000,
      operationTimeoutMs: 2_000,
    });
    await control.sendDirect("agent-a", "for A", "external");
    await control.sendDirect("agent-b", "for B", "external");
    await control.broadcast("for both", "external");
    const workspaceHash = workspaceKey(workspace);
    const started = Date.now();
    while (Date.now() - started < 2_000) {
      const a = readInboxFile(
        state,
        workspaceHash,
        hashScope("session-a"),
      ).messages;
      const b = readInboxFile(
        state,
        workspaceHash,
        hashScope("session-b"),
      ).messages;
      if (a.length >= 2 && b.length >= 2) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
    assert.deepEqual(
      readInboxFile(state, workspaceHash, hashScope("session-a")).messages.map(
        (message) => message.text,
      ),
      ["for A", "for both"],
    );
    assert.deepEqual(
      readInboxFile(state, workspaceHash, hashScope("session-b")).messages.map(
        (message) => message.text,
      ),
      ["for B", "for both"],
    );
    api.setSession("session-a");
    await manager.disconnect();
    const disconnectedAt = Date.now();
    let listed = await control.list();
    while (
      listed.sessions.some((session) => session.name === "agent-a") &&
      Date.now() - disconnectedAt < 2_000
    ) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      listed = await control.list();
    }
    assert.deepEqual(
      listed.sessions.map((session) => session.name),
      ["agent-b"],
    );

    await control.close();
    control = undefined;
    await stopProcess(server);
    server = spawn(
      "uv",
      ["run", "--project", coreRoot, "python", "-c", coreServerScript],
      {
        cwd: coreRoot,
        env: {
          ...process.env,
          INTER_AGENT_DATA_DIR: state,
          INTER_AGENT_CONFIG: config,
          INTER_AGENT_HOST: "127.0.0.1",
          INTER_AGENT_PORT: String(port),
          INTER_AGENT_SECRET: secret,
          PYTHONUNBUFFERED: "1",
        },
        stdio: "pipe",
      },
    );
    await waitForPort(port, server);
    const reconnectedAt = Date.now();
    while (
      manager.controllers.get("session-b")?.status !== "connected" &&
      Date.now() - reconnectedAt < 5_000
    )
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    assert.equal(manager.controllers.get("session-b")?.status, "connected");
    control = await ControlConnection.open({
      connectTimeoutMs: 2_000,
      operationTimeoutMs: 2_000,
    });
    const afterRestart = await control.list();
    assert.deepEqual(
      afterRestart.sessions.map((session) => session.name),
      ["agent-b"],
    );
  } finally {
    await manager?.dispose();
    await control?.close();
    await stopProcess(server);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined)
        delete process.env[`INTER_AGENT_${key.toUpperCase()}`];
      else process.env[`INTER_AGENT_${key.toUpperCase()}`] = value;
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});
