import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArguments, renderHumanResult } from '../src/vpncp.ts';
import { AdoptionError, parseSshConfig, runAdoption, realityPublicKey, privateDirectory, sshTargetArgs, type Probe, type AdoptionTransport } from '../../../packages/core/src/xray-adoption.ts';

const keys = generateKeyPairSync('x25519');
const privateKey = keys.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('base64url');
const uuid = '11111111-1111-4111-8111-111111111111';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'vpncp-adopt-'));
  const probe: Probe = { loadState: 'loaded', service: 'active', user: 'nobody', group: 'nogroup',
    version: 'Xray 26.11.9', configPath: '/usr/local/etc/xray/config.json',
    permissions: { uid: 65534, gid: 65534, mode: '0o640' }, listeners: ['*:8443'],
    diskMatchesRunning: true, layout: 'single-file', config: { inbounds: [{ protocol: 'vless', port: 8443,
      settings: { clients: [{ id: uuid, flow: 'xtls-rprx-vision' }] }, streamSettings: {
        network: 'raw', security: 'reality', realitySettings: { privateKey,
          serverNames: ['www.example.org'], shortIds: ['abcdef12'] } } }] } };
  const calls: string[] = [];
  const transport: AdoptionTransport = { resolve: alias => ({ alias, host: `${alias}.example.org`, user: 'root', port: 25281 }),
    probe: target => { calls.push(target.alias); return structuredClone(probe); } };
  return { root, probe, calls, transport };
}
function rejects(action: () => unknown, code: string) {
  let found = '';
  try { action(); } catch (error) { found = error instanceof AdoptionError ? error.code : 'other'; }
  assert.equal(found, code);
}
test('default parameters, explicit overrides, unknown and duplicate flags', () => {
  assert.equal(parseArguments(['setup', 'node-a']).to, 'v2rayn');
  assert.equal(parseArguments(['setup', 'node-a', '--ssh', 'alias', '--plan']).ssh, 'alias');
  assert.equal(parseArguments(['export', 'node-a', '--out', 'my file.txt', '--client', 'ref']).out, 'my file.txt');
  assert.equal(parseArguments(['export', 'node-a', '--to', 'mihomo-provider']).to, 'mihomo-provider');
  assert.equal(parseArguments(['export', 'node-a', '--to', 'mihomo-profile']).to, 'mihomo-profile');
  assert.equal(parseArguments(['export', 'node-a', '--to', 'vless-qr']).to, 'vless-qr');
  assert.equal(parseArguments(['export', 'node-a', '--to', 'sing-box']).to, 'sing-box');
  assert.equal(parseArguments(['pull', 'node-a', '--client', 'inbound-1-client-1', '--out', 'out-dir']).command, 'pull');
  assert.equal(parseArguments(['pull', 'node-a', '--client', 'inbound-1-client-1', '--out', 'out-dir']).out, 'out-dir');
  rejects(() => parseArguments(['pull', 'node-a', '--to', 'v2rayn']), 'OPTION_NOT_APPLICABLE');
  rejects(() => parseArguments(['export', 'node-a', '--to', 'clash']), 'EXPORT_FORMAT_UNSUPPORTED');
  rejects(() => parseArguments(['export', 'node-a', '--to', 'bad']), 'EXPORT_FORMAT_UNSUPPORTED');
  rejects(() => parseArguments(['status', 'a', '--plan']), 'UNKNOWN_OPTION');
  rejects(() => parseArguments(['setup', 'a', '--ssh']), 'OPTION_VALUE_REQUIRED');
  rejects(() => parseArguments(['setup', 'a', '--json', '--json']), 'DUPLICATE_OPTION');
});
test('Windows OpenSSH effective configuration parses CRLF and nonstandard port', () => {
  assert.deepEqual(parseSshConfig('alias', 'host alias\r\nhostname 192.0.2.10\r\nuser root\r\nport 25281\r\n'),
    { alias: 'alias', host: '192.0.2.10', user: 'root', port: 25281 });
  rejects(() => parseSshConfig('alias', 'hostname -bad\nport 0\nuser root'), 'SSH_TARGET_INVALID');
});
test('plan does not write; repeat adoption preserves credentials and state; nodes stay isolated', () => {
  const f = fixture();
  const before = JSON.stringify(f.probe);
  runAdoption({ command: 'setup', nodeId: 'a', ssh: 'alias-a', plan: true }, f.root, f.transport);
  assert.equal(existsSync(join(f.root, 'local')), false);
  assert.equal(runAdoption({ command: 'setup', nodeId: 'a', ssh: 'alias-a' }, f.root, f.transport).status, 'adopted');
  const state = join(f.root, 'local/private/cli-nodes/a/state.local.json');
  const content = readFileSync(state, 'utf8');
  assert.equal(runAdoption({ command: 'setup', nodeId: 'a' }, f.root, f.transport).status, 'unchanged');
  assert.equal(readFileSync(state, 'utf8'), content);
  runAdoption({ command: 'setup', nodeId: 'b', ssh: 'alias-b' }, f.root, f.transport);
  assert.deepEqual(f.calls, ['alias-a', 'alias-a', 'alias-a', 'alias-b']);
  assert.equal(JSON.stringify(f.probe), before);
  rejects(() => runAdoption({ command: 'status', nodeId: 'a', ssh: 'alias-b' }, f.root, f.transport), 'SSH_TARGET_CHANGED');
});
test('single-client export preserves identity, public key relationship, flow, port and REALITY fields', () => {
  const f = fixture();
  runAdoption({ command: 'setup', nodeId: 'a' }, f.root, f.transport);
  const result = runAdoption({ command: 'export', nodeId: 'a' }, f.root, f.transport);
  const link = new URL(readFileSync(result.outputFile as string, 'utf8').trim());
  assert.equal(link.username, uuid);
  assert.equal(link.port, '8443');
  assert.equal(link.searchParams.get('pbk'), keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'));
  assert.equal(link.searchParams.get('sni'), 'www.example.org');
  assert.equal(link.searchParams.get('sid'), 'abcdef12');
  assert.equal(link.searchParams.get('flow'), 'xtls-rprx-vision');
  assert.equal(link.searchParams.get('type'), 'tcp');
  for (const secret of [uuid, privateKey, 'abcdef12', 'vless://']) assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(runAdoption({ command: 'export', nodeId: 'a' }, f.root, f.transport).status, 'unchanged');
});
test('multiple clients require explicit selection; empty short ID and absent flow remain valid', () => {
  const f = fixture();
  f.probe.config.inbounds[0].settings.clients.push({ id: '22222222-2222-4222-8222-222222222222' });
  f.probe.config.inbounds[0].streamSettings.realitySettings.shortIds = [''];
  runAdoption({ command: 'setup', nodeId: 'a' }, f.root, f.transport);
  rejects(() => runAdoption({ command: 'export', nodeId: 'a' }, f.root, f.transport), 'CLIENT_SELECTION_REQUIRED');
  const output = join(f.root, 'custom.txt');
  const result = runAdoption({ command: 'export', nodeId: 'a', client: 'inbound-1-client-2', out: output }, f.root, f.transport);
  const link = new URL(readFileSync(result.outputFile as string, 'utf8').trim());
  assert.equal(link.searchParams.get('sid'), '');
  assert.equal(link.searchParams.has('flow'), false);
});
test('unknown layout, absent unit, stopped service, authentication and baseline failures', () => {
  const f = fixture();
  f.probe.layout = 'unsupported';
  assert.equal(runAdoption({ command: 'setup', nodeId: 'a' }, f.root, f.transport).status, 'unsupported');
  assert.equal(existsSync(join(f.root, 'local')), false);
  f.probe.loadState = 'not-found';
  assert.equal(runAdoption({ command: 'setup', nodeId: 'a' }, f.root, f.transport).status, 'not-installed');
  f.probe.loadState = 'loaded'; f.probe.layout = 'single-file'; f.probe.service = 'inactive';
  assert.equal(runAdoption({ command: 'status', nodeId: 'a' }, f.root, f.transport).status, 'installed-stopped');
  runAdoption({ command: 'setup', nodeId: 'a' }, f.root, f.transport);
  rejects(() => runAdoption({ command: 'export', nodeId: 'a' }, f.root, f.transport), 'RUNNING_CONFIG_UNVERIFIED');
  f.probe.config.inbounds[0].port = 9443;
  rejects(() => runAdoption({ command: 'export', nodeId: 'a' }, f.root, f.transport), 'REMOTE_BASELINE_CHANGED');
  f.transport.probe = () => { throw new AdoptionError('SSH_AUTH_FAILED', 4); };
  rejects(() => runAdoption({ command: 'status', nodeId: 'a' }, f.root, f.transport), 'SSH_AUTH_FAILED');
});
test('key validation and CLI errors never expose raw data; standalone help needs no server', () => {
  rejects(() => realityPublicKey('bad'), 'REALITY_PRIVATE_KEY_INVALID');
  const help = spawnSync(process.execPath, ['apps/cli/src/vpncp.ts', '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  const failure = spawnSync(process.execPath, ['apps/cli/src/vpncp.ts', 'export', 'a', '--to', 'bad', '--json'], { encoding: 'utf8' });
  assert.equal(failure.status, 2);
  assert.equal(JSON.parse(failure.stdout).code, 'EXPORT_FORMAT_UNSUPPORTED');
});
test('Windows workspace ACL preserves owner, verifies DACL and rejects then repairs unauthorized access', () => {
  if (process.platform !== 'win32') return;
  const parent = join(process.cwd(), 'local/private/acl-regression-tests');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'node-'));
  const path = join(directory, "[private] space & ' quote");
  const helper = join(process.cwd(), 'packages/core/src/protect-private-path.ps1');
  const invoke = (verify = false) => spawnSync('powershell', ['-NoProfile', '-NonInteractive',
    '-ExecutionPolicy', 'Bypass', '-File', helper, '-LiteralPath', path, ...(verify ? ['-VerifyOnly'] : [])],
    { encoding: 'utf8', windowsHide: true });
  // This uses the actual workspace volume and Node child process, where the old
  // fresh descriptor with SetOwner failed despite successful temp-volume tests.
  privateDirectory(path);
  const verified = invoke(true);
  assert.equal(verified.status, 0);
  assert.equal(JSON.parse(verified.stdout).stage, 'acl-verified');
  const grant = spawnSync(join(process.env.SystemRoot!, 'System32/icacls.exe'), [path, '/grant', '*S-1-1-0:R'], { encoding: 'utf8' });
  assert.equal(grant.status, 0);
  const refused = invoke(true);
  assert.equal(refused.status, 1);
  assert.equal(JSON.parse(refused.stdout).stage, 'acl-verify');
  privateDirectory(path);
  assert.equal(invoke(true).status, 0);
});

test('endpoint update explicitly authorizes address only, pins original SSH identity and updates export', () => {
  const f = fixture();
  runAdoption({ command: 'setup', nodeId: 'a' }, f.root, f.transport);
  const path = join(f.root, 'local/private/cli-nodes/a/state.local.json');
  const original = JSON.parse(readFileSync(path, 'utf8'));
  const oldExport = runAdoption({ command: 'export', nodeId: 'a' }, f.root, f.transport);
  const oldBytes = readFileSync(oldExport.outputFile as string, 'utf8');
  f.transport.resolve = alias => ({ alias, host: '192.0.2.99', user: 'root', port: 25281 });
  rejects(() => runAdoption({ command: 'export', nodeId: 'a' }, f.root, f.transport), 'SSH_TARGET_CHANGED');
  rejects(() => runAdoption({ command: 'endpoint', nodeId: 'a', expectedHost: 'wrong' }, f.root, f.transport), 'ENDPOINT_CONFIRMATION_REQUIRED');
  const priorProbe = f.transport.probe;
  f.transport.probe = target => {
    assert.equal(target.hostKeyAlias, original.target.host);
    const args = sshTargetArgs(target);
    assert(args.includes('StrictHostKeyChecking=yes'));
    assert(args.includes('HostKeyAlias=' + original.target.host));
    assert(args.includes('UpdateHostKeys=no'));
    return priorProbe(target);
  };
  runAdoption({ command: 'endpoint', nodeId: 'a', expectedHost: '192.0.2.99' }, f.root, f.transport);
  const updated = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(updated.hash, original.hash);
  assert.deepEqual(updated.probe, original.probe);
  const result = runAdoption({ command: 'export', nodeId: 'a', out: join(f.root, 'new.txt') }, f.root, f.transport);
  const link = new URL(readFileSync(result.outputFile as string, 'utf8').trim());
  assert.equal(link.hostname, '192.0.2.99'); assert.equal(link.port, '8443');
  assert.equal(link.username, uuid);
  assert.equal(readFileSync(oldExport.outputFile as string, 'utf8'), oldBytes);
  assert.equal(parseArguments(['endpoint', 'a', '--host', '192.0.2.99']).expectedHost, '192.0.2.99');
});
test('endpoint failures preserve exact prior state: key failure, identity changes, config drift, busy and concurrent update', () => {
  for (const scenario of ['key', 'user', 'port', 'alias', 'config', 'busy', 'concurrent', 'reresolve']) {
    const f = fixture(); runAdoption({ command: 'setup', nodeId: 'a' }, f.root, f.transport);
    const path = join(f.root, 'local/private/cli-nodes/a/state.local.json');
    const original = readFileSync(path, 'utf8');
    let calls = 0;
    f.transport.resolve = alias => ({ alias: scenario === 'alias' ? 'different' : alias,
      host: scenario === 'reresolve' && calls++ > 0 ? '192.0.2.100' : '192.0.2.99',
      user: scenario === 'user' ? 'other' : 'root', port: scenario === 'port' ? 22 : 25281 });
    if (scenario === 'key') f.transport.probe = () => { throw new AdoptionError('SSH_UNAVAILABLE', 4); };
    if (scenario === 'config') f.probe.config.inbounds[0].port = 9443;
    if (scenario === 'busy') writeFileSync(join(f.root, 'local/private/cli-nodes/a/operation.lock'), '');
    if (scenario === 'concurrent') f.transport.probe = () => { writeFileSync(path, original + ' '); return structuredClone(f.probe); };
    const codes: Record<string, string> = {key:'SSH_UNAVAILABLE',user:'SSH_TARGET_CHANGED',port:'SSH_TARGET_CHANGED',
      alias:'SSH_TARGET_CHANGED',config:'REMOTE_BASELINE_CHANGED',busy:'NODE_BUSY',concurrent:'LOCAL_STATE_CHANGED',reresolve:'SSH_TARGET_CHANGED'};
    rejects(() => runAdoption({ command: 'endpoint', nodeId: 'a', expectedHost: '192.0.2.99' }, f.root, f.transport), codes[scenario]);
    assert.equal(readFileSync(path, 'utf8'), original + (scenario === 'concurrent' ? ' ' : ''));
  }
});

test('endpoint atomic commit failure preserves original bytes and removes temporary file', () => {
  const f = fixture(); runAdoption({ command: 'setup', nodeId: 'a' }, f.root, f.transport);
  const path = join(f.root, 'local/private/cli-nodes/a/state.local.json');
  const original = readFileSync(path, 'utf8');
  f.transport.resolve = alias => ({ alias, host: '192.0.2.99', user: 'root', port: 25281 });
  const rename = fs.renameSync;
  fs.renameSync = () => { throw new Error('simulated commit failure'); };
  syncBuiltinESMExports();
  try {
    rejects(() => runAdoption({ command: 'endpoint', nodeId: 'a', expectedHost: '192.0.2.99' }, f.root, f.transport), 'PRIVATE_STORAGE_UNAVAILABLE');
  } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  assert.equal(readFileSync(path, 'utf8'), original);
  assert.equal(fs.readdirSync(join(f.root, 'local/private/cli-nodes/a')).some(name => name.endsWith('.tmp')), false);
});

test('export locks the probe and rejects endpoint interference without creating stale output', () => {
  const f = fixture(); runAdoption({ command: 'setup', nodeId: 'a' }, f.root, f.transport);
  const state = join(f.root, 'local/private/cli-nodes/a/state.local.json');
  const original = readFileSync(state, 'utf8');
  let host = 'a.example.org'; let nested = false;
  f.transport.resolve = alias => ({alias,host,user:'root',port:25281});
  f.transport.probe = () => {
    if (!nested) {
      nested = true; host = '192.0.2.99';
      rejects(() => runAdoption({command:'endpoint',nodeId:'a',expectedHost:host},f.root,f.transport),'NODE_BUSY');
    }
    return structuredClone(f.probe);
  };
  const output = join(f.root, 'concurrent.txt');
  rejects(() => runAdoption({command:'export',nodeId:'a',out:output},f.root,f.transport),'SSH_TARGET_CHANGED');
  assert.equal(existsSync(output), false);
  assert.equal(readFileSync(state,'utf8'), original);
  assert.equal(existsSync(join(f.root,'local/private/cli-nodes/a/operation.lock')),false);
  runAdoption({command:'endpoint',nodeId:'a',expectedHost:host},f.root,f.transport);
  const result=runAdoption({command:'export',nodeId:'a',out:output},f.root,f.transport);
  assert.equal(new URL(readFileSync(result.outputFile as string,'utf8').trim()).hostname,host);
});
test('endpoint and export report committed cleanup failures and retain the lock for explicit recovery', () => {
  for (const command of ['endpoint','export'] as const) {
    const f=fixture();runAdoption({command:'setup',nodeId:'a'},f.root,f.transport);
    const directory=join(f.root,'local/private/cli-nodes/a');
    const previous=JSON.parse(readFileSync(join(directory,'state.local.json'),'utf8'));
    if(command==='endpoint')f.transport.resolve=alias=>({alias,host:'192.0.2.99',user:'root',port:25281});
    const unlink=fs.unlinkSync;
    fs.unlinkSync=path=>{if(String(path).endsWith('released.lock'))throw Error('fixture cleanup failure');return unlink(path);};
    syncBuiltinESMExports();
    let result;
    try {result=runAdoption({command,nodeId:'a',expectedHost:'192.0.2.99'},f.root,f.transport);}
    finally {fs.unlinkSync=unlink;syncBuiltinESMExports();}
    assert.equal(result.status,'completed-cleanup-failed');
    assert.equal(result.code,'NODE_LOCK_CLEANUP_FAILED');
    assert.equal(result.lockCleanupStage,'remove-isolated');
    assert.equal(result.changed,true);assert.equal(result.committed,true);assert.equal(result.recoveryRequired,true);
    assert.equal(existsSync(join(directory,'operation.guard/released.lock')),true);
    assert.equal(existsSync(join(directory,'operation.guard')),true);
    const state=JSON.parse(readFileSync(join(directory,'state.local.json'),'utf8'));
    if(command==='endpoint'){assert.equal(state.target.host,'192.0.2.99');assert.deepEqual(state.probe,previous.probe);}
    else assert.equal(existsSync(result.outputFile as string),true);
  }
});
test('node lock cleanup never deletes another owner lock', () => {
  const f=fixture();runAdoption({command:'setup',nodeId:'a'},f.root,f.transport);
  const lock=join(f.root,'local/private/cli-nodes/a/operation.lock');
  f.transport.probe=()=>{writeFileSync(lock,'replacement-owner');return structuredClone(f.probe);};
  const result=runAdoption({command:'export',nodeId:'a'},f.root,f.transport);
  assert.equal(result.code,'NODE_LOCK_CLEANUP_FAILED');assert.equal(result.changed,true);
  assert.equal(readFileSync(join(f.root,'local/private/cli-nodes/a/operation.guard/released.lock'),'utf8'),'replacement-owner');
  assert.equal(existsSync(join(f.root,'local/private/cli-nodes/a/operation.guard')),true);
});

test('release isolates the checked lock and preserves canonical replacement after ownership check', () => {
  const f=fixture();runAdoption({command:'setup',nodeId:'a'},f.root,f.transport);
  f.transport.resolve=alias=>({alias,host:'192.0.2.99',user:'root',port:25281});
  const dir=join(f.root,'local/private/cli-nodes/a');const lock=join(dir,'operation.lock');
  const read=fs.readFileSync;let injected=false;
  fs.readFileSync=((path: any,...args: any[])=>{
    const value=(read as any)(path,...args);
    if(String(path)===join(dir,'operation.guard/released.lock')&&!injected){
      injected=true;writeFileSync(lock,'new-owner');
    }
    return value;
  }) as typeof fs.readFileSync;syncBuiltinESMExports();
  let result;
  try{result=runAdoption({command:'endpoint',nodeId:'a',expectedHost:'192.0.2.99'},f.root,f.transport);}
  finally{fs.readFileSync=read;syncBuiltinESMExports();}
  assert.equal(injected,true);assert.equal(result.changed,true);assert.equal(result.committed,true);
  assert.equal(result.code,'NODE_LOCK_CLEANUP_FAILED');assert.equal(result.lockCleanupStage,'verify-canonical');assert.equal(readFileSync(lock,'utf8'),'new-owner');
  assert.equal(existsSync(join(dir,'operation.guard')),true);
  rejects(()=>runAdoption({command:'export',nodeId:'a'},f.root,f.transport),'NODE_BUSY');
});
test('replacement before isolation is retained, protocol participants cannot enter during release', () => {
  const f=fixture();runAdoption({command:'setup',nodeId:'a'},f.root,f.transport);
  f.transport.resolve=alias=>({alias,host:'192.0.2.99',user:'root',port:25281});
  const dir=join(f.root,'local/private/cli-nodes/a');const lock=join(dir,'operation.lock');
  const rename=fs.renameSync;let injected=false;
  fs.renameSync=(from,to)=>{
    if(String(from)===lock&&!injected){
      injected=true;
      rejects(()=>runAdoption({command:'export',nodeId:'a'},f.root,f.transport),'NODE_BUSY');
      fs.unlinkSync(lock);writeFileSync(lock,'external-owner');
    }
    return rename(from,to);
  };syncBuiltinESMExports();let result;
  try{result=runAdoption({command:'endpoint',nodeId:'a',expectedHost:'192.0.2.99'},f.root,f.transport);}
  finally{fs.renameSync=rename;syncBuiltinESMExports();}
  assert.equal(injected,true);assert.equal(result.code,'NODE_LOCK_CLEANUP_FAILED');
  assert.equal(result.lockCleanupStage,'verify-owner');
  assert.equal(readFileSync(join(dir,'operation.guard/released.lock'),'utf8'),'external-owner');
  const original=readFileSync(join(dir,'state.local.json'),'utf8');
  rejects(()=>runAdoption({command:'endpoint',nodeId:'a',expectedHost:'192.0.2.99'},f.root,f.transport),'NODE_BUSY');
  assert.equal(readFileSync(join(dir,'state.local.json'),'utf8'),original);
  // Synthetic quiescent manual recovery only: preserve the foreign marker first.
  writeFileSync(join(f.root,'retained-lock-evidence.txt'),readFileSync(join(dir,'operation.guard/released.lock')));
  fs.unlinkSync(join(dir,'operation.guard/released.lock'));fs.rmdirSync(join(dir,'operation.guard'));
  assert.equal(runAdoption({command:'endpoint',nodeId:'a',expectedHost:'192.0.2.99'},f.root,f.transport).status,'endpoint-updated');
  assert.equal(readFileSync(join(dir,'state.local.json'),'utf8'),original);
});
test('mihomo provider and profile reuse the private export path and do not echo secrets', () => {
  const f = fixture();
  runAdoption({ command: 'setup', nodeId: 'a' }, f.root, f.transport);
  const probed = f.calls.length;
  rejects(() => runAdoption({ command: 'export', nodeId: 'a', to: 'clash' }, f.root, f.transport), 'EXPORT_FORMAT_UNSUPPORTED');
  assert.equal(f.calls.length, probed);
  const uri = runAdoption({ command: 'export', nodeId: 'a', to: 'v2rayn' }, f.root, f.transport);
  const provider = runAdoption({ command: 'export', nodeId: 'a', to: 'mihomo-provider' }, f.root, f.transport);
  const profile = runAdoption({ command: 'export', nodeId: 'a', to: 'mihomo-profile' }, f.root, f.transport);
  assert.match(String(uri.outputFile), /\.vless\.txt$/);
  assert.match(String(provider.outputFile), /\.mihomo-provider\.yaml$/);
  assert.match(String(profile.outputFile), /\.mihomo-profile\.yaml$/);
  assert.notEqual(uri.outputFile, provider.outputFile);
  assert.notEqual(provider.outputFile, profile.outputFile);
  const providerText = readFileSync(provider.outputFile as string, 'utf8');
  const profileText = readFileSync(profile.outputFile as string, 'utf8');
  assert.match(providerText, /^# .+\nproxies:\n/);
  assert.match(providerText, /support-x25519mlkem768: true/);
  assert.equal(providerText.includes('proxy-groups:'), false);
  assert.equal(providerText.includes('vless://'), false);
  assert.match(profileText, /type: "select"/);
  assert.match(profileText, /MATCH,rq-a-inbound-1-client-1-select/);
  assert.equal(/(^|\n)tun\s*:/.test(profileText), false);
  assert.equal(/(^|\n)dns\s*:/.test(profileText), false);
  assert.equal(profileText.includes('packet-encoding:'), false);
  assert.equal(/(^|\n)\s*udp\s*:/.test(profileText), false);
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  for (const result of [uri, provider, profile]) {
    const json = JSON.stringify(result);
    const human = renderHumanResult(result);
    for (const secret of [uuid, privateKey, publicKey, 'abcdef12', 'vless://', 'reality-opts', 'proxies:']) {
      assert.equal(json.includes(secret), false, secret);
      assert.equal(human.includes(secret), false, secret);
    }
    assert.equal(human.includes(String(result.outputFile)), true);
  }
  if (process.platform !== 'win32') {
    const directory = join(f.root, 'local/private/cli-nodes/a');
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(provider.outputFile as string).mode & 0o777, 0o600);
    assert.equal(statSync(profile.outputFile as string).mode & 0o777, 0o600);
    assert.equal(statSync(uri.outputFile as string).mode & 0o777, 0o600);
  }
  const original = providerText;
  writeFileSync(provider.outputFile as string, `${original}# changed\n`);
  rejects(() => runAdoption({ command: 'export', nodeId: 'a', to: 'mihomo-provider' }, f.root, f.transport), 'OUTPUT_EXISTS');
  assert.equal(readFileSync(provider.outputFile as string, 'utf8'), `${original}# changed\n`);
  writeFileSync(provider.outputFile as string, original);
  assert.equal(runAdoption({ command: 'export', nodeId: 'a', to: 'mihomo-provider' }, f.root, f.transport).status, 'unchanged');
  assert.equal(readFileSync(provider.outputFile as string, 'utf8'), original);
});
test('mihomo YAML keeps tcp, empty shortId and omits flow; other decryption is not relabeled', () => {
  const f = fixture();
  f.probe.config.inbounds[0].settings.clients.push({ id: '22222222-2222-4222-8222-222222222222' });
  f.probe.config.inbounds[0].streamSettings.realitySettings.shortIds = [''];
  f.probe.config.inbounds[0].settings.decryption = 'none';
  runAdoption({ command: 'setup', nodeId: 'a' }, f.root, f.transport);
  const result = runAdoption({ command: 'export', nodeId: 'a', client: 'inbound-1-client-2', to: 'mihomo-profile' }, f.root, f.transport);
  const yaml = readFileSync(result.outputFile as string, 'utf8');
  assert.match(yaml, /network: "tcp"/);
  assert.match(yaml, /short-id: ""/);
  assert.match(yaml, /encryption: "none"/);
  assert.match(yaml, /name: "rq-a-inbound-1-client-2"/);
  assert.match(yaml, /name: "rq-a-inbound-1-client-2-select"/);
  assert.equal(yaml.includes('flow:'), false);
  const blocked = fixture();
  blocked.probe.config.inbounds[0].settings.decryption = 'mlkem768x25519plus.example';
  runAdoption({ command: 'setup', nodeId: 'a' }, blocked.root, blocked.transport);
  const output = join(blocked.root, 'blocked.yaml');
  rejects(() => runAdoption({ command: 'export', nodeId: 'a', to: 'mihomo-provider', out: output }, blocked.root, blocked.transport), 'DECRYPTION_UNSUPPORTED');
  rejects(() => runAdoption({ command: 'export', nodeId: 'a', to: 'v2rayn', out: join(blocked.root, 'blocked.txt') }, blocked.root, blocked.transport), 'DECRYPTION_UNSUPPORTED');
  rejects(() => runAdoption({ command: 'export', nodeId: 'a', to: 'sing-box', out: join(blocked.root, 'blocked.json') }, blocked.root, blocked.transport), 'DECRYPTION_UNSUPPORTED');
  assert.equal(existsSync(output), false);
  assert.equal(existsSync(join(blocked.root, 'blocked.txt')), false);
  assert.equal(existsSync(join(blocked.root, 'blocked.json')), false);
});
test('vless-qr writes a protected PNG without echoing the URI in terminal output', () => {
  const f = fixture();
  runAdoption({ command: 'setup', nodeId: 'a' }, f.root, f.transport);
  const qr = runAdoption({ command: 'export', nodeId: 'a', to: 'vless-qr' }, f.root, f.transport);
  assert.match(String(qr.outputFile), /\.vless\.png$/);
  assert.equal(qr.format, 'vless-qr-png');
  const bytes = readFileSync(qr.outputFile as string);
  assert.equal(bytes.subarray(0, 8).toString('binary'), '\x89PNG\r\n\x1a\n');
  const json = JSON.stringify(qr);
  const human = renderHumanResult(qr);
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  for (const secret of [uuid, privateKey, publicKey, 'abcdef12', 'vless://']) {
    assert.equal(json.includes(secret), false, secret);
    assert.equal(human.includes(secret), false, secret);
  }
  assert.equal(human.includes(String(qr.outputFile)), true);
  if (process.platform !== 'win32') {
    assert.equal(statSync(qr.outputFile as string).mode & 0o777, 0o600);
  }
  writeFileSync(qr.outputFile as string, Buffer.concat([bytes, Buffer.from([0])]));
  rejects(() => runAdoption({ command: 'export', nodeId: 'a', to: 'vless-qr' }, f.root, f.transport), 'OUTPUT_EXISTS');
});
test('sing-box profile writes a protected JSON file and does not echo secrets', () => {
  const f = fixture();
  runAdoption({ command: 'setup', nodeId: 'a' }, f.root, f.transport);
  const result = runAdoption({ command: 'export', nodeId: 'a', to: 'sing-box' }, f.root, f.transport);
  assert.match(String(result.outputFile), /\.sing-box\.json$/);
  assert.equal(result.format, 'sing-box');
  const text = readFileSync(result.outputFile as string, 'utf8');
  const profile = JSON.parse(text);
  assert.equal(profile.outbounds[0].type, 'vless');
  assert.equal(profile.outbounds[0].network, 'tcp');
  assert.equal(profile.outbounds[0].packet_encoding, '');
  assert.equal(profile.outbounds[0].tls.utls.fingerprint, 'chrome');
  assert.equal(profile.outbounds[0].tls.reality.enabled, true);
  assert.equal(profile.outbounds[1].type, 'selector');
  assert.equal(profile.route.final, profile.outbounds[1].tag);
  assert.equal(profile.outbounds[0].tag, 'rq-a-inbound-1-client-1');
  assert.equal(profile.outbounds[1].tag, 'rq-a-inbound-1-client-1-select');
  assert.equal(text.includes('vless://'), false);
  assert.equal(text.includes('support-x25519mlkem768'), false);
  assert.equal(text.includes('curve_preferences'), false);
  assert.equal(text.includes('"inbounds"'), false);
  assert.equal(Object.hasOwn(profile, 'dns'), false);
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const json = JSON.stringify(result);
  const human = renderHumanResult(result);
  for (const secret of [uuid, privateKey, publicKey, 'abcdef12', 'vless://', 'public_key', 'outbounds']) {
    assert.equal(json.includes(secret), false, secret);
    assert.equal(human.includes(secret), false, secret);
  }
  assert.equal(human.includes(String(result.outputFile)), true);
  if (process.platform !== 'win32') {
    assert.equal(statSync(result.outputFile as string).mode & 0o777, 0o600);
    assert.equal(statSync(join(f.root, 'local/private/cli-nodes/a')).mode & 0o777, 0o700);
  }
  const original = text;
  writeFileSync(result.outputFile as string, `${original}\n`);
  rejects(() => runAdoption({ command: 'export', nodeId: 'a', to: 'sing-box' }, f.root, f.transport), 'OUTPUT_EXISTS');
  assert.equal(readFileSync(result.outputFile as string, 'utf8'), `${original}\n`);
  writeFileSync(result.outputFile as string, original);
  assert.equal(runAdoption({ command: 'export', nodeId: 'a', to: 'sing-box' }, f.root, f.transport).status, 'unchanged');
  assert.equal(readFileSync(result.outputFile as string, 'utf8'), original);
});
test('sing-box JSON keeps tcp, empty shortId and omits flow', () => {
  const f = fixture();
  f.probe.config.inbounds[0].settings.clients.push({ id: '22222222-2222-4222-8222-222222222222' });
  f.probe.config.inbounds[0].streamSettings.realitySettings.shortIds = [''];
  f.probe.config.inbounds[0].settings.decryption = 'none';
  runAdoption({ command: 'setup', nodeId: 'a' }, f.root, f.transport);
  const result = runAdoption({ command: 'export', nodeId: 'a', client: 'inbound-1-client-2', to: 'sing-box' }, f.root, f.transport);
  const profile = JSON.parse(readFileSync(result.outputFile as string, 'utf8'));
  assert.equal(profile.outbounds[0].network, 'tcp');
  assert.equal(profile.outbounds[0].tls.reality.short_id, '');
  assert.equal(Object.hasOwn(profile.outbounds[0], 'flow'), false);
  assert.equal(profile.outbounds[0].tag, 'rq-a-inbound-1-client-2');
  assert.equal(profile.outbounds[1].tag, 'rq-a-inbound-1-client-2-select');
  assert.equal(profile.route.final, 'rq-a-inbound-1-client-2-select');
});
test('IPv6 export host is bracketed in the URI and quoted in YAML', () => {
  const f = fixture();
  f.transport.resolve = alias => ({ alias, host: '2001:db8::10', user: 'root', port: 25281 });
  runAdoption({ command: 'setup', nodeId: 'a' }, f.root, f.transport);
  const uri = runAdoption({ command: 'export', nodeId: 'a', to: 'v2rayn' }, f.root, f.transport);
  const yaml = runAdoption({ command: 'export', nodeId: 'a', to: 'mihomo-provider' }, f.root, f.transport);
  const singBox = runAdoption({ command: 'export', nodeId: 'a', to: 'sing-box' }, f.root, f.transport);
  assert.match(readFileSync(uri.outputFile as string, 'utf8'), /@\[2001:db8::10\]:8443\?/);
  assert.match(readFileSync(yaml.outputFile as string, 'utf8'), /server: "2001:db8::10"/);
  assert.equal(JSON.parse(readFileSync(singBox.outputFile as string, 'utf8')).outbounds[0].server, '2001:db8::10');
  assert.equal(JSON.stringify(yaml).includes('2001:db8::10'), false);
  assert.equal(JSON.stringify(singBox).includes('2001:db8::10'), false);
});
test('pull writes every local artifact into the temp data dir and overwrites different canonical bytes', () => {
  const f = fixture();
  runAdoption({ command: 'setup', nodeId: 'a' }, f.root, f.transport);
  const result = runAdoption({ command: 'pull', nodeId: 'a' }, f.root, f.transport);
  const directory = join(f.root, 'local/private/cli-nodes/a');
  assert.equal(result.status, 'exported');
  assert.equal(result.outputDirectory, directory);
  assert.equal(String(result.outputDirectory).startsWith(f.root), true);
  const files = result.outputFiles as { format: string; path: string; status: string }[];
  assert.deepEqual(files.map(file => file.format), ['vless-uri', 'vless-qr-png', 'mihomo-provider', 'mihomo-profile', 'sing-box']);
  assert.deepEqual(files.map(file => file.status), ['exported', 'exported', 'exported', 'exported', 'exported']);
  assert.deepEqual(files.map(file => file.path.slice(directory.length + 1)), [
    'inbound-1-client-1.vless.txt', 'inbound-1-client-1.vless.png', 'inbound-1-client-1.mihomo-provider.yaml',
    'inbound-1-client-1.mihomo-profile.yaml', 'inbound-1-client-1.sing-box.json'
  ]);
  assert.equal(readFileSync(files[1].path).subarray(0, 8).toString('binary'), '\x89PNG\r\n\x1a\n');
  const provider = readFileSync(files[2].path, 'utf8');
  assert.match(provider, /support-x25519mlkem768: true/);
  assert.equal(provider.includes('vless://'), false);
  const singBox = JSON.parse(readFileSync(files[4].path, 'utf8'));
  assert.equal(singBox.outbounds[0].type, 'vless');
  assert.equal(singBox.outbounds[0].packet_encoding, '');
  assert.equal(readFileSync(files[4].path, 'utf8').includes('vless://'), false);
  const human = renderHumanResult(result);
  const json = JSON.stringify(result);
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  for (const secret of [uuid, privateKey, publicKey, 'abcdef12', 'vless://']) {
    assert.equal(json.includes(secret), false, secret);
    assert.equal(human.includes(secret), false, secret);
  }
  assert.equal(human.includes(`私有目录 ${directory}`), true);
  for (const file of files) assert.equal(human.includes(file.path), true);
  if (process.platform !== 'win32') {
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    for (const file of files) assert.equal(statSync(file.path).mode & 0o777, 0o600);
    fs.chmodSync(files[0].path, 0o644);
  }
  const again = runAdoption({ command: 'pull', nodeId: 'a' }, f.root, f.transport);
  assert.equal(again.status, 'unchanged');
  assert.equal(again.changed, false);
  if (process.platform !== 'win32') assert.equal(statSync(files[0].path).mode & 0o777, 0o600);
  const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const originalUri = digest(files[0].path);
  const originalProvider = digest(files[2].path);
  writeFileSync(files[0].path, 'sentinel-not-a-secret\n');
  writeFileSync(files[2].path, 'sentinel-not-a-secret\n');
  const replaced = runAdoption({ command: 'pull', nodeId: 'a' }, f.root, f.transport);
  assert.equal(replaced.changed, true);
  assert.equal(readFileSync(files[0].path, 'utf8').includes('sentinel-not-a-secret'), false);
  assert.equal(readFileSync(files[2].path, 'utf8').includes('sentinel-not-a-secret'), false);
  assert.equal(digest(files[0].path), originalUri);
  assert.equal(digest(files[2].path), originalProvider);
  if (process.platform !== 'win32') assert.equal(statSync(files[0].path).mode & 0o777, 0o600);
  writeFileSync(files[0].path, 'sentinel-not-a-secret\n');
  rejects(() => runAdoption({ command: 'export', nodeId: 'a', to: 'v2rayn' }, f.root, f.transport), 'OUTPUT_EXISTS');
  assert.equal(readFileSync(files[0].path, 'utf8'), 'sentinel-not-a-secret\n');
  writeFileSync(files[2].path, 'sentinel-not-a-secret\n');
  fs.unlinkSync(files[0].path);
  fs.symlinkSync(files[3].path, files[0].path);
  rejects(() => runAdoption({ command: 'pull', nodeId: 'a' }, f.root, f.transport), 'PRIVATE_PATH_UNSAFE');
  assert.equal(fs.lstatSync(files[0].path).isSymbolicLink(), true);
  assert.equal(readFileSync(files[2].path, 'utf8'), 'sentinel-not-a-secret\n');
  const missing = join(f.root, 'missing-out');
  rejects(() => runAdoption({ command: 'pull', nodeId: 'a', out: missing }, f.root, f.transport), 'OUTPUT_DIRECTORY_MISSING');
  assert.equal(existsSync(missing), false);
  fs.unlinkSync(files[0].path);
  const custom = join(f.root, 'custom-out');
  mkdirSync(custom);
  const customResult = runAdoption({ command: 'pull', nodeId: 'a', out: custom }, f.root, f.transport);
  const customFiles = customResult.outputFiles as { path: string }[];
  assert.equal(customResult.outputDirectory, custom);
  assert.equal(customFiles.every(file => file.path.startsWith(custom + sep)), true);
  assert.equal(existsSync(join(directory, 'inbound-1-client-1.vless.txt')), false);
  if (process.platform !== 'win32') {
    assert.equal(statSync(custom).mode & 0o777, 0o700);
    for (const file of customFiles) assert.equal(statSync(file.path).mode & 0o777, 0o600);
  }
  const humanCustom = renderHumanResult(customResult);
  assert.equal(humanCustom.includes('vless://'), false);
  assert.equal(humanCustom.includes(uuid), false);
  const multi = fixture();
  multi.probe.config.inbounds[0].settings.clients.push({ id: '22222222-2222-4222-8222-222222222222' });
  runAdoption({ command: 'setup', nodeId: 'a' }, multi.root, multi.transport);
  rejects(() => runAdoption({ command: 'pull', nodeId: 'a' }, multi.root, multi.transport), 'CLIENT_SELECTION_REQUIRED');
  const chosen = runAdoption({ command: 'pull', nodeId: 'a', client: 'inbound-1-client-2' }, multi.root, multi.transport);
  assert.match(String(chosen.outputFile), /inbound-1-client-2\.vless\.txt$/);
  assert.equal(JSON.stringify(chosen).includes('22222222-2222-4222-8222-222222222222'), false);
  assert.equal(renderHumanResult(chosen).includes('22222222-2222-4222-8222-222222222222'), false);
});
