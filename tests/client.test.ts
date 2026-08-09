import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import test from "node:test";
import assert from "node:assert/strict";
import {
  ControlConnection,
  type WebSocketFactory,
  type WebSocketLike,
} from "../src/client.js";
import {
  AuthenticationError,
  RemoteError,
  TimeoutError,
} from "../src/errors.js";
import {
  buildHello,
  serverProof,
  type ProtocolFrame,
} from "../src/protocol.js";
import type { EndpointResolution } from "../src/config.js";

class FakeSocket implements WebSocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  readonly sent: string[] = [];
  closed = false;
  private readonly onSend: (socket: FakeSocket, payload: ProtocolFrame) => void;

  constructor(
    onSend: (socket: FakeSocket, payload: ProtocolFrame) => void,
    open = true,
  ) {
    this.onSend = onSend;
    if (open) queueMicrotask(() => this.open());
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  send(data: string): void {
    this.sent.push(data);
    this.onSend(this, JSON.parse(data) as ProtocolFrame);
  }

  emit(payload: ProtocolFrame): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
}

function endpoint(
  overrides: Partial<EndpointResolution> = {},
): EndpointResolution {
  return {
    host: "127.0.0.1",
    port: 16839,
    dataDir: "/tmp/inter-agent-opencode-test-state",
    configPath: undefined,
    hostSource: "default",
    portSource: "default",
    dataDirSource: "default",
    tls: false,
    tlsSource: "default",
    scheme: "ws",
    tlsCertPath: "/tmp/inter-agent-opencode-test-state/tls-cert.pem",
    tlsCertSource: "default",
    supported: true,
    ...overrides,
  };
}

test("control handshake verifies the server proof before sending client proof", async () => {
  const secret = randomBytes(16).toString("base64url");
  let socket: FakeSocket | undefined;
  const factory: WebSocketFactory = () => {
    socket = new FakeSocket((current, payload) => {
      if (payload.op === "hello") {
        const hello = payload;
        const nonce = (hello.auth as { client_nonce: string }).client_nonce;
        current.emit({
          op: "auth_challenge",
          method: "hmac-sha256",
          server_nonce: "server-nonce",
          server_proof: serverProof("wrong-secret", {
            clientNonce: nonce,
            serverNonce: "server-nonce",
            hello,
          }),
        });
      }
    });
    return socket;
  };

  await assert.rejects(
    ControlConnection.open({
      endpoint: endpoint(),
      secret,
      websocketFactory: factory,
      connectTimeoutMs: 100,
    }),
    AuthenticationError,
  );
  assert(socket);
  assert.equal(socket.sent.length, 1);
  assert.equal(JSON.parse(socket.sent[0] ?? "{}").op, "hello");
  assert.equal(socket.closed, true);
});

test("handshake uses one total deadline across open, challenge, and welcome", async () => {
  const secret = randomBytes(16).toString("base64url");
  const factory: WebSocketFactory = () =>
    new FakeSocket((current, payload) => {
      if (payload.op === "hello") {
        const hello = payload;
        const nonce = (hello.auth as { client_nonce: string }).client_nonce;
        setTimeout(
          () =>
            current.emit({
              op: "auth_challenge",
              method: "hmac-sha256",
              server_nonce: "server-nonce",
              server_proof: serverProof(secret, {
                clientNonce: nonce,
                serverNonce: "server-nonce",
                hello,
              }),
            }),
          40,
        );
      } else if (payload.op === "auth_response") {
        setTimeout(
          () =>
            current.emit({
              op: "welcome",
              session_id: "control-session",
              assigned_name: "control",
              capabilities: {
                core: { version: "0.1" },
                channels: true,
                rate_limit: false,
              },
            }),
          40,
        );
      }
    });
  const started = performance.now();
  await assert.rejects(
    ControlConnection.open({
      endpoint: endpoint(),
      secret,
      websocketFactory: factory,
      connectTimeoutMs: 50,
    }),
    TimeoutError,
  );
  assert(performance.now() - started < 120);
});

test("control send, broadcast, and list use authenticated short-lived operations", async () => {
  const secret = randomBytes(16).toString("base64url");
  const sockets: FakeSocket[] = [];
  const factory: WebSocketFactory = () => {
    const socket = new FakeSocket((current, payload) => {
      if (payload.op === "hello") {
        const hello = payload;
        const nonce = (hello.auth as { client_nonce: string }).client_nonce;
        current.emit({
          op: "auth_challenge",
          method: "hmac-sha256",
          server_nonce: "server-nonce",
          server_proof: serverProof(secret, {
            clientNonce: nonce,
            serverNonce: "server-nonce",
            hello,
          }),
        });
        return;
      }
      if (payload.op === "auth_response") {
        current.emit({
          op: "welcome",
          session_id: "control-session",
          assigned_name: "control",
          capabilities: {
            core: { version: "0.1" },
            channels: true,
            rate_limit: false,
          },
        });
        return;
      }
      if (payload.op === "list") {
        current.emit({
          op: "list_ok",
          sessions: [
            { session_id: "agent-session", name: "agent-a", label: null },
          ],
        });
      }
    });
    sockets.push(socket);
    return socket;
  };

  const connection = await ControlConnection.open({
    endpoint: endpoint(),
    secret,
    websocketFactory: factory,
    sendErrorWindowMs: 10,
  });
  const listed = await connection.list();
  assert.equal(listed.sessions[0]?.name, "agent-a");
  const direct = await connection.sendDirect("agent-a", "hello", "sender-a");
  assert.equal(direct.error, undefined);
  const broadcast = await connection.broadcast("all", "sender-a");
  assert.equal(broadcast.error, undefined);
  const sentPayloads = sockets.flatMap((socket) =>
    socket.sent.map((raw) => JSON.parse(raw) as ProtocolFrame),
  );
  assert(
    sentPayloads.some(
      (payload) => payload.op === "send" && payload.from_name === "sender-a",
    ),
  );
  assert(
    sentPayloads.some(
      (payload) =>
        payload.op === "broadcast" && payload.from_name === "sender-a",
    ),
  );
  await connection.close();
  assert.equal(sockets[0]?.closed, true);
});

test("control operations preserve stable remote errors and redact the secret", async () => {
  const secret = randomBytes(16).toString("base64url");
  const factory: WebSocketFactory = () =>
    new FakeSocket((current, payload) => {
      if (payload.op === "hello") {
        const hello = payload;
        const nonce = (hello.auth as { client_nonce: string }).client_nonce;
        current.emit({
          op: "auth_challenge",
          method: "hmac-sha256",
          server_nonce: "server-nonce",
          server_proof: serverProof(secret, {
            clientNonce: nonce,
            serverNonce: "server-nonce",
            hello,
          }),
        });
      } else if (payload.op === "auth_response") {
        current.emit({
          op: "welcome",
          session_id: "control-session",
          assigned_name: "control",
          capabilities: {
            core: { version: "0.1" },
            channels: true,
            rate_limit: false,
          },
        });
      } else if (payload.op === "list") {
        current.emit({
          op: "error",
          code: "BAD_NAME",
          message: `bad ${secret}`,
        });
      }
    });

  const connection = await ControlConnection.open({
    endpoint: endpoint(),
    secret,
    websocketFactory: factory,
    operationTimeoutMs: 100,
  });
  await assert.rejects(connection.list(), (error: unknown) => {
    assert(error instanceof RemoteError);
    assert.equal(error.code, "BAD_NAME");
    assert(!String(error).includes(secret));
    return true;
  });
  await connection.close();
});

test("list deadline and unsupported endpoints fail closed without opening a socket", async () => {
  const secret = randomBytes(16).toString("base64url");
  let created = false;
  const factory: WebSocketFactory = () => {
    created = true;
    return new FakeSocket((current, payload) => {
      if (payload.op === "hello") {
        const hello = payload;
        const nonce = (hello.auth as { client_nonce: string }).client_nonce;
        current.emit({
          op: "auth_challenge",
          method: "hmac-sha256",
          server_nonce: "server-nonce",
          server_proof: serverProof(secret, {
            clientNonce: nonce,
            serverNonce: "server-nonce",
            hello,
          }),
        });
      } else if (payload.op === "auth_response") {
        current.emit({
          op: "welcome",
          session_id: "control-session",
          assigned_name: "control",
          capabilities: {
            core: { version: "0.1" },
            channels: true,
            rate_limit: false,
          },
        });
      }
    });
  };
  const connection = await ControlConnection.open({
    endpoint: endpoint(),
    secret,
    websocketFactory: factory,
    operationTimeoutMs: 10,
  });
  await assert.rejects(connection.list(), TimeoutError);
  await connection.close();
  assert.equal(created, true);

  await assert.rejects(
    ControlConnection.open({
      endpoint: endpoint({
        supported: false,
        unsupportedReason: "TLS is not supported",
      }),
      secret,
      websocketFactory: factory,
    }),
    /unsupported inter-agent endpoint/,
  );
});

test("invalid operation inputs are rejected before a message is sent", async () => {
  const secret = randomBytes(16).toString("base64url");
  let socket: FakeSocket | undefined;
  const factory: WebSocketFactory = () => {
    socket = new FakeSocket((current, payload) => {
      if (payload.op === "hello") {
        const hello = payload;
        const nonce = (hello.auth as { client_nonce: string }).client_nonce;
        current.emit({
          op: "auth_challenge",
          method: "hmac-sha256",
          server_nonce: "server-nonce",
          server_proof: serverProof(secret, {
            clientNonce: nonce,
            serverNonce: "server-nonce",
            hello,
          }),
        });
      } else if (payload.op === "auth_response") {
        current.emit({
          op: "welcome",
          session_id: "control-session",
          assigned_name: "control",
          capabilities: {
            core: { version: "0.1" },
            channels: true,
            rate_limit: false,
          },
        });
      }
    });
    return socket;
  };
  const connection = await ControlConnection.open({
    endpoint: endpoint(),
    secret,
    websocketFactory: factory,
  });
  const before = socket?.sent.length;
  await assert.rejects(
    connection.sendDirect("Bad Name", "text"),
    /invalid direct message target/,
  );
  assert.equal(socket?.sent.length, before);
  await connection.close();
});
