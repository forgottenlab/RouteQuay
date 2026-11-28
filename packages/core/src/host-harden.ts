import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  AdoptionError, configDigest, createOpenSshTransport, prepareSshConnect, withNodeLock,
  type AdoptionResult, type Probe, type SshClientFiles, type SshTarget
} from './xray-adoption.ts';

const safetyCodes = new Set([
  'HARDEN_SSH_PATH_UNCOVERED', 'HARDEN_SSH_LOCKOUT_RISK', 'HARDEN_SSH_PORT_MISMATCH',
  'HARDEN_BASELINE_CHANGED', 'REMOTE_BASELINE_CHANGED', 'RUNNING_CONFIG_UNVERIFIED',
  'HARDEN_FIREWALL_LAYOUT_UNSUPPORTED', 'HARDEN_XRAY_PORT_NOT_LISTENING', 'HARDEN_XRAY_PORT_UNKNOWN',
  'HARDEN_XRAY_NOT_ACTIVE', 'HARDEN_FIREWALL_BACKEND_CONFLICT', 'HARDEN_FIREWALL_TOOL_MISSING',
  'HARDEN_FIREWALL_UNREADABLE', 'HARDEN_SSH_KEY_ONLY_UNCONFIRMED', 'HARDEN_SANDBOX_ROLLED_BACK',
  'HARDEN_ACTION_FORBIDDEN', 'HARDEN_CIDR_UNRESTRICTED', 'SSH_TARGET_CHANGED', 'NODE_BUSY'
]);
const allowedActions = new Set([
  'ensure-chain', 'add-established', 'add-loopback', 'add-allow', 'set-policy-drop', 'ssh-key-only', 'sandbox'
]);

export type HardenCommand = {
  command: 'harden';
  nodeId: string;
  ssh?: string;
  plan?: boolean;
  apply?: boolean;
  json?: boolean;
  dataDir?: string;
  cidrs: string[];
};
export type HardenRequest = {
  mode: 'plan' | 'apply';
  cidrs: string[];
  sshPort: number;
  xrayPorts: number[];
  expectedFirewallHash?: string;
  expectedPreflightHash?: string | null;
};
export type HardenAction = { op: string; backend?: string; port?: number; cidr?: string };
export type HardenRemote = {
  ok?: boolean;
  code?: string;
  changed?: boolean;
  mode?: string;
  backend?: string | null;
  firewall?: string;
  firewallHash?: string;
  preflightFirewallHash?: string | null;
  policy?: string;
  sshPort?: number | null;
  xrayPorts?: number[];
  cidrs?: string[];
  sshSourceCovered?: boolean;
  sshSourceRestricted?: boolean;
  sshKeyOnly?: string;
  sandbox?: string;
  cloudSecurityGroup?: string;
  fail2ban?: string;
  fail2banReason?: string;
  optionalNotApplied?: string[];
  notProductized?: string[];
  blockers?: string[];
  actions?: HardenAction[];
};
export interface HardenTransport {
  resolve(alias: string): SshTarget;
  probe(target: SshTarget): Probe;
  invoke(target: SshTarget, request: HardenRequest): HardenRemote;
}

export function hardenExitCode(code: string | undefined): number {
  if (!code) return 0;
  if (safetyCodes.has(code)) return 3;
  if (code === 'SSH_UNAVAILABLE' || code === 'SSH_AUTH_FAILED' || code === 'ROOT_OR_SUDO_REQUIRED'
      || code === 'REMOTE_RESPONSE_INVALID' || code === 'HARDEN_REMOTE_FAILED') return 4;
  return 2;
}

export function canonicalCidr(value: string): string {
  if (typeof value !== 'string' || !value.includes('/') || /\s/.test(value)) failCidr('HARDEN_CIDR_INVALID');
  const [address, prefixText] = value.split('/') as [string, string];
  if (!/^\d+$/.test(prefixText ?? '')) failCidr('HARDEN_CIDR_INVALID');
  const prefix = Number(prefixText);
  if (address.includes(':')) return canonicalIpv6(address, prefix);
  if (prefix === 0) failCidr('HARDEN_CIDR_UNRESTRICTED');
  if (prefix < 1 || prefix > 32) failCidr('HARDEN_CIDR_INVALID');
  const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ipv4Int(address) & mask) >>> 0;
  const octets = [24, 16, 8, 0].map(shift => String((network >>> shift) & 255));
  return `${octets.join('.')}/${prefix}`;
}

export function cidrContains(cidr: string, ip: string): boolean {
  const [network, prefixText] = canonicalCidr(cidr).split('/') as [string, string];
  const prefix = Number(prefixText);
  if (network.includes(':')) {
    if (!ip.includes(':')) return false;
    const bits = 128n;
    const mask = ((1n << bits) - 1n) << BigInt(128 - prefix) & ((1n << bits) - 1n);
    return (ipv6Int(ip) & mask) === (ipv6Int(network) & mask);
  }
  if (ip.includes(':')) return false;
  const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4Int(ip) & mask) >>> 0 === (ipv4Int(network) & mask) >>> 0;
}

export function mergeCidrs(configured: string[], flags: string[]): string[] {
  const merged: string[] = [];
  for (const value of [...configured, ...flags]) {
    const cidr = canonicalCidr(value);
    if (!merged.includes(cidr)) merged.push(cidr);
  }
  if (merged.length > 16) throw new AdoptionError('HARDEN_CIDR_INVALID');
  return merged;
}

export function managedXrayPorts(config: unknown): number[] {
  const inbounds = config && typeof config === 'object' && Array.isArray((config as { inbounds?: unknown }).inbounds)
    ? (config as { inbounds: unknown[] }).inbounds : [];
  const ports: number[] = [];
  for (const inbound of inbounds) {
    if (!inbound || typeof inbound !== 'object') continue;
    const record = inbound as { protocol?: unknown; listen?: unknown; port?: unknown; settings?: { clients?: unknown }; streamSettings?: { security?: unknown; network?: unknown } };
    if (record.protocol !== 'vless' || record.streamSettings?.security !== 'reality') continue;
    if (typeof record.listen === 'string' && ['127.0.0.1', '::1', 'localhost'].includes(record.listen)) continue;
    const network = record.streamSettings?.network ?? 'tcp';
    if (network !== 'tcp' && network !== 'raw') continue;
    if (!Number.isInteger(record.port) || (record.port as number) < 1 || (record.port as number) > 65535) continue;
    const clients = record.settings?.clients;
    if (!Array.isArray(clients) || !clients.some(client => client && typeof client === 'object'
        && typeof (client as { id?: unknown }).id === 'string'
        && /^[0-9a-f-]{36}$/i.test((client as { id: string }).id))) continue;
    if (!ports.includes(record.port as number)) ports.push(record.port as number);
  }
  return ports;
}

export function hardenRemoteScript(): string {
  const preflight = readFileSync(new URL('./install-preflight.py', import.meta.url), 'utf8');
  const harden = readFileSync(new URL('./host-harden.py', import.meta.url), 'utf8');
  return `${preflight}\n${harden}`.replace(/\r\n/g, '\n');
}

export function createHardenTransport(files: SshClientFiles = {}): HardenTransport {
  const ssh = createOpenSshTransport(files);
  return {
    resolve: alias => ssh.resolve(alias),
    probe: target => ssh.probe(target),
    invoke(target, request) {
      const encoded = Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
      if (!/^[A-Za-z0-9+/=]+$/.test(encoded)) throw new AdoptionError('HARDEN_REQUEST_INVALID');
      const remote = `if [ "$(id -u)" = 0 ]; then env ROUTEQUAY_HARDEN_REQUEST_B64='${encoded}' python3 -B -; elif command -v sudo >/dev/null && sudo -n true 2>/dev/null; then sudo -n env SSH_CONNECTION="$SSH_CONNECTION" ROUTEQUAY_HARDEN_REQUEST_B64='${encoded}' python3 -B -; else echo '{"ok":false,"code":"ROOT_OR_SUDO_REQUIRED"}'; fi`;
      const result = spawnSync('ssh', [...prepareSshConnect(target, files), remote], {
        input: hardenRemoteScript(), encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024
      });
      if (!(result.stdout ?? '').trim()) {
        throw new AdoptionError(/Permission denied/i.test(result.stderr ?? '') ? 'SSH_AUTH_FAILED' : 'SSH_UNAVAILABLE', 4);
      }
      let body: unknown;
      try { body = JSON.parse(result.stdout); }
      catch { throw new AdoptionError('REMOTE_RESPONSE_INVALID', 4); }
      if (!body || typeof body !== 'object') throw new AdoptionError('REMOTE_RESPONSE_INVALID', 4);
      return body as HardenRemote;
    }
  };
}

type SavedState = { schemaVersion: string; nodeId: string; target: SshTarget; hash: string; probe: Probe };

export async function runHarden(options: HardenCommand, root = '.', transport: HardenTransport = createHardenTransport(),
  confirm?: (plan: AdoptionResult) => Promise<boolean>): Promise<AdoptionResult> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(options.nodeId)) throw new AdoptionError('NODE_ID_INVALID');
  const directory = resolve(root, 'local/private/cli-nodes', options.nodeId);
  const state = readSavedState(directory, options.nodeId);
  const resolved = transport.resolve(options.ssh ?? state.target.alias);
  if (resolved.alias !== state.target.alias || resolved.host !== state.target.host
      || resolved.user !== state.target.user || resolved.port !== state.target.port) {
    throw new AdoptionError('SSH_TARGET_CHANGED', 3);
  }
  const target: SshTarget = { ...resolved, ...(state.target.hostKeyAlias ? { hostKeyAlias: state.target.hostKeyAlias } : {}) };
  const probe = transport.probe(target);
  if (probe.layout !== 'single-file' || !probe.config) {
    return baseResult(options.nodeId, 'unsupported', false, 'LAYOUT_UNSUPPORTED');
  }
  const ports = managedXrayPorts(probe.config);
  const planned = await inspectPlan(options, target, probe, state, ports, transport);
  if (options.plan) return planned.view;
  if (planned.blockers.length) throw new AdoptionError(planned.blockers[0]!, hardenExitCode(planned.blockers[0]));
  assertAddOnly(planned.remote.actions);
  if (!options.apply && (!confirm || !await confirm(planned.view))) throw new AdoptionError('HARDEN_APPROVAL_REQUIRED');
  return withNodeLock(directory, () => {
    const fresh = transport.probe(target);
    if (fresh.layout !== 'single-file' || !fresh.config) throw new AdoptionError('LAYOUT_UNSUPPORTED', 3);
    if (JSON.stringify(managedXrayPorts(fresh.config)) !== JSON.stringify(ports)) throw new AdoptionError('HARDEN_BASELINE_CHANGED', 3);
    const again = inspectPlan(options, target, fresh, readSavedState(directory, options.nodeId), ports, transport);
    if (again.blockers.length) throw new AdoptionError(again.blockers[0]!, hardenExitCode(again.blockers[0]));
    if (again.remote.firewallHash !== planned.remote.firewallHash) throw new AdoptionError('HARDEN_BASELINE_CHANGED', 3);
    assertAddOnly(again.remote.actions);
    const applied = transport.invoke(target, {
      mode: 'apply', cidrs: options.cidrs, sshPort: target.port, xrayPorts: ports,
      expectedFirewallHash: again.remote.firewallHash, expectedPreflightHash: again.remote.preflightFirewallHash ?? null
    });
    if (!applied.ok) throw new AdoptionError(applied.code || 'HARDEN_APPLY_FAILED', hardenExitCode(applied.code));
    assertAddOnly(applied.actions);
    const changed = applied.changed === true;
    return viewOf(options.nodeId, changed ? 'hardened' : 'unchanged', changed, applied, []);
  });
}

function inspectPlan(options: HardenCommand, target: SshTarget, probe: Probe, state: SavedState, ports: number[],
  transport: HardenTransport): { view: AdoptionResult; remote: HardenRemote; blockers: string[] } {
  const remote = transport.invoke(target, { mode: 'plan', cidrs: options.cidrs, sshPort: target.port, xrayPorts: ports });
  if (remote.ok === false) throw new AdoptionError(remote.code || 'HARDEN_REMOTE_FAILED', hardenExitCode(remote.code));
  const blockers = unique([...localBlockers(state, probe, ports), ...(Array.isArray(remote.blockers) ? remote.blockers : [])]);
  return { remote, blockers, view: viewOf(options.nodeId, 'planned', false, remote, blockers) };
}

function localBlockers(state: SavedState, probe: Probe, ports: number[]): string[] {
  const blockers: string[] = [];
  if (state.hash !== configDigest(probe.config)) blockers.push('REMOTE_BASELINE_CHANGED');
  if (probe.service !== 'active' || probe.diskMatchesRunning !== true) blockers.push('RUNNING_CONFIG_UNVERIFIED');
  if (!ports.length) blockers.push('HARDEN_XRAY_PORT_UNKNOWN');
  return blockers;
}

function assertAddOnly(actions: HardenAction[] | undefined): void {
  if (!Array.isArray(actions)) throw new AdoptionError('HARDEN_ACTION_FORBIDDEN', 3);
  for (const action of actions) {
    if (!action || typeof action.op !== 'string' || !allowedActions.has(action.op) || /delete|flush|remove|replace/i.test(action.op)) {
      throw new AdoptionError('HARDEN_ACTION_FORBIDDEN', 3);
    }
  }
}

function viewOf(nodeId: string, status: string, changed: boolean, remote: HardenRemote, blockers: string[]): AdoptionResult {
  const actions = Array.isArray(remote.actions) ? remote.actions.map(action => ({
    op: action.op, ...(action.backend ? { backend: action.backend } : {}),
    ...(Number.isInteger(action.port) ? { port: action.port } : {}),
    ...(typeof action.cidr === 'string' ? { cidr: action.cidr } : {})
  })) : [];
  return {
    schemaVersion: 'vpncp-result-v1', nodeId, operation: 'harden', status, changed,
    checkedAt: new Date().toISOString(), ssh: 'connected',
    backend: remote.backend ?? null, firewall: remote.firewall ?? 'unknown',
    policy: remote.policy ?? 'unknown', sshPort: remote.sshPort ?? null,
    xrayPorts: Array.isArray(remote.xrayPorts) ? remote.xrayPorts : [],
    cidrs: Array.isArray(remote.cidrs) ? remote.cidrs : [],
    sshSourceCovered: remote.sshSourceCovered === true,
    sshSourceRestricted: remote.sshSourceRestricted === true,
    sshKeyOnly: remote.sshKeyOnly ?? 'unknown', sandbox: remote.sandbox ?? 'unknown',
    cloudSecurityGroup: 'unchanged', fail2ban: 'not-enabled',
    fail2banReason: remote.fail2banReason ?? 'not-enabled',
    optionalNotApplied: remote.optionalNotApplied ?? [],
    notProductized: remote.notProductized ?? [],
    blockers, actions
  };
}

function baseResult(nodeId: string, status: string, changed: boolean, code: string): AdoptionResult {
  return { schemaVersion: 'vpncp-result-v1', nodeId, operation: 'harden', status, changed,
    checkedAt: new Date().toISOString(), ssh: 'connected', code, cloudSecurityGroup: 'unchanged',
    fail2ban: 'not-enabled', blockers: [code], actions: [] };
}

function readSavedState(directory: string, nodeId: string): SavedState {
  const path = join(directory, 'state.local.json');
  if (!existsSync(path)) throw new AdoptionError('SETUP_REQUIRED');
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new AdoptionError('LOCAL_STATE_INVALID');
  let state: SavedState;
  try { state = JSON.parse(readFileSync(path, 'utf8')) as SavedState; }
  catch { throw new AdoptionError('LOCAL_STATE_INVALID'); }
  if (state.schemaVersion !== 'vpncp-adoption-v1' || state.nodeId !== nodeId || !state.target || typeof state.hash !== 'string') {
    throw new AdoptionError('LOCAL_STATE_INVALID');
  }
  return state;
}

function unique(values: string[]): string[] {
  const result: string[] = [];
  for (const value of values) if (value && !result.includes(value)) result.push(value);
  return result;
}

function failCidr(code: string): never {
  throw new AdoptionError(code);
}

function ipv4Int(text: string): number {
  const parts = text.split('.');
  if (parts.length !== 4) failCidr('HARDEN_CIDR_INVALID');
  let value = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part) || (part.length > 1 && part.startsWith('0'))) failCidr('HARDEN_CIDR_INVALID');
    const number = Number(part);
    if (number > 255) failCidr('HARDEN_CIDR_INVALID');
    value = (value << 8) | number;
  }
  return value >>> 0;
}

function canonicalIpv6(address: string, prefix: number): string {
  if (prefix === 0) failCidr('HARDEN_CIDR_UNRESTRICTED');
  if (prefix < 1 || prefix > 128 || address.includes('.')) failCidr('HARDEN_CIDR_INVALID');
  const bits = 128n;
  const mask = ((1n << bits) - 1n) << BigInt(128 - prefix) & ((1n << bits) - 1n);
  const network = ipv6Int(address) & mask;
  const groups: string[] = [];
  for (let shift = 112; shift >= 0; shift -= 16) groups.push(((network >> BigInt(shift)) & 0xffffn).toString(16));
  return `${compressIpv6(groups)}/${prefix}`;
}

function ipv6Int(text: string): bigint {
  if (text.includes('.') || text.includes('%') || (text.match(/::/g) || []).length > 1) failCidr('HARDEN_CIDR_INVALID');
  const halves = text.toLowerCase().split('::');
  const expand = (part: string) => part ? part.split(':') : [];
  let groups: string[];
  if (halves.length === 2) {
    const left = expand(halves[0] ?? '');
    const right = expand(halves[1] ?? '');
    if (left.length + right.length > 7) failCidr('HARDEN_CIDR_INVALID');
    groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  } else groups = expand(text.toLowerCase());
  if (groups.length !== 8) failCidr('HARDEN_CIDR_INVALID');
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) failCidr('HARDEN_CIDR_INVALID');
    value = (value << 16n) + BigInt(parseInt(group, 16));
  }
  return value;
}

function compressIpv6(groups: string[]): string {
  let bestStart = -1;
  let bestLength = 0;
  let index = 0;
  while (index < 8) {
    if (groups[index] === '0') {
      let end = index;
      while (end < 8 && groups[end] === '0') end += 1;
      if (end - index > bestLength) {
        bestStart = index;
        bestLength = end - index;
      }
      index = end;
    } else index += 1;
  }
  if (bestLength < 2) return groups.join(':');
  const left = groups.slice(0, bestStart).join(':');
  const right = groups.slice(bestStart + bestLength).join(':');
  if (!left && !right) return '::';
  if (!left) return `::${right}`;
  if (!right) return `${left}::`;
  return `${left}::${right}`;
}
