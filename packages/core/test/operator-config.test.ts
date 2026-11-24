import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdoptionError, SSH_IDENTITY_MAX_BYTES, prepareSshConnect, prepareSshResolve, sshResolveArgs, sshTargetArgs } from '../src/xray-adoption.ts';
import { resolveStateRoot } from '../src/install-layout.ts';
import {
  applyOperatorSshAlias, initOperatorConfig, operatorConfigPath, operatorSshFiles, readOperatorConfig, validateOperatorConfig
} from '../src/operator-config.ts';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const templatePath = join(repo, 'examples', 'operator-config.example.json');
const template = () => JSON.parse(readFileSync(templatePath, 'utf8')) as Record<string, unknown>;
const importScheme = `${'vle'}${'ss'}://`;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'routequay-operator-'));
}

test('the committed operator template is placeholder data with no password field', () => {
  const raw = readFileSync(templatePath, 'utf8');
  const config = validateOperatorConfig(JSON.parse(raw));
  assert.equal(config.schemaVersion, 'routequay-operator-config-v1');
  assert.equal(config.dataDir, '~/.routequay');
  assert.equal(config.ssh?.configPath, '~/.ssh/config');
  assert.equal(config.nodes[0]?.id, 'example-node');
  assert.equal(config.nodes[0]?.sshAlias, 'example-node');
  assert.equal(config.nodes[0]?.host, 'vpn.example.invalid');
  assert.equal(config.nodes[0]?.user, 'example-user');
  assert.equal(config.nodes[0]?.port, 22);
  assert.equal(config.nodes[0]?.identityFile, '~/.ssh/id_ed25519_example');
  assert.equal(config.nodes[0]?.authMethod, 'ssh-config');
  assert.equal(config.nodes[0]?.displayName, 'Example node');
  for (const word of ['password', 'passphrase', 'BEGIN ', importScheme]) assert.equal(raw.includes(word), false);
});

test('validation accepts an alias-only node and rejects secrets, unknown keys, and bad endpoints', () => {
  const aliasOnly = validateOperatorConfig({
    schemaVersion: 'routequay-operator-config-v1',
    nodes: [{ id: 'example-node', authMethod: 'agent' }]
  });
  assert.equal(aliasOnly.nodes[0]?.sshAlias, undefined);
  assert.equal(aliasOnly.nodes[0]?.authMethod, 'agent');
  const withKey = template();
  (withKey.nodes as Array<Record<string, unknown>>)[0].authMethod = 'ssh-key';
  assert.equal(validateOperatorConfig(withKey).nodes[0]?.authMethod, 'ssh-key');
  const cases: unknown[] = [
    { ...template(), password: 'nope' },
    { ...template(), nodes: [{ ...(template().nodes as object[])[0], passphrase: 'nope' }] },
    { ...template(), nodes: [{ ...(template().nodes as object[])[0], authMethod: 'password' }] },
    { ...template(), nodes: [{ ...(template().nodes as object[])[0], identityFile: `-----BEGIN OPENSSH PRIVATE KEY-----\nexample\n` }] },
    { ...template(), nodes: [{ ...(template().nodes as object[])[0], host: `${importScheme}vpn.example.invalid` }] },
    { ...template(), nodes: [{ ...(template().nodes as object[])[0], identityFile: 'A'.repeat(80) }] },
    { ...template(), extra: true },
    { ...template(), nodes: [{ ...(template().nodes as object[])[0], port: 0 }] },
    { ...template(), nodes: [{ ...(template().nodes as object[])[0], id: 'example-node' }, { id: 'example-node' }] }
  ];
  for (const value of cases) {
    assert.throws(() => validateOperatorConfig(value), (error: unknown) => error instanceof AdoptionError
      && (error.code === 'OPERATOR_CONFIG_INVALID' || error.code === 'OPERATOR_CONFIG_FORBIDDEN_FIELD'));
  }
});

test('init-config copies the template once, protects the file, and does not follow a symlink', () => {
  const dir = tempDir();
  const configPath = join(dir, 'config.json');
  const created = initOperatorConfig(repo, configPath);
  assert.equal(created, configPath);
  assert.equal(readFileSync(configPath, 'utf8'), readFileSync(templatePath, 'utf8'));
  if (process.platform !== 'win32') {
    assert.equal(statSync(configPath).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(configPath)).mode & 0o777, 0o700);
  }
  assert.throws(() => initOperatorConfig(repo, configPath), (error: unknown) => {
    return error instanceof AdoptionError && error.code === 'OPERATOR_CONFIG_EXISTS' && error.details?.reason === configPath;
  });
  assert.equal(readFileSync(configPath, 'utf8'), readFileSync(templatePath, 'utf8'));
  const linkedDir = tempDir();
  const target = join(linkedDir, 'target.json');
  const link = join(linkedDir, 'config.json');
  writeFileSync(target, '{"keep":true}\n');
  symlinkSync(target, link);
  assert.throws(() => initOperatorConfig(repo, link), (error: unknown) => error instanceof AdoptionError && error.code === 'OPERATOR_CONFIG_EXISTS');
  assert.equal(readFileSync(target, 'utf8'), '{"keep":true}\n');
});

test('a missing config is absent, an invalid config is refused, and sshAlias does not change SSH safety options', () => {
  const dir = tempDir();
  const missing = join(dir, 'missing.json');
  assert.equal(readOperatorConfig(missing), null);
  const broken = join(dir, 'broken.json');
  writeFileSync(broken, '{"schemaVersion":"routequay-operator-config-v1","nodes":[{"id":"example-node","password":"nope"}]}\n');
  assert.throws(() => readOperatorConfig(broken), (error: unknown) => error instanceof AdoptionError && error.code === 'OPERATOR_CONFIG_FORBIDDEN_FIELD');
  const config = validateOperatorConfig(template());
  const home = join(dir, 'home');
  assert.equal(operatorConfigPath({}, home), join(home, '.routequay', 'config.json'));
  assert.equal(operatorConfigPath({ ROUTEQUAY_CONFIG: '~/custom.json' }, home), join(home, 'custom.json'));
  const options = { command: 'status' as const, nodeId: 'example-node', to: 'v2rayn' };
  assert.equal(applyOperatorSshAlias(options, config).ssh, 'example-node');
  assert.equal(applyOperatorSshAlias({ ...options, ssh: 'other-alias' }, config).ssh, 'other-alias');
  assert.equal(applyOperatorSshAlias(options, null).ssh, undefined);
  assert.equal(applyOperatorSshAlias({ ...options, nodeId: 'other-node' }, config).ssh, undefined);
  const args = sshTargetArgs({ alias: 'example-node', host: 'vpn.example.invalid', user: 'example-user', port: 22 });
  assert.equal(args.includes('BatchMode=yes'), true);
  assert.equal(args.includes('StrictHostKeyChecking=yes'), true);
  assert.equal(args.includes('-F'), false);
  assert.equal(args.includes('-i'), false);
  assert.equal(args.includes('IdentitiesOnly=yes'), false);
  assert.equal(args.some(arg => arg.startsWith('IdentityFile=')), false);
  const installed = tempDir();
  writeFileSync(join(installed, 'routequay-install.json'), JSON.stringify({
    schemaVersion: 'routequay-install-v1', layout: 'windows-user', version: '0.1.0', node: '>=22.19.0', ownedFiles: ['routequay.cmd']
  }));
  assert.equal(resolveStateRoot(installed, { home, env: {}, configuredDataDir: config.dataDir }), join(home, '.routequay'));
  assert.equal(resolveStateRoot(dir, { home, env: {}, configuredDataDir: config.dataDir }), dir);
});

test('ssh -F and identity file are applied as paths, and unsafe files fail before ssh', () => {
  const dir = tempDir();
  const home = join(dir, 'home');
  const config = validateOperatorConfig(template());
  const files = operatorSshFiles(config, 'example-node', home);
  assert.deepEqual(files, {
    configFile: join(home, '.ssh', 'config'),
    identityFile: join(home, '.ssh', 'id_ed25519_example')
  });
  assert.equal(operatorSshFiles(null, 'example-node', home).configFile, undefined);
  assert.equal(operatorSshFiles(config, 'other-node', home).identityFile, undefined);
  assert.equal(operatorSshFiles(config, 'other-node', home).configFile, files.configFile);
  const keyOnly = validateOperatorConfig({
    schemaVersion: 'routequay-operator-config-v1',
    nodes: [{ id: 'example-node', identityFile: '~/fixture-identity' }]
  });
  assert.deepEqual(operatorSshFiles(keyOnly, 'example-node', home), { identityFile: join(home, 'fixture-identity') });
  assert.throws(() => operatorSshFiles(validateOperatorConfig({
    schemaVersion: 'routequay-operator-config-v1',
    nodes: [{ id: 'example-node', identityFile: '-fixture-identity' }]
  }), 'example-node', home), (error: unknown) => error instanceof AdoptionError && error.code === 'OPERATOR_CONFIG_INVALID');
  const target = { alias: 'example-node', host: '192.0.2.20', user: 'admin', port: 2222 };
  const plain = sshTargetArgs(target);
  assert.deepEqual(plain, ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=10',
    '-o', 'HostName=192.0.2.20', '-p', '2222', '-l', 'admin', 'example-node']);
  const cfg = join(dir, 'fixture ssh config');
  const key = join(dir, 'fixture-identity#kept');
  const body = 'fixture-file-body\n';
  writeFileSync(cfg, `Host example-node\n${body}`, { mode: 0o644 });
  writeFileSync(key, body, { mode: 0o600 });
  chmodSync(cfg, 0o644);
  chmodSync(key, 0o600);
  const withFiles = { configFile: cfg, identityFile: key };
  const args = prepareSshConnect(target, withFiles);
  assert.deepEqual(args, ['-F', cfg, '-i', key, '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=10', '-o', 'IdentitiesOnly=yes',
    '-o', 'HostName=192.0.2.20', '-p', '2222', '-l', 'admin', 'example-node']);
  assert.equal(args.includes('HostName=vpn.example.invalid'), false);
  assert.equal(args.includes('example-user'), false);
  assert.equal(args.includes('StrictHostKeyChecking=no'), false);
  assert.equal(args.some(arg => arg.includes('known_hosts') || arg.includes(body.trim()) || arg.includes('BEGIN ') || arg.includes('Host example-node')), false);
  assert.deepEqual(prepareSshResolve('example-node', withFiles), ['-F', cfg, '-G', 'example-node']);
  assert.equal(sshResolveArgs('example-node', withFiles).includes(key), false);
  assert.deepEqual(sshResolveArgs('example-node'), ['-G', 'example-node']);
  assert.equal(sshTargetArgs(target, { configFile: cfg }).includes('IdentitiesOnly=yes'), false);
  assert.equal(sshTargetArgs(target, { configFile: cfg }).includes('-i'), false);
  const refused = (filesToCheck: { configFile?: string; identityFile?: string }, code: string) => {
    assert.throws(() => prepareSshConnect(target, filesToCheck), (error: unknown) => {
      return error instanceof AdoptionError && error.code === code && error.exitCode === 4 && error.details === undefined
        && error.message === code && !String(error).includes(body.trim());
    });
  };
  refused({ configFile: join(dir, 'missing-ssh-config'), identityFile: key }, 'SSH_CONFIG_UNAVAILABLE');
  refused({ identityFile: join(dir, 'missing-identity') }, 'SSH_IDENTITY_UNAVAILABLE');
  const linked = join(dir, 'linked-identity');
  symlinkSync(key, linked);
  refused({ identityFile: linked }, 'SSH_IDENTITY_UNAVAILABLE');
  const linkedConfig = join(dir, 'linked-ssh-config');
  symlinkSync(cfg, linkedConfig);
  refused({ configFile: linkedConfig, identityFile: key }, 'SSH_CONFIG_UNAVAILABLE');
  const directory = join(dir, 'identity-dir');
  mkdirSync(directory);
  refused({ identityFile: directory }, 'SSH_IDENTITY_UNAVAILABLE');
  const emptyKey = join(dir, 'empty-identity');
  writeFileSync(emptyKey, '', { mode: 0o600 });
  chmodSync(emptyKey, 0o600);
  refused({ identityFile: emptyKey }, 'SSH_IDENTITY_UNAVAILABLE');
  if (process.platform !== 'win32') {
    const loose = join(dir, 'loose-identity');
    writeFileSync(loose, body, { mode: 0o600 });
    chmodSync(loose, 0o644);
    refused({ identityFile: loose }, 'SSH_IDENTITY_UNAVAILABLE');
  }
  const huge = join(dir, 'huge-identity');
  writeFileSync(huge, Buffer.alloc(SSH_IDENTITY_MAX_BYTES + 1, 0x61), { mode: 0o600 });
  chmodSync(huge, 0o600);
  refused({ identityFile: huge }, 'SSH_IDENTITY_UNAVAILABLE');
  assert.throws(() => prepareSshResolve('../bad', withFiles), (error: unknown) => error instanceof AdoptionError && error.code === 'SSH_ALIAS_INVALID');
  assert.equal(readFileSync(key, 'utf8'), body);
});
