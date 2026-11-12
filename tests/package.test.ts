import { test } from "bun:test";
import { JSONC } from "bun";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

interface PackageManifest {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
}

test("Pi production installs include the telemetry runtime without installing peers", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as PackageManifest;
  const lock = JSONC.parse(
    readFileSync(new URL("../bun.lock", import.meta.url), "utf8"),
  ) as {
    workspaces: Record<
      string,
      {
        dependencies: Record<string, string>;
        devDependencies: Record<string, string>;
      }
    >;
    packages: Record<string, [string, ...unknown[]]>;
  };
  const dependency = "@earendil-works/pi-telemetry";
  const version = manifest.dependencies[dependency];
  const workspace = lock.workspaces[""];

  assert(
    typeof version === "string",
    "Telemetry must be a production dependency",
  );
  assert(workspace);
  assert.equal(manifest.peerDependencies[dependency], undefined);
  assert.equal(manifest.devDependencies[dependency], undefined);
  assert.equal(workspace.dependencies[dependency], version);
  assert.equal(workspace.devDependencies[dependency], undefined);
  const lockedDependency = lock.packages[dependency];
  assert(lockedDependency);
  assert.equal(lockedDependency[0], `${dependency}@${version}`);
});

test("Pi host modules remain wildcard peers rather than bundled runtime dependencies", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as PackageManifest;
  for (const name of [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
  ]) {
    assert.equal(manifest.peerDependencies[name], "*");
    assert.equal(manifest.dependencies[name], undefined);
  }
});
