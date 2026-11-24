import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { help, parseArguments, parseGroupArguments, renderGroupResult, renderHumanResult } from '../src/vpncp.ts';
import { AdoptionError, configDigest, runAdoption, runClientGroups, type AdoptionTransport, type ClientGroupCommand, type Probe } from '../../../packages/core/src/xray-adoption.ts';
import { applyGroupAction, emptyClientGroupFile, groupLimit, groupMemberLimit, parseClientGroupFile, GroupStoreError } from '../../../packages/core/src/client-groups.ts';

const existingId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const keys = generateKeyPairSync('x25519');
const privateKey = keys.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('base64url');
const reality = { privateKey, serverNames: ['www.example.org'], shortIds: ['abcdef12'], minClientVer: '26.3.27', target: 'www.example.org:443' };
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const cli = fileURLToPath(new URL('../src/vpncp.ts', import.meta.url));

function client(id: string, email: string) {
  return { id, email, flow: 'xtls-rprx-vision' };
}

function configWith(ids: Array<{ id: string; email: string }>) {
  return { inbounds: [{ protocol: 'vless', port: 8443, settings: { decryption: 'none', clients: ids.map(item => client(item.id, item.email)) },
    streamSettings: { network: 'raw', security: 'reality', realitySettings: structuredClone(reality) } }] };
}

function fixture(clients = [{ id: existingId, email: 'client-1' }, { id: secondId, email: 'client-2' }]) {
  const root = mkdtempSync(join(tmpdir(), 'routequay-groups-'));
  const probe: Probe = { loadState: 'loaded', service: 'active', user: 'nobody', group: 'nogroup',
    version: 'Xray 26.11.9', configPath: '/usr/local/etc/xray/config.json',
    permissions: { uid: 65534, gid: 65534, mode: '0o640' }, listeners: ['*:8443'],
    diskMatchesRunning: true, layout: 'single-file', config: configWith(clients) };
  const calls = { apply: 0, probe: 0 };
  const transport: AdoptionTransport = {
    resolve: alias => ({ alias, host: `${alias}.example.org`, user: 'root', port: 25281 }),
    probe: () => { calls.probe += 1; return structuredClone(probe); },
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
  try { action(); }
  catch (error) { found = error instanceof AdoptionError ? error.code : error instanceof GroupStoreError ? error.code : 'other'; }
  assert.equal(found, code);
}

function fileDigest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function safe(text: string): boolean {
  return !text.includes(privateKey) && !text.includes(existingId) && !text.includes(secondId)
    && !/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i.test(text)
    && !text.includes('vless://') && !text.includes('abcdef12') && !text.includes('desk-note') && !text.includes('operator-label');
}

function groupFile(root: string): string {
  return join(root, 'local/private/cli-nodes/a/groups.local.json');
}

function stateFile(root: string): string {
  return join(root, 'local/private/cli-nodes/a/state.local.json');
}

function run(command: ClientGroupCommand, root: string) {
  return runClientGroups(command, root);
}

test('group names are operator-chosen labels, and partial documents fail closed', () => {
  const example = parseClientGroupFile(JSON.parse(readFileSync(join(repo, 'examples/client-groups.example.json'), 'utf8')), 'example-node');
  assert.deepEqual(example.groups.map(group => group.name), ['self', 'friend-a']);
  assert.deepEqual(example.groups[0]?.members, ['inbound-1-client-1']);
  const template = readFileSync(join(repo, 'examples/operator-config.example.json'), 'utf8');
  for (const word of ['configPath', 'knownHostsPath', 'identityFile']) assert.equal(template.includes(word), false);
  assert.equal(help.includes('vless://'), false);
  assert.equal(help.includes('add-member'), true);
  const base = { schemaVersion: 'routequay-client-groups-v1', nodeId: 'a', groups: [{ name: 'self', members: ['inbound-1-client-1'] }] };
  rejects(() => parseClientGroupFile({ ...base, groups: [{ name: 'self' }] }, 'a'), 'GROUP_STORE_INVALID');
  rejects(() => parseClientGroupFile({ ...base, nodeId: 'other' }, 'a'), 'GROUP_STORE_INVALID');
  rejects(() => parseClientGroupFile({ ...base, extra: true }, 'a'), 'GROUP_STORE_INVALID');
  rejects(() => parseClientGroupFile({ ...base, groups: [{ name: 'self', members: ['inbound-1-client-1', 'inbound-1-client-1'] }] }, 'a'), 'GROUP_STORE_INVALID');
  rejects(() => parseClientGroupFile({ ...base, groups: [{ name: 'self', members: [], note: 'desk-note' }] }, 'a'), 'GROUP_STORE_INVALID');
  rejects(() => parseClientGroupFile('{', 'a'), 'GROUP_STORE_INVALID');
  const parsed = parseGroupArguments(['group', 'node-a', 'add-member', 'friend-a', '--client', 'inbound-1-client-2', '--json']);
  assert.equal(parsed.name, 'friend-a');
  assert.equal(parsed.client, 'inbound-1-client-2');
  rejects(() => parseGroupArguments(['group', 'node-a', 'create', existingId]), 'OPTION_VALUE_INVALID');
  rejects(() => parseArguments(['export', 'node-a', '--client', 'inbound-1-client-1', '--group', 'self']), 'CONFLICTING_OPTIONS');
  rejects(() => parseArguments(['status', 'node-a', '--group', 'self']), 'OPTION_NOT_APPLICABLE');
  rejects(() => parseArguments(['add-client', 'node-a', '--group', 'self']), 'OPTION_NOT_APPLICABLE');
});

test('pure group edits enforce size limits and do not invent a fixed taxonomy', () => {
  let file = emptyClientGroupFile('a');
  const known = new Set(Array.from({ length: groupMemberLimit + 1 }, (_, index) => `inbound-1-client-${index + 1}`));
  for (let index = 0; index < groupLimit; index += 1) {
    file = applyGroupAction(file, { action: 'create', name: `set-${index + 1}` }).file;
  }
  assert.throws(() => applyGroupAction(file, { action: 'create', name: 'set-extra' }), (error: unknown) => error instanceof GroupStoreError && error.code === 'GROUP_LIMIT');
  let members = emptyClientGroupFile('a');
  members = applyGroupAction(members, { action: 'create', name: 'classmate-1' }).file;
  for (let index = 0; index < groupMemberLimit; index += 1) {
    members = applyGroupAction(members, { action: 'add-member', name: 'classmate-1', client: `inbound-1-client-${index + 1}`, knownRefs: known }).file;
  }
  assert.equal(members.groups[0]?.members.length, groupMemberLimit);
  assert.throws(() => applyGroupAction(members, { action: 'add-member', name: 'classmate-1', client: `inbound-1-client-${groupMemberLimit + 1}`, knownRefs: known }),
    (error: unknown) => error instanceof GroupStoreError && error.code === 'GROUP_MEMBER_LIMIT');
});

test('group commands stay on the adopted snapshot and never call the server', () => {
  const f = fixture();
  adopt(f);
  const probed = f.calls.probe;
  const stateDigest = fileDigest(stateFile(f.root));
  const remoteDigest = configDigest(f.probe.config);
  const listed = run({ nodeId: 'a', action: 'list' }, f.root);
  assert.equal(listed.status, 'listed');
  assert.deepEqual(listed.groups, []);
  assert.equal(existsSync(groupFile(f.root)), false);
  const created = run({ nodeId: 'a', action: 'create', name: 'self' }, f.root);
  assert.equal(created.status, 'created');
  assert.equal(created.changed, true);
  const added = run({ nodeId: 'a', action: 'add-member', name: 'self', client: 'inbound-1-client-1' }, f.root);
  assert.equal(added.status, 'member-added');
  assert.deepEqual(added.groups, [{ name: 'self', members: ['inbound-1-client-1'] }]);
  const again = run({ nodeId: 'a', action: 'add-member', name: 'self', client: 'inbound-1-client-1' }, f.root);
  assert.equal(again.status, 'unchanged');
  assert.equal(again.changed, false);
  run({ nodeId: 'a', action: 'add-member', name: 'self', client: 'inbound-1-client-2' }, f.root);
  const renamed = run({ nodeId: 'a', action: 'rename', name: 'self', newName: 'friend-a' }, f.root);
  assert.equal(renamed.status, 'renamed');
  assert.deepEqual(renamed.groups, [{ name: 'friend-a', members: ['inbound-1-client-1', 'inbound-1-client-2'] }]);
  const removedMember = run({ nodeId: 'a', action: 'remove-member', name: 'friend-a', client: 'inbound-1-client-2' }, f.root);
  assert.deepEqual(removedMember.groups, [{ name: 'friend-a', members: ['inbound-1-client-1'] }]);
  rejects(() => run({ nodeId: 'a', action: 'add-member', name: 'friend-a', client: 'inbound-1-client-9' }, f.root), 'CLIENT_NOT_FOUND');
  rejects(() => run({ nodeId: 'a', action: 'create', name: 'friend-a' }, f.root), 'GROUP_EXISTS');
  rejects(() => run({ nodeId: 'a', action: 'remove', name: 'missing' }, f.root), 'GROUP_NOT_FOUND');
  const removed = run({ nodeId: 'a', action: 'remove', name: 'friend-a' }, f.root);
  assert.equal(removed.status, 'removed');
  assert.deepEqual(removed.groups, []);
  assert.equal(f.calls.probe, probed);
  assert.equal(f.calls.apply, 0);
  assert.equal(fileDigest(stateFile(f.root)), stateDigest);
  assert.equal(configDigest(f.probe.config), remoteDigest);
  const stored = readFileSync(groupFile(f.root), 'utf8');
  assert.equal(stored.includes(existingId), false);
  assert.equal(stored.includes('friend-a'), false);
  if (process.platform !== 'win32') assert.equal(statSync(groupFile(f.root)).mode & 0o777, 0o600);
  const status = runAdoption({ command: 'status', nodeId: 'a' }, f.root, f.transport);
  assert.deepEqual(status.clients, ['inbound-1-client-1', 'inbound-1-client-2']);
  assert.deepEqual(status.groups, []);
});

test('a missing group file lists nothing, and a partial file is left untouched', () => {
  const f = fixture([{ id: existingId, email: 'client-1' }]);
  adopt(f);
  const digest = fileDigest(stateFile(f.root));
  writeFileSync(groupFile(f.root), '{', { mode: 0o600 });
  const partial = fileDigest(groupFile(f.root));
  rejects(() => run({ nodeId: 'a', action: 'list' }, f.root), 'GROUP_STORE_INVALID');
  rejects(() => run({ nodeId: 'a', action: 'create', name: 'self' }, f.root), 'GROUP_STORE_INVALID');
  assert.equal(fileDigest(groupFile(f.root)), partial);
  assert.equal(readFileSync(groupFile(f.root), 'utf8'), '{');
  assert.equal(fileDigest(stateFile(f.root)), digest);
  assert.equal(f.calls.apply, 0);
  rejects(() => runClientGroups({ nodeId: 'missing', action: 'list' }, f.root), 'SETUP_REQUIRED');
  assert.equal(existsSync(join(f.root, 'local/private/cli-nodes/missing/groups.local.json')), false);
});

test('a symlinked group file is refused and remote clients stay in place', () => {
  const f = fixture();
  adopt(f);
  const digest = fileDigest(stateFile(f.root));
  if (process.platform === 'win32') return;
  symlinkSync(stateFile(f.root), groupFile(f.root));
  rejects(() => run({ nodeId: 'a', action: 'create', name: 'self' }, f.root), 'PRIVATE_PATH_UNSAFE');
  assert.equal(lstatSync(groupFile(f.root)).isSymbolicLink(), true);
  assert.equal(fileDigest(stateFile(f.root)), digest);
  assert.equal(f.calls.apply, 0);
});

test('status lists group membership by ref, and local owner labels stay unprinted', () => {
  const f = fixture();
  adopt(f);
  run({ nodeId: 'a', action: 'create', name: 'friend-a' }, f.root);
  run({ nodeId: 'a', action: 'add-member', name: 'friend-a', client: 'inbound-1-client-2' }, f.root);
  const directory = join(f.root, 'local/private/cli-nodes/a');
  writeFileSync(join(directory, 'clients.local.json'), `${JSON.stringify({ schemaVersion: 'routequay-client-metadata-v1', nodeId: 'a',
    clients: [{ ref: 'inbound-1-client-1', ownerLabel: 'operator-label', remark: 'desk-note' }] })}\n`, { mode: 0o600 });
  const status = runAdoption({ command: 'status', nodeId: 'a' }, f.root, f.transport);
  assert.deepEqual(status.groups, [{ name: 'friend-a', members: ['inbound-1-client-2'] }]);
  const printed = JSON.stringify(status) + renderHumanResult(status);
  assert.equal(printed.includes('friend-a'), true);
  assert.equal(printed.includes('inbound-1-client-2'), true);
  assert.equal(printed.includes('desk-note'), false);
  assert.equal(printed.includes('operator-label'), false);
  assert.equal(safe(printed), true);
  f.probe.loadState = 'not-found';
  const absent = runAdoption({ command: 'status', nodeId: 'a' }, f.root, f.transport);
  assert.equal(absent.status, 'not-installed');
  assert.deepEqual(absent.groups, [{ name: 'friend-a', members: ['inbound-1-client-2'] }]);
  assert.equal(safe(JSON.stringify(absent) + renderHumanResult(absent)), true);
});

test('export and pull write one official file set per member and stop before a partial write', () => {
  const f = fixture();
  adopt(f);
  run({ nodeId: 'a', action: 'create', name: 'self' }, f.root);
  rejects(() => runAdoption({ command: 'export', nodeId: 'a', group: 'self', to: 'v2rayn' }, f.root, f.transport), 'GROUP_EMPTY');
  rejects(() => runAdoption({ command: 'pull', nodeId: 'a', group: 'missing' }, f.root, f.transport), 'GROUP_NOT_FOUND');
  run({ nodeId: 'a', action: 'add-member', name: 'self', client: 'inbound-1-client-2' }, f.root);
  run({ nodeId: 'a', action: 'add-member', name: 'self', client: 'inbound-1-client-1' }, f.root);
  const directory = join(f.root, 'local/private/cli-nodes/a');
  const remoteDigest = configDigest(f.probe.config);
  rejects(() => runAdoption({ command: 'export', nodeId: 'a', group: 'self', to: 'v2rayn', out: join(f.root, 'missing-out') }, f.root, f.transport), 'OUTPUT_DIRECTORY_MISSING');
  assert.equal(existsSync(join(directory, 'inbound-1-client-1.vless.txt')), false);
  const exported = runAdoption({ command: 'export', nodeId: 'a', group: 'self', to: 'v2rayn' }, f.root, f.transport);
  assert.equal(exported.status, 'exported');
  assert.deepEqual(exported.members, ['inbound-1-client-2', 'inbound-1-client-1']);
  assert.equal(exported.outputFile, undefined);
  const files = exported.outputFiles as Array<{ path: string; status: string }>;
  assert.deepEqual(files.map(file => file.path.slice(directory.length + 1)), ['inbound-1-client-2.vless.txt', 'inbound-1-client-1.vless.txt']);
  assert.equal(existsSync(join(directory, 'inbound-1-client-1.vless.png')), false);
  const printed = JSON.stringify(exported) + renderHumanResult(exported);
  assert.equal(safe(printed), true);
  assert.equal(printed.includes('inbound-1-client-1.vless.txt'), true);
  writeFileSync(join(directory, 'inbound-1-client-1.vless.txt'), 'x\n', { mode: 0o600 });
  unlinkSync(join(directory, 'inbound-1-client-2.vless.txt'));
  rejects(() => runAdoption({ command: 'export', nodeId: 'a', group: 'self', to: 'v2rayn' }, f.root, f.transport), 'OUTPUT_EXISTS');
  assert.equal(existsSync(join(directory, 'inbound-1-client-2.vless.txt')), false);
  const handoff = join(f.root, 'handoff');
  mkdirSync(handoff);
  const pulled = runAdoption({ command: 'pull', nodeId: 'a', group: 'self', out: handoff }, f.root, f.transport);
  const names = readdirSync(handoff).sort();
  assert.deepEqual(names, [
    'inbound-1-client-1.mihomo-profile.yaml', 'inbound-1-client-1.mihomo-provider.yaml', 'inbound-1-client-1.sing-box.json',
    'inbound-1-client-1.vless.png', 'inbound-1-client-1.vless.txt', 'inbound-1-client-2.mihomo-profile.yaml',
    'inbound-1-client-2.mihomo-provider.yaml', 'inbound-1-client-2.sing-box.json', 'inbound-1-client-2.vless.png',
    'inbound-1-client-2.vless.txt'
  ]);
  assert.equal(names.some(name => name.includes('self') || name.includes('friend')), false);
  assert.equal(safe(JSON.stringify(pulled) + renderHumanResult(pulled)), true);
  assert.equal(configDigest(f.probe.config), remoteDigest);
  assert.equal(f.calls.apply, 0);
  const removed = run({ nodeId: 'a', action: 'remove', name: 'self' }, f.root);
  assert.equal(removed.status, 'removed');
  const after = runAdoption({ command: 'status', nodeId: 'a' }, f.root, f.transport);
  assert.deepEqual(after.clients, ['inbound-1-client-1', 'inbound-1-client-2']);
  assert.deepEqual(after.groups, []);
  assert.equal(configDigest(f.probe.config), remoteDigest);
});

test('adding a client does not upload groups or drop the local record', () => {
  const f = fixture([{ id: existingId, email: 'client-1' }]);
  adopt(f);
  run({ nodeId: 'a', action: 'create', name: 'self' }, f.root);
  run({ nodeId: 'a', action: 'add-member', name: 'self', client: 'inbound-1-client-1' }, f.root);
  const carriesGroup = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some(carriesGroup);
    return Object.prototype.hasOwnProperty.call(value, 'groups') || Object.values(value).some(carriesGroup);
  };
  let sawGroup = false;
  f.transport.applyClient = (_target, payload) => {
    sawGroup = carriesGroup(payload.next) || carriesGroup(payload.baseline);
    f.probe.config = payload.next;
    f.calls.apply += 1;
    return { status: 'ROUTEQUAY_CLIENT_APPLIED' };
  };
  const added = runAdoption({ command: 'add-client', nodeId: 'a', apply: true }, f.root, f.transport);
  assert.equal(added.client, 'inbound-1-client-2');
  assert.equal(sawGroup, false);
  assert.equal(f.calls.apply, 1);
  const stored = JSON.parse(readFileSync(groupFile(f.root), 'utf8')) as { groups: Array<{ name: string; members: string[] }> };
  assert.deepEqual(stored.groups, [{ name: 'self', members: ['inbound-1-client-1'] }]);
  const printed = JSON.stringify(added) + renderHumanResult(added) + renderGroupResult(run({ nodeId: 'a', action: 'list' }, f.root));
  assert.equal(safe(printed), true);
});

test('the group command does not stat an operator identity file', () => {
  const f = fixture([{ id: existingId, email: 'client-1' }]);
  adopt(f);
  const configPath = join(f.root, 'operator.json');
  writeFileSync(configPath, JSON.stringify({ schemaVersion: 'routequay-operator-config-v1', nodes: [{ id: 'a', identityFile: 'missing-key' }] }));
  const runCli = spawnSync(process.execPath, [cli, 'group', 'a', 'create', 'classmate-1', '--json'], {
    env: { ...process.env, ROUTEQUAY_DATA_DIR: f.root, ROUTEQUAY_CONFIG: configPath }, encoding: 'utf8'
  });
  assert.equal(runCli.status, 0, runCli.stdout);
  assert.equal(existsSync(join(f.root, 'missing-key')), false);
  const body = JSON.parse(runCli.stdout) as { status: string; groups: Array<{ name: string }> };
  assert.equal(body.status, 'created');
  assert.equal(body.groups[0]?.name, 'classmate-1');
  assert.equal(safe(runCli.stdout), true);
  assert.equal(runCli.stdout.includes('vless://'), false);
});
