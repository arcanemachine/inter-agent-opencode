### 2. Verify clean installation and runtime behavior under Bun (verified)

- Evidence/criteria: run the clean installation and runtime checks under Bun and record the results before considering this follow-up complete.
- Executor verification: pass with Bun `1.3.14`. A clean disposable copy installed 31 packages under Bun; Bun build, typecheck, and format checks passed; the Node regression gate passed 90/90; focused Bun tests passed 12/12; direct and packed-consumer split-target imports passed in separate Bun processes; and the native Bun WSS CA-injection smoke passed. The exact OpenCode `1.18.15` source tag was not present in the available OpenCode checkout, so host-source provenance remains limited to the accepted package boundary.

### 3. Deferred: verify Windows locking, permissions, and symlink protections

- Priority: deferred until a real Windows host or CI runner is available; this is not a blocker for the current loopback OpenCode `1.18.15` scope. Do not emulate Windows checks on Linux.
- Evidence/criteria: run the Windows filesystem checks and record locking, permission, and symlink-protection results before considering this follow-up complete.
- Executor verification attempt: Windows is unavailable. The executor reports Linux (`uname`: `Linux ... x86_64`, `/etc/os-release`: Debian 13, `OSTYPE=linux-gnu`; Node `process.platform=linux`). No Windows filesystem checks were run or emulated, and no Windows locking, permission, or symlink-protection result is claimed; this follow-up remains deferred.

### 4. Repeat provider-backed OpenCode UAT with enough latency budget (verified)

- Evidence/criteria: observe a busy-to-idle queued second delivery and isolate model tool execution evidence; record any remaining provider-latency limitation.
- Executor verification: pass. Exact OpenCode `1.18.15` and the Synthetic provider model `synthetic/hf:openai/gpt-oss-120b` were available. A provider-backed turn was busy while two inbound sends succeeded; status transitioned to idle, then one queued delivery turn became busy and idle. Sanitized session metadata showed one automatic delivery prompt, two inbound records read by `inter_agent_read_messages`, completed model tool calls, and no duplicate delivery during a further 15-second idle observation.
