import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdoptionError, configDigest, type Probe } from '../../../packages/core/src/xray-adoption.ts';
import { canonicalCidr, cidrContains, hardenRemoteScript, managedXrayPorts, runHarden, type HardenRemote, type HardenRequest, type HardenTransport } from '../../../packages/core/src/host-harden.ts';
import { parseHardenArguments, renderHardenResult } from '../src/vpncp.ts';

const scriptPath = join(import.meta.dirname, '../../../packages/core/src/host-harden.py');
const clientId = '00000000-0000-4000-8000-000000000001';
const privateKey = 'fixture-private-key-value';

function python(code: string, payload: unknown) {
  const result = spawnSync('python3', ['-c', code, scriptPath], {
    input: JSON.stringify(payload), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

const driver = `
import importlib.util, json, sys, copy, os, base64, tempfile, subprocess
path = sys.argv[1]
spec = importlib.util.spec_from_file_location('host_harden', path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
report = {}
def fresh(**over):
    state = {
      "nftPresent": True, "chains": [], "ufwPresent": True, "ufwActive": False, "ufwDefault": "allow", "ufwRules": [],
      "firewalldPresent": True, "firewalldActive": False, "firewalldServices": [], "firewalldPorts": [], "firewalldRich": [],
      "sshConnection": "203.0.113.10 50000 192.0.2.20 22", "currentAuth": "publickey", "authorizedKeys": True,
      "sshd": {"port":"22","passwordauthentication":"yes","kbdinteractiveauthentication":"yes","challengeresponseauthentication":"yes","pubkeyauthentication":"yes"},
      "listeners": ["0.0.0.0:22", "0.0.0.0:9443"], "xrayActive": True, "sshUnit": "ssh", "files": {}, "calls": []
    }
    state.update(over)
    return state
def run(state, request, mode="plan"):
    host = mod.FixtureHost(copy.deepcopy(state))
    result = mod.plan_host(host, request) if mode == "plan" else mod.apply_host(host, request)
    return result, host.state
base = fresh()
plan_req = {"mode":"plan","cidrs":["203.0.113.10/24"],"sshPort":22,"xrayPorts":[9443]}
planned, planned_state = run(base, plan_req)
report["plan"] = {"blockers": planned["blockers"], "ops": [item["op"] for item in planned["actions"]],
  "backend": planned["backend"], "covered": planned["sshSourceCovered"], "cloud": planned["cloudSecurityGroup"],
  "fail2ban": planned["fail2ban"], "ports": planned["xrayPorts"], "changedChains": planned_state["chains"] != [],
  "mutating": any(call[0] == "nft" and call[1] == "add" for call in planned_state["calls"]),
  "sourceLeaked": "203.0.113.10" in json.dumps(planned)}
applied, applied_state = run(base, {**plan_req, "mode":"apply", "expectedFirewallHash": planned["firewallHash"]}, "apply")
rules = [rule for chain in applied_state["chains"] for rule in chain["rules"]]
report["apply"] = {"ok": applied["ok"], "changed": applied["changed"], "policy": applied_state["chains"][0]["policy"],
  "cidrs": sorted({rule.get("cidr") for rule in rules if rule.get("cidr")}),
  "ports": sorted({rule.get("port") for rule in rules if rule.get("port")}),
  "deleted": any(call[1] in ("delete", "flush") for call in applied_state["calls"] if call and call[0] == "nft"),
  "restartedSsh": any(call[:3] == ["systemctl", "restart", "ssh"] for call in applied_state["calls"])}
second_plan, _ = run(applied_state, {"mode":"plan","cidrs":["198.51.100.20/32"],"sshPort":22,"xrayPorts":[9443]})
second, second_state = run(applied_state, {"mode":"apply","cidrs":["198.51.100.20/32"],"sshPort":22,"xrayPorts":[9443],
  "expectedFirewallHash": second_plan["firewallHash"]}, "apply")
kept = {rule.get("cidr") for chain in second_state["chains"] for rule in chain["rules"] if rule.get("cidr")}
report["addOnly"] = {"ok": second["ok"], "kept": sorted(kept), "deleted": any(call[1] in ("delete", "flush") for call in second_state["calls"] if call and call[0] == "nft")}
locked, locked_state = run(base, {"mode":"apply","cidrs":["192.0.2.8/32"],"sshPort":22,"xrayPorts":[9443],
  "expectedFirewallHash": mod.plan_host(mod.FixtureHost(copy.deepcopy(base)), {"mode":"plan","cidrs":["192.0.2.8/32"],"sshPort":22,"xrayPorts":[9443]})["firewallHash"]}, "apply")
report["lockout"] = {"ok": locked["ok"], "code": locked.get("code"), "chains": locked_state["chains"],
  "sourceLeaked": "203.0.113.10" in json.dumps(locked)}
seed = fresh(sshConnection="198.51.100.20 50000 192.0.2.20 22", chains=[{"family":"inet","table":"filter","name":"input","policy":"accept","rules":[
  {"kind":"allow","port":22,"cidr":"198.51.100.20/32","broad":False,"comment":"keep-ssh"},
  {"kind":"allow","port":9443,"cidr":"198.51.100.20/32","broad":False,"comment":"keep-xray"}]}],
  sshd={"port":"22","passwordauthentication":"no","kbdinteractiveauthentication":"no","challengeresponseauthentication":"no","pubkeyauthentication":"yes"},
  files={mod.SSH_DROPIN: mod.SSH_DROPIN_BODY, mod.SANDBOX_DROPIN: mod.SANDBOX_BODY})
seed_plan, _ = run(seed, {"mode":"plan","cidrs":["203.0.113.8/32"],"sshPort":22,"xrayPorts":[9443]})
seed_apply, seed_state = run(seed, {"mode":"apply","cidrs":["203.0.113.8/32"],"sshPort":22,"xrayPorts":[9443], "expectedFirewallHash": seed_plan["firewallHash"]}, "apply")
seed_rules = [rule for chain in seed_state["chains"] for rule in chain["rules"]]
report["existing"] = {"ok": seed_apply["ok"], "policy": seed_state["chains"][0]["policy"],
  "kept": any(rule.get("comment") == "keep-ssh" for rule in seed_rules),
  "added": any(rule.get("cidr") == "203.0.113.8/32" for rule in seed_rules)}
ufw = fresh(ufwActive=True)
ufw_plan, _ = run(ufw, plan_req)
ufw_apply, ufw_state = run(ufw, {**plan_req, "mode":"apply", "expectedFirewallHash": ufw_plan["firewallHash"]}, "apply")
report["ufw"] = {"backend": ufw_plan["backend"], "ok": ufw_apply["ok"], "default": ufw_state["ufwDefault"],
  "nftAdd": any(call[0] == "nft" and call[1] == "add" for call in ufw_state["calls"])}
both_plan, _ = run(fresh(ufwActive=True, firewalldActive=True), plan_req)
report["conflict"] = both_plan["blockers"]
missing_plan, _ = run(fresh(nftPresent=False, ufwPresent=False, firewalldPresent=False), plan_req)
report["missing"] = missing_plan["blockers"]
broad = fresh(chains=[{"family":"inet","table":"filter","name":"input","policy":"accept","rules":[{"kind":"allow","port":22,"cidr":None,"broad":True,"comment":"world"}]}])
broad_plan, _ = run(broad, plan_req)
broad_apply, broad_state = run(broad, {**plan_req, "mode":"apply", "expectedFirewallHash": broad_plan["firewallHash"]}, "apply")
report["broad"] = {"restricted": broad_plan["sshSourceRestricted"], "fail2ban": broad_plan["fail2ban"],
  "reason": broad_plan["fail2banReason"], "kept": any(rule.get("comment") == "world" for chain in broad_state["chains"] for rule in chain["rules"]),
  "ok": broad_apply["ok"]}
broken = fresh(sandboxBreaks=True, files={mod.SSH_DROPIN: mod.SSH_DROPIN_BODY},
  sshd={"port":"22","passwordauthentication":"no","kbdinteractiveauthentication":"no","challengeresponseauthentication":"no","pubkeyauthentication":"yes"})
broken_plan, _ = run(broken, plan_req)
broken_apply, broken_state = run(broken, {**plan_req, "mode":"apply", "expectedFirewallHash": broken_plan["firewallHash"]}, "apply")
report["sandbox"] = {"code": broken_apply.get("code"), "present": mod.SANDBOX_DROPIN in broken_state.get("files", {}),
  "policy": broken_state["chains"][0]["policy"]}
vectors = ["203.0.113.10/32", "203.0.113.10/24", "198.51.100.20/32", "192.0.2.0/24", "2001:db8::/32", "2001:DB8:0:0:0:0:0:1/128", "127.0.0.1/8", "0.0.0.0/0", "::/0", "203.0.113.10", "192.0.2.1/33"]
canonical = {}
for value in vectors:
    try: canonical[value] = mod.canonical_cidr(value)
    except mod.CidrError as error: canonical[value] = error.code
report["canonical"] = canonical
handle, fixture = tempfile.mkstemp(suffix=".json")
os.close(handle)
with open(fixture, "w", encoding="utf-8") as output: json.dump(fresh(), output)
env = os.environ.copy()
env["ROUTEQUAY_HARDEN_FIXTURE"] = fixture
env["ROUTEQUAY_HARDEN_REQUEST_B64"] = base64.b64encode(json.dumps(plan_req).encode()).decode()
main = subprocess.run(["python3", path], capture_output=True, text=True, env=env)
body = json.loads(main.stdout)
after = json.load(open(fixture, encoding="utf-8"))
report["main"] = {"ok": body["ok"], "cloud": body["cloudSecurityGroup"], "chains": after["chains"],
  "mutating": any(call[0] == "nft" and len(call) > 1 and call[1] == "add" for call in after["calls"]),
  "sourceLeaked": "203.0.113.10" in main.stdout}
print(json.dumps(report))
`;

test('python3 fixture covers plan, add-only apply, and lockout without a live firewall', () => {
  const report = python(driver, {}) as {
    plan: { blockers: string[]; ops: string[]; backend: string; covered: boolean; cloud: string; fail2ban: string; ports: number[]; changedChains: boolean; mutating: boolean; sourceLeaked: boolean };
    apply: { ok: boolean; changed: boolean; policy: string; cidrs: string[]; ports: number[]; deleted: boolean; restartedSsh: boolean };
    addOnly: { ok: boolean; kept: string[]; deleted: boolean };
    lockout: { ok: boolean; code: string; chains: unknown[]; sourceLeaked: boolean };
    existing: { ok: boolean; policy: string; kept: boolean; added: boolean };
    ufw: { backend: string; ok: boolean; default: string; nftAdd: boolean };
    conflict: string[]; missing: string[];
    broad: { restricted: boolean; fail2ban: string; reason: string; kept: boolean; ok: boolean };
    sandbox: { code: string; present: boolean; policy: string };
    canonical: Record<string, string>;
    main: { ok: boolean; cloud: string; chains: unknown[]; mutating: boolean; sourceLeaked: boolean };
  };
  assert.deepEqual(report.plan.blockers, []);
  assert.equal(report.plan.backend, 'nftables');
  assert.equal(report.plan.covered, true);
  assert.equal(report.plan.cloud, 'unchanged');
  assert.equal(report.plan.fail2ban, 'not-enabled');
  assert.deepEqual(report.plan.ports, [9443]);
  assert.equal(report.plan.ports.includes(8443), false);
  assert.equal(report.plan.changedChains, false);
  assert.equal(report.plan.mutating, false);
  assert.equal(report.plan.sourceLeaked, false);
  assert.ok(report.plan.ops.indexOf('set-policy-drop') > report.plan.ops.indexOf('add-allow'));
  assert.equal(report.apply.ok, true);
  assert.equal(report.apply.changed, true);
  assert.equal(report.apply.policy, 'drop');
  assert.deepEqual(report.apply.cidrs, ['203.0.113.0/24']);
  assert.deepEqual(report.apply.ports, [22, 9443]);
  assert.equal(report.apply.deleted, false);
  assert.equal(report.apply.restartedSsh, false);
  assert.equal(report.addOnly.ok, true);
  assert.deepEqual(report.addOnly.kept, ['198.51.100.20/32', '203.0.113.0/24']);
  assert.equal(report.addOnly.deleted, false);
  assert.equal(report.lockout.ok, false);
  assert.equal(report.lockout.code, 'HARDEN_SSH_PATH_UNCOVERED');
  assert.deepEqual(report.lockout.chains, []);
  assert.equal(report.lockout.sourceLeaked, false);
  assert.equal(report.existing.ok, true);
  assert.equal(report.existing.policy, 'drop');
  assert.equal(report.existing.kept, true);
  assert.equal(report.existing.added, true);
  assert.equal(report.ufw.backend, 'ufw');
  assert.equal(report.ufw.ok, true);
  assert.equal(report.ufw.default, 'deny');
  assert.equal(report.ufw.nftAdd, false);
  assert.equal(report.conflict.includes('HARDEN_FIREWALL_BACKEND_CONFLICT'), true);
  assert.equal(report.missing.includes('HARDEN_FIREWALL_TOOL_MISSING'), true);
  assert.equal(report.broad.restricted, false);
  assert.equal(report.broad.fail2ban, 'not-enabled');
  assert.equal(report.broad.reason, 'not-default-existing-broad-allow');
  assert.equal(report.broad.kept, true);
  assert.equal(report.broad.ok, true);
  assert.equal(report.sandbox.code, 'HARDEN_SANDBOX_ROLLED_BACK');
  assert.equal(report.sandbox.present, false);
  assert.equal(report.sandbox.policy, 'drop');
  assert.equal(report.main.ok, true);
  assert.equal(report.main.cloud, 'unchanged');
  assert.deepEqual(report.main.chains, []);
  assert.equal(report.main.mutating, false);
  assert.equal(report.main.sourceLeaked, false);
  for (const [value, expected] of Object.entries({
    '203.0.113.10/32': '203.0.113.10/32', '203.0.113.10/24': '203.0.113.0/24',
    '198.51.100.20/32': '198.51.100.20/32', '192.0.2.0/24': '192.0.2.0/24',
    '2001:db8::/32': '2001:db8::/32', '2001:DB8:0:0:0:0:0:1/128': '2001:db8::1/128',
    '127.0.0.1/8': '127.0.0.0/8', '0.0.0.0/0': 'HARDEN_CIDR_UNRESTRICTED', '::/0': 'HARDEN_CIDR_UNRESTRICTED',
    '203.0.113.10': 'HARDEN_CIDR_INVALID', '192.0.2.1/33': 'HARDEN_CIDR_INVALID'
  })) {
    assert.equal(report.canonical[value], expected, value);
    if (expected.startsWith('HARDEN_')) assert.throws(() => canonicalCidr(value), (error: unknown) => error instanceof AdoptionError && error.code === expected);
    else assert.equal(canonicalCidr(value), expected);
  }
  assert.equal(cidrContains('203.0.113.0/24', '203.0.113.10'), true);
  assert.equal(cidrContains('192.0.2.8/32', '203.0.113.10'), false);
});

test('remote script reuses the read-only preflight hook and does not own cloud rules', () => {
  const script = hardenRemoteScript();
  const parsed = spawnSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], {
    input: script, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
  });
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.equal(script.includes('def inspect_install'), true);
  assert.equal(script.includes('def plan_host'), true);
  assert.equal(script.includes('firewallHash'), true);
  for (const forbidden of ['AuthorizeSecurityGroup', 'boto3', 'aws ec2', 'ufw delete', '--remove-rich-rule', 'minClientVer']) {
    assert.equal(script.includes(forbidden), false, forbidden);
  }
  const install = readFileSync(join(import.meta.dirname, '../../../packages/core/src/xray-install.ts'), 'utf8');
  assert.equal(install.includes('runHarden'), false);
  assert.equal(install.includes('host-harden'), false);
  assert.equal(install.includes('本次未修改规则'), true);
});

function managedConfig() {
  return {
    inbounds: [
      { protocol: 'vless', listen: '127.0.0.1', port: 1080, settings: { clients: [{ id: clientId }] }, streamSettings: { network: 'tcp', security: 'reality' } },
      { protocol: 'vless', listen: '0.0.0.0', port: 9443, settings: { decryption: 'none', clients: [{ id: clientId, flow: 'xtls-rprx-vision' }] },
        streamSettings: { network: 'tcp', security: 'reality', realitySettings: { privateKey, serverNames: ['www.example.com'], shortIds: ['abcd'] } } }
    ]
  };
}

function saved(root: string, config: ReturnType<typeof managedConfig>) {
  const directory = join(root, 'local/private/cli-nodes/node-a');
  mkdirSync(directory, { recursive: true });
  const state = { schemaVersion: 'vpncp-adoption-v1', nodeId: 'node-a', hash: configDigest(config),
    target: { alias: 'node-a', host: '192.0.2.10', user: 'root', port: 22 }, probe: { config } };
  writeFileSync(join(directory, 'state.local.json'), JSON.stringify(state));
  return directory;
}

function transportFor(config: ReturnType<typeof managedConfig>, directory: string, remote: (request: HardenRequest, call: number) => HardenRemote) {
  const modes: string[] = [];
  let calls = 0;
  const transport: HardenTransport = {
    resolve: alias => ({ alias, host: '192.0.2.10', user: 'root', port: 22 }),
    probe: () => ({ loadState: 'loaded', service: 'active', user: 'vcp', group: 'vcp', version: 'Xray 26.11.9',
      configPath: '/usr/local/etc/xray/config.json', permissions: { uid: 0, gid: 1, mode: '0o640' },
      config, listeners: ['0.0.0.0:9443', '0.0.0.0:22'], diskMatchesRunning: true, layout: 'single-file' } as Probe),
    invoke(_target, request) {
      calls += 1;
      modes.push(request.mode);
      if (request.mode === 'apply') assert.equal(existsSync(join(directory, 'operation.guard')), true);
      return remote(request, calls);
    }
  };
  return { transport, modes };
}

const readyRemote = (request: HardenRequest): HardenRemote => ({
  ok: true, changed: request.mode === 'apply', backend: 'nftables', firewall: 'read', firewallHash: 'a'.repeat(64),
  policy: 'drop', sshPort: 22, xrayPorts: request.xrayPorts, cidrs: request.cidrs, sshSourceCovered: true,
  sshSourceRestricted: true, sshKeyOnly: 'unchanged', sandbox: 'unchanged', cloudSecurityGroup: 'unchanged',
  fail2ban: 'not-enabled', fail2banReason: 'ssh-source-restricted', blockers: [],
  actions: [{ op: 'add-allow', backend: 'nftables', port: 22, cidr: request.cidrs[0] }, { op: 'set-policy-drop', backend: 'nftables' }]
});

test('plan is read-only, apply is explicit, and the managed port is not a second hardcoded list', async () => {
  const root = mkdtempSync(join(tmpdir(), 'routequay-harden-'));
  const config = managedConfig();
  const directory = saved(root, config);
  assert.deepEqual(managedXrayPorts(config), [9443]);
  const planned = transportFor(config, directory, request => readyRemote(request));
  const preview = await runHarden({ command: 'harden', nodeId: 'node-a', plan: true, cidrs: ['203.0.113.10/32'] }, root, planned.transport);
  assert.equal(preview.status, 'planned');
  assert.equal(preview.changed, false);
  assert.deepEqual(preview.xrayPorts, [9443]);
  assert.deepEqual(planned.modes, ['plan']);
  assert.equal(existsSync(join(directory, 'operation.guard')), false);
  const rendered = renderHardenResult(preview);
  assert.equal(rendered.includes(privateKey), false);
  assert.equal(rendered.includes(clientId), false);
  assert.equal(rendered.includes('vless://'), false);
  assert.equal(JSON.stringify(preview).includes(privateKey), false);

  const unapproved = transportFor(config, directory, request => readyRemote(request));
  await assert.rejects(() => runHarden({ command: 'harden', nodeId: 'node-a', cidrs: ['203.0.113.10/32'] }, root, unapproved.transport),
    (error: unknown) => error instanceof AdoptionError && error.code === 'HARDEN_APPROVAL_REQUIRED');
  assert.deepEqual(unapproved.modes, ['plan']);
  await assert.rejects(() => runHarden({ command: 'harden', nodeId: 'node-a', cidrs: ['203.0.113.10/32'] }, root, unapproved.transport, async () => false),
    (error: unknown) => error instanceof AdoptionError && error.code === 'HARDEN_APPROVAL_REQUIRED');

  const approved = transportFor(config, directory, request => readyRemote(request));
  const applied = await runHarden({ command: 'harden', nodeId: 'node-a', apply: true, cidrs: ['203.0.113.10/32'] }, root, approved.transport);
  assert.equal(applied.status, 'hardened');
  assert.equal(applied.changed, true);
  assert.equal(applied.cloudSecurityGroup, 'unchanged');
  assert.deepEqual(approved.modes, ['plan', 'plan', 'apply']);
  assert.equal(existsSync(join(directory, 'operation.guard')), false);
  assert.equal(JSON.stringify(applied).includes(privateKey), false);
  assert.equal(JSON.stringify(applied).includes(clientId), false);
});

test('an uncovered session or a delete action never reaches apply', async () => {
  const root = mkdtempSync(join(tmpdir(), 'routequay-harden-'));
  const config = managedConfig();
  const directory = saved(root, config);
  const uncovered = transportFor(config, directory, () => ({ ok: true, blockers: ['HARDEN_SSH_PATH_UNCOVERED'], actions: [],
    cloudSecurityGroup: 'unchanged', fail2ban: 'not-enabled', xrayPorts: [9443], cidrs: ['192.0.2.8/32'], sshSourceCovered: false }));
  const preview = await runHarden({ command: 'harden', nodeId: 'node-a', plan: true, cidrs: ['192.0.2.8/32'] }, root, uncovered.transport);
  assert.equal(preview.status, 'planned');
  assert.deepEqual(preview.blockers, ['HARDEN_SSH_PATH_UNCOVERED']);
  await assert.rejects(() => runHarden({ command: 'harden', nodeId: 'node-a', apply: true, cidrs: ['192.0.2.8/32'] }, root, uncovered.transport),
    (error: unknown) => error instanceof AdoptionError && error.code === 'HARDEN_SSH_PATH_UNCOVERED' && error.exitCode === 3);
  assert.equal(uncovered.modes.includes('apply'), false);
  const deleting = transportFor(config, directory, () => ({ ok: true, blockers: [], actions: [{ op: 'delete-allow' }], firewallHash: 'a'.repeat(64) }));
  await assert.rejects(() => runHarden({ command: 'harden', nodeId: 'node-a', apply: true, cidrs: ['203.0.113.10/32'] }, root, deleting.transport),
    (error: unknown) => error instanceof AdoptionError && error.code === 'HARDEN_ACTION_FORBIDDEN');
  assert.equal(deleting.modes.includes('apply'), false);
});

test('harden rejects conflicting modes and does not invent a CIDR', () => {
  assert.throws(() => parseHardenArguments(['harden', 'node-a', '--plan', '--apply']),
    (error: unknown) => error instanceof AdoptionError && error.code === 'CONFLICTING_OPTIONS');
  assert.throws(() => parseHardenArguments(['harden', 'node-a', '--cidr', '0.0.0.0/0']),
    (error: unknown) => error instanceof AdoptionError && error.code === 'HARDEN_CIDR_UNRESTRICTED');
  const parsed = parseHardenArguments(['harden', 'node-a', '--cidr', '203.0.113.10/24', '--cidr', '198.51.100.20/32', '--plan']);
  assert.deepEqual(parsed.cidrs, ['203.0.113.0/24', '198.51.100.20/32']);
  const cli = join(import.meta.dirname, '../src/vpncp.ts');
  const conflict = spawnSync(process.execPath, [cli, 'harden', 'node-a', '--plan', '--apply', '--json'], { encoding: 'utf8' });
  assert.equal(conflict.status, 2);
  assert.equal(JSON.parse(conflict.stdout).code, 'CONFLICTING_OPTIONS');
  const root = mkdtempSync(join(tmpdir(), 'routequay-harden-'));
  const missing = spawnSync(process.execPath, [cli, 'harden', 'node-a', '--plan', '--json', '--data-dir', root], {
    encoding: 'utf8', env: { ...process.env, ROUTEQUAY_CONFIG: join(root, 'missing.json') }
  });
  assert.equal(missing.status, 2);
  assert.equal(JSON.parse(missing.stdout).code, 'SETUP_REQUIRED');
  assert.equal(missing.stdout.includes('vless://'), false);
  assert.equal(missing.stdout.includes(privateKey), false);
});
