import { spawnSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  INSTALL_MARKER, InstallerError, filePathStore, installRuntime, memoryPathStore, mergeUserPath, npmCiArgs,
  nodeVersionSatisfies, parseMinimumNode, removeUserPath, resolvePathCommand, USER_PATH_SCOPE,
  USER_PATH_WRITE_COMMAND
} from './install-win.mjs';
import { listRuntimeFiles } from './runtime-manifest.mjs';
import { packRuntime } from './pack-runtime.mjs';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const minimum = parseMinimumNode('>=22.19.0');

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'routequay-install-'));
  return {
    root,
    dest: join(root, 'Programs', 'RouteQuay'),
    dataDir: join(root, 'home', '.routequay'),
    home: join(root, 'home')
  };
}

function seedData(dir) {
  const config = join(dir, 'config.json');
  const state = join(dir, 'local', 'private', 'cli-nodes', 'example-node', 'state.local.json');
  mkdirSync(dirname(state), { recursive: true });
  const configBody = '{"schemaVersion":"routequay-operator-config-v1","keep":true}\n';
  const stateBody = '{"keep":true}\n';
  writeFileSync(config, configBody);
  writeFileSync(state, stateBody);
  return { config, state, configBody, stateBody };
}

function install(box, extra = {}) {
  return installRuntime({
    action: 'install',
    sourceRoot: repo,
    dest: box.dest,
    dataDir: box.dataDir,
    home: box.home,
    skipNpm: true,
    ...extra
  });
}

function assertDataUntouched(seed) {
  assert.equal(readFileSync(seed.config, 'utf8'), seed.configBody);
  assert.equal(readFileSync(seed.state, 'utf8'), seed.stateBody);
}

test('Node.js below the package range is refused and the current range is not lowered', () => {
  assert.equal(nodeVersionSatisfies('22.18.9', minimum), false);
  assert.equal(nodeVersionSatisfies('v22.19.0', minimum), true);
  assert.equal(nodeVersionSatisfies(process.versions.node, minimum), true);
  const box = workspace();
  assert.throws(() => install(box, { nodeVersion: '22.18.0' }), (error) => error instanceof InstallerError && error.code === 'NODE_TOO_OLD');
  assert.equal(existsSync(box.dest), false);
  const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  assert.equal(manifest.engines.node, '>=22.19.0');
});

test('user PATH merge, removal, and shim resolution stay on the current-user entry', () => {
  assert.equal(USER_PATH_SCOPE, 'User');
  assert.equal(USER_PATH_WRITE_COMMAND.includes("'User'"), true);
  assert.equal(USER_PATH_WRITE_COMMAND.includes('Machine'), false);
  const directory = 'D:\\Apps\\RouteQuay';
  const merged = mergeUserPath('D:\\apps\\routequay;C:\\Windows', directory);
  assert.equal(merged, `${directory};C:\\Windows`);
  assert.equal(removeUserPath(merged, directory), 'C:\\Windows');
  const box = workspace();
  install(box);
  const pathValue = mergeUserPath(`C:\\Windows;${join(box.root, 'later')}`, box.dest);
  mkdirSync(join(box.root, 'later'), { recursive: true });
  writeFileSync(join(box.root, 'later', 'routequay.cmd'), 'not-the-installed-shim\r\n');
  assert.equal(resolvePathCommand(pathValue, 'routequay'), join(box.dest, 'routequay.cmd'));
  assert.equal(existsSync(join(box.dest, 'rq.cmd')), false);
  assert.equal(existsSync(join(repo, 'rq.cmd')), false);
  const shim = readFileSync(join(box.dest, 'routequay.cmd'), 'utf8');
  assert.match(shim, /node "%~dp0apps\\cli\\src\\vpncp\.ts"/);
  assert.equal(shim, readFileSync(join(repo, 'routequay.cmd'), 'utf8'));
  assert.match(readFileSync(join(box.dest, 'vpncp.cmd'), 'utf8'), /node "%~dp0apps\\cli\\src\\vpncp\.ts"/);
});

test('install copies the slim runtime, updates PATH only after confirmation, and leaves user data alone', () => {
  const box = workspace();
  const seed = seedData(box.dataDir);
  const store = memoryPathStore('C:\\Windows');
  const result = install(box, { confirmPath: false, pathStore: store });
  assert.equal(result.pathUpdated, false);
  assert.equal(store.read(), 'C:\\Windows');
  assert.equal(existsSync(join(box.dest, 'apps', 'cli', 'src', 'vpncp.ts')), true);
  assert.equal(existsSync(join(box.dest, 'package-lock.json')), true);
  assert.equal(existsSync(join(box.dest, 'apps', 'cli', 'test')), false);
  const marker = JSON.parse(readFileSync(join(box.dest, INSTALL_MARKER), 'utf8'));
  assert.equal(marker.schemaVersion, 'routequay-install-v1');
  assert.equal(marker.layout, 'windows-user');
  assert.equal(marker.pathScope, 'User');
  assert.equal(marker.userData, 'outside-program-directory');
  assert.deepEqual(marker.ownedFiles, listRuntimeFiles());
  assertDataUntouched(seed);
  assert.throws(() => install(box), (error) => error.code === 'ALREADY_INSTALLED');
  assertDataUntouched(seed);
});

test('confirmed install prepends the shim directory and a machine scope is refused', () => {
  const box = workspace();
  const store = memoryPathStore('C:\\Windows');
  install(box, { confirmPath: true, pathStore: store });
  assert.equal(store.read().split(';')[0], box.dest);
  const blocked = workspace();
  let wrote = false;
  assert.throws(() => install(blocked, {
    confirmPath: true,
    pathStore: { scope: 'Machine', read() { return ''; }, write() { wrote = true; } }
  }), (error) => error.code === 'USER_PATH_REQUIRED');
  assert.equal(wrote, false);
  assert.equal(existsSync(blocked.dest), false);
});

test('program files and private data must stay separate', () => {
  const box = workspace();
  assert.throws(() => install(box, { dataDir: box.dest }), (error) => error.code === 'DATA_DIR_OVERLAPS_PROGRAM_DIR');
  assert.throws(() => install(box, { dataDir: join(box.dest, '.routequay') }), (error) => error.code === 'DATA_DIR_OVERLAPS_PROGRAM_DIR');
  assert.throws(() => install(box, { dest: join(box.dataDir, 'Programs'), dataDir: box.dataDir }),
    (error) => error.code === 'DATA_DIR_OVERLAPS_PROGRAM_DIR');
  assert.equal(existsSync(box.dest), false);
});

test('update replaces program files, drops stale owned files, and does not touch user data', () => {
  const box = workspace();
  const seed = seedData(box.dataDir);
  install(box);
  writeFileSync(join(box.dest, 'routequay.cmd'), 'stale\r\n');
  writeFileSync(join(box.dest, 'user-note.txt'), 'keep me\n');
  const markerPath = join(box.dest, INSTALL_MARKER);
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  marker.ownedFiles.push('stale-owned.txt');
  writeFileSync(markerPath, JSON.stringify(marker));
  writeFileSync(join(box.dest, 'stale-owned.txt'), 'gone\n');
  installRuntime({
    action: 'update', sourceRoot: repo, dest: box.dest, dataDir: box.dataDir, home: box.home, skipNpm: true
  });
  assert.equal(readFileSync(join(box.dest, 'routequay.cmd'), 'utf8'), readFileSync(join(repo, 'routequay.cmd'), 'utf8'));
  assert.equal(readFileSync(join(box.dest, 'user-note.txt'), 'utf8'), 'keep me\n');
  assert.equal(existsSync(join(box.dest, 'stale-owned.txt')), false);
  assertDataUntouched(seed);
});

test('uninstall removes the shim, program files, and user PATH entry, and keeps user data', () => {
  const box = workspace();
  const seed = seedData(box.dataDir);
  const store = memoryPathStore(mergeUserPath('C:\\Windows', box.dest));
  install(box, { confirmPath: true, pathStore: store });
  mkdirSync(join(box.dest, 'node_modules', 'example-runtime'), { recursive: true });
  writeFileSync(join(box.dest, 'node_modules', 'example-runtime', 'index.js'), 'export {}\n');
  writeFileSync(join(box.dest, 'user-note.txt'), 'keep me\n');
  installRuntime({ action: 'uninstall', dest: box.dest, dataDir: box.dataDir, home: box.home, pathStore: store });
  assert.equal(store.read(), 'C:\\Windows');
  assert.equal(existsSync(join(box.dest, 'routequay.cmd')), false);
  assert.equal(existsSync(join(box.dest, 'vpncp.cmd')), false);
  assert.equal(existsSync(join(box.dest, INSTALL_MARKER)), false);
  assert.equal(existsSync(join(box.dest, 'node_modules')), false);
  assert.equal(readFileSync(join(box.dest, 'user-note.txt'), 'utf8'), 'keep me\n');
  assertDataUntouched(seed);
  const clean = workspace();
  install(clean);
  installRuntime({
    action: 'uninstall', dest: clean.dest, dataDir: clean.dataDir, home: clean.home, pathStore: memoryPathStore('')
  });
  assert.equal(existsSync(clean.dest), false);
  assert.equal(existsSync(clean.dataDir), false);
});

test('uninstall refuses a marker path that escapes the program directory', () => {
  const box = workspace();
  const seed = seedData(box.dataDir);
  install(box);
  const outside = join(box.root, 'secret.txt');
  writeFileSync(outside, 'keep\n');
  const marker = JSON.parse(readFileSync(join(box.dest, INSTALL_MARKER), 'utf8'));
  marker.ownedFiles.push('../secret.txt');
  writeFileSync(join(box.dest, INSTALL_MARKER), JSON.stringify(marker));
  assert.throws(() => installRuntime({
    action: 'uninstall', dest: box.dest, dataDir: box.dataDir, home: box.home, pathStore: memoryPathStore('')
  }), (error) => error.code === 'INSTALL_PATH_UNSAFE');
  assert.equal(readFileSync(outside, 'utf8'), 'keep\n');
  assert.equal(existsSync(join(box.dest, 'routequay.cmd')), true);
  assertDataUntouched(seed);
});

test('npm ci is requested for production dependencies and can be skipped in fixture installs', () => {
  assert.deepEqual(npmCiArgs, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
  const box = workspace();
  let called = '';
  install(box, { skipNpm: false, runNpm(dest) { called = dest; } });
  assert.equal(called, box.dest);
});

test('the installed copy answers routequay help without the checkout', () => {
  const box = workspace();
  install(box);
  symlinkSync(join(repo, 'node_modules'), join(box.dest, 'node_modules'), 'dir');
  const help = spawnSync(process.execPath, [join(box.dest, 'apps', 'cli', 'src', 'vpncp.ts'), '--help'], { encoding: 'utf8' });
  const setup = spawnSync(process.execPath, [join(box.dest, 'apps', 'cli', 'src', 'vpncp.ts'), 'setup'], { encoding: 'utf8' });
  const status = spawnSync(process.execPath, [join(box.dest, 'apps', 'cli', 'src', 'vpncp.ts'), 'status'], { encoding: 'utf8' });
  unlinkSync(join(box.dest, 'node_modules'));
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /routequay/);
  assert.match(help.stdout, /vpncp/);
  assert.equal(help.stdout.includes('vless://'), false);
  assert.equal(setup.status, 2, setup.stderr);
  assert.equal(status.status, 2, status.stderr);
  assert.equal(setup.stdout.includes('vless://'), false);
  assert.equal(status.stdout.includes('vless://'), false);
});

test('the installer command records PATH changes in the supplied user path file', () => {
  const box = workspace();
  const pathFile = join(box.root, 'user-path.txt');
  writeFileSync(pathFile, 'C:\\Windows');
  const run = spawnSync(process.execPath, [
    join(repo, 'scripts', 'install-win.mjs'), 'install',
    '--source', repo, '--dest', box.dest, '--data-dir', box.dataDir,
    '--path-file', pathFile, '--confirm-path', 'yes', '--skip-npm'
  ], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout);
  const body = JSON.parse(run.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.pathUpdated, true);
  assert.equal(run.stdout.includes('vless://'), false);
  assert.equal(readFileSync(pathFile, 'utf8').split(';')[0], box.dest);
  const again = spawnSync(process.execPath, [
    join(repo, 'scripts', 'install-win.mjs'), 'install',
    '--source', repo, '--dest', box.dest, '--data-dir', box.dataDir,
    '--path-file', pathFile, '--confirm-path', 'no', '--skip-npm'
  ], { encoding: 'utf8' });
  assert.equal(again.status, 2);
  assert.equal(JSON.parse(again.stdout).code, 'ALREADY_INSTALLED');
});

test('the pack script builds a slim zip the installer can describe', () => {
  const box = workspace();
  const output = join(box.root, 'routequay-runtime-win.zip');
  const names = packRuntime(repo, output);
  assert.deepEqual(names, listRuntimeFiles());
  const listed = spawnSync('python3', ['-c', 'import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))', output], { encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout), names);
  const forbidden = ['apps/cli/test/adoption.test.ts', 'docs/ROADMAP.zh-CN.md', '.git/config', 'node_modules/pngjs/package.json'];
  for (const name of forbidden) assert.equal(names.includes(name), false);
});

test('runtime files cover the CLI import graph and the PowerShell entry stays explicit', () => {
  const files = new Set(listRuntimeFiles());
  const missing = [];
  const pending = ['apps/cli/src/vpncp.ts', 'scripts/install-win.mjs'];
  const seen = new Set();
  const specifier = /(?:from\s+|import\s*\(\s*|new URL\(\s*)['"](\.[^'"]+)['"]/g;
  while (pending.length) {
    const rel = pending.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (!files.has(rel)) missing.push(rel);
    const source = readFileSync(join(repo, rel), 'utf8');
    const body = source.split(/\r?\n/).filter(line => !/^\s*import\s+type\s/.test(line)).join('\n');
    for (const match of body.matchAll(specifier)) {
      if (!/\.(?:ts|mjs|js|py|sh|ps1)$/.test(match[1])) continue;
      const next = join(dirname(rel), match[1]).replaceAll('\\', '/');
      pending.push(next);
    }
  }
  assert.deepEqual(missing, []);
  assert.equal(files.has('examples/operator-config.example.json'), true);
  assert.equal(files.has('packages/core/src/operator-config.ts'), true);
  const script = readFileSync(join(repo, 'scripts', 'install.ps1'), 'utf8');
  for (const phrase of ['does not install Node.js', 'engines.node', '[y/N]', '$ConfirmPath', 'current-user PATH', 'machine PATH is not changed', 'User configuration is kept', 'DefaultNoWhenRedirected']) {
    assert.equal(script.includes(phrase), true, phrase);
  }
  for (const phrase of ['winget', 'scoop', 'Remove-Item', 'Machine', 'apt-get', 'choco']) assert.equal(script.includes(phrase), false, phrase);
  assert.equal(readdirSync(repo).includes('rq.cmd'), false);
  const checkout = spawnSync(process.execPath, [join(repo, 'apps', 'cli', 'src', 'vpncp.ts'), '--help'], { encoding: 'utf8' });
  assert.equal(checkout.status, 0);
  assert.match(checkout.stdout, /routequay/);
});

test('a file path store round-trips the current-user PATH', () => {
  const box = workspace();
  const file = join(box.root, 'path.txt');
  const store = filePathStore(file);
  store.write(mergeUserPath('', box.dest));
  assert.equal(lstatSync(file).isFile(), true);
  assert.equal(removeUserPath(store.read(), box.dest), '');
});
