# Agent Instructions

This repository contains the OpenCode extension for the inter-agent message bus.

- Keep routine OpenCode operation inside TypeScript/Bun. Do not add a Python runtime helper or subprocess bridge.
- Preserve separate `./tui` and `./server` package targets; OpenCode rejects a module that exports both targets.
- Treat OpenCode `1.18.15` as the initial validated host target until broader compatibility is demonstrated.
- Do not auto-start or own the lifecycle of the inter-agent server.
- Keep peer messages subject to normal local instructions, permissions, and security rules.
- Keep secrets and authentication proofs out of logs, OpenCode KV, connection records, and inbox records.
- Update `README.md` when public behavior, installation, configuration, commands, tools, or compatibility changes.
- Run the package checks and relevant live acceptance checks before declaring a change complete.
