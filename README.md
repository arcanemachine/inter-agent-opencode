# Inter-agent for OpenCode

OpenCode extension for connecting agent sessions to the inter-agent message bus.

## Status

Phase 5 TUI listeners, commands, and exact-session server tools are implemented for OpenCode `1.18.15`; automatic model-turn delivery is not included. The package is not published.

The extension uses direct TypeScript/Bun WebSocket connections with separate OpenCode TUI and server plugin targets. It does not require a Python runtime helper for routine operation.

## Transport and security

The initial target is plaintext loopback only (`localhost`, loopback IPv4, or loopback IPv6). TLS and non-loopback endpoints fail closed. The inter-agent server must be started separately; this extension never starts or owns it.

Each OpenCode session has an independent routing name, connection lease, listener, and private bounded inbox. Navigating to another session does not disconnect an existing listener. Peer messages are treated as untrusted collaboration input and are persisted before best-effort attention/toast notifications.

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
