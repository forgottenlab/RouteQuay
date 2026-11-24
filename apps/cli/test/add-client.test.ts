import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArguments, renderHumanResult, runAddClient } from '../src/vpncp.ts';
import { AdoptionError, runAdoption, type AdoptionTransport, type Probe } from '../../../packages/core/src/xray-adoption.ts';
import { buildClientAppend, buildClientChangeScript, canonicalDigest, describeClientAppend } from '../../../packages/core/src/xray-client.ts';

const existingId = '11111111-1111-4111-8111-111111111111';
const keys = generateKeyPairSync('x25519');
const privateKey = keys.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('base64url');
const reality = { privateKey, serverNames: ['www.example.org'], shortIds: ['abcdef12'], minClientVer: '26.3.27', target: 'www.example.org:443' };

function baseConfig() {
  return { inbounds: [{ protocol: 'vless', port: 8443, settings: { decryption: 'none', clients: [
    { id: existingId, email: 'client-1', flow: 'xtls-rprx-vision' }] },
    streamSettings: { network: 'raw', security: 'reality', realitySettings: structuredClone(reality) } }] };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'routequay-add-client-'));
  const probe: Probe = { loadState: 'loaded', service: 'active', user: 'nobody', group: 'nogroup',
    version: 'Xray 26.11.9', configPath: '/usr/local/etc/xray/config.json',
    permissions: { uid: 65534, gid: 65534, mode: '0o640' }, listeners: ['*:8443'],
    diskMatchesRunning: true, layout: 'single-file', config: baseConfig() };
  const calls = { apply: 0 };
  const transport: AdoptionTransport = {
    resolve: alias => ({ alias, host: `${alias}.example.org`, user: 'root', port: 25281 }),
    probe: () => structuredClone(probe),
    applyClient(_target, payload) {
      calls.apply += 1;
      probe.config = payload.next;
      return { status: 'ROUTEQUAY_CLIENT_APPLIED' };
    }
  };
  return { root, probe, transport, calls };
}

function adopt(f: ReturnType<typeof fixture>) {
  assert.equal(runAdoption({ command: 'setup', nodeId: 'a' }, f.root, f.transport).status, 'adopted');
}

function rejects(action: () => unknown, code: string) {
  let found = '';
  try { action(); } catch (error) { found = error instanceof AdoptionError ? error.code : 'other'; }
  assert.equal(found, code);
}

function safe(text: string, extra: string[] = []): boolean {
  return !text.includes(privateKey) && !text.includes(existingId) && !text.includes('vless://')
    && !text.includes('abcdef12') && extra.every(secret => !text.includes(secret));
}

test('add-client accepts plan, apply, inbound and local labels, and rejects secrets in those labels', () => {
  const parsed = parseArguments(['add-client', 'node-a', '--plan', '--inbound', 'inbound-1', '--name', 'client-2', '--owner', 'self', '--remark', 'phone']);
  assert.equal(parsed.command, 'add-client');
  assert.equal(parsed.plan, true);
  assert.equal(parsed.inbound, 'inbound-1');
  assert.equal(parsed.name, 'client-2');
  assert.equal(parsed.ownerLabel, 'self');
  assert.equal(parsed.remark, 'phone');
  rejects(() => parseArguments(['add-client', 'node-a', '--plan', '--apply']), 'CONFLICTING_OPTIONS');
  rejects(() => parseArguments(['add-client', 'node-a', '--to', 'v2rayn']), 'OPTION_NOT_APPLICABLE');
  rejects(() => parseArguments(['status', 'node-a', '--owner', 'self']), 'OPTION_NOT_APPLICABLE');
  rejects(() => parseArguments(['add-client', 'node-a', '--owner', existingId]), 'OPTION_VALUE_INVALID');
  rejects(() => parseArguments(['add-client', 'node-a', '--name', 'has space']), 'OPTION_VALUE_INVALID');
});

test('plan reads the inbound and does not write a client or rotate REALITY', () => {
  const f = fixture();
  adopt(f);
  const before = canonicalDigest(f.probe.config);
  const result = runAdoption({ command: 'add-client', nodeId: 'a', plan: true }, f.root, f.transport);
  assert.equal(result.status, 'planned');
  assert.equal(result.changed, false);
  assert.equal(result.client, 'inbound-1-client-2');
  const plan = result.plan as { rotatesReality: boolean; changesMinClientVer: boolean; preservesExistingClients: boolean };
  assert.equal(plan.preservesExistingClients, true);
  assert.equal(plan.rotatesReality, false);
  assert.equal(plan.changesMinClientVer, false);
  assert.equal(f.calls.apply, 0);
  assert.equal(canonicalDigest(f.probe.config) === before, true);
  assert.equal((f.probe.config.inbounds[0].settings.clients as unknown[]).length, 1);
  assert.equal(existsSync(join(f.root, 'local/private/cli-nodes/a/inbound-1-client-2.vless.txt')), false);
  assert.equal(safe(JSON.stringify(result) + renderHumanResult(result)), true);
});

test('apply appends one UUID, keeps the existing client and REALITY, and writes only that client locally', async () => {
  const f = fixture();
  adopt(f);
  const directory = join(f.root, 'local/private/cli-nodes/a');
  const kept = join(directory, 'inbound-1-client-1.vless.txt');
  writeFileSync(kept, 'kept-local-file\n', { mode: 0o600 });
  const keptHash = createHash('sha256').update(readFileSync(kept)).digest('hex');
  const beforeReality = canonicalDigest(f.probe.config.inbounds[0].streamSettings);
  const beforeClient = canonicalDigest(f.probe.config.inbounds[0].settings.clients[0]);
  await assert.rejects(() => runAddClient({ command: 'add-client', nodeId: 'a', to: 'v2rayn' }, f.root, f.transport),
    (error: unknown) => error instanceof AdoptionError && error.code === 'CLIENT_APPROVAL_REQUIRED');
  assert.equal(f.calls.apply, 0);
  const result = runAdoption({ command: 'add-client', nodeId: 'a', apply: true, ownerLabel: 'self', remark: 'phone' }, f.root, f.transport);
  assert.equal(result.status, 'client-added');
  assert.equal(result.client, 'inbound-1-client-2');
  assert.equal(f.calls.apply, 1);
  const clients = f.probe.config.inbounds[0].settings.clients as Array<Record<string, string>>;
  assert.equal(clients.length, 2);
  assert.equal(canonicalDigest(clients[0]) === beforeClient, true);
  assert.equal(clients[0].id === existingId, true);
  assert.equal(clients[1].id === existingId, false);
  assert.equal(canonicalDigest(f.probe.config.inbounds[0].streamSettings) === beforeReality, true);
  assert.equal(f.probe.config.inbounds[0].streamSettings.realitySettings.minClientVer, '26.3.27');
  assert.equal(Object.keys(clients[1]).includes('id'), true);
  assert.equal(clients[1].email, 'client-2');
  assert.equal(clients[1].flow, 'xtls-rprx-vision');
  const names = ['inbound-1-client-2.vless.txt', 'inbound-1-client-2.vless.png', 'inbound-1-client-2.mihomo-provider.yaml',
    'inbound-1-client-2.mihomo-profile.yaml', 'inbound-1-client-2.sing-box.json'];
  for (const name of names) {
    const path = join(directory, name);
    assert.equal(existsSync(path), true);
    assert.equal(statSync(path).size > 32, true);
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  }
  if (process.platform !== 'win32') assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(createHash('sha256').update(readFileSync(kept)).digest('hex') === keptHash, true);
  const metadata = JSON.parse(readFileSync(join(directory, 'clients.local.json'), 'utf8')) as { clients: Array<Record<string, string>> };
  assert.equal(metadata.clients[0]?.ref, 'inbound-1-client-2');
  assert.equal(metadata.clients[0]?.ownerLabel, 'self');
  assert.equal(metadata.clients[0]?.remark, 'phone');
  assert.equal(JSON.stringify(metadata).includes(clients[1].id), false);
  const printed = JSON.stringify(result) + renderHumanResult(result);
  assert.equal(safe(printed, [clients[1].id]), true);
  assert.equal(printed.includes('self'), false);
  assert.equal(printed.includes('phone'), false);
  const status = runAdoption({ command: 'status', nodeId: 'a' }, f.root, f.transport);
  assert.deepEqual(status.clients, ['inbound-1-client-1', 'inbound-1-client-2']);
  rejects(() => runAdoption({ command: 'pull', nodeId: 'a' }, f.root, f.transport), 'CLIENT_SELECTION_REQUIRED');
  rejects(() => runAdoption({ command: 'export', nodeId: 'a' }, f.root, f.transport), 'CLIENT_SELECTION_REQUIRED');
  const pulled = runAdoption({ command: 'pull', nodeId: 'a', client: 'inbound-1-client-2' }, f.root, f.transport);
  assert.equal(pulled.client, 'inbound-1-client-2');
  assert.equal(safe(JSON.stringify(pulled), [clients[1].id]), true);
  assert.equal(createHash('sha256').update(readFileSync(kept)).digest('hex') === keptHash, true);
});

test('a second inbound must be selected, and mixed flow is refused before any write', () => {
  const f = fixture();
  f.probe.config.inbounds.push(structuredClone(f.probe.config.inbounds[0]));
  f.probe.config.inbounds[1].port = 9443;
  f.probe.config.inbounds[1].settings.clients[0].id = '00000000-0000-4000-8000-000000000002';
  f.probe.listeners = ['*:8443', '*:9443'];
  adopt(f);
  rejects(() => runAdoption({ command: 'add-client', nodeId: 'a', apply: true }, f.root, f.transport), 'INBOUND_SELECTION_REQUIRED');
  assert.equal(f.calls.apply, 0);
  const selected = runAdoption({ command: 'add-client', nodeId: 'a', apply: true, inbound: 'inbound-2' }, f.root, f.transport);
  assert.equal(selected.client, 'inbound-2-client-2');
  assert.equal((f.probe.config.inbounds[0].settings.clients as unknown[]).length, 1);
  assert.equal((f.probe.config.inbounds[1].settings.clients as unknown[]).length, 2);
  const mixed = fixture();
  adopt(mixed);
  mixed.probe.config.inbounds[0].settings.clients.push({ id: '22222222-2222-4222-8222-222222222222' });
  assert.equal(runAdoption({ command: 'setup', nodeId: 'a' }, mixed.root, mixed.transport).status, 'adopted');
  rejects(() => runAdoption({ command: 'add-client', nodeId: 'a', apply: true }, mixed.root, mixed.transport), 'CLIENT_FLOW_INCONSISTENT');
  assert.equal(mixed.calls.apply, 0);
});

test('a landed change resumes from the journal without appending another client', () => {
  const f = fixture();
  adopt(f);
  const baseline = canonicalDigest(f.probe.config);
  const built = buildClientAppend(f.probe.config);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  f.probe.config = built.plan.next;
  const journal = { schemaVersion: 'routequay-client-change-v1', id: 'ab'.repeat(16), nodeId: 'a',
    baselineCanonical: baseline, expectedCanonical: built.plan.canonicalHash, inboundIndex: 0, clientIndex: 1,
    configPath: '/usr/local/etc/xray/config.json', port: 8443 };
  writeFileSync(join(f.root, 'local/private/cli-nodes/a/client-change.local.json'), JSON.stringify(journal), { mode: 0o600 });
  const result = runAdoption({ command: 'add-client', nodeId: 'a', apply: true, ownerLabel: 'self' }, f.root, f.transport);
  assert.equal(result.status, 'client-added');
  assert.equal(result.client, 'inbound-1-client-2');
  assert.equal(f.calls.apply, 0);
  assert.equal((f.probe.config.inbounds[0].settings.clients as unknown[]).length, 2);
  assert.equal(existsSync(join(f.root, 'local/private/cli-nodes/a/client-change.local.json')), false);
  assert.equal(safe(JSON.stringify(result), [((f.probe.config.inbounds[0].settings.clients as Array<{ id: string }>)[1]).id]), true);
});

test('the remote append keeps bytes on refusal and restores them when restart fails', () => {
  const scriptPath = fileURLToPath(new URL('../../../packages/core/src/xray-add-client.py', import.meta.url));
  const secret = 'k'.repeat(43);
  const config = baseConfig();
  config.inbounds[0].streamSettings.realitySettings.privateKey = secret;
  const directory = mkdtempSync(join(tmpdir(), 'routequay-client-py-'));
  const path = join(directory, 'config.json');
  writeFileSync(path, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  const built = buildClientAppend(config);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  let receiptCount = 0;
  const run = (next: unknown, env: Record<string, string>) => {
    const receipt = join(directory, `receipt-${receiptCount += 1}`);
    const payload = { jobId: 'cd'.repeat(16), inboundIndex: 0, port: 8443, configPath: path, baseline: config, next, receiptDir: receipt };
    return spawnSync('python3', [scriptPath], { encoding: 'utf8', env: { ...process.env, ROUTEQUAY_CLIENT_LOCAL: '1',
      ROUTEQUAY_CLIENT_PAYLOAD: Buffer.from(JSON.stringify(payload)).toString('base64'), ...env } });
  };
  const applied = run(built.plan.next, {});
  assert.equal(applied.stdout === 'ROUTEQUAY_CLIENT_APPLIED\n' && applied.stderr === '' && applied.status === 0, true);
  const after = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(after.inbounds[0].settings.clients.length, 2);
  assert.equal(canonicalDigest(after.inbounds[0].streamSettings) === canonicalDigest(config.inbounds[0].streamSettings), true);
  assert.equal(after.inbounds[0].settings.clients[0].id === existingId, true);
  assert.equal(after.inbounds[0].streamSettings.realitySettings.minClientVer, '26.3.27');
  writeFileSync(path, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  const original = createHash('sha256').update(readFileSync(path)).digest('hex');
  const rotated = structuredClone(built.plan.next) as { inbounds: Array<{ streamSettings: { realitySettings: { privateKey: string } } }> };
  rotated.inbounds[0].streamSettings.realitySettings.privateKey = 'm'.repeat(43);
  const refused = run(rotated, {});
  assert.equal(refused.stdout === 'ROUTEQUAY_CLIENT_REFUSED\n' && refused.stderr === '', true);
  assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex') === original, true);
  const restored = run(built.plan.next, { ROUTEQUAY_CLIENT_RESTART_FAIL: '1' });
  assert.equal(restored.stdout === 'ROUTEQUAY_CLIENT_RESTORED\n' && restored.stderr === '', true);
  assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex') === original, true);
  const embedded = buildClientChangeScript({ jobId: 'ef'.repeat(16), inboundIndex: 0, port: 8443, configPath: path,
    baseline: config, next: built.plan.next });
  assert.equal(embedded.includes(secret), false);
  assert.equal(embedded.includes('vless://'), false);
  assert.equal(embedded.includes('ROUTEQUAY_CLIENT_APPLIED'), true);
  const described = describeClientAppend(config);
  assert.equal(described.ok, true);
  if (described.ok) assert.equal(safe(JSON.stringify(described.selection)), true);
});
