### 2. Verify clean installation and runtime behavior under Bun

- Evidence/criteria: run the clean installation and runtime checks under Bun and record the results before considering this follow-up complete.
- Executor verification attempt: Bun is unavailable in the verification environment. `bun --version` and `command -v bun` found no executable, and `asdf list bun` reported `No such plugin: bun`. No Bun installation, package install, build/typecheck/format/test/import, or runtime result is claimed; this follow-up remains open.

### 3. Verify Windows locking, permissions, and symlink protections

- Evidence/criteria: run the Windows filesystem checks and record locking, permission, and symlink-protection results before considering this follow-up complete.

### 4. Repeat provider-backed OpenCode UAT with enough latency budget

- Evidence/criteria: observe a busy-to-idle queued second delivery and isolate model tool execution evidence; record any remaining provider-latency limitation.
