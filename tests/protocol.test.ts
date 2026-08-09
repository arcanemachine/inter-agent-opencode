import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTH_METHOD,
  CLIENT_PROOF_DOMAIN,
  DEFAULT_BROADCAST_TEXT_MAX,
  DEFAULT_DIRECT_TEXT_MAX,
  SERVER_PROOF_DOMAIN,
  buildHello,
  canonicalHelloTranscript,
  clientProof,
  decodeFrame,
  parseAuthChallenge,
  parseFrame,
  parseListOk,
  parseMessage,
  serverProof,
  utf8ByteLength,
  validateName,
  validateText,
  verifyServerProof,
} from "../src/protocol.js";
import { ProtocolError } from "../src/errors.js";

test("Core canonical transcript and proof vectors match exactly", () => {
  const hello = buildHello({
    role: "agent",
    sessionId: "session-a",
    name: "agent-a",
    label: "Agent A",
    capabilities: { z: true, core: { version: "0.1" } },
    clientNonce: "client-nonce",
  });
  assert.equal(
    canonicalHelloTranscript(hello),
    '{"capabilities":{"core":{"version":"0.1"},"z":true},"label":"Agent A","name":"agent-a","role":"agent","session_id":"session-a"}',
  );
  assert.equal(
    serverProof("shared-secret", {
      clientNonce: "client-nonce",
      serverNonce: "server-nonce",
      hello,
    }),
    "72ed75c6928eeabf901e4f993e84a11d53e93dd0476711ea41b20ebceac5d3df",
  );
  assert.equal(
    clientProof("shared-secret", {
      clientNonce: "client-nonce",
      serverNonce: "server-nonce",
      hello,
    }),
    "a37d6e95133ed0745d0dc66d88a9badccc1198c7db4641bbfd93b3cc081aaaa2",
  );
  assert.notEqual(SERVER_PROOF_DOMAIN, CLIENT_PROOF_DOMAIN);
});

test("hello shape and domain separation are explicit", () => {
  const hello = buildHello({
    role: "control",
    sessionId: "ctl",
    name: "control",
    capabilities: {},
    clientNonce: "client-nonce",
  });
  assert.equal(hello.auth.method, AUTH_METHOD);
  assert.equal(hello.label, null);
  assert.equal(
    verifyServerProof(
      serverProof("secret", {
        clientNonce: "client-nonce",
        serverNonce: "server-nonce",
        hello,
      }),
      "secret",
      { clientNonce: "client-nonce", serverNonce: "server-nonce", hello },
    ),
    true,
  );
  assert.equal(
    verifyServerProof(
      serverProof("secret", {
        clientNonce: "client-nonce",
        serverNonce: "server-nonce",
        hello,
      }),
      "wrong",
      { clientNonce: "client-nonce", serverNonce: "server-nonce", hello },
    ),
    false,
  );
});

test("frame parsing rejects malformed data and accepts UTF-8 binary frames", () => {
  assert.deepEqual(parseFrame(new TextEncoder().encode('{"op":"list"}')), {
    op: "list",
  });
  assert.deepEqual(parseFrame('{"op":"list"}'), { op: "list" });
  assert.throws(() => parseFrame("not-json"), ProtocolError);
  assert.throws(() => parseFrame("[]"), ProtocolError);
  assert.throws(() => decodeFrame(new Uint8Array([0xff])), ProtocolError);
  assert.throws(
    () => parseAuthChallenge({ op: "auth_challenge", method: AUTH_METHOD }),
    ProtocolError,
  );
});

test("protocol validation uses routing and UTF-8 byte limits", () => {
  assert.equal(validateName("agent-a"), true);
  assert.equal(validateName("Agent-A"), false);
  assert.equal(validateName("a".repeat(41)), false);
  assert.equal(utf8ByteLength("é"), 2);
  assert.equal(validateText("é", 2), true);
  assert.equal(validateText("é", 1), false);
  assert.equal(validateText("a", DEFAULT_DIRECT_TEXT_MAX), true);
  assert.equal(validateText("a", DEFAULT_BROADCAST_TEXT_MAX), true);
});

test("canonical Unicode key ordering matches Core code-point ordering", () => {
  const hello = buildHello({
    role: "agent",
    sessionId: "unicode-session",
    name: "agent-a",
    label: "Unicode",
    capabilities: {
      "\ue000": { "\u{10000}": true, a: 1 },
      "\u{10000}": { "\ue000": false },
    },
    clientNonce: "unicode-client",
  });
  const bmp = "\ue000";
  const supplementary = "\u{10000}";
  assert.equal(
    canonicalHelloTranscript(hello),
    `{"capabilities":{"${bmp}":{"a":1,"${supplementary}":true},"${supplementary}":{"${bmp}":false}},"label":"Unicode","name":"agent-a","role":"agent","session_id":"unicode-session"}`,
  );
  assert.equal(
    serverProof("unicode-secret", {
      clientNonce: "unicode-client",
      serverNonce: "unicode-server",
      hello,
    }),
    "55d36454e8a4db7ebc3e18490f9cb24a8ba3fadffd9f72f0dff9fc17a20ce946",
  );
  assert.equal(
    clientProof("unicode-secret", {
      clientNonce: "unicode-client",
      serverNonce: "unicode-server",
      hello,
    }),
    "4f4988c4b783022a8e4fd5c0df182860a93682651e1dcc9494a3c8d3161ad3a3",
  );
});

test("message schema rejects invalid target, channel, and payload forms", () => {
  const base = {
    op: "msg",
    msg_id: "m",
    from: "s",
    from_name: "sender",
    ts: "now",
  };
  assert.throws(
    () => parseMessage({ ...base, to: 42, text: "text" }),
    ProtocolError,
  );
  assert.throws(
    () => parseMessage({ ...base, channel: 42, text: "text" }),
    ProtocolError,
  );
  assert.throws(
    () => parseMessage({ ...base, channel: "Bad Channel", text: "text" }),
    ProtocolError,
  );
  assert.throws(
    () =>
      parseMessage({
        ...base,
        text: "text",
        custom_type: "custom",
        payload: {},
      }),
    ProtocolError,
  );
  assert.throws(
    () => parseMessage({ ...base, custom_type: "", payload: {} }),
    ProtocolError,
  );
  assert.throws(
    () => parseMessage({ ...base, custom_type: "custom" }),
    ProtocolError,
  );
  assert.throws(
    () => parseMessage({ ...base, custom_type: "custom", payload: undefined }),
    ProtocolError,
  );
  assert.doesNotThrow(() =>
    parseMessage({ ...base, text: "text", to: null, channel: "updates" }),
  );
  assert.doesNotThrow(() =>
    parseMessage({ ...base, custom_type: "custom", payload: { value: true } }),
  );
});

test("list and error frames retain stable typed codes without raw snapshots", () => {
  const list = parseListOk({
    op: "list_ok",
    sessions: [{ session_id: "a", name: "agent-a", label: null }],
  });
  assert.equal(list.sessions[0]?.name, "agent-a");
  const frame = parseFrame(
    '{"op":"error","code":"BAD_NAME","message":"invalid"}',
  );
  assert.equal(frame.code, "BAD_NAME");
});
