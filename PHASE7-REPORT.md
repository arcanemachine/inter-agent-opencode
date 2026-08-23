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
- `TODO.md` records the verified Bun and provider-backed busy-to-idle/tool UAT follow-ups; deferred environment-specific validation is kept in `TODO-LATER.md`.

## Standalone Bun follow-up verification

The official Bun `bun-v1.3.14/bun-linux-x64-baseline.zip` release asset was acquired from the GitHub release metadata and verified before extraction. The API-reported and computed SHA-256 digest was `a063908ae08b7852ca10939bbdc6ceed3ddabce8fb9402dce83d65d73b36e6c7`. Bun reported `1.3.14` (`1.3.14+0d9b296af`). The available OpenCode checkout contains immutable release-version commit `1ec6bdc8c666e315ba85ef5276fac9b0eb7ba109` (`sync release versions for v1.18.15`), but no `v1.18.15` tag ref; this supplies a source reference, while the cached runtime binary's build provenance remains unproven.

- A clean disposable copy of accepted child `0de9bfb` installed 31 packages with Bun in about 0.76 s.
- Bun `run build`, `run typecheck`, and `run format:check` passed in about 0.87 s, 0.81 s, and 0.67 s respectively. An initial unadjusted disposable-copy attempt exited 126 because the asdf Node shim had no version selection file; rerunning with the existing Node installation ahead of that shim passed, with no product defect identified.
- The existing Node regression gate `npm test` passed 90/90 in about 21.2 s with the read-only Core checkout and direct `uv` runtime supplied through temporary test paths.
- Bun focused compiled tests (`bun test dist-tests/tests/config.test.js dist-tests/tests/package.test.js`) passed 12/12 in about 0.08 s. Direct Bun imports of compiled `./tui` and `./server` passed in separate processes, as did separate packed-consumer imports after Bun installed the generated archive. A native Bun WSS CA-injection smoke passed without a listener or credentials.
- No source or lockfile changes were made to the accepted child; only this report and `TODO.md` record the evidence.

## Windows filesystem follow-up attempt

The executor environment is Linux, not Windows: `uname -a` reported a Linux 6.8 x86_64 kernel, `/etc/os-release` reported Debian 13, `OSTYPE=linux-gnu`, and Node reported `process.platform=linux`. No Windows filesystem checks were run or emulated, so no Windows locking, permission, or symlink-protection result is claimed. The follow-up remains open. No source files were changed; only this report and `TODO.md` record the limitation.

## Provider-backed OpenCode UAT follow-up

The exact OpenCode `1.18.15` runtime and the environment-provided Synthetic provider were available. An isolated Core server and OpenCode server ran on fresh loopback ports with private temporary roots; the shared `127.0.0.1:16837` endpoint was not used. The provider model was `synthetic/hf:openai/gpt-oss-120b`; no credentials, prompts, message contents, session IDs, model output, or private paths were retained.

- `opencode --version` reported `1.18.15`; the provider-backed `session.prompt_async` request returned HTTP 204.
- While the provider session reported `busy`, two independently submitted inbound messages both succeeded. The first busy-to-idle transition occurred about 7.9 seconds after the first inbound submission; the second inbound was submitted about 0.6 seconds after the first. After idle, the queued delivery turn entered `busy` about 0.2 seconds later and returned to `idle` about 4.8 seconds after that.
- Sanitized session metadata contained three user turns: the initial provider prompt, the busy provider prompt, and exactly one automatic delivery prompt. Completed model tool parts were two `inter_agent_status` calls and one `bash` call; the automatic delivery turn separately completed exactly one `inter_agent_read_messages` call reporting two inbox records, followed by an assistant completion.
- A further 15-second idle observation saw no additional busy transition, duplicate delivery, or recursive delivery turn. This run did not leave a provider-latency limitation for the required busy-to-idle evidence.

All owned Core/OpenCode processes, TUI session, listeners, private temporary roots, logs, and generated state were terminated or removed. No source files or protected repositories were modified.

## Limitations and explicit non-goals

Windows locking/permissions/symlink behavior, exact immutable OpenCode `1.18.15` source provenance, OpenCode versions outside `>=1.18.15 <1.19.0`, non-loopback transport, server auto-start/lifecycle ownership, publication, release tags, remote pushes, ecosystem changes, protocol/Core changes, and Phase 8 work are not included. The extension does not remove Core state or inboxes during uninstall.

## Cleanup and boundary status

All owned OpenCode/Core processes, PTY sessions, fresh-port listeners, and Phase 7 temporary UAT roots were terminated or removed after each run. The pre-existing shared `127.0.0.1:16837` listener was observed but never accessed, changed, or terminated. The Core and OpenCode source repositories were not modified.
