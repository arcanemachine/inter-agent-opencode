# Home connect and synthetic delivery research

Status: historical compatibility research for the Home-connect and compact-delivery implementation.

## Compatibility facts

OpenCode `1.18.15` provides the v2 session client used by the extension, including `client.session.create()` and `route.navigate("session", { sessionID })`. The TUI client is bound to the current project directory, so an empty session uses the active OpenCode project context.

OpenCode text prompt parts support `synthetic: true`. The TUI omits synthetic user text from the normal message rendering, while model conversion retains it. This supports an ordered pair of parts:

```ts
[
  { type: "text", text: safetyContext, synthetic: true },
  { type: "text", text: compactVisibleSummary },
];
```

Synthetic text remains stored and model-visible. It must never contain secrets or authentication material.

## Design decisions

- Parse and validate connection arguments before creating an OpenCode session.
- Reuse the current session ID when the route already names a session.
- From Home, create one empty session and use the returned ID for navigation, controller lookup, and lease scope.
- Reject overlapping connection attempts and route changes during session creation.
- Preserve Core lifecycle ownership outside the extension.
- Keep full safety instructions and bounded routing context in the synthetic part.
- Keep the visible summary compact and exclude internal session IDs and sender IDs.
- Preserve the durable inbox as the authority for full message content.

## Source anchors

The implementation lives in `src/tui.ts`. Unit coverage lives in `tests/tui.test.ts`. Public installation and usage instructions live in `README.md`.
