import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { ConfigError, UnsupportedEndpointError } from "./errors.js";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 16837;
export const DEFAULT_TOKEN_FILENAME = "token";
export const DEFAULT_TLS_CERT_FILENAME = "tls-cert.pem";

export type Environment = Record<string, string | undefined>;

export type ResolverOptions = {
  env?: Environment;
  platform?: NodeJS.Platform;
  home?: string;
};

export type CoreConfig = Record<string, unknown>;

export type LoadedConfig = {
  values: CoreConfig;
  path: string | undefined;
};

export type EndpointResolution = {
  host: string;
  port: number;
  dataDir: string;
  configPath: string | undefined;
  hostSource: "env" | "config" | "default";
  portSource: "env" | "config" | "default";
  dataDirSource: "env" | "config" | "default";
  tls: boolean;
  tlsSource: "env" | "config" | "default";
  scheme: "ws" | "wss";
  tlsCertPath: string;
  tlsCertSource: "env" | "config" | "default";
  supported: boolean;
  unsupportedReason?: string;
};

export type SecretResolution = {
  secret: string;
  source: "env" | "config" | "token_file";
  tokenPath?: string;
  configPath?: string;
};

export function expandPath(raw: string, options: ResolverOptions = {}): string {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  let expanded = raw;
  if (expanded === "~") expanded = home;
  else if (expanded.startsWith("~/")) expanded = join(home, expanded.slice(2));
  expanded = expanded.replace(
    /\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, braced, plain) => {
      const name = braced ?? plain;
      return env[name] ?? match;
    },
  );
  return expanded;
}

export function configPath(options: ResolverOptions = {}): string {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const override = env.INTER_AGENT_CONFIG;
  if (override) return expandPath(override, options);
  if (platform === "darwin")
    return join(
      home,
      "Library",
      "Application Support",
      "inter-agent",
      "config.json",
    );
  if (platform.startsWith("win")) {
    const appData = env.APPDATA;
    if (appData) return join(appData, "inter-agent", "config.json");
  }
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, "inter-agent", "config.json");
  return join(home, ".config", "inter-agent", "config.json");
}

export function dataDirectory(
  options: ResolverOptions = {},
  config?: LoadedConfig,
): string {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  if (env.INTER_AGENT_DATA_DIR)
    return expandPath(env.INTER_AGENT_DATA_DIR, options);
  const configured = configString(config?.values, "dataDir");
  if (configured) return expandPath(configured, options);
  if (platform === "darwin")
    return join(home, "Library", "Application Support", "inter-agent");
  if (platform.startsWith("win")) {
    const local = env.LOCALAPPDATA ?? env.APPDATA;
    if (local) return join(local, "inter-agent");
  }
  const xdg = env.XDG_STATE_HOME;
  if (xdg) return join(xdg, "inter-agent");
  return join(home, ".local", "state", "inter-agent");
}

export function loadConfig(options: ResolverOptions = {}): LoadedConfig {
  const path = configPath(options);
  if (!existsSync(path)) return { values: {}, path: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new ConfigError("invalid inter-agent config file");
  }
  if (!isRecord(parsed))
    throw new ConfigError("inter-agent config root must be a JSON object");
  return { values: parsed, path };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configString(
  config: CoreConfig | undefined,
  key: string,
): string | undefined {
  const value = config?.[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string")
    throw new ConfigError(`inter-agent config key ${key} must be a string`);
  return value;
}

function parsePort(value: unknown, source: string): number {
  if (typeof value === "number") {
    if (!Number.isInteger(value))
      throw new ConfigError(`${source} must be an integer`);
    return validatePort(value, source);
  }
  if (typeof value !== "string" || !/^\d+$/.test(value))
    throw new ConfigError(`${source} must be an integer`);
  return validatePort(Number(value), source);
}

function validatePort(value: number, source: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) {
    throw new ConfigError(`${source} must be between 1 and 65535`);
  }
  return value;
}

function envPort(env: Environment): number | undefined {
  const value = env.INTER_AGENT_PORT;
  if (value === undefined || value === "") return undefined;
  return parsePort(value, "INTER_AGENT_PORT");
}

function parseBoolean(value: unknown, source: string): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string")
    throw new ConfigError(`${source} must be a boolean`);
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on", "wss", "tls"].includes(normalized))
    return true;
  if (["0", "false", "no", "off", "ws", "plaintext"].includes(normalized))
    return false;
  throw new ConfigError(`${source} must be a boolean`);
}

function configBoolean(config: CoreConfig, key: string): boolean | undefined {
  const value = config[key];
  if (value === undefined || value === null) return undefined;
  return parseBoolean(value, `inter-agent config key ${key}`);
}

function envBoolean(env: Environment, key: string): boolean | undefined {
  const value = env[key];
  if (value === undefined || value === "") return undefined;
  return parseBoolean(value, key);
}

function normalizedHost(host: string): string {
  const trimmed = host.trim();
  return trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;
}

function isLoopbackIp(host: string): boolean {
  const value = normalizedHost(host).toLowerCase();
  const version = isIP(value);
  if (version === 4) return value.startsWith("127.");
  if (version === 6) return value === "::1" || value.startsWith("::ffff:127.");
  return false;
}

export async function resolvesLoopback(host: string): Promise<boolean> {
  const value = normalizedHost(host);
  if (value.toLowerCase() === "localhost" || isLoopbackIp(value)) return true;
  try {
    const records = await lookup(value, { all: true, verbatim: true });
    return (
      records.length > 0 &&
      records.every((record) => isLoopbackIp(record.address))
    );
  } catch {
    return false;
  }
}

export async function resolveEndpoint(
  options: ResolverOptions = {},
): Promise<EndpointResolution> {
  const env = options.env ?? process.env;
  const config = loadConfig(options);
  const configuredHost = configString(config.values, "host");
  const envHost = env.INTER_AGENT_HOST;
  const host = envHost || configuredHost || DEFAULT_HOST;
  const hostSource = envHost ? "env" : configuredHost ? "config" : "default";
  const configuredPort = config.values.port;
  const envPortValue = envPort(env);
  const port =
    envPortValue ??
    (configuredPort === undefined || configuredPort === null
      ? DEFAULT_PORT
      : parsePort(configuredPort, "inter-agent config key port"));
  const portSource =
    envPortValue !== undefined
      ? "env"
      : configuredPort === undefined || configuredPort === null
        ? "default"
        : "config";
  const dataDir = dataDirectory(options, config);
  const configuredTls = configBoolean(config.values, "tls");
  const envTls = envBoolean(env, "INTER_AGENT_TLS");
  const loopback = await resolvesLoopback(host);
  const tls = envTls ?? configuredTls ?? !loopback;
  const tlsSource =
    envTls !== undefined
      ? "env"
      : configuredTls !== undefined
        ? "config"
        : "default";
  const configuredCert = configString(config.values, "tlsCert");
  const envCert = env.INTER_AGENT_TLS_CERT;
  const tlsCertPath = envCert
    ? expandPath(envCert, options)
    : configuredCert
      ? expandPath(configuredCert, options)
      : join(dataDir, DEFAULT_TLS_CERT_FILENAME);
  const tlsCertSource = envCert ? "env" : configuredCert ? "config" : "default";
  const reasons: string[] = [];
  if (!loopback) reasons.push("host is not loopback");
  return {
    host: normalizedHost(host),
    port,
    dataDir,
    configPath: config.path,
    hostSource,
    portSource,
    dataDirSource: env.INTER_AGENT_DATA_DIR
      ? "env"
      : configString(config.values, "dataDir")
        ? "config"
        : "default",
    tls,
    tlsSource,
    scheme: tls ? "wss" : "ws",
    tlsCertPath,
    tlsCertSource,
    supported: reasons.length === 0,
    ...(reasons.length ? { unsupportedReason: reasons.join("; ") } : {}),
  };
}

export function assertSupportedEndpoint(endpoint: EndpointResolution): void {
  if (!endpoint.supported)
    throw new UnsupportedEndpointError(
      endpoint.unsupportedReason ?? "unsupported transport",
    );
}

export function tokenPath(
  options: ResolverOptions = {},
  config?: LoadedConfig,
): string {
  return join(dataDirectory(options, config), DEFAULT_TOKEN_FILENAME);
}

export function endpointUri(
  endpoint: Pick<EndpointResolution, "host" | "port" | "scheme">,
): string {
  const host =
    isIP(endpoint.host) === 6 && !endpoint.host.startsWith("[")
      ? `[${endpoint.host}]`
      : endpoint.host;
  return `${endpoint.scheme}://${host}:${endpoint.port}`;
}

function ensurePrivateDirectory(path: string): void {
  try {
    const existing = lstatSync(path);
    if (existing.isSymbolicLink() || !existing.isDirectory())
      throw new ConfigError(
        "inter-agent data directory is not a private directory",
      );
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  try {
    chmodSync(path, 0o700);
  } catch {
    // Windows may not support POSIX mode bits.
  }
}

function readToken(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new ConfigError("unable to inspect inter-agent token file");
  }
  if (!stat.isFile())
    throw new ConfigError("inter-agent token path is not a regular file");
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows may not support POSIX mode bits.
  }
  let value: string;
  try {
    value = readFileSync(path, "utf8").trim();
  } catch {
    throw new ConfigError("unable to read inter-agent token file");
  }
  return value || undefined;
}

function createToken(path: string): string {
  const token = randomBytes(32).toString("base64url");
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, `${token}\n`, { encoding: "utf8" });
    } finally {
      closeSync(fd);
    }
    try {
      chmodSync(temp, 0o600);
    } catch {
      // Windows may not support POSIX mode bits.
    }
    renameSync(temp, path);
    try {
      chmodSync(path, 0o600);
    } catch {
      // Windows may not support POSIX mode bits.
    }
    return token;
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // Best effort cleanup of this process's private temporary file.
    }
    const existing = readToken(path);
    if (existing) return existing;
    if (error instanceof ConfigError) throw error;
    throw new ConfigError("unable to create inter-agent token file");
  }
}

export function resolveSecret(
  options: ResolverOptions = {},
  config?: LoadedConfig,
): SecretResolution {
  const env = options.env ?? process.env;
  const loaded = config ?? loadConfig(options);
  const explicitEnv = env.INTER_AGENT_SECRET;
  if (explicitEnv !== undefined) {
    if (!explicitEnv.trim())
      throw new ConfigError("INTER_AGENT_SECRET must not be empty");
    return { secret: explicitEnv, source: "env", configPath: loaded.path };
  }
  const explicitConfig = configString(loaded.values, "secret");
  if (explicitConfig !== undefined) {
    if (!explicitConfig.trim())
      throw new ConfigError("inter-agent config key secret must not be empty");
    return {
      secret: explicitConfig,
      source: "config",
      configPath: loaded.path,
    };
  }
  const path = tokenPath(options, loaded);
  ensurePrivateDirectory(dirname(path));
  const token = readToken(path) ?? createToken(path);
  return { secret: token, source: "token_file", tokenPath: path };
}
