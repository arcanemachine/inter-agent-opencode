import type { PluginModule } from "@opencode-ai/plugin";
import { tool, type ToolContext, type ToolResult } from "@opencode-ai/plugin";
import {
  assertSupportedEndpoint,
  resolveEndpoint,
  resolveSecret,
  type EndpointResolution,
} from "./config.js";
import {
  broadcast,
  listSessions,
  sendDirect,
  type WebSocketFactory,
} from "./client.js";
import {
  DEFAULT_BROADCAST_TEXT_MAX,
  DEFAULT_DIRECT_TEXT_MAX,
  validateName,
  validateText,
  type SessionInfo,
} from "./protocol.js";
import {
  canonicalWorkspacePath,
  hashScope,
  readPreferences,
  resolveLease,
  workspaceKey,
  type ConnectionLease,
} from "./state.js";
import { readInboxFile, type InboxMessage } from "./inbox.js";

const DEFAULT_INBOX_COUNT = 20;
const MAX_INBOX_COUNT = 100;

type ServerPluginInput = Parameters<NonNullable<PluginModule["server"]>>[0];

type ServerToolOptions = {
  websocketFactory?: WebSocketFactory;
};

type SessionScope = {
  endpoint: EndpointResolution;
  workspacePath: string;
  workspaceHash: string;
  sessionHash: string;
  sessionID: string;
};

type CallerScope = SessionScope & {
  lease: ConnectionLease;
};

function result(
  title: string,
  value: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
): ToolResult {
  return {
    title,
    output: JSON.stringify(value),
    metadata,
  };
}

function contextWorkspacePath(context: ToolContext): string {
  const path = context.worktree || context.directory;
  if (!path) throw new Error("OpenCode project scope is unavailable");
  return canonicalWorkspacePath(path);
}

function scopeFor(
  context: ToolContext,
  endpoint: EndpointResolution,
): SessionScope {
  const workspacePath = contextWorkspacePath(context);
  return {
    endpoint,
    workspacePath,
    workspaceHash: workspaceKey(workspacePath),
    sessionHash: hashScope(context.sessionID),
    sessionID: context.sessionID,
  };
}

function exactLease(lease: ConnectionLease, scope: SessionScope): boolean {
  return (
    lease.workspacePath === scope.workspacePath &&
    lease.workspaceHash === scope.workspaceHash &&
    lease.openCodeSessionID === scope.sessionID &&
    lease.sessionHash === scope.sessionHash &&
    lease.host === scope.endpoint.host &&
    lease.port === scope.endpoint.port &&
    lease.tls === scope.endpoint.tls &&
    validateName(lease.name)
  );
}

function unavailableSession(): Error {
  return new Error(
    "this OpenCode session is disconnected or unavailable; connect it before using inter-agent messaging",
  );
}

function preferenceMatchesLease(
  preferences: ReturnType<typeof readPreferences>,
  lease: ConnectionLease,
): boolean {
  return (
    !preferences ||
    (preferences.name === lease.name && preferences.label === lease.label)
  );
}

async function sessionScope(context: ToolContext): Promise<SessionScope> {
  return scopeFor(context, await resolveEndpoint());
}

async function callerScope(context: ToolContext): Promise<CallerScope> {
  const scope = await sessionScope(context);
  assertSupportedEndpoint(scope.endpoint);
  const resolution = resolveLease(scope.endpoint.dataDir, {
    workspacePath: scope.workspacePath,
    openCodeSessionID: scope.sessionID,
  });
  if (
    resolution.check !== "fresh" ||
    !resolution.lease ||
    !exactLease(resolution.lease, scope)
  )
    throw unavailableSession();
  const preferences = readPreferences(
    scope.endpoint.dataDir,
    scope.workspaceHash,
    scope.sessionHash,
    {
      workspacePath: scope.workspacePath,
      openCodeSessionID: scope.sessionID,
    },
  );
  if (!preferenceMatchesLease(preferences, resolution.lease))
    throw unavailableSession();
  return { ...scope, lease: resolution.lease };
}

function operationOptions(
  context: ToolContext,
  endpoint: EndpointResolution,
  options: ServerToolOptions,
) {
  return {
    endpoint,
    secret: resolveSecret().secret,
    signal: context.abort,
    websocketFactory: options.websocketFactory,
  };
}

function validateCount(count: unknown): number {
  const value = count === undefined ? DEFAULT_INBOX_COUNT : count;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_INBOX_COUNT
  )
    throw new Error("count must be an integer between 1 and 100");
  return value;
}

function sessionsValue(sessions: SessionInfo[]) {
  return {
    sessions: sessions.map((session) => ({
      session_id: session.session_id,
      name: session.name,
      label: session.label,
    })),
  };
}

function statusValue(
  scope: SessionScope,
  lease: ConnectionLease | undefined,
  leaseState: string,
  server: "reachable" | "unreachable",
  inboxCount: number,
  name: string | null,
  label: string | null,
) {
  return {
    endpoint: `${scope.endpoint.host}:${scope.endpoint.port}`,
    supported: scope.endpoint.supported,
    server,
    session: lease ? "connected" : "disconnected",
    name,
    label,
    lease: leaseState,
    inbox: inboxCount,
  };
}

async function executeSend(
  args: { to: string; text: string },
  context: ToolContext,
  options: ServerToolOptions,
): Promise<ToolResult> {
  if (!validateName(args.to))
    throw new Error("to must be a valid inter-agent name");
  if (
    typeof args.text !== "string" ||
    args.text.length === 0 ||
    !validateText(args.text, DEFAULT_DIRECT_TEXT_MAX)
  )
    throw new Error("text is empty or exceeds the direct message limit");
  const caller = await callerScope(context);
  await sendDirect(
    args.to,
    args.text,
    caller.lease.name,
    operationOptions(context, caller.endpoint, options),
  );
  return result("Inter-agent message sent", {
    sent: true,
    to: args.to,
    from_name: caller.lease.name,
  });
}

async function executeBroadcast(
  args: { text: string },
  context: ToolContext,
  options: ServerToolOptions,
): Promise<ToolResult> {
  if (
    typeof args.text !== "string" ||
    args.text.length === 0 ||
    !validateText(args.text, DEFAULT_BROADCAST_TEXT_MAX)
  )
    throw new Error("text is empty or exceeds the broadcast message limit");
  const caller = await callerScope(context);
  await broadcast(
    args.text,
    caller.lease.name,
    operationOptions(context, caller.endpoint, options),
  );
  return result("Inter-agent broadcast sent", {
    sent: true,
    from_name: caller.lease.name,
  });
}

async function executeList(
  context: ToolContext,
  options: ServerToolOptions,
): Promise<ToolResult> {
  const scope = await sessionScope(context);
  assertSupportedEndpoint(scope.endpoint);
  const listed = await listSessions(
    operationOptions(context, scope.endpoint, options),
  );
  return result("Inter-agent sessions", sessionsValue(listed.sessions), {
    count: listed.sessions.length,
  });
}

async function executeStatus(
  context: ToolContext,
  options: ServerToolOptions,
): Promise<ToolResult> {
  const scope = await sessionScope(context);
  const resolution = resolveLease(scope.endpoint.dataDir, {
    workspacePath: scope.workspacePath,
    openCodeSessionID: scope.sessionID,
  });
  const preferences = readPreferences(
    scope.endpoint.dataDir,
    scope.workspaceHash,
    scope.sessionHash,
    {
      workspacePath: scope.workspacePath,
      openCodeSessionID: scope.sessionID,
    },
  );
  const lease =
    resolution.check === "fresh" &&
    resolution.lease &&
    exactLease(resolution.lease, scope) &&
    preferenceMatchesLease(preferences, resolution.lease)
      ? resolution.lease
      : undefined;
  let server: "reachable" | "unreachable" = "unreachable";
  if (scope.endpoint.supported) {
    try {
      await listSessions(operationOptions(context, scope.endpoint, options));
      server = "reachable";
    } catch {
      server = "unreachable";
    }
  }
  const inboxCount = readInboxFile(
    scope.endpoint.dataDir,
    scope.workspaceHash,
    scope.sessionHash,
  ).messages.length;
  const value = statusValue(
    scope,
    lease,
    lease ? "fresh" : resolution.check,
    server,
    inboxCount,
    lease?.name ?? preferences?.name ?? null,
    lease?.label ?? preferences?.label ?? null,
  );
  return result("Inter-agent status", value, {
    session: value.session,
  });
}

async function executeInbox(
  args: { count?: number },
  context: ToolContext,
): Promise<ToolResult> {
  const count = validateCount(args.count);
  const scope = await sessionScope(context);
  const messages: InboxMessage[] = readInboxFile(
    scope.endpoint.dataDir,
    scope.workspaceHash,
    scope.sessionHash,
  ).messages.slice(-count);
  return result("Inter-agent inbox", { messages }, { count: messages.length });
}

export function createServerTools(options: ServerToolOptions = {}) {
  return {
    inter_agent_send: tool({
      description:
        "Send a direct inter-agent message from this OpenCode session.",
      args: {
        to: tool.schema.string().describe("Recipient agent name"),
        text: tool.schema.string().describe("Message text"),
      },
      execute: (args, context) => executeSend(args, context, options),
    }),
    inter_agent_broadcast: tool({
      description:
        "Broadcast an inter-agent message to everyone only when explicitly requested.",
      args: {
        text: tool.schema.string().describe("Message text"),
      },
      execute: (args, context) => executeBroadcast(args, context, options),
    }),
    inter_agent_list: tool({
      description: "List currently connected inter-agent sessions.",
      args: {},
      execute: (_args, context) => executeList(context, options),
    }),
    inter_agent_status: tool({
      description: "Show inter-agent status for this exact OpenCode session.",
      args: {},
      execute: (_args, context) => executeStatus(context, options),
    }),
    inter_agent_read_messages: tool({
      description:
        "Read this exact OpenCode session's durable inter-agent inbox.",
      args: {
        count: tool.schema
          .number()
          .int()
          .min(1)
          .max(MAX_INBOX_COUNT)
          .optional()
          .describe("Maximum messages to return (1-100)"),
      },
      execute: (args, context) => executeInbox(args, context),
    }),
  };
}

const server: PluginModule = {
  id: "inter-agent",
  async server(_input: ServerPluginInput) {
    return { tool: createServerTools() };
  },
};

export default server;
