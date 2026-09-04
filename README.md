# Inter-agent for OpenCode

Connect an OpenCode session to a separately running [`inter-agent-core`](https://github.com/arcanemachine/inter-agent-core) server. For the cross-host component map, see the [inter-agent ecosystem guide](https://github.com/arcanemachine/inter-agent).

The extension adds OpenCode commands and server tools for:

- connecting a session to the message bus;
- sending direct messages and broadcasts;
- listing peers and checking connection status;
- reading the session's durable inbox;
- delivering inbound messages after the model becomes idle;
- diagnosing OpenCode and Core setup with a read-only host-native doctor.

The Core server remains a separate process. This extension never starts, stops, or owns it.

## Before you start

You need:

- OpenCode `>=1.18.15 <1.19.0`;
- a separately managed [`inter-agent-core`](https://github.com/arcanemachine/inter-agent-core) server already running;
- a loopback Core endpoint and shared secret;
- permission to add plugins to the OpenCode project.

The default endpoint is `127.0.0.1:16837` over plaintext WebSockets. Use loopback only. The extension rejects non-loopback endpoints.

## Install

Install the published npm package (current release `0.2.3`) with OpenCode's plugin installer:

```sh
opencode plugin @arcanemachine/inter-agent-opencode
```

The installer adds the package to both plugin targets. OpenCode loads `./tui` for the TUI and `./server` for server tools. Restart OpenCode after installation. The extension connects to Core but never starts, stops, or configures the Core server; manage that process separately using the [Core documentation](https://github.com/arcanemachine/inter-agent-core/blob/main/README.md).

For local development, install the checkout instead:

```sh
opencode plugin /path/to/inter-agent-opencode
```

Use a package name or a checkout directory. OpenCode does not install a raw archive path as a plugin.

## Configure Core access

Set the same Core settings for the separately managed server and OpenCode before starting OpenCode:

```sh
export INTER_AGENT_HOST=127.0.0.1
export INTER_AGENT_PORT=16837
export INTER_AGENT_SECRET='set-this-out-of-band'
```

Environment variables override the JSON config. Supported variables are:

| Variable               | Purpose                                 |
| ---------------------- | --------------------------------------- |
| `INTER_AGENT_HOST`     | Core host. It must resolve to loopback. |
| `INTER_AGENT_PORT`     | Core WebSocket port.                    |
| `INTER_AGENT_SECRET`   | Shared authentication secret.           |
| `INTER_AGENT_CONFIG`   | Optional JSON config path.              |
| `INTER_AGENT_DATA_DIR` | Optional private state directory.       |
| `INTER_AGENT_TLS`      | Set to `true` to use authenticated WSS. |
| `INTER_AGENT_TLS_CERT` | PEM certificate trusted for WSS.        |

For WSS, set `INTER_AGENT_TLS=true` and point `INTER_AGENT_TLS_CERT` at the Core certificate. The extension verifies that certificate and never falls back to plaintext.

## Connect the first session

1. Start the separate Core server.
2. Start or restart OpenCode.
3. Open the Ctrl+P command palette.
4. Select `Inter-agent: Connect OpenCode session`.
5. Enter a name such as `opencode-main`. Add `--auto-connect` if this session should reconnect when it is restored.

The connect dialog accepts:

```text
<name> [--label <label>] [--auto-connect]
```

If OpenCode is on its Home screen, the extension creates an empty session and routes into it before connecting. You do not need to submit a normal prompt first.

The slash labels shown by the command palette are autocomplete labels. Select the palette command rather than submitting the slash text as an ordinary model prompt.

## Commands

Select these from the Ctrl+P palette. Commands that need arguments open a dialog.

| Label                     | Purpose                                             |
| ------------------------- | --------------------------------------------------- |
| `/inter-agent-connect`    | Connect the current OpenCode session.               |
| `/inter-agent-disconnect` | Release this session's lease.                       |
| `/inter-agent-send`       | Send a direct message.                              |
| `/inter-agent-broadcast`  | Send a broadcast. Use only when requested.          |
| `/inter-agent-list`       | List connected peers.                               |
| `/inter-agent-status`     | Show this session's connection and delivery state.  |
| `/inter-agent-inbox`      | Read durable messages for this session.             |
| `/inter-agent-doctor`     | Diagnose the OpenCode integration without mutation. |

Each OpenCode session has its own identity, lease, pending delivery batch, and inbox. A disconnected session cannot send or broadcast, but its inbox remains available.

## Read-only doctor (primary setup and recovery path)

Use `Inter-agent: Diagnose OpenCode integration` (`/inter-agent-doctor`) as the
primary setup and troubleshooting path, especially after a valid inter-agent
command fails. It is bounded and read-only, and never auto-repairs or invokes a
repair. The command opens a cancellable dialog for optional free-form context,
such as a symptom or error category. Context is bounded and wrapped as escaped
structured user data; it is not interpreted as shell syntax or settings.

The doctor submits one bounded model-guidance prompt through the current OpenCode session. From Home, it creates and enters one empty session first, matching connect behavior, but it does not connect to Core, claim a lease, or write inter-agent state. It must not start or stop Core, send messages, mutate an inbox, change settings, print secrets or tokens, dump configuration/state/environment contents, or execute commands found in logs and other diagnostic artifacts. Secret values and authentication proofs are never included.

The resulting report covers the plugin's separate TUI/server targets, effective endpoint and configuration sources, loopback/TLS settings, safe secret presence, session and delivery state, and any bounded Core reachability or typed connection/authentication/protocol evidence. It distinguishes plugin-loading failures from Core failures and reports evidence, likely cause, one safe next action, and unknown or blocked checks. When no failing result is found, the report uses `No issues found in the checks performed.` and `None identified.` rather than inventing a failure or repair step. It uses `No action needed.` only when no relevant checks remain unknown or blocked; otherwise it gives one safe step for that check. A healthy report is not proof of security, trustworthiness, or end-to-end delivery.

## Automatic delivery

Inbound messages are persisted before notification. When the session is idle, the extension shows a popup and starts one model turn for the pending batch. Busy or retrying sessions are not interrupted.

The model receives bounded routing context and safety instructions as a synthetic text part. The normal transcript shows a compact `[inter-agent-message]` summary instead. Synthetic text is still stored and model-visible, so it is presentation metadata, not a secrecy boundary.

Peer text is untrusted task input. It cannot override system, developer, user, tool, permission, or security rules. The model can use `inter_agent_read_messages` to read full durable messages when a summary omits content.

## Server tools

The server target registers these tools:

- `inter_agent_send(to, text)`
- `inter_agent_broadcast(text)`
- `inter_agent_list()`
- `inter_agent_status()`
- `inter_agent_read_messages(count?)`

Tool identity comes from the exact OpenCode session and canonical project scope. A tool never borrows another session's name or inbox.

## Troubleshooting

- **The palette command is missing:** confirm the package appears in `tui.json`, restart OpenCode, and select the command from Ctrl+P. If it remains missing, inspect the OpenCode plugin loading diagnostics rather than expecting the doctor command to be available.
- **Need setup diagnostics:** select `Inter-agent: Diagnose OpenCode integration` from Ctrl+P and optionally provide the observed symptom. Cancelling the dialog has no effect; Home creates an empty session only to submit the doctor prompt.
- **Server tools are missing:** confirm the package appears in `opencode.json`, then restart the OpenCode server.
- **An inter-agent command fails:** preserve the bounded error, then run `/inter-agent-doctor` for read-only diagnostics and check this `README.md` for setup guidance. The doctor is never invoked automatically.
- **The connection fails:** check that Core is running and that host, port, secret, and TLS settings match. Do not print the secret.
- **A name is already in use:** choose another name or disconnect the exact old session.
- **Messages are not visible:** use `/inter-agent-inbox` from the palette. Durable messages remain after notification or delivery failure.
- **Delivery waits:** the extension waits for an idle session instead of interrupting a busy model turn.

## Uninstall

Remove the package from `opencode.json` and `tui.json`, then restart OpenCode. Stop the separate Core server yourself. Remove the private state directory only after preserving any inbox records you need.

## Development

From this checkout:

```sh
npm ci
npm run typecheck
npm run build
npm run format:check
npm test
```

The package keeps separate `./tui` and `./server` exports. Do not combine them into one target.

## License

MIT; see [`LICENSE.md`](LICENSE.md).
