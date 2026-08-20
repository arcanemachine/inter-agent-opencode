# Phase 7 completion report

## Scope and accepted baseline

Phase 7 performed initial verification and documentation for the accepted Phase 1–6 baseline at commit `afaa4b1` (`feat: deliver inbound OpenCode turns`). No implementation or protocol/Core changes were made. The package remains OpenCode `1.18.15`-targeted, loopback/plaintext-only, split into independent `./tui` and `./server` exports, and independent of Core-server lifecycle.

## Reference provenance

- The exact Core version and commit used for verification were not recorded in the existing Phase 7 evidence. The evidence identifies an isolated, read-only Core checkout supplied through `INTER_AGENT_CORE_ROOT`, but no immutable Core reference was retained; no version or commit is inferred here.
- The runtime OpenCode host version `1.18.15` was recorded. The exact clean OpenCode source reference (checkout, commit, or other immutable source identifier) used for verification and UAT was not recorded.

## Verification evidence

All commands were run against a clean temporary copy with a clean dependency install. The isolated Core checkout was read-only and supplied through `INTER_AGENT_CORE_ROOT` for live tests.

| Check                                       | Result                                                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `npm ci --no-audit --no-fund`               | Pass; 31 packages installed in about 0.8 s                                                           |
| `npm run typecheck`                         | Pass; about 1.0 s                                                                                    |
| `npm run build`                             | Pass; about 1.0 s                                                                                    |
| `npm run format:check`                      | Pass                                                                                                 |
| `npm test`                                  | Pass; 87/87, about 20.2 s                                                                            |
| `npm run test:compiled`                     | Pass; 87/87, about 19.2 s                                                                            |
| `npm run test:state:compiled`               | Pass; 30/30, about 7.8 s                                                                             |
| `npm pack --dry-run`                        | Pass; 20 files                                                                                       |
| packed archive allowlist                    | Pass; JavaScript/declarations and public docs only; no source maps, source, tests, or `node_modules` |
| offline packed install and split imports    | Pass; both `./tui` and `./server` imported from the packed consumer install                          |
| dependency tree                             | Pass; `npm ls --omit=dev --all`                                                                      |
| dependency audit                            | Pass; offline `npm audit --omit=dev --audit-level=high`                                              |
| packed private-path/obvious-credential scan | Pass                                                                                                 |
| `git diff --check`                          | Pass                                                                                                 |

The full and compiled suites cover the accepted protocol, authentication, endpoint rejection, atomic state, lease/recovery, exact-session routing, inbox durability, server tools, reconnect, TUI command, and automatic-delivery behavior.

An isolated live protocol/Core run used fresh loopback ports and temporary roots under the Phase 7 namespace. The compiled live protocol and TUI tests passed 2/2 in about 2.0 s: authenticated control handshake, direct send, broadcast, list, wrong-secret rejection, two exact TUI listeners, inbox isolation, disconnect, Core restart, and reconnect.

## Real OpenCode 1.18.15 UAT

A real OpenCode `1.18.15` server and PTY TUI were started with fresh loopback ports and private temporary roots. Server plugin configuration used a local file plugin in `opencode.json`; TUI configuration used the separate `tui.json` through `OPENCODE_TUI_CONFIG`. This corrected the earlier activation diagnosis: server configuration alone does not load TUI commands.

Observed evidence:

- The real TUI loaded the plugin and `/inter-agent-connect` connected exact session A as `agent-a` and a second foreground session B as `agent-b`; the first listener remained in the background.
- Native `/inter-agent-list` produced the connected peer listing. A native `/inter-agent-status` toast was not captured in the bounded PTY view, so no stronger status-command claim is made.
- Core control direct delivery to background A and broadcast delivery to A and foreground B were accepted. The real OpenCode message API showed assistant completions for both exact sessions.
- A real server `prompt_async` request returned HTTP 204. A provider model turn produced one `inter_agent_status` tool part, proving the native server target/tool was available in the real host. A broader tool matrix was not claimed.
- A bounded busy test observed the real session in `busy`/`retry` while a second message was sent. The provider remained busy at the end of the bounded observation window, so queued busy-to-idle drain completion is not claimed. This is a provider-latency limitation, not an implementation result.

No secrets, authentication proofs, message contents, session IDs, or private temporary paths were retained in this report.

## Core-compatible WSS follow-up

The follow-up was implemented from accepted child commit `56768d0cfe94e720b76605ebded742acf2a5b959`. The read-only Core checkout used for live verification was `561b05e9c7f3422dd45ddfc935c39667a4586bb5`; the Core checkout remained clean. The OpenCode PTY displayed version `1.18.15` during the run.

- Loopback TLS is now a supported endpoint mode. The native factory reads the certificate selected by `INTER_AGENT_TLS_CERT`, configured `tlsCert`, or `<data-dir>/tls-cert.pem` and passes its bytes as Bun's native `WebSocket` `tls.ca` option.
- A runtime without the native Bun TLS trust API fails closed with no insecure option and no plaintext fallback.
- An isolated live Core WSS server accepted the real OpenCode runtime's authenticated handshake and server-proof verification. The live probe exercised list, direct delivery, and broadcast delivery, then rejected a wrong certificate. Both the environment certificate source and the data-directory default source resolved to `wss://` and passed.
- The focused unit suite verifies certificate source precedence, native CA injection, and fail-closed behavior when TLS trust injection is unavailable. Full tests passed 90/90.

All owned WSS Core/OpenCode processes, listeners, generated certificates, and temporary roots were removed after verification. No certificate or key contents were retained.

## Documentation delivered

- `README.md` now documents local installation/packing, separate server and TUI configuration, environment and JSON settings, commands, all five server tools, loopback/plaintext security, automatic delivery/reaction policy, troubleshooting, compatibility, development checks, and uninstall.
- `TODO.md` records the remaining clean standalone Bun, Windows filesystem, and longer provider-backed busy-to-idle/tool UAT follow-ups.

## Standalone Bun follow-up attempt

The executor environment does not provide Bun: `bun --version` and `command -v bun` found no executable, and `asdf list bun` reported `No such plugin: bun`. Consequently, no clean Bun installation, package install, build/typecheck/format/test/import, or runtime result is claimed. The follow-up remains open. No source files were changed; only this report and `TODO.md` record the limitation.

## Windows filesystem follow-up attempt

The executor environment is Linux, not Windows: `uname -a` reported a Linux 6.8 x86_64 kernel, `/etc/os-release` reported Debian 13, `OSTYPE=linux-gnu`, and Node reported `process.platform=linux`. No Windows filesystem checks were run or emulated, so no Windows locking, permission, or symlink-protection result is claimed. The follow-up remains open. No source files were changed; only this report and `TODO.md` record the limitation.

## Limitations and explicit non-goals

Clean standalone Bun installation, Windows locking/permissions/symlink behavior, OpenCode versions outside `>=1.18.15 <1.19.0`, non-loopback transport, server auto-start/lifecycle ownership, publication, release tags, remote pushes, ecosystem changes, protocol/Core changes, and Phase 8 work are not included. The extension does not remove Core state or inboxes during uninstall.

## Cleanup and boundary status

All owned OpenCode/Core processes, PTY sessions, fresh-port listeners, and Phase 7 temporary UAT roots were terminated or removed after each run. The pre-existing shared `127.0.0.1:16837` listener was observed but never accessed, changed, or terminated. The Core and OpenCode source repositories were not modified.
