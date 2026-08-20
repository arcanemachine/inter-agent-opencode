import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import {
  endpointUri,
  type EndpointResolution,
  assertSupportedEndpoint,
  resolveEndpoint,
  resolveSecret,
} from "./config.js";
import {
  AuthenticationError,
  ConnectionError,
  ProtocolError,
  RemoteError,
  TimeoutError,
  InterAgentError,
} from "./errors.js";
import {
  buildAuthResponse,
  buildHello,
  decodeFrame,
  parseAuthChallenge,
  parseError,
  parseFrame,
  parseListOk,
  parseMessage,
  parseWelcome,
  validateName,
  validateText,
  verifyServerProof,
  DEFAULT_BROADCAST_TEXT_MAX,
  DEFAULT_DIRECT_TEXT_MAX,
  type BroadcastFrame,
  type Hello,
  type ListOkFrame,
  type ProtocolFrame,
  type SendFrame,
  type Welcome,
} from "./protocol.js";

export const HANDSHAKE_TIMEOUT_MS = 5_000;
export const LIST_TIMEOUT_MS = 2_000;
export const SEND_ERROR_WINDOW_MS = 250;

export type WebSocketMessageEvent = { data: unknown };
export type WebSocketCloseEvent = { code?: number; reason?: string };

export interface WebSocketLike {
  readonly readyState?: number;
  onopen: (() => void) | null;
  onmessage: ((event: WebSocketMessageEvent) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: WebSocketCloseEvent) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (
  url: string,
  tlsCertPath?: string,
) => WebSocketLike;

type WebSocketConstructor = new (
  url: string,
  options?: unknown,
) => WebSocketLike;

type BunRuntime = {
  readonly WebSocket?: unknown;
};

export type ClientOptions = {
  endpoint?: EndpointResolution;
  secret?: string;
  websocketFactory?: WebSocketFactory;
  connectTimeoutMs?: number;
  operationTimeoutMs?: number;
  sendErrorWindowMs?: number;
  signal?: AbortSignal;
};

export type ControlClientOptions = ClientOptions & { fromName?: string };

export type SendResult = {
  welcome: Welcome;
  error?: RemoteError;
};

export type AgentConnectionOptions = ClientOptions & {
  name: string;
  label?: string | null;
};

export function defaultWebSocketFactory(
  url: string,
  tlsCertPath?: string,
): WebSocketLike {
  const Constructor = globalThis.WebSocket as unknown as
    | WebSocketConstructor
    | undefined;
  if (typeof Constructor !== "function")
    throw new ConnectionError("native WebSocket is unavailable");
  if (!tlsCertPath) return new Constructor(url);

  const bun = (globalThis as unknown as { Bun?: BunRuntime }).Bun;
  if (!bun)
    throw new ConnectionError(
      "WSS requires native Bun WebSocket TLS trust support",
    );
  let certificate: Uint8Array;
  try {
    certificate = readFileSync(tlsCertPath);
  } catch {
    throw new ConnectionError("unable to read inter-agent TLS certificate");
  }
  try {
    return new Constructor(url, { tls: { ca: certificate } });
  } catch {
    throw new ConnectionError("unable to create inter-agent WSS WebSocket");
  }
}

class SocketSession {
  private readonly queue: string[] = [];
  private waiter:
    | { resolve: (value: string) => void; reject: (error: unknown) => void }
    | undefined;
  private failure: Error | undefined;
  private closed = false;

  constructor(private readonly socket: WebSocketLike) {
    socket.onmessage = (event) => {
      try {
        this.deliver(decodeFrame(event.data));
      } catch (error) {
        this.fail(
          error instanceof Error
            ? error
            : new ProtocolError("invalid websocket frame"),
        );
      }
    };
    socket.onerror = () =>
      this.fail(new ConnectionError("inter-agent WebSocket connection failed"));
    socket.onclose = () =>
      this.fail(new ConnectionError("inter-agent WebSocket connection closed"));
  }

  private deliver(data: string): void {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.resolve(data);
    } else {
      this.queue.push(data);
    }
  }

  private fail(error: Error): void {
    if (this.closed || this.failure) return;
    this.failure = error;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.reject(error);
  }

  async waitOpen(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (this.socket.readyState === 1) return;
    await waitForEvent<void>(
      (resolve, reject) => {
        const previousOpen = this.socket.onopen;
        const previousClose = this.socket.onclose;
        const previousError = this.socket.onerror;
        this.socket.onopen = () => {
          previousOpen?.();
          resolve();
        };
        this.socket.onclose = (event) => {
          previousClose?.(event);
          reject(
            new ConnectionError(
              "inter-agent WebSocket closed before authentication",
            ),
          );
        };
        this.socket.onerror = (event) => {
          previousError?.(event);
          reject(
            new ConnectionError(
              "inter-agent WebSocket failed before authentication",
            ),
          );
        };
      },
      timeoutMs,
      signal,
      "inter-agent WebSocket connection timed out",
    );
  }

  send(data: string): void {
    try {
      this.socket.send(data);
    } catch {
      throw new ConnectionError("inter-agent WebSocket send failed");
    }
  }

  async receive(timeoutMs: number, signal?: AbortSignal): Promise<string> {
    if (this.failure) throw this.failure;
    const queued = this.queue.shift();
    if (queued !== undefined) return queued;
    return waitForEvent<string>(
      (resolve, reject) => {
        this.waiter = { resolve, reject };
      },
      timeoutMs,
      signal,
      "inter-agent operation timed out",
    ).catch((error) => {
      this.waiter = undefined;
      throw error;
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.reject(new ConnectionError("inter-agent WebSocket closed"));
    this.socket.onmessage = null;
    this.socket.onopen = null;
    this.socket.onerror = null;
    this.socket.onclose = null;
    try {
      this.socket.close();
    } catch {
      // Closing an already closed socket is harmless.
    }
  }
}

function waitForEvent<T>(
  install: (
    resolve: (value: T) => void,
    reject: (error: unknown) => void,
  ) => void,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  timeoutMessage: string,
): Promise<T> {
  if (signal?.aborted)
    return Promise.reject(
      new InterAgentError("operation aborted", "AbortError", true),
    );
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new TimeoutError(timeoutMessage));
    }, timeoutMs);
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new InterAgentError("operation aborted", "AbortError", true));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    signal?.addEventListener("abort", abort, { once: true });
    install(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

function safeRemoteError(frame: ProtocolFrame, secret: string): RemoteError {
  const parsed = parseError(frame);
  return new RemoteError(parsed.code, parsed.message, secret);
}

function parseOperationError(
  raw: string,
  secret: string,
): RemoteError | undefined {
  const frame = parseFrame(raw);
  if (frame.op !== "error") return undefined;
  return safeRemoteError(frame, secret);
}

export class AgentConnection {
  private constructor(
    private readonly session: SocketSession,
    readonly welcome: Welcome,
    private readonly secret: string,
    private readonly signal?: AbortSignal,
  ) {}

  static async open(options: AgentConnectionOptions): Promise<AgentConnection> {
    const endpoint = options.endpoint ?? (await resolveEndpoint());
    assertSupportedEndpoint(endpoint);
    const secret = options.secret ?? resolveSecret().secret;
    const factory = options.websocketFactory ?? defaultWebSocketFactory;
    const connectTimeoutMs = options.connectTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
    const deadline = performance.now() + connectTimeoutMs;
    const socket = createSocket(factory, endpoint);
    const session = new SocketSession(socket);
    try {
      await session.waitOpen(remainingDeadline(deadline), options.signal);
      const hello = buildHello({
        role: "agent",
        sessionId: randomUUID(),
        name: options.name,
        label: options.label ?? null,
        capabilities: {},
      });
      const clientNonce = hello.auth.client_nonce;
      session.send(JSON.stringify(hello));
      const challengeFrame = parseFrame(
        await session.receive(remainingDeadline(deadline), options.signal),
      );
      if (challengeFrame.op === "error")
        throw safeRemoteError(challengeFrame, secret);
      const challenge = parseAuthChallenge(challengeFrame);
      if (
        !verifyServerProof(challenge.server_proof, secret, {
          clientNonce,
          serverNonce: challenge.server_nonce,
          hello,
        })
      )
        throw new AuthenticationError();
      session.send(
        JSON.stringify(
          buildAuthResponse(secret, {
            clientNonce,
            serverNonce: challenge.server_nonce,
            hello,
          }),
        ),
      );
      const welcomeFrame = parseFrame(
        await session.receive(remainingDeadline(deadline), options.signal),
      );
      if (welcomeFrame.op === "error")
        throw safeRemoteError(welcomeFrame, secret);
      const welcome = parseWelcome(welcomeFrame);
      return new AgentConnection(session, welcome, secret, options.signal);
    } catch (error) {
      session.close();
      if (error instanceof InterAgentError) throw error;
      throw new ConnectionError("inter-agent authentication failed");
    }
  }

  async receive(
    timeoutMs = HANDSHAKE_TIMEOUT_MS * 12,
  ): Promise<import("./protocol.js").Message> {
    const frame = parseFrame(
      await this.session.receive(timeoutMs, this.signal),
    );
    if (frame.op === "error") throw safeRemoteError(frame, this.secret);
    return parseMessage(frame);
  }

  async close(): Promise<void> {
    this.session.close();
  }
}

export class ControlConnection {
  private constructor(
    private readonly session: SocketSession,
    readonly welcome: Welcome,
    private readonly secret: string,
    private readonly operationTimeoutMs: number,
    private readonly sendErrorWindowMs: number,
    private readonly signal?: AbortSignal,
  ) {}

  static async open(options: ClientOptions = {}): Promise<ControlConnection> {
    const endpoint = options.endpoint ?? (await resolveEndpoint());
    assertSupportedEndpoint(endpoint);
    const secret = options.secret ?? resolveSecret().secret;
    const factory = options.websocketFactory ?? defaultWebSocketFactory;
    const connectTimeoutMs = options.connectTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
    const deadline = performance.now() + connectTimeoutMs;
    const socket = createSocket(factory, endpoint);
    const session = new SocketSession(socket);
    try {
      await session.waitOpen(remainingDeadline(deadline), options.signal);
      const hello = buildHello({
        role: "control",
        sessionId: randomUUID(),
        name: "control",
        label: null,
        capabilities: {},
      });
      const clientNonce = hello.auth.client_nonce;
      session.send(JSON.stringify(hello));
      const challengeFrame = parseFrame(
        await session.receive(remainingDeadline(deadline), options.signal),
      );
      if (challengeFrame.op === "error")
        throw safeRemoteError(challengeFrame, secret);
      const challenge = parseAuthChallenge(challengeFrame);
      if (
        !verifyServerProof(challenge.server_proof, secret, {
          clientNonce,
          serverNonce: challenge.server_nonce,
          hello,
        })
      ) {
        throw new AuthenticationError();
      }
      session.send(
        JSON.stringify(
          buildAuthResponse(secret, {
            clientNonce,
            serverNonce: challenge.server_nonce,
            hello,
          }),
        ),
      );
      const welcomeFrame = parseFrame(
        await session.receive(remainingDeadline(deadline), options.signal),
      );
      if (welcomeFrame.op === "error")
        throw safeRemoteError(welcomeFrame, secret);
      const welcome = parseWelcome(welcomeFrame);
      return new ControlConnection(
        session,
        welcome,
        secret,
        options.operationTimeoutMs ?? LIST_TIMEOUT_MS,
        options.sendErrorWindowMs ?? SEND_ERROR_WINDOW_MS,
        options.signal,
      );
    } catch (error) {
      session.close();
      if (error instanceof InterAgentError) throw error;
      throw new ConnectionError("inter-agent authentication failed");
    }
  }

  async sendDirect(
    to: string,
    text: string,
    fromName?: string,
  ): Promise<SendResult> {
    if (!validateName(to))
      throw new ProtocolError("invalid direct message target", "BAD_NAME");
    if (!validateText(text, DEFAULT_DIRECT_TEXT_MAX))
      throw new ProtocolError(
        "direct message text is too large",
        "TEXT_TOO_LARGE",
      );
    if (fromName !== undefined && !validateName(fromName))
      throw new ProtocolError("invalid from_name", "BAD_FROM_NAME");
    const payload: SendFrame = { op: "send", to, text };
    if (fromName !== undefined) payload.from_name = fromName;
    return this.sendAndObserve(payload);
  }

  async broadcast(text: string, fromName?: string): Promise<SendResult> {
    if (!validateText(text, DEFAULT_BROADCAST_TEXT_MAX))
      throw new ProtocolError("broadcast text is too large", "TEXT_TOO_LARGE");
    if (fromName !== undefined && !validateName(fromName))
      throw new ProtocolError("invalid from_name", "BAD_FROM_NAME");
    const payload: BroadcastFrame = { op: "broadcast", text };
    if (fromName !== undefined) payload.from_name = fromName;
    return this.sendAndObserve(payload);
  }

  async list(): Promise<ListOkFrame> {
    this.session.send(JSON.stringify({ op: "list" }));
    const frame = parseFrame(
      await this.session.receive(this.operationTimeoutMs, this.signal),
    );
    if (frame.op === "error") throw safeRemoteError(frame, this.secret);
    return parseListOk(frame);
  }

  async close(): Promise<void> {
    this.session.close();
  }

  private async sendAndObserve(
    payload: SendFrame | BroadcastFrame,
  ): Promise<SendResult> {
    this.session.send(JSON.stringify(payload));
    try {
      const raw = await this.session.receive(
        this.sendErrorWindowMs,
        this.signal,
      );
      const error = parseOperationError(raw, this.secret);
      if (error) throw error;
      throw new ProtocolError("unexpected response after message send");
    } catch (error) {
      if (error instanceof TimeoutError) return { welcome: this.welcome };
      throw error;
    }
  }
}

function remainingDeadline(deadline: number): number {
  const remaining = Math.ceil(deadline - performance.now());
  if (remaining <= 0)
    throw new TimeoutError("inter-agent WebSocket connection timed out");
  return remaining;
}

function createSocket(
  factory: WebSocketFactory,
  endpoint: EndpointResolution,
): WebSocketLike {
  try {
    return factory(
      endpointUri(endpoint),
      endpoint.tls ? endpoint.tlsCertPath : undefined,
    );
  } catch (error) {
    if (error instanceof InterAgentError) throw error;
    throw new ConnectionError("unable to create inter-agent WebSocket");
  }
}

export async function sendDirect(
  to: string,
  text: string,
  fromName?: string,
  options: ClientOptions = {},
): Promise<SendResult> {
  const connection = await ControlConnection.open(options);
  try {
    return await connection.sendDirect(to, text, fromName);
  } finally {
    await connection.close();
  }
}

export async function broadcast(
  text: string,
  fromName?: string,
  options: ClientOptions = {},
): Promise<SendResult> {
  const connection = await ControlConnection.open(options);
  try {
    return await connection.broadcast(text, fromName);
  } finally {
    await connection.close();
  }
}

export async function listSessions(
  options: ClientOptions = {},
): Promise<ListOkFrame> {
  const connection = await ControlConnection.open(options);
  try {
    return await connection.list();
  } finally {
    await connection.close();
  }
}

export function websocketUrl(endpoint: EndpointResolution): string {
  return endpointUri(endpoint);
}
