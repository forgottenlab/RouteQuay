import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INSTALL_MARKER, InstallLayoutError, defaultUserDataDir, resolveStateRoot } from '../src/install-layout.ts';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'routequay-layout-'));
}

function writeMarker(programRoot: string, body: unknown): void {
  writeFileSync(join(programRoot, INSTALL_MARKER), JSON.stringify(body));
}

const marker = {
  schemaVersion: 'routequay-install-v1',
  layout: 'windows-user',
  version: '0.1.0',
  node: '>=22.19.0',
  ownedFiles: ['routequay.cmd']
};

test('a checkout keeps state under the program root and does not create user data', () => {
  const programRoot = tempRoot();
  const home = join(programRoot, 'home');
  const state = join(programRoot, 'local', 'private', 'cli-nodes', 'example-node', 'state.local.json');
  mkdirSync(join(state, '..'), { recursive: true });
  writeFileSync(state, '{"keep":true}\n');
  const resolved = resolveStateRoot(programRoot, { home, env: {}, configuredDataDir: '~/.routequay' });
  assert.equal(resolved, programRoot);
  assert.equal(resolveStateRoot(programRoot, { home, env: {} }), programRoot);
});

test('an install marker uses the user data directory and an explicit override wins', () => {
  const programRoot = tempRoot();
  const home = join(programRoot, 'home');
  writeMarker(programRoot, marker);
  assert.equal(resolveStateRoot(programRoot, { home, env: {} }), defaultUserDataDir(home));
  assert.equal(resolveStateRoot(programRoot, { home, env: {}, configuredDataDir: '~/custom-data' }), join(home, 'custom-data'));
  const explicit = join(programRoot, 'explicit-data');
  assert.equal(resolveStateRoot(programRoot, { home, env: {}, dataDir: explicit, configuredDataDir: '~/custom-data' }), explicit);
  assert.equal(resolveStateRoot(programRoot, {
    home, dataDir: undefined, configuredDataDir: '~/custom-data', env: { ROUTEQUAY_DATA_DIR: '~/from-env' }
  }), join(home, 'from-env'));
});

test('a checkout can opt into another data directory without a marker', () => {
  const programRoot = tempRoot();
  const home = join(programRoot, 'home');
  assert.equal(resolveStateRoot(programRoot, { home, env: { ROUTEQUAY_DATA_DIR: '~/.routequay' } }), defaultUserDataDir(home));
  assert.equal(resolveStateRoot(programRoot, { home, env: {}, dataDir: '~/.routequay' }), defaultUserDataDir(home));
});

test('a corrupt or linked install marker is refused', () => {
  const programRoot = tempRoot();
  writeMarker(programRoot, { schemaVersion: 'other', layout: 'windows-user', ownedFiles: [] });
  assert.throws(() => resolveStateRoot(programRoot, { home: programRoot, env: {} }), (error: unknown) => {
    return error instanceof InstallLayoutError && error.code === 'INSTALL_LAYOUT_INVALID';
  });
  const linked = tempRoot();
  const target = join(linked, 'marker-target.json');
  writeFileSync(target, JSON.stringify(marker));
  symlinkSync(target, join(linked, INSTALL_MARKER));
  assert.throws(() => resolveStateRoot(linked, { home: linked, env: {} }), InstallLayoutError);
});
