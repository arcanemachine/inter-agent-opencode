import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { ControlConnection } from "../src/client.js";
import { AuthenticationError } from "../src/errors.js";
import { endpointUri, type EndpointResolution } from "../src/config.js";
import {
  buildAuthResponse,
  buildHello,
  parseAuthChallenge,
  parseFrame,
  parseMessage,
  parseWelcome,
  verifyServerProof,
  type Message,
  type ProtocolFrame,
} from "../src/protocol.js";

const coreRoot =
  process.env.INTER_AGENT_CORE_ROOT ??
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../inter-agent-core");
const coreServerScript =
  "import asyncio, os\nfrom inter_agent.core.server import run_server\nasyncio.run(run_server(os.environ['INTER_AGENT_HOST'], int(os.environ['INTER_AGENT_PORT'])))";

type AgentSocket = WebSocket & {
  onmessage: ((event: MessageEvent<string>) => void) | null;
};

function freshEndpoint(port: number): EndpointResolution {
  return {
    host: "127.0.0.1",
    port,
    dataDir: "/tmp/inter-agent-opencode-phase2-live-state",
    configPath: undefined,
    hostSource: "default",
    portSource: "env",
    dataDirSource: "default",
    tls: false,
    tlsSource: "default",
    scheme: "ws",
    tlsCertPath: "/tmp/inter-agent-opencode-phase2-live-state/tls-cert.pem",
    tlsCertSource: "default",
    supported: true,
  };
}

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
      throw new Error(
        "isolated Core server exited before accepting connections",
      );
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

function waitForSocketOpen(
  socket: WebSocket,
  timeoutMs = 2_000,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(
      () => reject(new Error("agent WebSocket open timeout")),
      timeoutMs,
    );
    socket.onopen = () => {
      clearTimeout(timer);
      resolvePromise();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("agent WebSocket open failed"));
    };
  });
}

function receiveSocket(
  socket: WebSocket,
  timeoutMs = 2_000,
): Promise<ProtocolFrame> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(
      () => reject(new Error("agent WebSocket receive timeout")),
      timeoutMs,
    );
    socket.onmessage = (event) => {
      clearTimeout(timer);
      try {
        resolvePromise(parseFrame(event.data));
      } catch (error) {
        reject(error);
      }
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("agent WebSocket receive failed"));
    };
  });
}

async function connectAgent(
  endpoint: EndpointResolution,
  secret: string,
): Promise<{ socket: AgentSocket; welcome: ReturnType<typeof parseWelcome> }> {
  const socket = new WebSocket(endpointUri(endpoint)) as AgentSocket;
  await waitForSocketOpen(socket);
  const hello = buildHello({
    role: "agent",
    sessionId: randomUUID(),
    name: "agent-target",
    label: null,
    capabilities: {},
  });
  socket.send(JSON.stringify(hello));
  const challenge = parseAuthChallenge(await receiveSocket(socket));
  assert.equal(
    verifyServerProof(challenge.server_proof, secret, {
      clientNonce: hello.auth.client_nonce,
      serverNonce: challenge.server_nonce,
      hello,
    }),
    true,
  );
  socket.send(
    JSON.stringify(
      buildAuthResponse(secret, {
        clientNonce: hello.auth.client_nonce,
        serverNonce: challenge.server_nonce,
        hello,
      }),
    ),
  );
  const welcome = parseWelcome(await receiveSocket(socket));
  return { socket, welcome };
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

test("control handshake, direct send, broadcast, and list interoperate with isolated Core", async () => {
  const root = mkdtempSync(join(tmpdir(), "inter-agent-opencode-phase2-live-"));
  const state = join(root, "state");
  const config = join(root, "missing-config.json");
  const port = await unusedPort();
  const secret = randomBytes(32).toString("base64url");
  const server = spawn(
    "uv",
    ["run", "--project", coreRoot, "python", "-c", coreServerScript],
    {
      cwd: coreRoot,
      env: {
        ...process.env,
        INTER_AGENT_CONFIG: config,
        INTER_AGENT_DATA_DIR: state,
        INTER_AGENT_HOST: "127.0.0.1",
        INTER_AGENT_PORT: String(port),
        INTER_AGENT_SECRET: secret,
        PYTHONUNBUFFERED: "1",
      },
      stdio: "pipe",
    },
  );
  let agent:
    | { socket: AgentSocket; welcome: ReturnType<typeof parseWelcome> }
    | undefined;
  let control: ControlConnection | undefined;
  try {
    await waitForPort(port, server);
    const endpoint = freshEndpoint(port);
    agent = await connectAgent(endpoint, secret);
    control = await ControlConnection.open({
      endpoint,
      secret,
      connectTimeoutMs: 2_000,
      operationTimeoutMs: 2_000,
      sendErrorWindowMs: 250,
    });
    assert.equal(agent.welcome.assigned_name, "agent-target");
    const listed = await control.list();
    assert.deepEqual(
      listed.sessions.map((session) => session.name),
      ["agent-target"],
    );

    const directFrame = receiveSocket(agent.socket);
    await control.sendDirect("agent-target", "direct message", "sender-a");
    const direct = parseMessage(await directFrame);
    assert.equal(direct.text, "direct message");
    assert.equal(direct.from_name, "sender-a");
    assert.equal(direct.to, "agent-target");

    const broadcastFrame = receiveSocket(agent.socket);
    await control.broadcast("broadcast message", "sender-a");
    const broadcast = parseMessage(await broadcastFrame);
    assert.equal(broadcast.text, "broadcast message");
    assert.equal(broadcast.from_name, "sender-a");
    assert.equal(broadcast.to ?? null, null);

    await assert.rejects(
      ControlConnection.open({
        endpoint,
        secret: `${secret}-wrong`,
        connectTimeoutMs: 2_000,
      }),
      AuthenticationError,
    );
  } finally {
    agent?.socket.close();
    await control?.close();
    await stopProcess(server);
    rmSync(root, { recursive: true, force: true });
  }
});
