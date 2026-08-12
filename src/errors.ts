export type ProtocolErrorCode =
  | "PROTOCOL_ERROR"
  | "AUTH_FAILED"
  | "TOO_MANY_CONNECTIONS"
  | "BAD_ROLE"
  | "BAD_SESSION"
  | "SESSION_TAKEN"
  | "BAD_NAME"
  | "BAD_LABEL"
  | "NAME_TAKEN"
  | "UNKNOWN_OP"
  | "BAD_TEXT"
  | "BAD_FROM_NAME"
  | "BAD_CUSTOM_TYPE"
  | "TEXT_TOO_LARGE"
  | "CUSTOM_PAYLOAD_TOO_LARGE"
  | "UNKNOWN_TARGET"
  | "AMBIGUOUS_TARGET"
  | "BAD_CHANNEL"
  | "CHANNEL_LIMIT_REACHED"
  | "NOT_SUBSCRIBED"
  | "UNKNOWN_CHANNEL"
  | "KICKED";

export class InterAgentError extends Error {
  readonly kind: string;
  readonly retryable: boolean;

  constructor(message: string, kind: string, retryable = false) {
    super(message);
    this.name = kind;
    this.kind = kind;
    this.retryable = retryable;
  }
}

export class ConfigError extends InterAgentError {
  constructor(message: string) {
    super(message, "ConfigError");
  }
}

export class UnsupportedEndpointError extends InterAgentError {
  readonly reason: string;

  constructor(reason: string) {
    super(
      `unsupported inter-agent endpoint: ${reason}`,
      "UnsupportedEndpointError",
    );
    this.reason = reason;
  }
}

export class StateError extends InterAgentError {
  constructor(message: string) {
    super(message, "StateError");
  }
}

export class ProtocolError extends InterAgentError {
  readonly code: ProtocolErrorCode;

  constructor(message: string, code: ProtocolErrorCode = "PROTOCOL_ERROR") {
    super(message, "ProtocolError");
    this.code = code;
  }
}

export class AuthenticationError extends InterAgentError {
  constructor(message = "inter-agent server authentication failed") {
    super(message, "AuthenticationError");
  }
}

export class ConnectionError extends InterAgentError {
  constructor(message: string, retryable = true) {
    super(message, "ConnectionError", retryable);
  }
}

export class TimeoutError extends InterAgentError {
  constructor(message: string) {
    super(message, "TimeoutError", true);
  }
}

function redact(value: string, secret?: string): string {
  if (!secret || !value.includes(secret)) return value;
  return value.split(secret).join("[redacted]");
}

export class RemoteError extends InterAgentError {
  readonly code: ProtocolErrorCode;
  readonly remoteMessage: string;

  constructor(code: ProtocolErrorCode, message: string, secret?: string) {
    const safeMessage = redact(message, secret);
    super(
      `inter-agent ${code}: ${safeMessage}`,
      "RemoteError",
      isTransientCode(code),
    );
    this.code = code;
    this.remoteMessage = safeMessage;
  }
}

function isTransientCode(code: ProtocolErrorCode): boolean {
  return code === "TOO_MANY_CONNECTIONS";
}

export function isProtocolErrorCode(
  value: unknown,
): value is ProtocolErrorCode {
  return (
    typeof value === "string" &&
    [
      "PROTOCOL_ERROR",
      "AUTH_FAILED",
      "TOO_MANY_CONNECTIONS",
      "BAD_ROLE",
      "BAD_SESSION",
      "SESSION_TAKEN",
      "BAD_NAME",
      "BAD_LABEL",
      "NAME_TAKEN",
      "UNKNOWN_OP",
      "BAD_TEXT",
      "BAD_FROM_NAME",
      "BAD_CUSTOM_TYPE",
      "TEXT_TOO_LARGE",
      "CUSTOM_PAYLOAD_TOO_LARGE",
      "UNKNOWN_TARGET",
      "AMBIGUOUS_TARGET",
      "BAD_CHANNEL",
      "CHANNEL_LIMIT_REACHED",
      "NOT_SUBSCRIBED",
      "UNKNOWN_CHANNEL",
      "KICKED",
    ].includes(value)
  );
}
