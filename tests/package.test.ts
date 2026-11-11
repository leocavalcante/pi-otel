import { test } from 'bun:test';
import { JSONC } from 'bun';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Pi production installs include the telemetry runtime without installing peers', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSONC.parse(readFileSync(new URL('../bun.lock', import.meta.url), 'utf8')) as {
    workspaces: Record<string, { dependencies: Record<string, string>; devDependencies: Record<string, string> }>;
    packages: Record<string, [string, ...unknown[]]>;
  };
  const dependency = '@earendil-works/pi-telemetry';
  const version = manifest.dependencies[dependency];

  assert.equal(typeof version, 'string', 'Telemetry must be a production dependency');
  assert.equal(manifest.peerDependencies[dependency], undefined);
  assert.equal(manifest.devDependencies[dependency], undefined);
  assert.equal(lock.workspaces[''].dependencies[dependency], version);
  assert.equal(lock.workspaces[''].devDependencies[dependency], undefined);
  assert.equal(lock.packages[dependency][0], `${dependency}@${version}`);
});
