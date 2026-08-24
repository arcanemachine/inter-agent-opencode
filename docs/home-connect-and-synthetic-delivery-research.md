# Home connect and synthetic delivery research

Status: source research record for the pre-implementation baseline. The current candidate and its remaining acceptance work are tracked in `docs/home-connect-and-compact-delivery-plan.md`.

## Evidence boundary

- Extension baseline: `src/tui.ts` at `60d6f38`.
- OpenCode compatibility target: `1.18.15`, source commit `284214c78d32a09fd9c729bdefc07be50f74eb40`.
- The installed `@opencode-ai/plugin` and `@opencode-ai/sdk` packages are both `1.18.15`.
- No extension source, configuration, or TODO file was changed for this research.

## A. Connect from Home

### Confirmed baseline behavior

At the researched baseline identified above:

- `src/tui.ts:183-187` accepts only a `session` route with a `sessionID`; otherwise it throws `Open or create an OpenCode session first`.
- `TuiManager.connect()` at `src/tui.ts:995-1001` calls that route check before parsing the connect arguments or calling the session controller. Therefore `/inter-agent-connect` cannot connect from Home.
- The connect command at `src/tui.ts:1178-1187` is registered through the TUI prompt dialog.
- Startup restoration at `src/tui.ts:1252-1283` runs only when the current route is already a session and only reconnects a persisted preference with `autoConnect: true`. `--auto-connect` therefore affects later restoration; it cannot solve first use from Home.

### Confirmed OpenCode 1.18.15 API support

- `TuiPluginApi.client` is the v2 `OpencodeClient` and `TuiPluginApi.route.navigate(name, params)` is public in `packages/plugin/src/tui.ts:581-615`.
- The v2 SDK exposes `client.session.create(parameters?, options?)`. Its parameters are optional, its body fields are optional, and a successful request returns HTTP 200 with a `Session` containing an `id` (`packages/sdk/js/src/v2/gen/sdk.gen.ts:3405-3457` and `packages/sdk/js/src/v2/gen/types.gen.ts:9473-9513`).
- The TUI-created SDK client is bound to the current directory through `createOpencodeClient({ directory })`, which adds the OpenCode directory header (`packages/tui/src/context/sdk.tsx:11-31` and `packages/sdk/js/src/v2/client.ts:50-92`). An empty `session.create()` therefore uses that client context.
- The server create endpoint accepts no payload or an optional create payload, creates a session without sending a prompt, and returns its session record (`packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:203-213` and `packages/opencode/src/session/session.ts:669-691`).
- `api.route.navigate("session", { sessionID })` maps to OpenCode's internal session route synchronously (`packages/tui/src/plugin/adapters.tsx:41-55,196-205`).
- OpenCode itself uses the same v2 client to create a session and then uses the returned `res.data.id`; its normal prompt path delays navigation by 50 ms only after the subsequent prompt submission. This proves the create and route surfaces exist, but it does not prove the proposed plugin flow in a real host.

### Candidate flow

A source-compatible flow for OpenCode 1.18.15 is:

1. Parse and validate connect arguments before creating anything.
2. Reuse the current session ID when already on a session route.
3. On Home only, call `api.client.session.create({}, { throwOnError: true })` and use `created.data.id` directly.
4. Navigate with `api.route.navigate("session", { sessionID })`.
5. Call the existing controller for that returned ID so the existing identity, lease, endpoint, authentication, and cleanup rules remain authoritative.

The controller already releases a newly claimed lease when the Core connection attempt fails. It does not own or start the Core server. If OpenCode session creation succeeds but Core connection fails, the safe behavior is to keep the new empty OpenCode session and report the connection error rather than delete user-visible OpenCode state.

### Required race and error handling

- Guard the Home create/connect operation against overlapping confirmations so one command cannot create multiple empty sessions.
- Do not create a session for invalid connect arguments.
- Handle a rejected create request before navigation or lease claim.
- Use the returned session ID for controller lookup rather than rereading reactive route state immediately after navigation.
- Decide and test what happens if the user leaves Home while `session.create()` is pending. The route API has no completion acknowledgement; forcibly navigating after the user moved elsewhere could be surprising.
- Preserve the existing controller cleanup on endpoint, lease, authentication, or transport failure.

### Not yet confirmed

- The full Home-create, navigate, connect sequence has not been exercised in a real OpenCode 1.18.15 TUI plugin.
- Route rendering and sync timing for a just-created empty session have not been tested under slow event delivery.
- Experimental workspace routing was not exercised; the source evidence confirms the normal directory-bound TUI client.
- The preferred policy when the user changes routes during creation is a product decision, not a source fact.

## B. Compact visible delivery with hidden safety context

### Confirmed baseline behavior

At the researched baseline identified above:

- `buildDeliveryPrompt()` at `src/tui.ts:109-129` produces one long string containing the untrusted-peer safety rule, batch count, message IDs, sender metadata, kind/recipient metadata, and bounded previews.
- `deliverPending()` at `src/tui.ts:385-410` sends that string as one ordinary text part through `session.promptAsync()`.
- A prior real-host observation was reported as: attention popup, then an automatic model turn that used `inter_agent_read_messages`. That observation was not independently rerun during this research.

### Confirmed OpenCode 1.18.15 synthetic-part behavior

- The v2 SDK `TextPartInput` includes optional `synthetic?: boolean`, and prompt input accepts an ordered array of text parts (`packages/sdk/js/src/v2/gen/types.gen.ts:2550-2563,9794-9818`). The installed 1.18.15 declarations match this.
- Prompt processing spreads each text input into the stored part without removing `synthetic` (`packages/opencode/src/session/prompt.ts:992-997`).
- The main TUI user-message renderer includes text only when `!part.synthetic` (`packages/tui/src/routes/session/index.tsx:1365-1384`). Visible-message navigation also requires a non-synthetic, non-ignored text part (`index.tsx:384-396`). Revert/prompt restoration and message-dialog copy/fork paths likewise omit synthetic text (`index.tsx:631-642`; `dialog-message.tsx:38-49,64-70,87-95`).
- Model conversion includes every non-empty, non-ignored user text part and does not filter on `synthetic` (`packages/opencode/src/session/message-v2.ts:195-210`). Therefore a synthetic safety part remains model-visible.

Together, these facts support two ordered text parts:

```ts
[
  { type: "text", text: safetyContext, synthetic: true },
  { type: "text", text: compactVisibleSummary },
];
```

At the source level, the first part is omitted from the normal TUI transcript while both parts are passed to the model. The non-synthetic summary keeps the user message visible and navigable.

### Safety constraints

- Keep the complete untrusted-peer rule in the synthetic part; shortening the visible part must not weaken model instructions.
- Keep peer content explicitly non-authoritative and retain the instruction to use `inter_agent_read_messages` for full or omitted content.
- Keep previews bounded and preserve the durable inbox as the full-content authority.
- Treat `synthetic` as presentation metadata, not a secrecy boundary. Synthetic parts remain stored and model-visible and may be observable through APIs or other transcript/export surfaces. Never place secrets or authentication material in either part.

### Not yet confirmed

- The proposed two-part payload has not been exercised in a real OpenCode 1.18.15 TUI/model turn.
- Normal transcript filtering is confirmed from source, but every possible OpenCode export, API, log, alternate UI, or future host surface was not audited.
- Actual visual formatting of the compact summary and its behavior during bursts need real-host UAT.
- Compatibility outside the declared `>=1.18.15 <1.19.0` range is not established.

## Suggested verification before implementation acceptance

- Add a fake-API test asserting argument validation happens before session creation, one Home command creates one session, navigation receives the returned ID, and Core connect failure leaves no claimed lease.
- Add a real OpenCode 1.18.15 TUI test for Home create, navigation, connection, disconnect, and retry after Core failure.
- Add a unit test asserting the delivery call contains one synthetic safety part followed by one compact non-synthetic summary part.
- In real OpenCode 1.18.15, verify the transcript shows only the compact summary while the model still follows the hidden safety context and can read the durable message through `inter_agent_read_messages`.
