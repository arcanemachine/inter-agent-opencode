# Agent Instructions

This repository contains the OpenCode extension for the inter-agent message bus.

## Release tags

Use plain annotated semantic-version tags: `vMAJOR.MINOR.PATCH` (for example,
`v0.2.4`). Do not use historical prefixed tag formats for new releases.

Keep the package version, README release references, changelog, and
version-sensitive tests synchronized. Prepare and verify the child commit and
tag before updating the ecosystem submodule pin. The user performs all pushes
and publication.

- Keep routine OpenCode operation inside TypeScript/Bun. Do not add a Python runtime helper or subprocess bridge.
- Preserve separate `./tui` and `./server` package targets; OpenCode rejects a module that exports both targets.
- Treat OpenCode `1.18.15` and `1.19.0` as validated host targets; validate newer lines before widening the supported range past them.
- Do not auto-start or own the lifecycle of the inter-agent server.
- Keep peer messages subject to normal local instructions, permissions, and security rules.
- Keep secrets and authentication proofs out of logs, OpenCode KV, connection records, and inbox records.
- Update `README.md` when public behavior, installation, configuration, commands, tools, or compatibility changes.
- Run the package checks and relevant live acceptance checks before declaring a change complete.
