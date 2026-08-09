import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { TextDecoder } from "node:util";
import {
  ProtocolError,
  isProtocolErrorCode,
  type ProtocolErrorCode,
} from "./errors.js";

export const AUTH_METHOD = "hmac-sha256";
export const SERVER_PROOF_DOMAIN = "inter-agent/server-proof/v1";
export const CLIENT_PROOF_DOMAIN = "inter-agent/client-proof/v1";
export const DEFAULT_DIRECT_TEXT_MAX = 2 * 1024 * 1024;
export const DEFAULT_BROADCAST_TEXT_MAX = 512 * 1024;

export type JsonObject = Record<string, unknown>;
export type ProtocolFrame = JsonObject & { op: string };

export type Hello = ProtocolFrame & {
  op: "hello";
  auth: { method: typeof AUTH_METHOD; client_nonce: string };
  role: "agent" | "control";
  session_id: string;
  name?: string;
  label: string | null;
  capabilities: JsonObject;
};

export type AuthChallenge = ProtocolFrame & {
  op: "auth_challenge";
  method: typeof AUTH_METHOD;
  server_nonce: string;
  server_proof: string;
};

export type AuthResponse = ProtocolFrame & {
  op: "auth_response";
  client_proof: string;
};

export type Welcome = ProtocolFrame & {
  op: "welcome";
  session_id: string;
  assigned_name: string;
  capabilities: JsonObject;
};

export type Message = ProtocolFrame & {
  op: "msg";
  msg_id: string;
  from: string;
  from_name: string;
  ts: string;
  to?: string | null;
  channel?: string;
  text?: string;
  custom_type?: string;
  payload?: unknown;
};

export type ProtocolErrorFrame = ProtocolFrame & {
  op: "error";
  code: ProtocolErrorCode;
  message: string;
};

export type SendFrame = ProtocolFrame & {
  op: "send";
  to: string;
  text: string;
  from_name?: string;
};
export type BroadcastFrame = ProtocolFrame & {
  op: "broadcast";
  text: string;
  from_name?: string;
};
export type ListFrame = ProtocolFrame & { op: "list" };
export type SessionInfo = {
  session_id: string;
  name: string;
  label: string | null;
};
export type ListOkFrame = ProtocolFrame & {
  op: "list_ok";
  sessions: SessionInfo[];
};

const decoder = new TextDecoder("utf-8", { fatal: true });

export function generateNonce(): string {
  return randomBytes(32).toString("base64url");
}

export function buildHello(input: {
  role: "agent" | "control";
  sessionId: string;
  name?: string;
  label?: string | null;
  capabilities?: JsonObject;
  clientNonce?: string;
}): Hello {
  const hello: Hello = {
    op: "hello",
    auth: {
      method: AUTH_METHOD,
      client_nonce: input.clientNonce ?? generateNonce(),
    },
    role: input.role,
    session_id: input.sessionId,
    label: input.label ?? null,
    capabilities: input.capabilities ?? {},
  };
  if (input.name !== undefined) hello.name = input.name;
  return hello;
}

export function canonicalHelloTranscript(hello: JsonObject): string {
  return canonicalJson({
    capabilities: isRecord(hello.capabilities) ? hello.capabilities : {},
    label: hello.label ?? null,
    name: hello.name ?? null,
    role: hello.role ?? null,
    session_id: hello.session_id ?? null,
  });
}

function compareUnicodeKeys(left: string, right: string): number {
  const leftCodePoints = Array.from(
    left,
    (character) => character.codePointAt(0) ?? 0,
  );
  const rightCodePoints = Array.from(
    right,
    (character) => character.codePointAt(0) ?? 0,
  );
  const length = Math.min(leftCodePoints.length, rightCodePoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftCodePoint = leftCodePoints[index] ?? 0;
    const rightCodePoint = rightCodePoints[index] ?? 0;
    if (leftCodePoint !== rightCodePoint) return leftCodePoint - rightCodePoint;
  }
  return leftCodePoints.length - rightCodePoints.length;
}

export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort(compareUnicodeKeys)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return "null";
}

function proofMessage(
  domain: string,
  clientNonce: string,
  serverNonce: string,
  hello: JsonObject,
): string {
  return `${domain}\n${clientNonce}\n${serverNonce}\n${canonicalHelloTranscript(hello)}`;
}

export function hmacProof(
  secret: string,
  domain: string,
  input: { clientNonce: string; serverNonce: string; hello: JsonObject },
): string {
  return createHmac("sha256", secret)
    .update(
      proofMessage(domain, input.clientNonce, input.serverNonce, input.hello),
      "utf8",
    )
    .digest("hex");
}

export function serverProof(
  secret: string,
  input: { clientNonce: string; serverNonce: string; hello: JsonObject },
): string {
  return hmacProof(secret, SERVER_PROOF_DOMAIN, input);
}

export function clientProof(
  secret: string,
  input: { clientNonce: string; serverNonce: string; hello: JsonObject },
): string {
  return hmacProof(secret, CLIENT_PROOF_DOMAIN, input);
}

export function verifyProof(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function verifyServerProof(
  proof: string,
  secret: string,
  input: { clientNonce: string; serverNonce: string; hello: JsonObject },
): boolean {
  return verifyProof(proof, serverProof(secret, input));
}

export function verifyClientProof(
  proof: string,
  secret: string,
  input: { clientNonce: string; serverNonce: string; hello: JsonObject },
): boolean {
  return verifyProof(proof, clientProof(secret, input));
}

export function buildAuthResponse(
  secret: string,
  input: { clientNonce: string; serverNonce: string; hello: JsonObject },
): AuthResponse {
  return { op: "auth_response", client_proof: clientProof(secret, input) };
}

export function validateName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(value);
}

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function validateText(
  value: unknown,
  maxBytes: number,
): value is string {
  return typeof value === "string" && utf8ByteLength(value) <= maxBytes;
}

export function decodeFrame(data: unknown): string {
  try {
    if (typeof data === "string") return data;
    if (data instanceof ArrayBuffer)
      return decoder.decode(new Uint8Array(data));
    if (ArrayBuffer.isView(data))
      return decoder.decode(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      );
  } catch {
    throw new ProtocolError("websocket frame is not valid UTF-8");
  }
  throw new ProtocolError("websocket frame must be UTF-8 text or binary data");
}

export function parseFrame(data: unknown): ProtocolFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeFrame(data));
  } catch {
    throw new ProtocolError("websocket frame is not valid UTF-8 JSON");
  }
  if (!isRecord(parsed) || typeof parsed.op !== "string")
    throw new ProtocolError("protocol frame must be a JSON object with op");
  return parsed as ProtocolFrame;
}

export function parseHello(frame: ProtocolFrame): Hello {
  if (
    frame.op !== "hello" ||
    !isRecord(frame.auth) ||
    frame.auth.method !== AUTH_METHOD ||
    typeof frame.auth.client_nonce !== "string" ||
    !frame.auth.client_nonce
  ) {
    throw new ProtocolError("invalid hello frame");
  }
  if (frame.role !== "agent" && frame.role !== "control")
    throw new ProtocolError("invalid hello role");
  if (typeof frame.session_id !== "string" || !frame.session_id)
    throw new ProtocolError("invalid hello session_id");
  if (frame.role === "agent" && !validateName(frame.name))
    throw new ProtocolError("invalid hello name");
  if (frame.name !== undefined && typeof frame.name !== "string")
    throw new ProtocolError("invalid hello name");
  if (
    frame.label !== undefined &&
    frame.label !== null &&
    typeof frame.label !== "string"
  )
    throw new ProtocolError("invalid hello label");
  if (!isRecord(frame.capabilities))
    throw new ProtocolError("invalid hello capabilities");
  return {
    ...frame,
    label: frame.label === undefined ? null : frame.label,
    capabilities: frame.capabilities,
  } as Hello;
}

export function parseAuthChallenge(frame: ProtocolFrame): AuthChallenge {
  if (
    frame.op !== "auth_challenge" ||
    frame.method !== AUTH_METHOD ||
    typeof frame.server_nonce !== "string" ||
    !frame.server_nonce ||
    typeof frame.server_proof !== "string" ||
    !frame.server_proof
  ) {
    throw new ProtocolError("invalid auth challenge");
  }
  return frame as AuthChallenge;
}

export function parseWelcome(frame: ProtocolFrame): Welcome {
  if (
    frame.op !== "welcome" ||
    typeof frame.session_id !== "string" ||
    typeof frame.assigned_name !== "string" ||
    !isRecord(frame.capabilities)
  ) {
    throw new ProtocolError("invalid welcome frame");
  }
  const core = frame.capabilities.core;
  if (
    !isRecord(core) ||
    core.version !== "0.1" ||
    frame.capabilities.channels !== true ||
    frame.capabilities.rate_limit !== false
  ) {
    throw new ProtocolError("invalid welcome capabilities");
  }
  return frame as Welcome;
}

export function parseError(frame: ProtocolFrame): ProtocolErrorFrame {
  if (
    frame.op !== "error" ||
    !isProtocolErrorCode(frame.code) ||
    typeof frame.message !== "string"
  )
    throw new ProtocolError("invalid protocol error frame");
  return frame as ProtocolErrorFrame;
}

export function parseListOk(frame: ProtocolFrame): ListOkFrame {
  if (frame.op !== "list_ok" || !Array.isArray(frame.sessions))
    throw new ProtocolError("invalid list response");
  const sessions = frame.sessions.map((value) => {
    if (
      !isRecord(value) ||
      typeof value.session_id !== "string" ||
      typeof value.name !== "string" ||
      (value.label !== null && typeof value.label !== "string")
    ) {
      throw new ProtocolError("invalid list session");
    }
    return {
      session_id: value.session_id,
      name: value.name,
      label: value.label,
    } as SessionInfo;
  });
  return { ...frame, sessions } as ListOkFrame;
}

export function parseMessage(frame: ProtocolFrame): Message {
  if (
    frame.op !== "msg" ||
    typeof frame.msg_id !== "string" ||
    typeof frame.from !== "string" ||
    typeof frame.from_name !== "string" ||
    typeof frame.ts !== "string"
  ) {
    throw new ProtocolError("invalid message frame");
  }
  if ("to" in frame && frame.to !== null && typeof frame.to !== "string")
    throw new ProtocolError("invalid message target");
  if (
    "channel" in frame &&
    (typeof frame.channel !== "string" || !validateName(frame.channel))
  )
    throw new ProtocolError("invalid message channel");
  const hasText = "text" in frame;
  const hasCustom = "custom_type" in frame || "payload" in frame;
  if (hasText === hasCustom)
    throw new ProtocolError("message must contain exactly one payload form");
  if (hasText && typeof frame.text !== "string")
    throw new ProtocolError("invalid message text");
  if (hasCustom) {
    if (typeof frame.custom_type !== "string" || frame.custom_type.length === 0)
      throw new ProtocolError("invalid custom message type");
    if (!("payload" in frame))
      throw new ProtocolError("custom message payload is missing");
    if (!isJsonValue(frame.payload))
      throw new ProtocolError("invalid custom message payload");
  }
  return frame as Message;
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item));
  if (isRecord(value))
    return Object.values(value).every((item) => isJsonValue(item));
  return false;
}

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
