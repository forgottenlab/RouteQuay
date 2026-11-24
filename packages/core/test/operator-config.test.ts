import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdoptionError, sshTargetArgs } from '../src/xray-adoption.ts';
import { resolveStateRoot } from '../src/install-layout.ts';
import {
  applyOperatorSshAlias, initOperatorConfig, operatorConfigPath, readOperatorConfig, validateOperatorConfig
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
  assert.equal(args.some(arg => arg.startsWith('IdentityFile=')), false);
  const installed = tempDir();
  writeFileSync(join(installed, 'routequay-install.json'), JSON.stringify({
    schemaVersion: 'routequay-install-v1', layout: 'windows-user', version: '0.1.0', node: '>=22.19.0', ownedFiles: ['routequay.cmd']
  }));
  assert.equal(resolveStateRoot(installed, { home, env: {}, configuredDataDir: config.dataDir }), join(home, '.routequay'));
  assert.equal(resolveStateRoot(dir, { home, env: {}, configuredDataDir: config.dataDir }), dir);
});
