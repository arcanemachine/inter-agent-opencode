import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

type PackageManifest = {
  name: string;
  version: string;
  type: string;
  engines: { opencode: string };
  exports: Record<string, string>;
  files: string[];
};

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifestPath = resolve(projectRoot, "package.json");
const distPath = resolve(projectRoot, "dist");

async function readManifest(): Promise<PackageManifest> {
  return JSON.parse(await readFile(manifestPath, "utf8")) as PackageManifest;
}

test("package metadata exposes independent OpenCode targets", async () => {
  const manifest = await readManifest();

  assert.equal(manifest.name, "@arcanemachine/inter-agent-opencode");
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.type, "module");
  assert.equal(manifest.engines.opencode, ">=1.18.15 <1.19.0");
  assert.deepEqual(manifest.exports, {
    "./tui": "./dist/tui.js",
    "./server": "./dist/server.js",
  });
});

test("compiled targets have mutually exclusive default exports", async () => {
  const tuiModule = (await import(
    pathToFileURL(resolve(distPath, "tui.js")).href
  )) as {
    default: Record<string, unknown>;
  };
  const serverModule = (await import(
    pathToFileURL(resolve(distPath, "server.js")).href
  )) as {
    default: Record<string, unknown>;
  };

  assert.deepEqual(Object.keys(tuiModule.default).sort(), ["id", "tui"]);
  assert.equal(tuiModule.default.id, "inter-agent");
  assert.equal(typeof tuiModule.default.tui, "function");
  assert.equal("server" in tuiModule.default, false);

  assert.deepEqual(Object.keys(serverModule.default).sort(), ["id", "server"]);
  assert.equal(serverModule.default.id, "inter-agent");
  assert.equal(typeof serverModule.default.server, "function");
  assert.equal("tui" in serverModule.default, false);
});

test("target initialization has no runtime side effects", async () => {
  const tuiModule = (await import(
    pathToFileURL(resolve(distPath, "tui.js")).href
  )) as {
    default: { tui: (...args: never[]) => Promise<void> };
  };
  const serverModule = (await import(
    pathToFileURL(resolve(distPath, "server.js")).href
  )) as {
    default: { server: (...args: never[]) => Promise<Record<string, never>> };
  };

  assert.equal(await tuiModule.default.tui(), undefined);
  assert.deepEqual(await serverModule.default.server(), {});
});
