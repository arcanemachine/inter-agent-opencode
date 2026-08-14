import type { TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { TimeoutError, InterAgentError, RemoteError } from "./errors.js";
import {
  AgentConnection,
  broadcast,
  listSessions,
  sendDirect,
  type WebSocketFactory,
} from "./client.js";
import {
  assertSupportedEndpoint,
  resolveEndpoint,
  resolveSecret,
  type EndpointResolution,
} from "./config.js";
import { validateName, type Message } from "./protocol.js";
import {
  LEASE_REFRESH_INTERVAL_MS,
  claimLease,
  hashScope,
  readPreferences,
  refreshLease,
  releaseLease,
  resolveLease,
  writePreferences,
  workspaceKey,
  type ConnectionLease,
  type LeaseClaimInput,
} from "./state.js";
import { readInboxFile, recordMessage } from "./inbox.js";

const RECONNECT_INITIAL_MS = 250;
const RECONNECT_MAX_MS = 4_000;
const RECEIVE_TIMEOUT_MS = 60_000;
const DEFAULT_INBOX_COUNT = 20;
const MAX_INBOX_COUNT = 100;

type ControllerStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "stopped";

type ConnectArgs = {
  name: string;
  label: string | null;
  autoConnect: boolean;
};

type SessionRoute = { sessionID: string };

type SessionIdentity = {
  workspacePath: string;
  workspaceHash: string;
  sessionHash: string;
  name: string;
  label: string | null;
};

type ManagerApi = TuiPluginApi & {
  websocketFactory?: WebSocketFactory;
};

function trimLimit(
  value: string,
  length: number,
): { value: string; truncated: boolean } {
  if (value.length <= length) return { value, truncated: false };
  return {
    value: value.slice(0, Math.max(0, length - 1)) + "…",
    truncated: true,
  };
}

function parseWords(input: unknown): string[] {
  if (Array.isArray(input)) return input.map(String);
  if (typeof input === "string") {
    const words: string[] = [];
    const pattern = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g;
    for (const match of input.matchAll(pattern)) {
      const value = match[0] ?? "";
      words.push(
        value.startsWith('"') && value.endsWith('"')
          ? value.slice(1, -1)
          : value.startsWith("'") && value.endsWith("'")
            ? value.slice(1, -1)
            : value,
      );
    }
    return words;
  }
  if (input && typeof input === "object") {
    const value = input as { args?: unknown; input?: unknown };
    return parseWords(value.args ?? value.input);
  }
  return [];
}

export function parseConnectArgs(input: unknown): ConnectArgs {
  const words = parseWords(input);
  const name = words.shift();
  if (!name || !validateName(name))
    throw new Error(
      "usage: /inter-agent-connect <name> [--label <label>] [--auto-connect]",
    );
  let label: string | null = null;
  let autoConnect = false;
  while (words.length) {
    const option = words.shift();
    if (option === "--auto-connect") {
      autoConnect = true;
      continue;
    }
    if (option === "--label") {
      label = words.shift() ?? null;
      if (label === null || label.length === 0 || label.length > 200)
        throw new Error(
          "--label requires a non-empty label of at most 200 characters",
        );
      continue;
    }
    throw new Error(`unknown connect option: ${option}`);
  }
  return { name, label, autoConnect };
}

function currentSession(api: ManagerApi): SessionRoute {
  const route = api.route.current;
  if (route.name !== "session" || !route.params?.sessionID)
    throw new Error("Open or create an OpenCode session first");
  return { sessionID: String(route.params.sessionID) };
}

function workspacePath(api: ManagerApi): string {
  return api.state.path.worktree || api.state.path.directory;
}

function claimInput(
  api: ManagerApi,
  endpoint: EndpointResolution,
  sessionID: string,
  name: string,
  label: string | null,
): LeaseClaimInput {
  const path = workspacePath(api);
  const workspaceHash = workspaceKey(path);
  return {
    workspacePath: path,
    workspaceHash,
    openCodeSessionID: sessionID,
    sessionHash: hashScope(sessionID),
    name,
    label,
    host: endpoint.host,
    port: endpoint.port,
    tls: endpoint.tls,
  };
}

function leaseMatches(lease: ConnectionLease, input: LeaseClaimInput): boolean {
  return (
    lease.workspacePath === input.workspacePath &&
    lease.workspaceHash === input.workspaceHash &&
    lease.openCodeSessionID === input.openCodeSessionID &&
    lease.sessionHash === input.sessionHash &&
    lease.name === input.name &&
    lease.label === input.label &&
    lease.host === input.host &&
    lease.port === input.port &&
    lease.tls === input.tls
  );
}

function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "inter-agent operation failed";
}

export function isTerminalListenerError(error: unknown): boolean {
  if (error instanceof RemoteError)
    return [
      "AUTH_FAILED",
      "PROTOCOL_ERROR",
      "BAD_ROLE",
      "BAD_SESSION",
      "BAD_NAME",
      "BAD_LABEL",
      "SESSION_TAKEN",
      "NAME_TAKEN",
      "TOO_MANY_CONNECTIONS",
      "KICKED",
    ].includes(error.code);
  return (
    (error instanceof InterAgentError && !error.retryable) ||
    (error instanceof Error &&
      /connection lease is owned|connection lease owner|malformed or mismatched|lease is unavailable/.test(
        error.message,
      ))
  );
}

class SessionController {
  readonly sessionID: string;
  private connection: AgentConnection | undefined;
  private lease: ConnectionLease | undefined;
  private endpoint: EndpointResolution | undefined;
  private receiveTask: Promise<void> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private retry = 0;
  private intentional = false;
  private disposed = false;
  private _status: ControllerStatus = "disconnected";
  private lastError: string | undefined;
  private identity: SessionIdentity | undefined;

  constructor(
    private readonly manager: TuiManager,
    sessionID: string,
  ) {
    this.sessionID = sessionID;
  }

  get status(): ControllerStatus {
    return this._status;
  }

  get currentLease(): ConnectionLease | undefined {
    return this.lease;
  }

  get reconnectAttempt(): number {
    return this.retry;
  }

  get error(): string | undefined {
    return this.lastError;
  }

  get sessionIdentity(): SessionIdentity | undefined {
    return this.identity;
  }

  async connect(args: ConnectArgs, restore = false): Promise<string> {
    if (this.disposed) throw new Error("session controller is disposed");
    if (
      this.connection &&
      this.lease?.name === args.name &&
      this.lease.label === args.label
    )
      return `Already connected as ${args.name}`;
    if (this.connection || this.lease)
      throw new Error("disconnect this session before changing its identity");
    this.intentional = false;
    this._status = "connecting";
    this.lastError = undefined;
    let claimed: ConnectionLease | undefined;
    let attemptEndpoint: EndpointResolution | undefined;
    let pendingConnection: AgentConnection | undefined;
    try {
      const endpoint = await resolveEndpoint();
      attemptEndpoint = endpoint;
      assertSupportedEndpoint(endpoint);
      const secret = resolveSecret().secret;
      const input = claimInput(
        this.manager.api,
        endpoint,
        this.sessionID,
        args.name,
        args.label,
      );
      claimed = claimLease(endpoint.dataDir, input);
      pendingConnection = await AgentConnection.open({
        endpoint,
        secret,
        name: args.name,
        label: args.label,
        signal: this.manager.api.lifecycle.signal,
        websocketFactory: this.manager.api.websocketFactory,
      });
      if (this.disposed || this.intentional) {
        await pendingConnection.close();
        releaseLease(
          endpoint.dataDir,
          claimed.workspaceHash,
          claimed.sessionHash,
          claimed.ownerToken,
        );
        throw new Error("connection cancelled");
      }
      writePreferences(
        endpoint.dataDir,
        claimed.workspaceHash,
        claimed.sessionHash,
        {
          version: 1,
          workspacePath: claimed.workspacePath,
          workspaceHash: claimed.workspaceHash,
          openCodeSessionID: claimed.openCodeSessionID,
          sessionHash: claimed.sessionHash,
          name: args.name,
          label: args.label,
          autoConnect: args.autoConnect,
        },
      );
      this.endpoint = endpoint;
      this.identity = {
        workspacePath: claimed.workspacePath,
        workspaceHash: claimed.workspaceHash,
        sessionHash: claimed.sessionHash,
        name: claimed.name,
        label: claimed.label,
      };
      this.lease = claimed;
      this.connection = pendingConnection;
      this.retry = 0;
      this._status = "connected";
      this.startTimers();
      this.receiveTask = this.receiveLoop(pendingConnection);
      void this.receiveTask;
      return `${restore ? "Auto-connected" : "Connected"} as ${args.name}`;
    } catch (error) {
      await pendingConnection?.close();
      this._status = "disconnected";
      if (claimed) {
        try {
          if (!attemptEndpoint)
            throw new Error("connection attempt endpoint unavailable");
          releaseLease(
            attemptEndpoint.dataDir,
            claimed.workspaceHash,
            claimed.sessionHash,
            claimed.ownerToken,
          );
        } catch {
          // The lease cleanup policy preserves the primary connection error.
        }
      }
      throw error;
    }
  }

  private startTimers(): void {
    this.stopTimers();
    this.heartbeatTimer = setInterval(() => {
      void this.refresh();
    }, LEASE_REFRESH_INTERVAL_MS);
  }

  private stopTimers(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private async refresh(): Promise<void> {
    if (
      !this.connection ||
      !this.lease ||
      !this.endpoint ||
      this.intentional ||
      this.disposed
    )
      return;
    try {
      this.lease = refreshLease(
        this.endpoint.dataDir,
        this.lease.workspaceHash,
        this.lease.sessionHash,
        this.lease.ownerToken,
      );
    } catch (error) {
      this.lastError = errorText(error);
      await this.transportFailed(error);
    }
  }

  private async receiveLoop(connection: AgentConnection): Promise<void> {
    while (
      !this.disposed &&
      !this.intentional &&
      this.connection === connection
    ) {
      try {
        const message = await connection.receive(RECEIVE_TIMEOUT_MS);
        await this.handleMessage(message);
      } catch (error) {
        if (error instanceof TimeoutError) continue;
        if (this.connection !== connection || this.intentional || this.disposed)
          return;
        await this.transportFailed(error);
        return;
      }
    }
  }

  private async handleMessage(message: Message): Promise<void> {
    if (!this.lease || !this.endpoint) return;
    const text =
      message.text ??
      JSON.stringify(message.payload) ??
      String(message.payload);
    const title = trimLimit(
      `Inter-agent message from ${message.from_name}`,
      80,
    );
    const preview = trimLimit(text, 240);
    const kind =
      message.to === null || message.to === undefined ? "broadcast" : "direct";
    const result = recordMessage(
      this.endpoint.dataDir,
      this.lease.workspaceHash,
      this.lease.sessionHash,
      {
        id: message.msg_id,
        receivedAt: new Date().toISOString(),
        from: message.from,
        fromName: message.from_name,
        kind,
        to: message.to ?? null,
        text,
        notificationTruncated: preview.truncated,
      },
    );
    if (!result.added) return;
    try {
      await this.manager.api.attention.notify({
        title: title.value,
        message: preview.value,
      });
    } catch {
      // Notifications are best effort; the durable inbox is authoritative.
    }
    try {
      this.manager.api.ui.toast({
        variant: "info",
        title: title.value,
        message: preview.value,
      });
    } catch {
      // The message has already been durably recorded.
    }
  }

  private async transportFailed(
    error: unknown,
    releaseCurrentLease = true,
  ): Promise<void> {
    if (this.intentional || this.disposed) return;
    const connection = this.connection;
    this.connection = undefined;
    this.stopTimers();
    await connection?.close();
    this.lastError = errorText(error);
    if (isTerminalListenerError(error)) {
      this._status = "stopped";
      if (releaseCurrentLease && this.lease && this.endpoint) {
        try {
          releaseLease(
            this.endpoint.dataDir,
            this.lease.workspaceHash,
            this.lease.sessionHash,
            this.lease.ownerToken,
          );
        } catch {
          // Preserve the terminal transport error.
        }
      }
      this.lease = undefined;
      return;
    }
    this._status = "reconnecting";
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.intentional || this.disposed) return;
    const base = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_INITIAL_MS * 2 ** this.retry++,
    );
    const delay = Math.min(
      RECONNECT_MAX_MS,
      Math.round(base * (0.75 + Math.random() * 0.5)),
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.reconnect();
    }, delay);
  }

  private async reacquireReconnectLease(
    endpoint: EndpointResolution,
  ): Promise<{ lease: ConnectionLease; attemptOwned: boolean }> {
    const identity = this.identity;
    if (!identity)
      throw new Error("connection identity is unavailable; connect again");
    const input: LeaseClaimInput = {
      workspacePath: identity.workspacePath,
      workspaceHash: identity.workspaceHash,
      openCodeSessionID: this.sessionID,
      sessionHash: identity.sessionHash,
      name: identity.name,
      label: identity.label,
      host: endpoint.host,
      port: endpoint.port,
      tls: endpoint.tls,
    };
    const resolution = resolveLease(endpoint.dataDir, {
      workspacePath: identity.workspacePath,
      openCodeSessionID: this.sessionID,
    });
    if (resolution.check === "fresh") {
      const diskLease = resolution.lease;
      if (!diskLease)
        throw new Error("connection lease is unavailable; connect again");
      const ownerToken = this.lease?.ownerToken;
      if (!ownerToken || diskLease.ownerToken !== ownerToken)
        throw new Error("connection lease is owned by another process");
      if (!leaseMatches(diskLease, input)) {
        releaseLease(
          endpoint.dataDir,
          diskLease.workspaceHash,
          diskLease.sessionHash,
          ownerToken,
        );
        const replaced = claimLease(endpoint.dataDir, input);
        return { lease: replaced, attemptOwned: true };
      }
      return { lease: diskLease, attemptOwned: false };
    }
    if (resolution.check !== "missing" && resolution.check !== "expired")
      throw new Error(
        "connection lease is malformed or mismatched; connect again",
      );
    const claimed = claimLease(endpoint.dataDir, input);
    return { lease: claimed, attemptOwned: true };
  }

  private refreshReconnectLease(
    endpoint: EndpointResolution,
    expected: ConnectionLease,
  ): ConnectionLease {
    const identity = this.identity;
    if (!identity)
      throw new Error("connection identity is unavailable; connect again");
    const input: LeaseClaimInput = {
      workspacePath: identity.workspacePath,
      workspaceHash: identity.workspaceHash,
      openCodeSessionID: this.sessionID,
      sessionHash: identity.sessionHash,
      name: identity.name,
      label: identity.label,
      host: endpoint.host,
      port: endpoint.port,
      tls: endpoint.tls,
    };
    const resolution = resolveLease(endpoint.dataDir, {
      workspacePath: identity.workspacePath,
      openCodeSessionID: this.sessionID,
    });
    if (resolution.check === "fresh" && resolution.lease) {
      if (resolution.lease.ownerToken !== expected.ownerToken)
        throw new Error("connection lease is owned by another process");
      if (!leaseMatches(resolution.lease, input))
        throw new Error("connection lease identity or endpoint changed");
      return refreshLease(
        endpoint.dataDir,
        identity.workspaceHash,
        identity.sessionHash,
        expected.ownerToken,
      );
    }
    if (resolution.check === "fresh")
      throw new Error("connection lease is unavailable; connect again");
    if (resolution.check === "missing" || resolution.check === "expired")
      throw new Error(
        "connection lease expired before authentication completed",
      );
    throw new Error(
      "connection lease is malformed or mismatched; connect again",
    );
  }

  private async reconnect(): Promise<void> {
    if (this.intentional || this.disposed || !this.identity) return;
    let attemptLease: ConnectionLease | undefined;
    let attemptOwned = false;
    let attemptEndpoint: EndpointResolution | undefined;
    let pendingConnection: AgentConnection | undefined;
    try {
      const endpoint = await resolveEndpoint();
      attemptEndpoint = endpoint;
      assertSupportedEndpoint(endpoint);
      const prepared = await this.reacquireReconnectLease(endpoint);
      attemptLease = prepared.lease;
      attemptOwned = prepared.attemptOwned;
      const secret = resolveSecret().secret;
      pendingConnection = await AgentConnection.open({
        endpoint,
        secret,
        name: this.identity.name,
        label: this.identity.label,
        signal: this.manager.api.lifecycle.signal,
        websocketFactory: this.manager.api.websocketFactory,
      });
      attemptLease = this.refreshReconnectLease(endpoint, attemptLease);
      this.endpoint = endpoint;
      this.lease = attemptLease;
      this.connection = pendingConnection;
      this.retry = 0;
      this._status = "connected";
      this.startTimers();
      this.receiveTask = this.receiveLoop(pendingConnection);
    } catch (error) {
      await pendingConnection?.close();
      if (attemptOwned && attemptLease) {
        try {
          if (!attemptEndpoint)
            throw new Error("reconnect attempt endpoint unavailable");
          releaseLease(
            attemptEndpoint.dataDir,
            attemptLease.workspaceHash,
            attemptLease.sessionHash,
            attemptLease.ownerToken,
          );
        } catch {
          // Preserve the reconnect failure.
        }
      }
      this.lastError = errorText(error);
      if (
        isTerminalListenerError(error) ||
        (error instanceof Error &&
          /owned by another|malformed or mismatched|unavailable/.test(
            error.message,
          ))
      ) {
        await this.transportFailed(error, false);
      } else {
        this._status = "reconnecting";
        this.scheduleReconnect();
      }
    }
  }

  async disconnect(explicit: boolean): Promise<string> {
    this.intentional = true;
    this.stopTimers();
    await this.connection?.close();
    this.connection = undefined;
    const oldName = this.identity?.name ?? this.lease?.name;
    if (this.lease && this.endpoint) {
      try {
        releaseLease(
          this.endpoint.dataDir,
          this.lease.workspaceHash,
          this.lease.sessionHash,
          this.lease.ownerToken,
        );
      } catch (error) {
        this.lastError = errorText(error);
      }
    }
    if (explicit) {
      try {
        const scope = await this.manager.sessionScope(this.sessionID);
        const preferences = readPreferences(
          scope.endpoint.dataDir,
          scope.workspaceHash,
          scope.sessionHash,
          {
            workspacePath: scope.workspacePath,
            openCodeSessionID: this.sessionID,
          },
        );
        if (preferences)
          writePreferences(
            scope.endpoint.dataDir,
            scope.workspaceHash,
            scope.sessionHash,
            { ...preferences, autoConnect: false },
          );
      } catch (error) {
        this.lastError = errorText(error);
      }
    }
    this.lease = undefined;
    this._status = "disconnected";
    return oldName
      ? `Disconnected ${oldName}`
      : "Session is already disconnected";
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.disconnect(false);
    this._status = "stopped";
  }
}

export class TuiManager {
  readonly controllers = new Map<string, SessionController>();
  private readonly unregisterCommands: () => void;
  private disposed = false;

  constructor(readonly api: ManagerApi) {
    this.unregisterCommands = this.registerCommands();
    this.api.lifecycle.onDispose(() => this.dispose());
    this.api.event.on("session.deleted", (event) => {
      const sessionID = event.properties.sessionID;
      void this.deleteSession(sessionID);
    });
    void this.restoreCurrent();
  }

  private controller(sessionID: string): SessionController {
    const existing = this.controllers.get(sessionID);
    if (existing) return existing;
    const created = new SessionController(this, sessionID);
    this.controllers.set(sessionID, created);
    return created;
  }

  private currentController(): SessionController {
    return this.controller(currentSession(this.api).sessionID);
  }

  async sessionScope(sessionID: string): Promise<{
    endpoint: EndpointResolution;
    workspacePath: string;
    workspaceHash: string;
    sessionHash: string;
  }> {
    const endpoint = await resolveEndpoint();
    const path = workspacePath(this.api);
    return {
      endpoint,
      workspacePath: path,
      workspaceHash: workspaceKey(path),
      sessionHash: hashScope(sessionID),
    };
  }

  async connect(input: unknown): Promise<string> {
    const route = currentSession(this.api);
    const args = parseConnectArgs(input);
    const result = await this.controller(route.sessionID).connect(args);
    this.toast(result, "success");
    return result;
  }

  async disconnect(): Promise<string> {
    const result = await this.currentController().disconnect(true);
    this.toast(result, "info");
    return result;
  }

  async send(input: unknown): Promise<string> {
    const words = parseWords(input);
    const to = words.shift();
    const text = words.join(" ");
    if (!to || !validateName(to) || !text)
      throw new Error("usage: /inter-agent-send <to> <text>");
    const controller = this.currentController();
    const lease = controller.currentLease;
    if (!lease || controller.status !== "connected")
      throw new Error("connect this OpenCode session first");
    const endpoint = await resolveEndpoint();
    assertSupportedEndpoint(endpoint);
    const result = await sendDirect(to, text, lease.name, {
      endpoint,
      secret: resolveSecret().secret,
      signal: this.api.lifecycle.signal,
      websocketFactory: this.api.websocketFactory,
    });
    const output = `Sent message to ${to}`;
    this.toast(output, "success");
    return output;
  }

  async broadcast(input: unknown): Promise<string> {
    const text = parseWords(input).join(" ");
    if (!text) throw new Error("usage: /inter-agent-broadcast <text>");
    const controller = this.currentController();
    const lease = controller.currentLease;
    if (!lease || controller.status !== "connected")
      throw new Error("connect this OpenCode session first");
    const endpoint = await resolveEndpoint();
    assertSupportedEndpoint(endpoint);
    await broadcast(text, lease.name, {
      endpoint,
      secret: resolveSecret().secret,
      signal: this.api.lifecycle.signal,
      websocketFactory: this.api.websocketFactory,
    });
    const output = "Broadcast sent";
    this.toast(output, "success");
    return output;
  }

  async list(): Promise<string> {
    const endpoint = await resolveEndpoint();
    assertSupportedEndpoint(endpoint);
    const result = await listSessions({
      endpoint,
      secret: resolveSecret().secret,
      signal: this.api.lifecycle.signal,
      websocketFactory: this.api.websocketFactory,
    });
    const output =
      result.sessions
        .map(
          (session) =>
            `${session.name}${session.label ? ` (${session.label})` : ""}`,
        )
        .join(", ") || "No connected agents";
    this.toast(output, "info");
    return output;
  }

  async status(): Promise<string> {
    const endpoint = await resolveEndpoint();
    const controller = this.currentController();
    let reachable = "unreachable";
    if (endpoint.supported) {
      try {
        await listSessions({
          endpoint,
          secret: resolveSecret().secret,
          signal: this.api.lifecycle.signal,
          websocketFactory: this.api.websocketFactory,
        });
        reachable = "reachable";
      } catch {
        reachable = "unreachable";
      }
    }
    const scope = await this.sessionScope(controller.sessionID);
    const leaseResolution = resolveLease(endpoint.dataDir, {
      workspacePath: scope.workspacePath,
      openCodeSessionID: controller.sessionID,
    });
    const leaseState = leaseResolution.check;
    const diskLease = leaseResolution.lease;
    const inboxCount = readInboxFile(
      endpoint.dataDir,
      scope.workspaceHash,
      scope.sessionHash,
    ).messages.length;
    const identity = controller.sessionIdentity;
    const output = `endpoint=${endpoint.host}:${endpoint.port} supported=${endpoint.supported} server=${reachable} session=${controller.status} name=${diskLease?.name ?? identity?.name ?? "none"} label=${diskLease?.label ?? identity?.label ?? "none"} reconnect=${controller.reconnectAttempt} lease=${leaseState} pending=0 inbox=${inboxCount}`;
    this.toast(output, "info");
    return output;
  }

  async inbox(input: unknown): Promise<string> {
    const words = parseWords(input);
    const count = words.length ? Number(words[0]) : DEFAULT_INBOX_COUNT;
    if (!Number.isInteger(count) || count < 1 || count > MAX_INBOX_COUNT)
      throw new Error("inbox count must be between 1 and 100");
    const controller = this.currentController();
    const scope = await this.sessionScope(controller.sessionID);
    const records = readInboxFile(
      scope.endpoint.dataDir,
      scope.workspaceHash,
      scope.sessionHash,
    ).messages.slice(-count);
    const output =
      records
        .map(
          (message) =>
            `[${message.id}] ${message.fromName} (${message.kind}) ${message.receivedAt}\n${message.text}`,
        )
        .join("\n\n") || "Inbox is empty";
    this.toast(output, "info");
    return output;
  }

  private toast(message: string, variant: "info" | "success" | "error"): void {
    try {
      this.api.ui.toast({ message, variant });
    } catch {
      // Commands still return their structured text to the host.
    }
  }

  private promptInput(
    title: string,
    placeholder: string,
    callback: (value: string) => Promise<string>,
  ): void {
    this.api.ui.dialog.replace(() =>
      this.api.ui.DialogPrompt({
        title,
        placeholder,
        onConfirm: (value: string) => {
          this.api.ui.dialog.clear();
          void callback(value).catch((error) => this.commandError(error));
        },
        onCancel: () => this.api.ui.dialog.clear(),
      }),
    );
  }

  private registerCommands(): () => void {
    const keymap = this.api.keymap as unknown as {
      registerLayer: (layer: {
        commands: unknown[];
        bindings?: unknown[];
      }) => () => void;
    };
    const command = (
      name: string,
      title: string,
      slashName: string,
      run: () => void | Promise<void>,
    ) => ({
      namespace: "palette",
      name,
      title,
      desc: title,
      slashName,
      run,
    });
    return keymap.registerLayer({
      commands: [
        command(
          "inter-agent.connect",
          "Connect this OpenCode session",
          "inter-agent-connect",
          () =>
            this.promptInput(
              "Inter-agent connect",
              "name [--label label] [--auto-connect]",
              async (value) => this.connect(value),
            ),
        ),
        command(
          "inter-agent.disconnect",
          "Disconnect this OpenCode session",
          "inter-agent-disconnect",
          () => {
            void this.disconnect().catch((error) => this.commandError(error));
          },
        ),
        command(
          "inter-agent.send",
          "Send an inter-agent message",
          "inter-agent-send",
          () =>
            this.promptInput("Inter-agent send", "to text", async (value) =>
              this.send(value),
            ),
        ),
        command(
          "inter-agent.broadcast",
          "Broadcast an inter-agent message",
          "inter-agent-broadcast",
          () =>
            this.promptInput("Inter-agent broadcast", "text", async (value) =>
              this.broadcast(value),
            ),
        ),
        command(
          "inter-agent.list",
          "List inter-agent peers",
          "inter-agent-list",
          () => {
            void this.list().catch((error) => this.commandError(error));
          },
        ),
        command(
          "inter-agent.status",
          "Show inter-agent status",
          "inter-agent-status",
          () => {
            void this.status().catch((error) => this.commandError(error));
          },
        ),
        command(
          "inter-agent.inbox",
          "Read this session's inter-agent inbox",
          "inter-agent-inbox",
          () =>
            this.promptInput(
              "Inter-agent inbox",
              "count (optional)",
              async (value) => this.inbox(value),
            ),
        ),
      ],
    });
  }

  private commandError(error: unknown): string {
    const message = errorText(error);
    this.toast(message, "error");
    return message;
  }

  private async restoreCurrent(): Promise<void> {
    if (this.disposed || this.api.route.current.name !== "session") return;
    const sessionID = String(
      (this.api.route.current as { params?: { sessionID?: unknown } }).params
        ?.sessionID,
    );
    if (!sessionID || sessionID === "undefined") return;
    if (!this.api.state.session.get(sessionID)) return;
    try {
      const endpoint = await resolveEndpoint();
      const path = workspacePath(this.api);
      const preferences = readPreferences(
        endpoint.dataDir,
        workspaceKey(path),
        hashScope(sessionID),
        {
          workspacePath: path,
          openCodeSessionID: sessionID,
        },
      );
      if (preferences?.autoConnect && preferences.name)
        await this.controller(sessionID).connect(
          {
            name: preferences.name,
            label: preferences.label,
            autoConnect: true,
          },
          true,
        );
    } catch {
      // Auto-connect is opt-in and must not make plugin initialization fail.
    }
  }

  async deleteSession(sessionID: string): Promise<void> {
    const controller = this.controllers.get(sessionID);
    if (!controller) return;
    await controller.dispose();
    this.controllers.delete(sessionID);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unregisterCommands();
    await Promise.all(
      [...this.controllers.values()].map((controller) => controller.dispose()),
    );
    this.controllers.clear();
  }
}

const tui: TuiPluginModule = {
  id: "inter-agent",
  async tui(api) {
    if (!api) return;
    new TuiManager(api as ManagerApi);
  },
};

export default tui;
