import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateInstallScript, installPlan, runSetup, xrayRelease, type InstallInspection, type InstallTransport } from '../../../packages/core/src/xray-install.ts';
import { AdoptionError, runAdoption, type Probe } from '../../../packages/core/src/xray-adoption.ts';
import { parseArguments, renderHumanResult } from '../src/vpncp.ts';

function fixture(os = 'debian', release = '13') {
  const root = mkdtempSync(join(tmpdir(), 'vpncp-install-'));
  const inspection: InstallInspection = { os, release, arch: 'x86_64', systemd: true,
    serviceManager: 'systemd', packageManager: 'apt',
    filesystem: { standardDirectories: true, safePaths: true, writable: true,
      posixPermissions: true, serviceAccountFiles: true, nologin: true },
    root: true, sudo: true, missingCommands: [], freeMiB: 1024, existing: [], units: [], processes: [],
    loadState: 'not-found', inspectionComplete: true, listeners: [], firewall: 'unknown',
    baseline: 'a'.repeat(64), sshEndpoint: ['192.0.2.10', '25281'] };
  let probe: Probe = { loadState: 'not-found', service: 'inactive', user: 'root', group: null,
    linux: { os, release, arch: 'x86_64', serviceManager: 'systemd', packageManager: 'apt' },
    version: null, configPath: null, permissions: null, config: null, listeners: [], diskMatchesRunning: false, install: inspection };
  let receipt = 'absent';
  let executions = 0;
  let outcome = 'installed';
  let lastScript = '';
  const transport: InstallTransport = {
    resolve: alias => ({ alias, host: '192.0.2.10', user: 'root', port: 25281 }),
    probe: () => structuredClone(probe),
    receipt: () => receipt,
    execute: (_target, script) => {
      executions++;
      lastScript = script;
      receipt = outcome === 'rollback-failed' ? 'pending' : outcome;
      if (outcome !== 'installed') return { status: outcome === 'rollback-failed' ? 70 : 1, stdout: 'VPNCP_FAILED:config-validation:restored' };
      const config = JSON.parse(Buffer.from(script.match(/b64decode\('([A-Za-z0-9+/=]+)'\)/)![1], 'base64').toString());
      probe = { loadState: 'loaded', service: 'active', user: 'vcp-test', group: 'vcp-test',
        linux: { os, release, arch: inspection.arch, serviceManager: inspection.serviceManager, packageManager: inspection.packageManager },
        version: 'Xray 26.11.9', configPath: '/usr/local/etc/xray/config.json',
        permissions: { uid: 0, gid: 987, mode: '0o640' }, layout: 'single-file', config,
        listeners: [`0.0.0.0:${config.inbounds[0].port}`], diskMatchesRunning: true };
      return { status: 0, stdout: 'VPNCP_INSTALLED' };
    }
  };
  return { root, transport, inspection, get probe() { return probe; }, get executions() { return executions; },
    get script() { return lastScript; }, outcome: (value: string) => { outcome = value; } };
}
async function rejected(action: () => unknown | Promise<unknown>, code: string) {
  let actual = '';
  try { await action(); } catch (error) { actual = error instanceof AdoptionError ? error.code : String(error); }
  assert.equal(actual, code);
}
test('clean Debian plan is strictly read-only and uses pinned release and simple defaults', async () => {
  const f = fixture();
  const result = await runSetup({ command: 'setup', nodeId: 'blank', plan: true }, f.root, f.transport);
  assert.equal(result.action, 'install');
  assert.equal(result.operation, 'setup');
  assert.equal(result.firstInstallReady, true);
  assert.equal('supported' in result, false);
  assert.equal(result.plan?.port, 8443);
  assert.equal(result.plan?.asset.sha256, xrayRelease.assets.x86_64.sha256);
  assert.equal(f.executions, 0);
  assert.equal(existsSync(join(f.root, 'local')), false);
});
test('noninteractive install needs explicit approval; negative confirmation makes no writes', async () => {
  const f = fixture();
  await rejected(() => runSetup({ command: 'setup', nodeId: 'blank' }, f.root, f.transport), 'INSTALL_APPROVAL_REQUIRED');
  await rejected(() => runSetup({ command: 'setup', nodeId: 'blank' }, f.root, f.transport, async () => false), 'INSTALL_APPROVAL_REQUIRED');
  assert.equal(f.executions, 0);
  assert.equal(existsSync(join(f.root, 'local')), false);
});
test('apply is wired through installer to adoption, status and export; repeat preserves identity', async () => {
  const f = fixture();
  const options = { command: 'setup' as const, nodeId: 'blank', apply: true, port: 9443, clientName: 'laptop',
    serverName: 'www.example.org', realityTarget: 'www.example.org:443', readyTimeout: 45 };
  const result = await runSetup(options, f.root, f.transport, undefined, async () => 'reachable');
  assert.equal(result.status, 'installed');
  const uri = new URL(readFileSync(result.outputFile as string, 'utf8').trim());
  assert.equal(uri.port, '9443');
  assert.equal(uri.username, f.probe.config.inbounds[0].settings.clients[0].id);
  assert.equal(f.probe.config.inbounds[0].settings.clients[0].email, 'laptop');
  assert.equal(result.networkStatus, 'tcp-reachable-proxy-unverified');
  assert.equal(result.proxyHttps, 'not-verified');
  assert.equal(runAdoption({ command: 'status', nodeId: 'blank' }, f.root, f.transport).managed, true);
  const before = JSON.stringify(f.probe.config);
  assert.equal((await runSetup(options, f.root, f.transport)).status, 'unchanged');
  assert.equal(JSON.stringify(f.probe.config), before);
  assert.equal(f.executions, 1);
  assert.equal(JSON.stringify(result).includes(f.probe.config.inbounds[0].settings.clients[0].id), false);
});
test('setup bring-back writes every local artifact and a later adoption overwrites canonical files', async () => {
  const f = fixture();
  const result = await runSetup({ command: 'setup', nodeId: 'blank', apply: true }, f.root, f.transport, undefined, async () => 'reachable');
  assert.equal(result.status, 'installed');
  const files = result.outputFiles as { format: string; path: string }[];
  assert.deepEqual(files.map(file => file.format), ['vless-uri', 'vless-qr-png', 'mihomo-provider', 'mihomo-profile', 'sing-box']);
  assert.equal(String(result.outputDirectory).startsWith(f.root), true);
  assert.equal(files.every(file => file.path.startsWith(String(result.outputDirectory))), true);
  const secretKey = f.probe.config.inbounds[0].streamSettings.realitySettings.privateKey as string;
  const clientId = f.probe.config.inbounds[0].settings.clients[0].id as string;
  const human = renderHumanResult(result);
  for (const secret of [secretKey, clientId, 'vless://']) {
    assert.equal(JSON.stringify(result).includes(secret), false, secret);
    assert.equal(human.includes(secret), false, secret);
  }
  assert.equal(human.includes(String(result.outputFile)), true);
  assert.equal(readFileSync(files[1].path).subarray(0, 8).toString('binary'), '\x89PNG\r\n\x1a\n');
  if (process.platform !== 'win32') {
    assert.equal(statSync(String(result.outputDirectory)).mode & 0o777, 0o700);
    for (const file of files) assert.equal(statSync(file.path).mode & 0o777, 0o600);
  }
  writeFileSync(String(result.outputFile), 'sentinel-not-a-secret\n');
  const unchanged = await runSetup({ command: 'setup', nodeId: 'blank' }, f.root, f.transport);
  assert.equal(unchanged.status, 'unchanged');
  assert.equal(readFileSync(String(result.outputFile), 'utf8'), 'sentinel-not-a-secret\n');
  f.probe.config.inbounds[0].settings.clients[0].email = 'other';
  const refreshed = await runSetup({ command: 'setup', nodeId: 'blank' }, f.root, f.transport);
  assert.equal(refreshed.status, 'adopted');
  assert.equal(readFileSync(String(result.outputFile), 'utf8').includes('sentinel-not-a-secret'), false);
  assert.equal(JSON.stringify(refreshed).includes(clientId), false);
  assert.equal(renderHumanResult(refreshed).includes('vless://'), false);
  f.probe.config.inbounds[0].settings.clients.push({ id: '22222222-2222-4222-8222-222222222222' });
  const ambiguous = await runSetup({ command: 'setup', nodeId: 'blank' }, f.root, f.transport);
  assert.equal(ambiguous.status, 'adopted-local-handoff-failed');
  assert.equal(ambiguous.localHandoffCode, 'CLIENT_SELECTION_REQUIRED');
  assert.equal(ambiguous.managed, true);
  assert.equal(JSON.stringify(ambiguous).includes('22222222-2222-4222-8222-222222222222'), false);
});
test('port conflicts, permissions, residual installations and incomplete evidence stop installation', async () => {
  for (const [property, value, code] of [
    ['existing', ['/etc/xray'], 'INSTALL_LAYOUT_UNSUPPORTED'], ['units', ['xray@old.service'], 'INSTALL_LAYOUT_UNSUPPORTED'],
    ['processes', ['xray'], 'INSTALL_LAYOUT_UNSUPPORTED'], ['root', false, 'INSTALL_ROOT_OR_SUDO_REQUIRED'],
    ['inspectionComplete', false, 'INSTALL_LAYOUT_UNSUPPORTED'], ['os', 'ubuntu', 'INSTALL_OS_UNSUPPORTED'],
    ['freeMiB', 10, 'INSTALL_PREREQUISITES_MISSING'], ['missingCommands', ['curl'], 'INSTALL_PREREQUISITES_MISSING'],
    ['arch', 'unknown', 'INSTALL_ARCH_UNSUPPORTED'], ['listeners', ['tcp LISTEN 0 100 0.0.0.0:8443 0.0.0.0:*'], 'INSTALL_PORT_IN_USE']
  ] as const) {
    const f = fixture();
    Object.assign(f.inspection, { [property]: value });
    await rejected(() => runSetup({ command: 'setup', nodeId: 'blank', apply: true }, f.root, f.transport), code);
    assert.equal(f.executions, 0);
  }
});
test('overrides are parsed and validated; shell injection and unapproved versions are refused', async () => {
  const f = fixture();
  const options = parseArguments(['setup', 'blank', '--apply', '--port', '9443', '--client-name', 'laptop',
    '--server-name', 'www.example.org', '--version', '26.11.9', '--ready-timeout', '60']);
  assert.equal(options.port, 9443);
  assert.equal(options.readyTimeout, 60);
  for (const [override, code] of [
    [{ port: 25281 }, 'INSTALL_PORT_INVALID'], [{ serverName: "evil'; touch /oops" }, 'REALITY_TARGET_INVALID'],
    [{ version: 'latest' }, 'INSTALL_VERSION_UNSUPPORTED'], [{ readyTimeout: 999 }, 'READY_TIMEOUT_INVALID']
  ] as const) await rejected(() => runSetup({ ...options, ...override }, f.root, f.transport), code);
});
test('confirmation-to-apply baseline drift aborts; SSH resolution mismatch aborts', async () => {
  const f = fixture();
  await rejected(() => runSetup({ command: 'setup', nodeId: 'blank' }, f.root, f.transport, async () => {
    f.inspection.baseline = 'b'.repeat(64); return true;
  }), 'INSTALL_BASELINE_CHANGED');
  assert.equal(f.executions, 0);
  const other = fixture();
  await rejected(() => runSetup({ command: 'setup', nodeId: 'blank' }, other.root, other.transport, async () => {
    other.transport.resolve = alias => ({ alias, host: '192.0.2.99', port: 25281, user: 'root' });
    return true;
  }), 'SSH_TARGET_CHANGED');
  assert.equal(other.executions, 0);
});
test('failed transactions distinguish restored and unknown; unknown receipt blocks blind retry', async () => {
  for (const outcome of ['recovered', 'pending', 'unknown']) {
    const f = fixture(); f.outcome(outcome);
    const result = await runSetup({ command: 'setup', nodeId: 'blank', apply: true }, f.root, f.transport);
    assert.equal(result.status, outcome === 'recovered' ? 'failed-restored' : 'unknown');
    if (outcome !== 'recovered') {
      await rejected(() => runSetup({ command: 'setup', nodeId: 'blank', apply: true }, f.root, f.transport), 'TRANSACTION_RECOVERY_REQUIRED');
      assert.equal(f.executions, 1);
    }
  }
});
test('external failure leaves healthy service and gives firewall diagnosis without rewriting rules', async () => {
  const f = fixture();
  const result = await runSetup({ command: 'setup', nodeId: 'blank', apply: true }, f.root, f.transport, undefined, async () => 'unreachable');
  assert.equal(result.status, 'installed');
  assert.equal(result.networkStatus, 'local-ready-external-unreachable');
  assert.equal(f.probe.service, 'active');
});
test('rollback failure retains recovery point and blocks another execution', async () => {
  const f = fixture();
  f.outcome('rollback-failed');
  const result = await runSetup({ command: 'setup', nodeId: 'blank', apply: true }, f.root, f.transport);
  assert.equal(result.status, 'rollback-failed');
  assert.equal(result.code, 'INSTALL_ROLLBACK_FAILED');
  assert.equal(typeof result.recoveryReceipt, 'string');
  await rejected(() => runSetup({ command: 'setup', nodeId: 'blank', apply: true }, f.root, f.transport), 'TRANSACTION_RECOVERY_REQUIRED');
  assert.equal(f.executions, 1);
});
test('production script reuses shared transaction and pins sources, validates before publish, waits and journals ownership', () => {
  const f = fixture();
  const plan = installPlan({ command: 'setup', nodeId: 'blank' }, f.transport.resolve('blank'), f.probe);
  const script = generateInstallScript(plan, 'a'.repeat(32));
  for (const fragment of ['verify_install_baseline', 'flock -nx', 'sha256sum --status', 'run -test',
    'READY_TIMEOUT', 'SERVICE_NOT_READY', 'account.uid', 'userdel', 'systemctl start xray', 'rollback_owned_account']) assert.equal(script.includes(fragment), true);
  assert.equal(script.includes('systemctl restart'), false);
  assert.equal(script.includes('nft add'), false);
  assert.equal(script.indexOf('run -test -config "$receipt/config.json"') < script.indexOf('publish 0 "$receipt/xray"'), true);
});
test('post-install local handoff failures keep the installed receipt and report changed state accurately', async () => {
  const f = fixture();
  const execute = f.transport.execute;
  f.transport.execute = (target, script) => {
    const result = execute(target, script);
    f.probe.diskMatchesRunning = false;
    return result;
  };
  const result = await runSetup({ command: 'setup', nodeId: 'blank', apply: true }, f.root, f.transport);
  assert.equal(result.status, 'installed-local-state-incomplete');
  assert.equal(result.changed, true);
  assert.equal(f.transport.receipt(f.transport.resolve('blank'), ''), 'installed');
});
test('an installed target never enters the executor even with apply; plan handles vendor templates by runtime probe', async () => {
  const f = fixture();
  await runSetup({ command: 'setup', nodeId: 'blank', apply: true }, f.root, f.transport, undefined, async () => 'reachable');
  const plan = await runSetup({ command: 'setup', nodeId: 'blank', plan: true }, f.root, f.transport);
  assert.equal(plan.action, 'unchanged');
  assert.equal(f.executions, 1);
  f.probe.layout = 'unsupported';
  const unsupported = await runSetup({ command: 'setup', nodeId: 'blank', apply: true }, f.root, f.transport);
  assert.equal(unsupported.action, 'inspect');
  assert.equal(f.executions, 1);
});
test('Ubuntu 24.04 selects the shared installer for x86_64 and aarch64 with defaults and overrides', async () => {
  for (const arch of ['x86_64', 'aarch64']) {
    const f = fixture('ubuntu', '24.04');
    f.inspection.arch = arch;
    const options = { command: 'setup' as const, nodeId: 'ubuntu-node', port: 9443, clientName: 'laptop' };
    const planned = await runSetup({ ...options, plan: true }, f.root, f.transport);
    assert.equal(planned.plan?.platform.os, 'ubuntu');
    assert.equal(planned.plan?.platform.release, '24.04');
    assert.equal(planned.plan?.platform.serviceManager, 'systemd');
    assert.equal(planned.plan?.dependencyPolicy, 'existing-tools-only');
    assert.equal(planned.plan?.port, 9443);
    assert.equal(f.executions, 0);
    assert.equal(existsSync(join(f.root, 'local')), false);
    const installed = await runSetup({ ...options, apply: true }, f.root, f.transport, undefined, async () => 'reachable');
    assert.equal(installed.status, 'installed');
    assert.equal(installed.plan, undefined);
    const before = JSON.stringify(f.probe.config);
    assert.equal((await runSetup(options, f.root, f.transport)).status, 'unchanged');
    assert.equal(JSON.stringify(f.probe.config), before);
    assert.equal(f.executions, 1);
    assert.equal(runAdoption({ command: 'status', nodeId: 'ubuntu-node' }, f.root, f.transport).managed, true);
  }
});
test('only explicit OS/version pairs qualify for installation, independent of Debian ancestry', async () => {
  for (const [os, release] of [['ubuntu', '22.04'], ['ubuntu', '24.10'], ['ubuntu', '24.04.4'],
    ['debian', '12'], ['debian', '14'], ['linuxmint', '24.04'], ['unknown', '24.04']]) {
    const f = fixture(os, release);
    await rejected(() => runSetup({ command: 'setup', nodeId: 'node', plan: true }, f.root, f.transport), 'INSTALL_OS_UNSUPPORTED');
    assert.equal(f.executions, 0);
    assert.equal(existsSync(join(f.root, 'local')), false);
  }
});
test('capability gates apply equally to both distributions; apt absence does not trigger package changes', async () => {
  for (const [os, release] of [['debian', '13'], ['ubuntu', '24.04']]) {
    const f = fixture(os, release);
    f.inspection.systemd = false;
    await rejected(() => runSetup({ command: 'setup', nodeId: 'node', plan: true }, f.root, f.transport), 'INSTALL_SERVICE_MANAGER_UNSUPPORTED');
    f.inspection.systemd = true;
    f.inspection.serviceManager = 'unknown';
    await rejected(() => runSetup({ command: 'setup', nodeId: 'node', plan: true }, f.root, f.transport), 'INSTALL_SERVICE_MANAGER_UNSUPPORTED');
    f.inspection.serviceManager = 'systemd';
    for (const capability of Object.keys(f.inspection.filesystem) as Array<keyof InstallInspection['filesystem']>) {
      f.inspection.filesystem[capability] = false;
      await rejected(() => runSetup({ command: 'setup', nodeId: 'node', plan: true }, f.root, f.transport), 'INSTALL_FILESYSTEM_UNSUPPORTED');
      f.inspection.filesystem[capability] = true;
    }
    f.inspection.missingCommands = ['curl'];
    await rejected(() => runSetup({ command: 'setup', nodeId: 'node', plan: true }, f.root, f.transport), 'INSTALL_PREREQUISITES_MISSING');
    f.inspection.missingCommands = [];
    f.inspection.packageManager = 'unknown';
    const result = await runSetup({ command: 'setup', nodeId: 'node', plan: true }, f.root, f.transport);
    assert.equal(result.plan?.dependencyPolicy, 'existing-tools-only');
    assert.equal(result.plan?.platform.packageManager, 'unknown');
    assert.equal(f.executions, 0);
  }
});
test('unqualified installation platforms retain safe discovery and existing service adoption', async () => {
  const f = fixture('ubuntu', '24.04');
  await runSetup({ command: 'setup', nodeId: 'node', apply: true }, f.root, f.transport, undefined, async () => 'reachable');
  f.probe.linux = { os: 'linuxmint', release: '22', arch: 'x86_64', serviceManager: 'systemd', packageManager: 'apt' };
  const status = runAdoption({ command: 'status', nodeId: 'node' }, f.root, f.transport);
  assert.equal((status.supportLevels as { firstInstallPlatform: boolean }).firstInstallPlatform, false);
  const plan = await runSetup({ command: 'setup', nodeId: 'node', plan: true }, f.root, f.transport);
  assert.equal(plan.action, 'unchanged');
  assert.equal(f.executions, 1);
});
test('Debian and Ubuntu use identical deployment and rollback script after configuration payload normalization', () => {
  const scripts = [['debian', '13'], ['ubuntu', '24.04']].map(([os, release]) => {
    const f = fixture(os, release);
    const plan = installPlan({ command: 'setup', nodeId: 'node' }, f.transport.resolve('node'), f.probe);
    return generateInstallScript(plan, 'a'.repeat(32)).replace(/b64decode\('[A-Za-z0-9+/=]+'\)/, "b64decode('FIXTURE')");
  });
  assert.equal(scripts[0], scripts[1]);
});

test('authorized endpoint permits installed journal setup plan with original host identity on both platforms', async () => {
  for (const [os,release] of [['debian','13'],['ubuntu','24.04']]) {
    const f=fixture(os,release);
    await runSetup({command:'setup',nodeId:'blank',apply:true},f.root,f.transport,undefined,async()=> 'reachable');
    const journal=join(f.root,'local/private/cli-install/blank/operation.local.json');
    const originalJournal=readFileSync(journal,'utf8');
    f.transport.resolve=alias=>({alias,host:'192.0.2.99',user:'root',port:25281});
    runAdoption({command:'endpoint',nodeId:'blank',expectedHost:'192.0.2.99'},f.root,f.transport);
    const state=join(f.root,'local/private/cli-nodes/blank/state.local.json');
    const original=readFileSync(state,'utf8');
    f.transport.receipt=target=>{assert.equal(target.hostKeyAlias,'192.0.2.10');assert.equal(target.host,'192.0.2.99');return 'installed';};
    const result=await runSetup({command:'setup',nodeId:'blank',plan:true},f.root,f.transport);
    assert.equal(result.status,'planned');assert.equal(result.action,'unchanged');
    assert.equal((await runSetup({command:'setup',nodeId:'blank'},f.root,f.transport)).status,'unchanged');
    assert.equal(f.executions,1);assert.equal(readFileSync(state,'utf8'),original);
    assert.equal(readFileSync(journal,'utf8'),originalJournal);
    for(const status of ['pending','unknown','absent','recovered']) {
      f.transport.receipt=()=>status;
      await rejected(()=>runSetup({command:'setup',nodeId:'blank',plan:true},f.root,f.transport),'TRANSACTION_RECOVERY_REQUIRED');
    }
  }
});
test('setup rejects moved target without endpoint authorization, changed identity or changed baseline', async () => {
  const f=fixture();await runSetup({command:'setup',nodeId:'blank',apply:true},f.root,f.transport,undefined,async()=> 'reachable');
  f.transport.resolve=alias=>({alias,host:'192.0.2.99',user:'root',port:25281});
  await rejected(()=>runSetup({command:'setup',nodeId:'blank',plan:true},f.root,f.transport),'SSH_TARGET_CHANGED');
  runAdoption({command:'endpoint',nodeId:'blank',expectedHost:'192.0.2.99'},f.root,f.transport);
  f.transport.probe=()=>{throw new AdoptionError('SSH_UNAVAILABLE',4);};
  await rejected(()=>runSetup({command:'setup',nodeId:'blank',plan:true},f.root,f.transport),'SSH_UNAVAILABLE');
  f.transport.probe=()=>structuredClone(f.probe);
  f.probe.config.inbounds[0].port=9443;
  await rejected(()=>runSetup({command:'setup',nodeId:'blank',plan:true},f.root,f.transport),'REMOTE_BASELINE_CHANGED');
  const state=join(f.root,'local/private/cli-nodes/blank/state.local.json');const data=JSON.parse(readFileSync(state,'utf8'));
  data.target.hostKeyAlias='untrusted.example.org';writeFileSync(state,JSON.stringify(data));
  await rejected(()=>runSetup({command:'setup',nodeId:'blank',plan:true},f.root,f.transport),'SSH_TARGET_CHANGED');
});

test('journal schema, transaction shape and node association reject before any transport call', async () => {
  const f=fixture();await runSetup({command:'setup',nodeId:'blank',apply:true},f.root,f.transport,undefined,async()=> 'reachable');
  f.transport.resolve=alias=>({alias,host:'192.0.2.99',user:'root',port:25281});
  runAdoption({command:'endpoint',nodeId:'blank',expectedHost:'192.0.2.99'},f.root,f.transport);
  const path=join(f.root,'local/private/cli-install/blank/operation.local.json');
  const original=readFileSync(path,'utf8');const journal=JSON.parse(original);
  const cases=[{...journal,schemaVersion:'unknown'}, {...journal,plan:{...journal.plan,nodeId:'different'}},
    {...journal,id:'invalid'}, {...journal,target:{...journal.target,port:0}},
    {...journal,plan:{...journal.plan,target:{...journal.target,user:'different'}}},
    {...journal,plan:null},null,[],{schemaVersion:'vpncp-install-operation-v1'},'{broken-json'];
  f.transport.resolve=()=>{throw Error('transport must not be called');};
  for(const item of cases){
    const bytes=typeof item==='string'?item:JSON.stringify(item);writeFileSync(path,bytes);
    await rejected(()=>runSetup({command:'setup',nodeId:'blank',plan:true},f.root,f.transport),'TRANSACTION_RECOVERY_REQUIRED');
    assert.equal(readFileSync(path,'utf8'),bytes);
  }
  writeFileSync(path,original);
});
