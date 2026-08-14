import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  TuiManager,
  isTerminalListenerError,
  parseConnectArgs,
} from "../src/tui.js";
import type { ProtocolFrame } from "../src/protocol.js";
import type { WebSocketFactory, WebSocketLike } from "../src/client.js";
import { serverProof } from "../src/protocol.js";
import { RemoteError, UnsupportedEndpointError } from "../src/errors.js";
import { readInboxFile } from "../src/inbox.js";
import {
  claimLease,
  hashScope,
  releaseLease,
  readPreferences,
  resolveLease,
  sessionDir,
  workspaceKey,
  type ConnectionLease,
  type LeaseClaimInput,
} from "../src/state.js";

class AgentSocket implements WebSocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  closed = false;
  constructor(
    private readonly onSend: (
      socket: AgentSocket,
      frame: ProtocolFrame,
    ) => void,
  ) {
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }
  send(data: string): void {
    this.onSend(this, JSON.parse(data) as ProtocolFrame);
  }
  emit(frame: ProtocolFrame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
}

function releaseLeaseForTest(dataDir: string, lease: ConnectionLease): void {
  releaseLease(
    dataDir,
    lease.workspaceHash,
    lease.sessionHash,
    lease.ownerToken,
  );
}

function resolveForeignOwner(
  dataDir: string,
  lease: ConnectionLease,
): string | undefined {
  return resolveLease(dataDir, {
    workspacePath: lease.workspacePath,
    openCodeSessionID: lease.openCodeSessionID,
  }).lease?.ownerToken;
}

function fakeApi(
  workspace: string,
  sockets: Map<string, AgentSocket>,
  urls: string[] = [],
  behavior: {
    failAuthAndChangeDataDir?: string;
    failAfter?: number;
    closeAfterAuth?: number;
    welcomeDelayMs?: number;
    ownerLoss?: { dataDir: string; workspacePath: string; after: number };
  } = {},
) {
  let currentSession = "session-a";
  let authCount = 0;
  const disposeHandlers: Array<() => void | Promise<void>> = [];
  const secret = "phase4-test-secret";
  const factory: WebSocketFactory = (url) => {
    urls.push(url);
    let socket!: AgentSocket;
    socket = new AgentSocket((current, frame) => {
      if (frame.op === "hello") {
        const nonce = (frame.auth as { client_nonce: string }).client_nonce;
        current.emit({
          op: "auth_challenge",
          method: "hmac-sha256",
          server_nonce: "server",
          server_proof: serverProof(secret, {
            clientNonce: nonce,
            serverNonce: "server",
            hello: frame,
          }),
        });
      } else if (frame.op === "auth_response") {
        authCount += 1;
        if (behavior.closeAfterAuth && authCount >= behavior.closeAfterAuth) {
          current.close();
          return;
        }
        if (
          behavior.failAuthAndChangeDataDir &&
          authCount >= (behavior.failAfter ?? 1)
        ) {
          process.env.INTER_AGENT_DATA_DIR = behavior.failAuthAndChangeDataDir;
          current.emit({
            op: "error",
            code: "AUTH_FAILED",
            message: "authentication failed",
          });
          return;
        }
        const welcome = {
          op: "welcome" as const,
          session_id: `${currentSession}-bus`,
          assigned_name: (frame as { name?: string }).name ?? "agent",
          capabilities: {
            core: { version: "0.1" },
            channels: true,
            rate_limit: false,
          },
        };
        if (behavior.welcomeDelayMs)
          setTimeout(() => current.emit(welcome), behavior.welcomeDelayMs);
        else current.emit(welcome);
        if (behavior.ownerLoss && authCount >= behavior.ownerLoss.after) {
          const currentLease = resolveLease(behavior.ownerLoss.dataDir, {
            workspacePath: behavior.ownerLoss.workspacePath,
            openCodeSessionID: currentSession,
          }).lease;
          if (currentLease) {
            releaseLease(
              behavior.ownerLoss.dataDir,
              currentLease.workspaceHash,
              currentLease.sessionHash,
              currentLease.ownerToken,
            );
            claimLease(behavior.ownerLoss.dataDir, {
              workspacePath: behavior.ownerLoss.workspacePath,
              workspaceHash: currentLease.workspaceHash,
              openCodeSessionID: currentSession,
              sessionHash: currentLease.sessionHash,
              name: "foreign-agent",
              label: null,
              host: currentLease.host,
              port: currentLease.port,
              tls: currentLease.tls,
            });
          }
        }
      } else if (frame.op === "list") {
        current.emit({ op: "list_ok", sessions: [] });
      }
    });
    sockets.set(`socket-${sockets.size}`, socket);
    return socket;
  };
  const api = {
    websocketFactory: factory,
    route: {
      get current() {
        return { name: "session", params: { sessionID: currentSession } };
      },
      register: () => () => {},
      navigate: () => {},
    },
    state: {
      path: { worktree: workspace, directory: workspace },
      session: { get: (id: string) => ({ id }) },
    },
    keymap: {
      registerLayer(layer: { commands: unknown[] }) {
        (api as { commands?: unknown[] }).commands = layer.commands;
        return () => {};
      },
    },
    event: { on: () => () => {} },
    lifecycle: {
      signal: new AbortController().signal,
      onDispose(handler: () => void | Promise<void>) {
        disposeHandlers.push(handler);
        return () => {};
      },
    },
    notifications: [] as Array<{ title?: string; message: string }>,
    attention: {
      notify: async (input: { title?: string; message: string }) => {
        (api.notifications as Array<{ title?: string; message: string }>).push(
          input,
        );
        return { ok: true, notification: true, sound: false };
      },
    },
    ui: {
      toast: () => {},
      DialogPrompt: (props: unknown) => props,
      dialog: {
        replace(render: () => unknown) {
          (api as { prompt?: unknown }).prompt = render();
        },
        clear() {
          (api as { prompt?: unknown }).prompt = undefined;
        },
      },
    },
    commands: undefined as unknown,
    prompt: undefined as unknown,
    setSession(id: string) {
      currentSession = id;
    },
    disposeHandlers,
  };
  return api;
}

test("terminal listener errors stop retry while transport errors retry", () => {
  for (const code of [
    "AUTH_FAILED",
    "PROTOCOL_ERROR",
    "BAD_NAME",
    "SESSION_TAKEN",
    "NAME_TAKEN",
    "TOO_MANY_CONNECTIONS",
    "KICKED",
  ] as const)
    assert.equal(
      isTerminalListenerError(new RemoteError(code, "failure")),
      true,
    );
  assert.equal(
    isTerminalListenerError(new UnsupportedEndpointError("TLS")),
    true,
  );
  assert.equal(isTerminalListenerError(new Error("socket closed")), false);
});

test("connect argument parsing validates identity and options", () => {
  assert.deepEqual(
    parseConnectArgs("agent-a --label 'Agent A' --auto-connect"),
    {
      name: "agent-a",
      label: "Agent A",
      autoConnect: true,
    },
  );
  assert.throws(() => parseConnectArgs("Bad Name"), /usage/);
  assert.throws(
    () => parseConnectArgs("agent-a --unknown"),
    /unknown connect option/,
  );
});

test("native palette commands are reachable and argument commands use a dialog", async () => {
  const root = mkdtempSync(
    join(tmpdir(), "inter-agent-opencode-phase4-command-"),
  );
  const workspace = mkdtempSync(
    join(tmpdir(), "inter-agent-opencode-phase4-command-ws-"),
  );
  const previous = {
    data: process.env.INTER_AGENT_DATA_DIR,
    secret: process.env.INTER_AGENT_SECRET,
    host: process.env.INTER_AGENT_HOST,
    port: process.env.INTER_AGENT_PORT,
  };
  process.env.INTER_AGENT_DATA_DIR = root;
  process.env.INTER_AGENT_SECRET = "phase4-test-secret";
  process.env.INTER_AGENT_HOST = "127.0.0.1";
  process.env.INTER_AGENT_PORT = "16839";
  try {
    const api = fakeApi(workspace, new Map());
    const manager = new TuiManager(api as never);
    const commands = api.commands as Array<{
      namespace: string;
      title: string;
      desc: string;
      slashName: string;
      run: () => void;
    }>;
    assert.equal(commands.length, 7);
    assert.deepEqual(
      commands.map((command) => [command.namespace, command.slashName]),
      [
        ["palette", "inter-agent-connect"],
        ["palette", "inter-agent-disconnect"],
        ["palette", "inter-agent-send"],
        ["palette", "inter-agent-broadcast"],
        ["palette", "inter-agent-list"],
        ["palette", "inter-agent-status"],
        ["palette", "inter-agent-inbox"],
      ],
    );
    commands[0]?.run();
    const prompt = api.prompt as { onConfirm: (value: string) => void };
    assert.equal(typeof prompt.onConfirm, "function");
    prompt.onConfirm("agent-a --auto-connect");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(manager.controllers.get("session-a")?.status, "connected");
    await manager.dispose();
  } finally {
    if (previous.data === undefined) delete process.env.INTER_AGENT_DATA_DIR;
    else process.env.INTER_AGENT_DATA_DIR = previous.data;
    if (previous.secret === undefined) delete process.env.INTER_AGENT_SECRET;
    else process.env.INTER_AGENT_SECRET = previous.secret;
    if (previous.host === undefined) delete process.env.INTER_AGENT_HOST;
    else process.env.INTER_AGENT_HOST = previous.host;
    if (previous.port === undefined) delete process.env.INTER_AGENT_PORT;
    else process.env.INTER_AGENT_PORT = previous.port;
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("initial auth failure cleans the exact attempt data directory", async () => {
  const oldRoot = mkdtempSync(
    join(tmpdir(), "inter-agent-opencode-phase4-auth-old-"),
  );
  const newRoot = mkdtempSync(
    join(tmpdir(), "inter-agent-opencode-phase4-auth-new-"),
  );
  const workspace = mkdtempSync(
    join(tmpdir(), "inter-agent-opencode-phase4-auth-ws-"),
  );
  const previous = {
    data: process.env.INTER_AGENT_DATA_DIR,
    secret: process.env.INTER_AGENT_SECRET,
    host: process.env.INTER_AGENT_HOST,
    port: process.env.INTER_AGENT_PORT,
  };
  process.env.INTER_AGENT_DATA_DIR = oldRoot;
  process.env.INTER_AGENT_SECRET = "phase4-test-secret";
  process.env.INTER_AGENT_HOST = "127.0.0.1";
  process.env.INTER_AGENT_PORT = "16839";
  try {
    const api = fakeApi(workspace, new Map(), [], {
      failAuthAndChangeDataDir: newRoot,
    });
    const manager = new TuiManager(api as never);
    await assert.rejects(manager.connect("agent-a"), /authentication failed/);
    const oldResolution = resolveLease(oldRoot, {
      workspacePath: workspace,
      openCodeSessionID: "session-a",
    });
    assert.equal(oldResolution.present, false);
    assert.equal(existsSync(join(newRoot, "opencode")), false);
    assert.equal(manager.controllers.get("session-a")?.status, "disconnected");
    await manager.dispose();
  } finally {
    if (previous.data === undefined) delete process.env.INTER_AGENT_DATA_DIR;
    else process.env.INTER_AGENT_DATA_DIR = previous.data;
    if (previous.secret === undefined) delete process.env.INTER_AGENT_SECRET;
    else process.env.INTER_AGENT_SECRET = previous.secret;
    if (previous.host === undefined) delete process.env.INTER_AGENT_HOST;
    else process.env.INTER_AGENT_HOST = previous.host;
    if (previous.port === undefined) delete process.env.INTER_AGENT_PORT;
    else process.env.INTER_AGENT_PORT = previous.port;
    rmSync(oldRoot, { recursive: true, force: true });
    rmSync(newRoot, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("TUI manager isolates two sessions and records notifications", async () => {
  const root = mkdtempSync(join(tmpdir(), "inter-agent-opencode-phase4-tui-"));
  const workspace = mkdtempSync(
    join(tmpdir(), "inter-agent-opencode-phase4-ws-"),
  );
  const previous = {
    data: process.env.INTER_AGENT_DATA_DIR,
    secret: process.env.INTER_AGENT_SECRET,
    host: process.env.INTER_AGENT_HOST,
    port: process.env.INTER_AGENT_PORT,
  };
  process.env.INTER_AGENT_DATA_DIR = root;
  process.env.INTER_AGENT_SECRET = "phase4-test-secret";
  process.env.INTER_AGENT_HOST = "127.0.0.1";
  process.env.INTER_AGENT_PORT = "16839";
  const sockets = new Map<string, AgentSocket>();
  try {
    const api = fakeApi(workspace, sockets);
    const manager = new TuiManager(api as never);
    await manager.connect("agent-a");
    api.setSession("session-b");
    await manager.connect("agent-b");
    assert.equal(manager.controllers.size, 2);
    const first = [...sockets.values()][0];
    const second = [...sockets.values()][1];
    first?.emit({
      op: "msg",
      msg_id: "a-message",
      from: "peer",
      from_name: "peer-a",
      ts: new Date().toISOString(),
      to: "agent-a",
      text: "message for A",
    });
    first?.emit({
      op: "msg",
      msg_id: "a-message",
      from: "peer",
      from_name: "peer-a",
      ts: new Date().toISOString(),
      to: "agent-a",
      text: "duplicate",
    });
    first?.emit({
      op: "msg",
      msg_id: "long-message",
      from: "peer",
      from_name: "peer-a",
      ts: new Date().toISOString(),
      to: "agent-a",
      text: "x".repeat(400),
    });
    second?.emit({
      op: "msg",
      msg_id: "b-message",
      from: "peer",
      from_name: "peer-b",
      ts: new Date().toISOString(),
      to: "agent-b",
      text: "message for B",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const workspaceHash = workspaceKey(workspace);
    const inboxA = readInboxFile(root, workspaceHash, hashScope("session-a"));
    const inboxB = readInboxFile(root, workspaceHash, hashScope("session-b"));
    assert.deepEqual(
      inboxA.messages.map((message) => message.id),
      ["a-message", "long-message"],
    );
    assert.equal(api.notifications.length, 3);
    assert.equal(api.notifications[0]?.message, "message for A");
    assert.equal(api.notifications[2]?.message.length, 240);
    assert.deepEqual(
      inboxB.messages.map((message) => message.id),
      ["b-message"],
    );
    api.setSession("session-a");
    await manager.disconnect();
    assert.match(await manager.inbox("2"), /a-message/);
    assert.match(await manager.status(), /pending=0/);
    assert.match(await manager.status(), /inbox=2/);
    await manager.dispose();
    assert.equal(first?.closed, true);
    assert.equal(second?.closed, true);
  } finally {
    if (previous.data === undefined) delete process.env.INTER_AGENT_DATA_DIR;
    else process.env.INTER_AGENT_DATA_DIR = previous.data;
    if (previous.secret === undefined) delete process.env.INTER_AGENT_SECRET;
    else process.env.INTER_AGENT_SECRET = previous.secret;
    if (previous.host === undefined) delete process.env.INTER_AGENT_HOST;
    else process.env.INTER_AGENT_HOST = previous.host;
    if (previous.port === undefined) delete process.env.INTER_AGENT_PORT;
    else process.env.INTER_AGENT_PORT = previous.port;
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("successful reconnect refreshes only after post-auth validation", async () => {
  const root = mkdtempSync(
    join(tmpdir(), "inter-agent-opencode-phase4-success-ordering-"),
  );
  const workspace = mkdtempSync(
    join(tmpdir(), "inter-agent-opencode-phase4-success-ordering-ws-"),
  );
  const previous = {
    data: process.env.INTER_AGENT_DATA_DIR,
    secret: process.env.INTER_AGENT_SECRET,
    host: process.env.INTER_AGENT_HOST,
    port: process.env.INTER_AGENT_PORT,
  };
  process.env.INTER_AGENT_DATA_DIR = root;
  process.env.INTER_AGENT_SECRET = "phase4-test-secret";
  process.env.INTER_AGENT_HOST = "127.0.0.1";
  process.env.INTER_AGENT_PORT = "16839";
  const sockets = new Map<string, AgentSocket>();
  try {
    const api = fakeApi(workspace, sockets, [], { welcomeDelayMs: 30 });
    const manager = new TuiManager(api as never);
    await manager.connect("agent-a");
    const lease = manager.controllers.get("session-a")?.currentLease;
    assert(lease);
    const path = join(
      sessionDir(root, lease.workspaceHash, lease.sessionHash),
      "connection.json",
    );
    const before = readFileSync(path, "utf8");
    [...sockets.values()][0]?.close();
    const started = Date.now();
    while (
      (sockets.size < 2 ||
        manager.controllers.get("session-a")?.status !== "connected") &&
      Date.now() - started < 2_000
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(manager.controllers.get("session-a")?.status, "connected");
    assert.notEqual(readFileSync(path, "utf8"), before);
    await manager.dispose();
  } finally {
    if (previous.data === undefined) delete process.env.INTER_AGENT_DATA_DIR;
    else process.env.INTER_AGENT_DATA_DIR = previous.data;
    if (previous.secret === undefined) delete process.env.INTER_AGENT_SECRET;
    else process.env.INTER_AGENT_SECRET = previous.secret;
    if (previous.host === undefined) delete process.env.INTER_AGENT_HOST;
    else process.env.INTER_AGENT_HOST = previous.host;
    if (previous.port === undefined) delete process.env.INTER_AGENT_PORT;
    else process.env.INTER_AGENT_PORT = previous.port;
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("failed reconnect attempts do not extend a disconnected lease", async () => {
  const root = mkdtempSync(
    join(tmpdir(), "inter-agent-opencode-phase4-ordering-"),
  );
  const workspace = mkdtempSync(
    join(tmpdir(), "inter-agent-opencode-phase4-ordering-ws-"),
  );
  const previous = {
    data: process.env.INTER_AGENT_DATA_DIR,
    secret: process.env.INTER_AGENT_SECRET,
    host: process.env.INTER_AGENT_HOST,
    port: process.env.INTER_AGENT_PORT,
  };
  process.env.INTER_AGENT_DATA_DIR = root;
  process.env.INTER_AGENT_SECRET = "phase4-test-secret";
  process.env.INTER_AGENT_HOST = "127.0.0.1";
  process.env.INTER_AGENT_PORT = "16839";
  const sockets = new Map<string, AgentSocket>();
  try {
    const api = fakeApi(workspace, sockets, [], { closeAfterAuth: 2 });
    const manager = new TuiManager(api as never);
    await manager.connect("agent-a");
    const lease = manager.controllers.get("session-a")?.currentLease;
    assert(lease);
    const path = join(
      sessionDir(root, lease.workspaceHash, lease.sessionHash),
      "connection.json",
    );
    const before = readFileSync(path, "utf8");
    [...sockets.values()][0]?.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(manager.controllers.get("session-a")?.status, "reconnecting");
    assert.equal(readFileSync(path, "utf8"), before);
    await manager.dispose();
  } finally {
    if (previous.data === undefined) delete process.env.INTER_AGENT_DATA_DIR;
    else process.env.INTER_AGENT_DATA_DIR = previous.data;
    if (previous.secret === undefined) delete process.env.INTER_AGENT_SECRET;
    else process.env.INTER_AGENT_SECRET = previous.secret;
    if (previous.host === undefined) delete process.env.INTER_AGENT_HOST;
    else process.env.INTER_AGENT_HOST = previous.host;
    if (previous.port === undefined) delete process.env.INTER_AGENT_PORT;
    else process.env.INTER_AGENT_PORT = previous.port;
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("reconnect stops before opening a socket when a foreign lease takes over", async () => {
  const root = mkdtempSync(
    join(tmpdir(), "inter-agent-opencode-phase4-takeover-"),
  );
  const workspace = mkdtempSync(
    join(tmpdir(), "inter-agent-opencode-phase4-takeover-ws-"),
  );
  const previous = {
    data: process.env.INTER_AGENT_DATA_DIR,
    secret: process.env.INTER_AGENT_SECRET,
    host: process.env.INTER_AGENT_HOST,
    port: process.env.INTER_AGENT_PORT,
  };
  process.env.INTER_AGENT_DATA_DIR = root;
  process.env.INTER_AGENT_SECRET = "phase4-test-secret";
  process.env.INTER_AGENT_HOST = "127.0.0.1";
  process.env.INTER_AGENT_PORT = "16839";
  const sockets = new Map<string, AgentSocket>();
  try {
    const api = fakeApi(workspace, sockets);
    const manager = new TuiManager(api as never);
    await manager.connect("agent-a");
    const controller = manager.controllers.get("session-a");
    const oldLease = controller?.currentLease;
    assert(oldLease);
    const first = [...sockets.values()][0];
    first?.close();
    const foreignInput: LeaseClaimInput = {
      workspacePath: workspace,
      workspaceHash: workspaceKey(workspace),
      openCodeSessionID: "session-a",
      sessionHash: hashScope("session-a"),
      name: "foreign-agent",
      label: null,
      host: "127.0.0.1",
      port: 16839,
      tls: false,
    };
    releaseLeaseForTest(root, oldLease);
    const foreign = claimLease(root, foreignInput, Date.now());
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(sockets.size, 1);
    assert.equal(controller?.status, "stopped");
    await assert.rejects(
      manager.send("agent-b message"),
      /connect this OpenCode session first/,
    );
    assert.equal(resolveForeignOwner(root, foreign), foreign.ownerToken);
    await manager.disconnect();
    const preferences = readPreferences(
      root,
      foreign.workspaceHash,
      foreign.sessionHash,
      { workspacePath: workspace, openCodeSessionID: "session-a" },
    );
    assert.equal(preferences?.autoConnect, false);
    await manager.dispose();
  } finally {
    if (previous.data === undefined) delete process.env.INTER_AGENT_DATA_DIR;
    else process.env.INTER_AGENT_DATA_DIR = previous.data;
    if (previous.secret === undefined) delete process.env.INTER_AGENT_SECRET;
    else process.env.INTER_AGENT_SECRET = previous.secret;
    if (previous.host === undefined) delete process.env.INTER_AGENT_HOST;
    else process.env.INTER_AGENT_HOST = previous.host;
    if (previous.port === undefined) delete process.env.INTER_AGENT_PORT;
    else process.env.INTER_AGENT_PORT = previous.port;
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("reconnect reclaims an endpoint-changed lease before auth", async () => {
  const root = mkdtempSync(
    join(tmpdir(), "inter-agent-opencode-phase4-endpoint-"),
  );
  const workspace = mkdtempSync(
    join(tmpdir(), "inter-agent-opencode-phase4-endpoint-ws-"),
  );
  const previous = {
    data: process.env.INTER_AGENT_DATA_DIR,
    secret: process.env.INTER_AGENT_SECRET,
    host: process.env.INTER_AGENT_HOST,
    port: process.env.INTER_AGENT_PORT,
  };
  process.env.INTER_AGENT_DATA_DIR = root;
  process.env.INTER_AGENT_SECRET = "phase4-test-secret";
  process.env.INTER_AGENT_HOST = "127.0.0.1";
  process.env.INTER_AGENT_PORT = "16839";
  const sockets = new Map<string, AgentSocket>();
  const urls: string[] = [];
  try {
    const api = fakeApi(workspace, sockets, urls);
    const manager = new TuiManager(api as never);
    await manager.connect("agent-a");
    assert.equal(urls[0], "ws://127.0.0.1:16839");
    const first = [...sockets.values()][0];
    process.env.INTER_AGENT_PORT = "16840";
    first?.close();
    const started = Date.now();
    while (sockets.size < 2 && Date.now() - started < 2_000)
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(sockets.size >= 2, true);
    assert.equal(urls.at(-1), "ws://127.0.0.1:16840");
    const lease = resolveLease(root, {
      workspacePath: workspace,
      openCodeSessionID: "session-a",
    }).lease;
    assert.equal(lease?.port, 16840);
    assert.equal(lease?.name, "agent-a");
    assert.equal(manager.controllers.get("session-a")?.status, "connected");
    await manager.dispose();
  } finally {
    if (previous.data === undefined) delete process.env.INTER_AGENT_DATA_DIR;
    else process.env.INTER_AGENT_DATA_DIR = previous.data;
    if (previous.secret === undefined) delete process.env.INTER_AGENT_SECRET;
    else process.env.INTER_AGENT_SECRET = previous.secret;
    if (previous.host === undefined) delete process.env.INTER_AGENT_HOST;
    else process.env.INTER_AGENT_HOST = previous.host;
    if (previous.port === undefined) delete process.env.INTER_AGENT_PORT;
    else process.env.INTER_AGENT_PORT = previous.port;
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("reconnect auth failure cleans only its new data directory", async () => {
  const oldRoot = mkdtempSync(
    join(tmpdir(), "inter-agent-opencode-phase4-reconnect-old-"),
  );
  const newRoot = mkdtempSync(
    join(tmpdir(), "inter-agent-opencode-phase4-reconnect-new-"),
  );
  const workspace = mkdtempSync(
    join(tmpdir(), "inter-agent-opencode-phase4-reconnect-auth-ws-"),
  );
  const previous = {
    data: process.env.INTER_AGENT_DATA_DIR,
    secret: process.env.INTER_AGENT_SECRET,
    host: process.env.INTER_AGENT_HOST,
    port: process.env.INTER_AGENT_PORT,
  };
  process.env.INTER_AGENT_DATA_DIR = oldRoot;
  process.env.INTER_AGENT_SECRET = "phase4-test-secret";
  process.env.INTER_AGENT_HOST = "127.0.0.1";
  process.env.INTER_AGENT_PORT = "16839";
  const sockets = new Map<string, AgentSocket>();
  try {
    const api = fakeApi(workspace, sockets, [], {
      failAuthAndChangeDataDir: newRoot,
      failAfter: 2,
    });
    const manager = new TuiManager(api as never);
    await manager.connect("agent-a");
    const oldLease = manager.controllers.get("session-a")?.currentLease;
    assert(oldLease);
    process.env.INTER_AGENT_DATA_DIR = newRoot;
    const first = [...sockets.values()][0];
    first?.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(sockets.size, 2);
    assert.equal(manager.controllers.get("session-a")?.status, "stopped");
    assert.equal(
      resolveLease(oldRoot, {
        workspacePath: workspace,
        openCodeSessionID: "session-a",
      }).lease?.ownerToken,
      oldLease.ownerToken,
    );
    assert.equal(
      resolveLease(newRoot, {
        workspacePath: workspace,
        openCodeSessionID: "session-a",
      }).present,
      false,
    );
    await manager.dispose();
  } finally {
    if (previous.data === undefined) delete process.env.INTER_AGENT_DATA_DIR;
    else process.env.INTER_AGENT_DATA_DIR = previous.data;
    if (previous.secret === undefined) delete process.env.INTER_AGENT_SECRET;
    else process.env.INTER_AGENT_SECRET = previous.secret;
    if (previous.host === undefined) delete process.env.INTER_AGENT_HOST;
    else process.env.INTER_AGENT_HOST = previous.host;
    if (previous.port === undefined) delete process.env.INTER_AGENT_PORT;
    else process.env.INTER_AGENT_PORT = previous.port;
    rmSync(oldRoot, { recursive: true, force: true });
    rmSync(newRoot, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("post-auth owner loss closes the socket without connected state", async () => {
  const root = mkdtempSync(
    join(tmpdir(), "inter-agent-opencode-phase4-owner-loss-"),
  );
  const workspace = mkdtempSync(
    join(tmpdir(), "inter-agent-opencode-phase4-owner-loss-ws-"),
  );
  const previous = {
    data: process.env.INTER_AGENT_DATA_DIR,
    secret: process.env.INTER_AGENT_SECRET,
    host: process.env.INTER_AGENT_HOST,
    port: process.env.INTER_AGENT_PORT,
  };
  process.env.INTER_AGENT_DATA_DIR = root;
  process.env.INTER_AGENT_SECRET = "phase4-test-secret";
  process.env.INTER_AGENT_HOST = "127.0.0.1";
  process.env.INTER_AGENT_PORT = "16839";
  const sockets = new Map<string, AgentSocket>();
  try {
    const api = fakeApi(workspace, sockets, [], {
      ownerLoss: { dataDir: root, workspacePath: workspace, after: 2 },
    });
    const manager = new TuiManager(api as never);
    await manager.connect("agent-a");
    [...sockets.values()][0]?.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(sockets.size, 2);
    assert.equal(manager.controllers.get("session-a")?.status, "stopped");
    const foreign = resolveLease(root, {
      workspacePath: workspace,
      openCodeSessionID: "session-a",
    }).lease;
    assert.equal(foreign?.name, "foreign-agent");
    await manager.dispose();
  } finally {
    if (previous.data === undefined) delete process.env.INTER_AGENT_DATA_DIR;
    else process.env.INTER_AGENT_DATA_DIR = previous.data;
    if (previous.secret === undefined) delete process.env.INTER_AGENT_SECRET;
    else process.env.INTER_AGENT_SECRET = previous.secret;
    if (previous.host === undefined) delete process.env.INTER_AGENT_HOST;
    else process.env.INTER_AGENT_HOST = previous.host;
    if (previous.port === undefined) delete process.env.INTER_AGENT_PORT;
    else process.env.INTER_AGENT_PORT = previous.port;
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("TUI listener reconnects after a transient close", async () => {
  const root = mkdtempSync(
    join(tmpdir(), "inter-agent-opencode-phase4-reconnect-"),
  );
  const workspace = mkdtempSync(
    join(tmpdir(), "inter-agent-opencode-phase4-reconnect-ws-"),
  );
  const previous = {
    data: process.env.INTER_AGENT_DATA_DIR,
    secret: process.env.INTER_AGENT_SECRET,
    host: process.env.INTER_AGENT_HOST,
    port: process.env.INTER_AGENT_PORT,
  };
  process.env.INTER_AGENT_DATA_DIR = root;
  process.env.INTER_AGENT_SECRET = "phase4-test-secret";
  process.env.INTER_AGENT_HOST = "127.0.0.1";
  process.env.INTER_AGENT_PORT = "16839";
  const sockets = new Map<string, AgentSocket>();
  try {
    const api = fakeApi(workspace, sockets);
    const manager = new TuiManager(api as never);
    await manager.connect("agent-a");
    const oldLease = manager.controllers.get("session-a")?.currentLease;
    const first = [...sockets.values()][0];
    first?.close();
    if (oldLease)
      releaseLease(
        root,
        oldLease.workspaceHash,
        oldLease.sessionHash,
        oldLease.ownerToken,
      );
    const started = Date.now();
    while (sockets.size < 2 && Date.now() - started < 2_000)
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(sockets.size >= 2, true);
    assert.equal(manager.controllers.get("session-a")?.status, "connected");
    await manager.dispose();
  } finally {
    if (previous.data === undefined) delete process.env.INTER_AGENT_DATA_DIR;
    else process.env.INTER_AGENT_DATA_DIR = previous.data;
    if (previous.secret === undefined) delete process.env.INTER_AGENT_SECRET;
    else process.env.INTER_AGENT_SECRET = previous.secret;
    if (previous.host === undefined) delete process.env.INTER_AGENT_HOST;
    else process.env.INTER_AGENT_HOST = previous.host;
    if (previous.port === undefined) delete process.env.INTER_AGENT_PORT;
    else process.env.INTER_AGENT_PORT = previous.port;
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});
