# Home connect and compact delivery execution plan

Status: implementation and acceptance complete; release handoff pending. No commit, push, or publication is authorized for the agent.

Research basis: `docs/home-connect-and-synthetic-delivery-research.md`.

## Goal

1. Allow `/inter-agent-connect` before the user has submitted an initial OpenCode prompt.
2. Keep automatic-delivery safety context visible to the model but hidden from the normal transcript.
3. Show a compact OpenCode-friendly `[inter-agent-message]` summary instead of verbose routing and safety details.

## Current local implementation

The working tree already contains an uncommitted candidate implementation:

- `src/tui.ts`
  - validates connect arguments before creating a session;
  - creates an empty session when the current route is `home`;
  - navigates using the returned session ID and then uses the existing lease/connection controller;
  - rejects overlapping connect attempts and route changes during creation;
  - sends synthetic safety/context text followed by a compact visible summary.
- `tests/tui.test.ts`
  - covers Home session creation and lease identity;
  - covers synthetic safety context, compact visible summaries, and the total prompt-size bound.
- `README.md`
  - documents Home connect and compact delivery behavior.

Verified locally:

- Typecheck and build passed.
- Test suite passed: 91/91.
- Format and diff checks passed.
- Isolated real-host OpenCode 1.18.21 UAT passed for Home connect, compact transcript rendering, automatic model delivery, and inbox tool use.

## Execution

### 1. Independent review

Review the current diff against the research facts and project constraints.

Confirm:

- invalid connect input cannot create an OpenCode session;
- one Home connect creates at most one session;
- the returned session ID, not reactive route state, scopes the controller and lease;
- route-change and session-create failures cannot claim a lease;
- Core lifecycle remains externally owned;
- the synthetic part retains all safety/routing information needed by the model;
- the visible summary is bounded, contains no internal session UUIDs, and preserves sender/kind/message preview;
- the combined UTF-8 delivery payload remains within 8 KiB;
- existing busy/idle, deduplication, durability, and failure semantics remain unchanged.

Deliverable: findings ordered by severity, or an explicit no-findings result. Do not edit files, commit, push, or publish.

### 2. Correct review findings

If review reports defects, make only the required corrections and add focused regression coverage. Do not refactor unrelated code.

Deliverable: changed paths, rationale, and focused verification results. Do not commit, push, or publish.

### 3. Compatibility acceptance

Run a fresh isolated OpenCode 1.18.15 UAT using the built checkout target and a separately managed temporary Core server.

Verify in order:

1. Start on the no-session landing screen.
2. Run `/inter-agent-connect <unique-name> --auto-connect` without first submitting a normal prompt.
3. Confirm exactly one empty OpenCode session is created and the exact inter-agent identity is connected.
4. Send an inbound direct message while idle.
5. Confirm the popup appears.
6. Confirm the normal transcript shows only the compact `[inter-agent-message]` summary.
7. Confirm the hidden synthetic safety/context part still reaches the model and the automatic turn may use `inter_agent_read_messages`.
8. Confirm the turn returns idle with `pending=0` and the durable inbox retained.
9. Restart OpenCode and confirm opt-in auto-connect restores the same session preference without replaying old inbox messages.
10. Stop only temporary processes owned by the test and preserve concise evidence.

If OpenCode 1.18.15 cannot be run in the environment, report that as a blocker; do not substitute source inspection or a fake API for acceptance.

### 4. Final package gate

After review findings are closed and 1.18.15 acceptance passes:

- run the package's documented typecheck, build, test, format, and packed-artifact checks once;
- verify the README matches the accepted runtime behavior;
- verify only intended files are changed;
- prepare a release/version recommendation for user approval.

Do not commit, push, publish, or edit ecosystem/sibling repositories without separate user approval.

## Acceptance criteria

- First-use connect requires no initial user prompt.
- No invalid or overlapping connect attempt creates multiple sessions or claims a lease.
- Visible delivery is compact and OpenCode-friendly.
- Safety rules and bounded routing metadata remain model-visible.
- Automatic delivery, durable inbox, session isolation, deduplication, and failure handling remain intact.
- OpenCode 1.18.15 real-host acceptance passes.
- All final package gates pass.
