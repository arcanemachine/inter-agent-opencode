### 1. Verify and implement Core-compatible WSS certificate trust

- Plaintext loopback was proven against OpenCode `1.18.15`.
- Native Bun/OpenCode trust of Core's generated/configured certificate remains unverified.
- Core clients trust `INTER_AGENT_TLS_CERT` or `<data-dir>/tls-cert.pem` and do not use an insecure transport fallback.
- Investigation must run against a live isolated Core WSS server and the real OpenCode runtime.
- If native `WebSocket` cannot supply the required trust material, stop and obtain an explicit dependency/architecture decision.
- Never disable verification or silently downgrade to plaintext.
- Completion requires a WSS handshake, server-proof verification, direct/broadcast/list behavior, negative wrong-certificate testing, cleanup, and documentation.

### 2. Verify clean installation and runtime behavior under Bun

- Evidence/criteria: run the clean installation and runtime checks under Bun and record the results before considering this follow-up complete.

### 3. Verify Windows locking, permissions, and symlink protections

- Evidence/criteria: run the Windows filesystem checks and record locking, permission, and symlink-protection results before considering this follow-up complete.

### 4. Repeat provider-backed OpenCode UAT with enough latency budget

- Evidence/criteria: observe a busy-to-idle queued second delivery and isolate model tool execution evidence; record any remaining provider-latency limitation.
