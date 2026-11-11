import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const directory = mkdtempSync(join(tmpdir(), "pi-otel-package-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const options = {
  encoding: "utf8",
  timeout: 180000,
  shell: process.platform === "win32",
};
try {
  const output = execFileSync(
    npm,
    ["pack", "--json", "--ignore-scripts", "--pack-destination", directory],
    options,
  );
  const records = JSON.parse(output);
  const packages = Array.isArray(records) ? records : Object.values(records);
  assert.equal(packages.length, 1);
  const packed = packages[0];
  const paths = packed.files.map((file) => file.path);
  for (const required of [
    "src/extension.ts",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/extension.js",
    "CHANGELOG.md",
    "README.md",
    "LICENSE",
  ]) {
    assert(paths.includes(required), `Missing published file: ${required}`);
  }
  assert(
    !paths.some((path) => /^(?:tests|node_modules|\.github)\//.test(path)),
  );
  assert(
    !paths.some((path) =>
      /(?:^|\/)(?:\.env(?:\..*)?|auth\.json|credentials[^/]*)$/.test(path),
    ),
  );

  const consumer = join(directory, "consumer");
  execFileSync(
    npm,
    [
      "install",
      "--prefix",
      consumer,
      "--ignore-scripts",
      "--legacy-peer-deps",
      "--no-audit",
      "--no-fund",
      join(directory, packed.filename),
      `@earendil-works/pi-ai@${manifest.devDependencies["@earendil-works/pi-ai"]}`,
    ],
    {
      ...options,
      stdio: "inherit",
    },
  );
  const installedManifest = JSON.parse(
    readFileSync(
      join(consumer, "node_modules/@leocavalcante/pi-otel/package.json"),
      "utf8",
    ),
  );
  assert.equal(installedManifest.version, manifest.version);
  const entry = join(consumer, "smoke.mjs");
  writeFileSync(
    entry,
    `
    import assert from "node:assert/strict";
    import { createPiOtel } from "@leocavalcante/pi-otel";
    import extension from "@leocavalcante/pi-otel/extension";
    assert.equal(typeof extension, "function");
    process.env.OTEL_SDK_DISABLED = "true";
    const otel = createPiOtel({ serviceName: "package-smoke" });
    await otel.shutdown();
    console.log("Packed SDK and compiled extension load under Node.js.");
  `,
  );
  execFileSync(
    process.execPath,
    ["--import", resolve("tests/environment.ts"), entry],
    {
      timeout: 30000,
      stdio: "inherit",
      env: { ...process.env, OTEL_SDK_DISABLED: "true" },
    },
  );
  console.log(
    `Validated ${packed.filename}: ${paths.length} allowlisted files.`,
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
