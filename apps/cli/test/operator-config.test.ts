import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/vpncp.ts';

const importScheme = `${'vle'}${'ss'}://`;

function capture(env: NodeJS.ProcessEnv, args: string[]): Promise<{ code: number; logs: string[] }> {
  const logs: string[] = [];
  const original = console.log;
  console.log = (line?: unknown) => { logs.push(String(line)); };
  return main(args, env).then(code => ({ code, logs })).finally(() => { console.log = original; });
}

test('init-config prints only the new path and refuses to overwrite or print the template', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'routequay-init-'));
  const configPath = join(dir, 'config.json');
  const env = { ...process.env, ROUTEQUAY_CONFIG: configPath };
  const created = await capture(env, ['init-config']);
  assert.equal(created.code, 0);
  assert.deepEqual(created.logs, [configPath]);
  const stored = readFileSync(configPath, 'utf8');
  for (const word of ['password', 'passphrase', importScheme, 'BEGIN ']) assert.equal(created.logs.join('\n').includes(word), false);
  assert.equal(created.logs.join('\n').includes('vpn.example.invalid'), false);
  const json = await capture({ ...process.env, ROUTEQUAY_CONFIG: join(dir, 'other.json') }, ['init', '--json']);
  assert.equal(json.code, 0);
  assert.deepEqual(JSON.parse(json.logs[0] ?? ''), { path: join(dir, 'other.json') });
  const again = await capture(env, ['init']);
  assert.equal(again.code, 2);
  assert.deepEqual(again.logs, [configPath]);
  assert.equal(again.logs.join('\n').includes('OPERATOR_CONFIG_EXISTS'), false);
  assert.equal(again.logs.join('\n').includes('操作失败'), false);
  assert.equal(again.logs.join('\n').includes('identityFile'), false);
  assert.equal(again.logs.join('\n').includes('vpn.example.invalid'), false);
  assert.equal(readFileSync(configPath, 'utf8'), stored);
  const named = await capture(env, ['init-config']);
  assert.equal(named.code, 2);
  assert.deepEqual(named.logs, [configPath]);
  const jsonAgain = await capture(env, ['init-config', '--json']);
  assert.equal(jsonAgain.code, 2);
  const refused = JSON.parse(jsonAgain.logs[0] ?? '');
  assert.equal(refused.code, 'OPERATOR_CONFIG_EXISTS');
  assert.equal(refused.details?.reason, configPath);
  assert.equal(jsonAgain.logs.join('\n').includes('vpn.example.invalid'), false);
  assert.equal(jsonAgain.logs.join('\n').includes('identityFile'), false);
  assert.equal(readFileSync(configPath, 'utf8'), stored);
  const forced = await capture({ ...process.env, ROUTEQUAY_CONFIG: join(dir, 'third.json') }, ['init-config', '--force']);
  assert.equal(forced.code, 2);
  assert.match(forced.logs.join('\n'), /UNKNOWN_OPTION/);
});

test('an invalid operator config fails before SSH and does not echo the file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'routequay-invalid-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, '{"schemaVersion":"routequay-operator-config-v1","nodes":[{"id":"example-node","password":"nope"}]}\n');
  const result = await capture({ ...process.env, ROUTEQUAY_CONFIG: configPath }, ['status', 'example-node', '--json']);
  assert.equal(result.code, 2);
  const body = JSON.parse(result.logs[0] ?? '');
  assert.equal(body.code, 'OPERATOR_CONFIG_FORBIDDEN_FIELD');
  assert.equal(result.logs.join('\n').includes('nope'), false);
  assert.equal(result.logs.join('\n').includes(importScheme), false);
});
