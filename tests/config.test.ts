import { readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  assertSupportedEndpoint,
  configPath,
  dataDirectory,
  endpointUri,
  expandPath,
  loadConfig,
  resolveEndpoint,
  resolveSecret,
} from "../src/config.js";
import { ConfigError, UnsupportedEndpointError } from "../src/errors.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "inter-agent-opencode-phase2-unit-"));
}

test("path expansion and platform defaults match Core", () => {
  const env = {
    TEST_HOME: "/tmp/test-home",
    XDG_CONFIG_HOME: "/tmp/config",
    XDG_STATE_HOME: "/tmp/state",
  };
  assert.equal(
    expandPath("~/$TEST_HOME/${TEST_HOME}", { env, home: "/home/user" }),
    "/home/user//tmp/test-home//tmp/test-home",
  );
  assert.equal(
    configPath({ env, home: "/home/user", platform: "linux" }),
    "/tmp/config/inter-agent/config.json",
  );
  assert.equal(
    dataDirectory({ env, home: "/home/user", platform: "linux" }),
    "/tmp/state/inter-agent",
  );
  assert.equal(
    endpointUri({ host: "::1", port: 16839, scheme: "ws" }),
    "ws://[::1]:16839",
  );
  assert.equal(
    configPath({ env: {}, home: "/home/user", platform: "darwin" }),
    "/home/user/Library/Application Support/inter-agent/config.json",
  );
  assert.equal(
    dataDirectory({ env: {}, home: "/home/user", platform: "win32" }),
    "/home/user/.local/state/inter-agent",
  );
});

test("environment values override config values and defaults", async () => {
  const root = tempRoot();
  try {
    const configFile = join(root, "config.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        host: "config-host",
        port: 16838,
        dataDir: join(root, "config-state"),
        tls: true,
      }),
    );
    const env = {
      INTER_AGENT_CONFIG: configFile,
      INTER_AGENT_HOST: "localhost",
      INTER_AGENT_PORT: "16839",
      INTER_AGENT_DATA_DIR: join(root, "env-state"),
      INTER_AGENT_TLS: "false",
    };
    const endpoint = await resolveEndpoint({
      env,
      platform: "linux",
      home: root,
    });
    assert.equal(endpoint.host, "localhost");
    assert.equal(endpoint.port, 16839);
    assert.equal(endpoint.dataDir, join(root, "env-state"));
    assert.equal(endpoint.tls, false);
    assert.equal(endpoint.supported, true);
    assert.equal(endpoint.hostSource, "env");
    assert.equal(endpoint.portSource, "env");
    assert.equal(endpoint.dataDirSource, "env");
    assert.equal(endpoint.tlsSource, "env");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-loopback and TLS endpoints fail closed", async () => {
  const root = tempRoot();
  try {
    const configFile = join(root, "missing.json");
    const remote = await resolveEndpoint({
      env: { INTER_AGENT_CONFIG: configFile, INTER_AGENT_HOST: "192.0.2.10" },
      home: root,
      platform: "linux",
    });
    assert.equal(remote.tls, true);
    assert.equal(remote.supported, false);
    assert.throws(
      () => assertSupportedEndpoint(remote),
      UnsupportedEndpointError,
    );
    const tls = await resolveEndpoint({
      env: { INTER_AGENT_CONFIG: configFile, INTER_AGENT_TLS: "tls" },
      home: root,
      platform: "linux",
    });
    assert.equal(tls.supported, false);
    assert.match(tls.unsupportedReason ?? "", /TLS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid config values fail without echoing values", async () => {
  const root = tempRoot();
  try {
    const configFile = join(root, "config.json");
    writeFileSync(configFile, JSON.stringify({ port: "not-a-port" }));
    await assert.rejects(
      resolveEndpoint({ env: { INTER_AGENT_CONFIG: configFile }, home: root }),
      (error: unknown) => {
        assert(error instanceof ConfigError);
        assert.doesNotMatch(String(error), /not-a-port/);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("secret precedence avoids token creation for explicit values", () => {
  const root = tempRoot();
  try {
    const configFile = join(root, "config.json");
    writeFileSync(configFile, JSON.stringify({ secret: "config-secret" }));
    const config = loadConfig({
      env: { INTER_AGENT_CONFIG: configFile },
      home: root,
    });
    const envSecret = resolveSecret(
      {
        env: {
          INTER_AGENT_CONFIG: configFile,
          INTER_AGENT_SECRET: "env-secret",
        },
        home: root,
      },
      config,
    );
    assert.equal(envSecret.secret, "env-secret");
    assert.equal(envSecret.source, "env");
    assert.equal(
      resolveSecret(
        { env: { INTER_AGENT_CONFIG: configFile }, home: root },
        config,
      ).secret,
      "config-secret",
    );
    assert.equal(
      statSync(join(root, "token"), { throwIfNoEntry: false }),
      undefined,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fallback token is URL-safe, atomic, and private", () => {
  const root = tempRoot();
  try {
    const resolution = resolveSecret({
      env: {
        INTER_AGENT_CONFIG: join(root, "missing.json"),
        INTER_AGENT_DATA_DIR: join(root, "state"),
      },
      home: root,
    });
    assert.equal(resolution.source, "token_file");
    assert(resolution.tokenPath);
    const token = readFileSync(resolution.tokenPath, "utf8").trim();
    assert.equal(token, resolution.secret);
    assert.match(token, /^[A-Za-z0-9_-]+$/);
    assert.equal(statSync(resolution.tokenPath).mode & 0o777, 0o600);
    assert.equal(statSync(join(root, "state")).mode & 0o777, 0o700);
    const second = resolveSecret({
      env: {
        INTER_AGENT_CONFIG: join(root, "missing.json"),
        INTER_AGENT_DATA_DIR: join(root, "state"),
      },
      home: root,
    });
    assert.equal(second.secret, token);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("empty explicit secrets are rejected", () => {
  const root = tempRoot();
  try {
    const configFile = join(root, "config.json");
    writeFileSync(configFile, JSON.stringify({ secret: "" }));
    assert.throws(
      () =>
        resolveSecret({ env: { INTER_AGENT_CONFIG: configFile }, home: root }),
      (error: unknown) => {
        assert(error instanceof ConfigError);
        assert.doesNotMatch(String(error), /secret=|token/);
        return true;
      },
    );
    assert.throws(
      () =>
        resolveSecret({
          env: {
            INTER_AGENT_SECRET: "   ",
            INTER_AGENT_CONFIG: join(root, "missing.json"),
          },
          home: root,
        }),
      ConfigError,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unresolved path variables remain unchanged like Core", () => {
  const expanded = expandPath("~/prefix/$UNSET_ONE/${UNSET_TWO}/tail", {
    env: {},
    home: "/home/user",
  });
  assert.equal(expanded, "/home/user/prefix/$UNSET_ONE/${UNSET_TWO}/tail");
});
