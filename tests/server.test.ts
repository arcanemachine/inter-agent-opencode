import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import server, { createServerTools } from "../src/server.js";
import type { ProtocolFrame } from "../src/protocol.js";
import { serverProof } from "../src/protocol.js";
import type { WebSocketFactory, WebSocketLike } from "../src/client.js";
import { claimLease, hashScope, workspaceKey } from "../src/state.js";
import { recordMessage } from "../src/inbox.js";

class ToolSocket implements WebSocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;

  constructor(
    private readonly onSend: (socket: ToolSocket, frame: ProtocolFrame) => void,
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
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
}

function context(sessionID: string, workspace: string) {
  return {
    sessionID,
    messageID: `message-${sessionID}`,
    agent: "default",
    directory: workspace,
    worktree: workspace,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

function parseOutput(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  const output = (value as { output?: unknown }).output;
  if (typeof output !== "string") throw new Error("tool output missing");
  return JSON.parse(output) as Record<string, unknown>;
}

function claim(
  dataDir: string,
  workspace: string,
  sessionID: string,
  name: string,
): void {
  const workspaceHash = workspaceKey(workspace);
  claimLease(dataDir, {
    workspacePath: workspace,
    workspaceHash,
    openCodeSessionID: sessionID,
    sessionHash: hashScope(sessionID),
    name,
    label: null,
    host: "127.0.0.1",
    port: 16839,
    tls: false,
  });
}

test("server plugin exposes exactly the five Phase 5 tools", async () => {
  const hooks = await server.server({} as never);
  assert.deepEqual(Object.keys(hooks.tool ?? {}).sort(), [
    "inter_agent_broadcast",
    "inter_agent_list",
    "inter_agent_read_messages",
    "inter_agent_send",
    "inter_agent_status",
  ]);
  const tools = createServerTools();
  assert.equal(Object.keys(tools).length, 5);
  assert.match(
    tools.inter_agent_broadcast.description,
    /everyone only when explicitly requested/,
  );
});

test("server tools preserve exact session identities and inbox scope", async () => {
  const dataDir = mkdtempSync(
    join(tmpdir(), "inter-agent-opencode-phase5-server-"),
  );
  const workspace = mkdtempSync(
    join(tmpdir(), "inter-agent-opencode-phase5-server-ws-"),
  );
  const previous = {
    data: process.env.INTER_AGENT_DATA_DIR,
    host: process.env.INTER_AGENT_HOST,
    port: process.env.INTER_AGENT_PORT,
    secret: process.env.INTER_AGENT_SECRET,
  };
  process.env.INTER_AGENT_DATA_DIR = dataDir;
  process.env.INTER_AGENT_HOST = "127.0.0.1";
  process.env.INTER_AGENT_PORT = "16839";
  process.env.INTER_AGENT_SECRET = "phase5-test-secret";
  const sent: ProtocolFrame[] = [];
  const factory: WebSocketFactory = (url) => {
    assert.equal(url, "ws://127.0.0.1:16839");
    return new ToolSocket((socket, frame) => {
      if (frame.op === "hello") {
        const nonce = (frame.auth as { client_nonce: string }).client_nonce;
        socket.emit({
          op: "auth_challenge",
          method: "hmac-sha256",
          server_nonce: "server",
          server_proof: serverProof("phase5-test-secret", {
            clientNonce: nonce,
            serverNonce: "server",
            hello: frame,
          }),
        });
      } else if (frame.op === "auth_response") {
        socket.emit({
          op: "welcome",
          session_id: "control-session",
          assigned_name: "control",
          capabilities: {
            core: { version: "0.1" },
            channels: true,
            rate_limit: false,
          },
        });
      } else if (frame.op === "send" || frame.op === "broadcast") {
        sent.push(frame);
      } else if (frame.op === "list") {
        socket.emit({
          op: "list_ok",
          sessions: [
            { session_id: "session-a", name: "agent-a", label: null },
            { session_id: "session-b", name: "agent-b", label: null },
          ],
        });
      }
    });
  };
  const tools = createServerTools({ websocketFactory: factory });
  const a = context("session-a", workspace);
  const b = context("session-b", workspace);
  const alias = join(dataDir, "workspace-alias");
  symlinkSync(workspace, alias, "dir");
  const aliasA = { ...a, directory: alias, worktree: alias };
  try {
    claim(dataDir, workspace, "session-a", "agent-a");
    claim(dataDir, workspace, "session-b", "agent-b");
    recordMessage(dataDir, workspaceKey(workspace), hashScope("session-a"), {
      id: "message-a",
      receivedAt: new Date().toISOString(),
      from: "peer-a",
      fromName: "peer-a",
      kind: "direct",
      to: "agent-a",
      text: "for A",
      notificationTruncated: false,
    });
    recordMessage(dataDir, workspaceKey(workspace), hashScope("session-b"), {
      id: "message-b",
      receivedAt: new Date().toISOString(),
      from: "peer-b",
      fromName: "peer-b",
      kind: "direct",
      to: "agent-b",
      text: "for B",
      notificationTruncated: false,
    });

    const send = await tools.inter_agent_send.execute(
      { to: "peer-a", text: "from A" },
      a,
    );
    const broadcast = await tools.inter_agent_broadcast.execute(
      { text: "from B" },
      b,
    );
    assert.deepEqual(parseOutput(send), {
      sent: true,
      to: "peer-a",
      from_name: "agent-a",
    });
    assert.deepEqual(parseOutput(broadcast), {
      sent: true,
      from_name: "agent-b",
    });
    assert.equal(sent[0]?.op, "send");
    assert.equal((sent[0] as { from_name?: string }).from_name, "agent-a");
    assert.equal(sent[1]?.op, "broadcast");
    assert.equal((sent[1] as { from_name?: string }).from_name, "agent-b");

    const inboxA = parseOutput(
      await tools.inter_agent_read_messages.execute({ count: 1 }, a),
    );
    const inboxB = parseOutput(
      await tools.inter_agent_read_messages.execute({}, b),
    );
    assert.equal(
      (inboxA.messages as Array<{ text: string }>)[0]?.text,
      "for A",
    );
    assert.equal(
      (inboxB.messages as Array<{ text: string }>)[0]?.text,
      "for B",
    );
    const inboxAlias = parseOutput(
      await tools.inter_agent_read_messages.execute({}, aliasA),
    );
    assert.equal(
      (inboxAlias.messages as Array<{ text: string }>)[0]?.text,
      "for A",
    );
    const aliasSend = await tools.inter_agent_send.execute(
      { to: "peer-a", text: "from alias A" },
      aliasA,
    );
    assert.equal(
      (aliasSend as { output: string }).output.includes("agent-a"),
      true,
    );
    assert.equal(sent[2]?.op, "send");
    assert.equal((sent[2] as { from_name?: string }).from_name, "agent-a");

    const status = parseOutput(await tools.inter_agent_status.execute({}, a));
    assert.equal(status.session, "connected");
    assert.equal(status.name, "agent-a");
    const listed = parseOutput(await tools.inter_agent_list.execute({}, a));
    assert.equal((listed.sessions as unknown[]).length, 2);
  } finally {
    if (previous.data === undefined) delete process.env.INTER_AGENT_DATA_DIR;
    else process.env.INTER_AGENT_DATA_DIR = previous.data;
    if (previous.host === undefined) delete process.env.INTER_AGENT_HOST;
    else process.env.INTER_AGENT_HOST = previous.host;
    if (previous.port === undefined) delete process.env.INTER_AGENT_PORT;
    else process.env.INTER_AGENT_PORT = previous.port;
    if (previous.secret === undefined) delete process.env.INTER_AGENT_SECRET;
    else process.env.INTER_AGENT_SECRET = previous.secret;
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("disconnected server tools cannot borrow another session and reject bad counts", async () => {
  const dataDir = mkdtempSync(
    join(tmpdir(), "inter-agent-opencode-phase5-disconnected-"),
  );
  const workspace = mkdtempSync(
    join(tmpdir(), "inter-agent-opencode-phase5-disconnected-ws-"),
  );
  const unrelated = mkdtempSync(
    join(tmpdir(), "inter-agent-opencode-phase5-unrelated-ws-"),
  );
  const previous = {
    data: process.env.INTER_AGENT_DATA_DIR,
    host: process.env.INTER_AGENT_HOST,
    port: process.env.INTER_AGENT_PORT,
    secret: process.env.INTER_AGENT_SECRET,
  };
  process.env.INTER_AGENT_DATA_DIR = dataDir;
  process.env.INTER_AGENT_HOST = "127.0.0.1";
  process.env.INTER_AGENT_PORT = "16839";
  process.env.INTER_AGENT_SECRET = "phase5-test-secret";
  const sent: ProtocolFrame[] = [];
  const tools = createServerTools({
    websocketFactory: (url) => {
      assert.equal(url, "ws://127.0.0.1:16839");
      return new ToolSocket((socket, frame) => {
        sent.push(frame);
        if (frame.op === "hello") {
          const nonce = (frame.auth as { client_nonce: string }).client_nonce;
          socket.emit({
            op: "auth_challenge",
            method: "hmac-sha256",
            server_nonce: "server",
            server_proof: serverProof("phase5-test-secret", {
              clientNonce: nonce,
              serverNonce: "server",
              hello: frame,
            }),
          });
        } else if (frame.op === "auth_response") {
          socket.emit({
            op: "welcome",
            session_id: "control-session",
            assigned_name: "control",
            capabilities: {
              core: { version: "0.1" },
              channels: true,
              rate_limit: false,
            },
          });
        } else if (frame.op === "list") {
          socket.emit({ op: "list_ok", sessions: [] });
        }
      });
    },
  });
  try {
    claim(dataDir, workspace, "session-b", "agent-b");
    await assert.rejects(
      tools.inter_agent_send.execute(
        { to: "agent-b", text: "must not transmit" },
        context("session-a", workspace),
      ),
      /disconnected or unavailable/,
    );
    await assert.rejects(
      tools.inter_agent_send.execute(
        { to: "agent-b", text: "wrong scope" },
        context("session-b", unrelated),
      ),
      /disconnected or unavailable/,
    );
    await assert.rejects(
      tools.inter_agent_broadcast.execute(
        { text: "must not transmit" },
        context("session-a", workspace),
      ),
      /disconnected or unavailable/,
    );
    assert.equal(sent.length, 0);
    for (const count of [0, 101, 1.5, "1", null]) {
      await assert.rejects(
        tools.inter_agent_read_messages.execute(
          { count } as never,
          context("session-a", workspace),
        ),
        /count must be an integer between 1 and 100/,
      );
    }
    const status = parseOutput(
      await tools.inter_agent_status.execute(
        {},
        context("session-a", workspace),
      ),
    );
    assert.equal(status.session, "disconnected");
    assert.equal(status.name, null);
  } finally {
    if (previous.data === undefined) delete process.env.INTER_AGENT_DATA_DIR;
    else process.env.INTER_AGENT_DATA_DIR = previous.data;
    if (previous.host === undefined) delete process.env.INTER_AGENT_HOST;
    else process.env.INTER_AGENT_HOST = previous.host;
    if (previous.port === undefined) delete process.env.INTER_AGENT_PORT;
    else process.env.INTER_AGENT_PORT = previous.port;
    if (previous.secret === undefined) delete process.env.INTER_AGENT_SECRET;
    else process.env.INTER_AGENT_SECRET = previous.secret;
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
    rmSync(unrelated, { recursive: true, force: true });
  }
});
