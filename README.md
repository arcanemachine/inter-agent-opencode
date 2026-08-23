# Inter-agent for OpenCode

OpenCode extension for connecting agent sessions to the inter-agent message bus. The package is not published; install it from a local package archive or a local checkout.

## Compatibility and transport

- Validated host: OpenCode `1.18.15` (package range `>=1.18.15 <1.19.0`).
- Separate package targets: `./tui` for the TUI and `./server` for server tools. Do not configure one target as the other.
- Supported transport: authenticated WebSocket on loopback only (`127.0.0.1`, `::1`, or a loopback-resolving `localhost`). Plaintext `ws://` is the default; authenticated `wss://` is available when TLS is enabled and uses the native Bun WebSocket CA option. Non-loopback hosts and runtimes without native TLS trust injection fail closed.
- The inter-agent server is a separate process. This extension never starts, stops, or owns its lifecycle.
- Clean installation and runtime checks pass under Bun `1.3.14`.

The package is validated against OpenCode `1.18.15`; the available source checkout records release-version commit `1ec6bdc8c666e315ba85ef5276fac9b0eb7ba109`, but it has no matching tag ref. The cached runtime binary's build provenance is not independently established.

## Installation

Build and pack from this checkout:

```sh
npm ci
npm run build
npm pack
```

Install the resulting archive wherever OpenCode resolves plugins (or use the local checkout as a file plugin during development):

```sh
npm install ./arcanemachine-inter-agent-opencode-0.1.0.tgz
```

OpenCode loads server and TUI plugins from separate configuration files. For an installed package, add the package name to both files as needed:

```jsonc
// opencode.json — server tools
{ "plugin": ["@arcanemachine/inter-agent-opencode"] }
```

```jsonc
// tui.json — TUI commands/listener
{ "plugin": ["@arcanemachine/inter-agent-opencode"] }
```

`opencode.json` is the server-plugin configuration. TUI plugin configuration is `tui.json`; when using a non-default file, set `OPENCODE_TUI_CONFIG` to that file before starting the TUI. A local checkout can be configured with an absolute `file://` URL instead of the package name. Keep configuration files and plugin caches private.

## Configuration

The extension reads the same Core-compatible settings from environment variables or a JSON config file. Environment variables take precedence. The supported variables are:

| Variable               | Meaning                                                                  |
| ---------------------- | ------------------------------------------------------------------------ |
| `INTER_AGENT_HOST`     | Server host; defaults to `127.0.0.1`. Must resolve to loopback.          |
| `INTER_AGENT_PORT`     | Server port; defaults to `16837`.                                        |
| `INTER_AGENT_SECRET`   | Shared authentication secret.                                            |
| `INTER_AGENT_CONFIG`   | JSON config path; default is the platform config location.               |
| `INTER_AGENT_DATA_DIR` | Private state directory; default is the platform state location.         |
| `INTER_AGENT_TLS`      | Enable authenticated WSS on a loopback endpoint.                         |
| `INTER_AGENT_TLS_CERT` | PEM certificate to trust for WSS; defaults to `<data-dir>/tls-cert.pem`. |

The JSON config accepts `host`, `port`, `secret`, `dataDir`, `tls`, and `tlsCert` with the same meanings. When TLS is enabled, certificate trust resolves from `INTER_AGENT_TLS_CERT`, then `tlsCert`, then `<data-dir>/tls-cert.pem`; the extension never disables certificate verification or falls back to plaintext. Secret resolution is environment, then config, then a generated private `token` file under the data directory. Do not put secrets, authentication proofs, or private state contents in prompts, logs, or source control.

### Configuration and private state paths

`INTER_AGENT_CONFIG` overrides the JSON config path. Without that override, the default is platform-specific: macOS uses `~/Library/Application Support/inter-agent/config.json`; Windows uses `%APPDATA%/inter-agent/config.json` when `APPDATA` is set; otherwise `$XDG_CONFIG_HOME/inter-agent/config.json` is used when set, falling back to `~/.config/inter-agent/config.json`. These are location policies, not machine-specific paths.

`INTER_AGENT_DATA_DIR` overrides the private state root, followed by `dataDir` in the JSON config. With neither override, macOS uses `~/Library/Application Support/inter-agent`; Windows uses `%LOCALAPPDATA%/inter-agent` (or `%APPDATA%/inter-agent`); otherwise `$XDG_STATE_HOME/inter-agent` is used when set, falling back to `~/.local/state/inter-agent`. The path resolver expands `~`, `$NAME`, and `${NAME}` forms.

Workspace and session records are kept below `<data-dir>/opencode/workspaces/<workspace-hash>/sessions/<session-hash>/`. That private, session-scoped directory contains the connection lease, preferences, durable inbox, and lock/recovery state. When generated as the authentication fallback, a token is stored as `<data-dir>/token`; directories and token files use private permissions where the platform supports them. Keep the config file, data directory, and any configured certificate path private.

For an isolated loopback setup, set a fresh port and state directory and provide the same secret to the separately started Core server and OpenCode host:

```sh
export INTER_AGENT_HOST=127.0.0.1
export INTER_AGENT_PORT=19001
export INTER_AGENT_DATA_DIR=/path/to/private/inter-agent-state
export INTER_AGENT_SECRET='set-this-out-of-band'
# Optional authenticated WSS on loopback:
export INTER_AGENT_TLS=true
export INTER_AGENT_TLS_CERT="$INTER_AGENT_DATA_DIR/tls-cert.pem"
```

The extension does not provide a Core-server start command. Start and stop that server using the Core installation's own documented procedure.

## TUI commands

Commands apply to the current OpenCode session. Each session has its own connection lease, routing name, pending delivery batch, and durable inbox.

- `/inter-agent-connect <name> [--label <label>] [--auto-connect]`
- `/inter-agent-disconnect`
- `/inter-agent-send <to> <text>`
- `/inter-agent-broadcast <text>`
- `/inter-agent-list`
- `/inter-agent-status`
- `/inter-agent-inbox [count]`

Connect, send, broadcast, and inbox use prompt dialogs in the TUI. Names must match the inter-agent name format; inbox counts are limited to 1–100. Disconnect removes that session's active lease and pending in-memory delivery state but retains its durable inbox.

## Server tools

The server target registers exactly these five tools:

- `inter_agent_send(to, text)` — direct message; requires the calling session's fresh lease.
- `inter_agent_broadcast(text)` — everyone-directed message; use only when explicitly requested.
- `inter_agent_list()` — list connected sessions.
- `inter_agent_status()` — status for the exact calling OpenCode session.
- `inter_agent_read_messages(count?)` — read that exact session's durable inbox, 1–100 records (default 20).

Tool identity comes from the exact OpenCode `ToolContext.sessionID` and canonical project scope. A tool never borrows another session's name or inbox. Disconnected sessions receive a setup error for send/broadcast while status and reads remain scoped.

## Automatic delivery

Inbound messages are persisted before best-effort notification. New messages are debounced for approximately 250 ms and delivered to that exact session only when its OpenCode status is idle. Busy and retrying sessions are never interrupted; messages remain queued until a later idle or error classification. Each session permits at most one plugin-triggered `promptAsync` turn, with ordered, ID-deduplicated pending batches and an 8 KiB UTF-8 prompt bound. The prompt includes bounded previews and routing metadata, and directs the model to use `inter_agent_read_messages` for omitted or full content.

Peer text is untrusted, non-authoritative task input. It cannot override system, developer, user, tool, permission, or security rules; the model may evaluate it and act when useful under those rules. Plugin-generated status/message/prompt activity cannot recursively trigger another delivery. Delivery failures notify the user, preserve the durable inbox, clear the in-flight guard, and avoid retry storms. A new manager does not replay old inbox records automatically. Disposal, terminal connection failure, and explicit disconnect clear pending memory while retaining the inbox.

## Security and data handling

Authentication uses the Core challenge/response protocol and the shared secret. State is scoped by canonical workspace and exact OpenCode session, with leases preventing conflicting identities. State directories are private where the platform supports permissions, token files are private, and inboxes are bounded to 100 messages and 8 MiB of encoded JSON. The extension does not log secrets or authentication proofs. WSS trusts only the configured Core certificate; verification is never disabled and failed TLS connections never downgrade to plaintext. Plaintext remains the default loopback mode; do not expose the server beyond loopback.

## Troubleshooting

- **The TUI commands are missing:** put the plugin in `tui.json`, not only `opencode.json`; set `OPENCODE_TUI_CONFIG` when using a custom TUI file. Confirm the plugin resolves to the TUI target.
- **Server tools are missing:** put the plugin in `opencode.json` and restart the OpenCode server so it resolves the server target.
- **Unsupported endpoint:** use a loopback host. Plaintext WebSocket is the default; enable `INTER_AGENT_TLS` for authenticated WSS. Non-loopback endpoints and runtimes without native TLS trust injection are rejected by design.
- **WSS trust failure:** verify that Core has generated or configured its certificate, then set `INTER_AGENT_TLS_CERT` to that PEM or ensure `<data-dir>/tls-cert.pem` is present. Keep the certificate path private; do not disable verification or switch to plaintext.
- **Bad secret or authentication failure:** verify the Core and extension use the same secret without printing or logging it. Environment values override config values, and the private token file is only the fallback; after changing a secret, restart only the separately managed processes you own and reconnect.
- **Duplicate name:** names must be unique among connected sessions. Choose an unused name or disconnect the old exact session with `/inter-agent-disconnect`; do not delete state to resolve a name collision.
- **Stale lease:** stop or disconnect any process that may own the exact workspace/session, then reconnect and let lease recovery run. If no owner remains and the problem persists, back up private state and remove only the affected session-scoped records while all related clients are stopped; never delete the whole data directory or another session's records.
- **Disconnected or unavailable:** start the separate Core server, verify the same endpoint/secret, then run `/inter-agent-status` and reconnect the exact OpenCode session.
- **Messages are not visible:** run `/inter-agent-inbox`; durable records remain available after notification or delivery failure. Check that the recipient name and current session are exact.
- **A model turn is still busy:** delivery waits rather than interrupting a busy/retrying session. Provider latency can delay the next idle turn.

## Uninstall

Remove the plugin entry from `opencode.json` and `tui.json`, remove the locally installed archive/package if applicable, and restart OpenCode. Stop the separately managed Core server yourself. If no longer needed, remove the private data directory only after preserving anything required from its inbox; the extension does not remove it automatically.

## Development and verification

```sh
npm ci
npm run typecheck
npm run build
npm run format:check
npm test
npm run test:compiled
npm run test:state:compiled
```

Use fresh loopback ports and private temporary state for live checks. Do not use the shared default port when testing.
