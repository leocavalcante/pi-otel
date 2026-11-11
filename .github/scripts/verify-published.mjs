import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";

const { name } = JSON.parse(readFileSync("package.json", "utf8"));
const version = process.argv[2];
assert.match(version ?? "", /^\d+\.\d+\.\d+$/);
const endpoint = `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`;

// The registry can take a minute to expose a new version and its attestation.
for (let attempt = 1; attempt <= 24; attempt++) {
  try {
    const response = await fetch(endpoint, {
      signal: AbortSignal.timeout(15000),
    });
    if (response.ok) {
      const metadata = await response.json();
      assert.equal(metadata.name, name);
      assert.equal(metadata.version, version);
      if (
        metadata.dist?.attestations?.provenance?.predicateType ===
        "https://slsa.dev/provenance/v1"
      ) {
        console.log(`Verified ${name}@${version} on npm with provenance.`);
        process.exit(0);
      }
    } else if (
      response.status !== 404 &&
      response.status !== 429 &&
      response.status < 500
    ) {
      throw new Error(`Registry returned ${response.status}.`);
    }
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    if (
      error instanceof Error &&
      error.message.startsWith("Registry returned")
    ) {
      throw error;
    }
    console.log(`Registry check ${attempt} failed; retrying.`);
  }
  await setTimeout(5000);
}
throw new Error(
  `${name}@${version} or its provenance is not visible on npm. Check the publish job before retrying.`,
);
