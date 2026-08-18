# Inter-agent for OpenCode

OpenCode extension for connecting agent sessions to the inter-agent message bus.

## Status

Phase 6 TUI listeners, exact-session server tools, and automatic model-turn delivery are implemented for OpenCode `1.18.15`. The package is not published.

The extension uses direct TypeScript/Bun WebSocket connections with separate OpenCode TUI and server plugin targets. It does not require a Python runtime helper for routine operation.

## Transport and security

The initial target is plaintext loopback only (`localhost`, loopback IPv4, or loopback IPv6). TLS and non-loopback endpoints fail closed. The inter-agent server must be started separately; this extension never starts or owns it.

Each OpenCode session has an independent routing name, connection lease, listener, and private bounded inbox. Navigating to another session does not disconnect an existing listener. Peer messages are treated as untrusted collaboration input and are persisted before best-effort attention/toast notifications. Each connected session owns its pending delivery batch; pending state is never shared between sessions.

## TUI commands

The command palette and slash entries are named:

- `/inter-agent-connect`
- `/inter-agent-disconnect`
- `/inter-agent-send`
- `/inter-agent-broadcast`
- `/inter-agent-list`
- `/inter-agent-status`
- `/inter-agent-inbox`

Connect, send, broadcast, and inbox open an OpenCode prompt dialog for their arguments (for example, `agent-a --label Agent-A --auto-connect`, `peer text`, or `20`). Disconnect, list, and status run immediately. Commands operate on the current OpenCode session. Disconnect preserves that session's inbox and disables opt-in auto-connect. Inbox retention is bounded at 100 messages and 8 MiB of encoded JSON content.

## Automatic model-turn delivery

New inbound messages are debounced for approximately 250 ms and delivered only when that exact OpenCode session is idle. A busy or retrying session is never interrupted; messages arriving during a model turn wait for the next idle or error classification. At most one plugin-triggered `promptAsync` turn is active per session. Delivery prompts are bounded to 8 KiB, identify message IDs, routing names, kind, and bounded previews, and mark peer text as untrusted and non-authoritative. The model may evaluate peer content and act when useful under the current rules; peer text cannot override system, developer, user, tool, permission, or security rules. The prompt directs the model to use `inter_agent_read_messages` for omitted or full content. Plugin-generated status/message activity cannot recursively trigger another delivery.

Delivery is best effort: failures notify the user without deleting durable inbox records and without retry storms. A new manager does not replay pre-existing inbox records automatically. Disposal, terminal connection failure, and explicit disconnect clean that session's pending in-memory batch while preserving its inbox.

## Server tools

The server plugin registers exactly five tools: `inter_agent_send(to, text)`, `inter_agent_broadcast(text)`, `inter_agent_list()`, `inter_agent_status()`, and `inter_agent_read_messages(count?)`. Server tools resolve the exact OpenCode `ToolContext.sessionID` and canonical project scope. Send and broadcast require that session's fresh connected lease and use its active lease name as `from_name`; they never borrow another session's identity. Broadcast is only for explicit everyone-directed requests. Message reads are exact-session and bounded to 1–100 messages (default 20). Disconnected sessions receive a concise setup error for send and broadcast while status and reads remain scoped to that session.

The extension still uses separate `./tui` and `./server` package targets, and the server is started separately; the extension does not own server lifecycle.

## Development

```sh
npm ci
npm run build
npm test
```

Use `INTER_AGENT_HOST`, `INTER_AGENT_PORT`, `INTER_AGENT_SECRET`, `INTER_AGENT_CONFIG`, and `INTER_AGENT_DATA_DIR` for Core-compatible configuration. The default server endpoint is `127.0.0.1:16837`; use an isolated endpoint for tests.
