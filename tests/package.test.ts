import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Pi production installs include the telemetry runtime without installing peers', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const dependency = '@earendil-works/pi-telemetry';
  const version = manifest.dependencies[dependency];

  assert.equal(typeof version, 'string', 'Telemetry must be a production dependency');
  assert.equal(manifest.peerDependencies[dependency], undefined);
  assert.equal(manifest.devDependencies[dependency], undefined);
  assert.equal(lock.packages[''].dependencies[dependency], version);
  assert.notEqual(lock.packages[`node_modules/${dependency}`].dev, true);
});
