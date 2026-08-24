# Home connect and compact delivery

Status: implemented and released in `0.2.1`.

## Purpose

The extension supports two user-visible behaviors:

1. `/inter-agent-connect` can be selected before the user submits an initial OpenCode prompt.
2. Automatic delivery keeps model context and the normal transcript separate.

## Implemented behavior

`src/tui.ts` validates connection arguments before it creates anything. On the Home route it creates one empty OpenCode session, verifies that the route did not change, navigates with the returned session ID, and then uses the existing lease and connection controller. Overlapping attempts are rejected.

Automatic delivery sends two ordered text parts. The synthetic part contains the safety rules, bounded routing data, and preview metadata for the model. The normal part contains a compact `[inter-agent-message]` summary. UTF-8 truncation, omitted-ID summaries, and the combined 8 KiB limit are bounded for arbitrary message content.

The extension does not start or stop Core. It keeps identity, leases, inboxes, and delivery state scoped to the exact workspace and OpenCode session.

## Acceptance record

- OpenCode `1.18.15` real-host acceptance passed for Home connection, automatic delivery, inbox access, and session restoration.
- The package test suite passes.
- Typecheck, build, formatting, and packed-artifact checks pass.

## Maintenance notes

Keep the public setup path in `README.md`. Keep source-level compatibility evidence and design history in `home-connect-and-synthetic-delivery-research.md`. Do not put release history, transient test identifiers, or secrets in the onboarding guide.
