### 2. Verify clean installation and runtime behavior under Bun (verified)

- Evidence/criteria: run the clean installation and runtime checks under Bun and record the results before considering this follow-up complete.
- Executor verification: pass with Bun `1.3.14`. A clean disposable copy installed 31 packages under Bun; Bun build, typecheck, and format checks passed; the Node regression gate passed 90/90; focused Bun tests passed 12/12; direct and packed-consumer split-target imports passed in separate Bun processes; and the native Bun WSS CA-injection smoke passed. The available OpenCode checkout contains immutable release-version commit `1ec6bdc8c666e315ba85ef5276fac9b0eb7ba109` (`sync release versions for v1.18.15`), but no `v1.18.15` tag ref; this supplies a source reference, while the cached runtime binary's build provenance remains unproven.

### 3. Repeat provider-backed OpenCode UAT with enough latency budget (verified)

- Evidence/criteria: observe a busy-to-idle queued second delivery and isolate model tool execution evidence; record any remaining provider-latency limitation.
- Executor verification: pass. Exact OpenCode `1.18.15` and the Synthetic provider model `synthetic/hf:openai/gpt-oss-120b` were available. A provider-backed turn was busy while two inbound sends succeeded; status transitioned to idle, then one queued delivery turn became busy and idle. Sanitized session metadata showed one automatic delivery prompt, two inbound records read by `inter_agent_read_messages`, completed model tool calls, and no duplicate delivery during a further 15-second idle observation.
