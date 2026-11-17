import { spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createShadowrocketLink } from '../../exporters/src/shadowrocket-real.ts';
import { supportsFirstInstallPlatform, type LinuxEnvironment } from './linux-compatibility.ts';

export class AdoptionError extends Error {
  code: string;
  exitCode: number;
  details?: { stage: string; processExit?: number | null; systemCode?: string; errorType?: string; hresult?: number;
    reason?: string; missingCommands?: string[] };
  constructor(code: string, exitCode = 2) { super(code); this.code = code; this.exitCode = exitCode; }
}
export type SshTarget = { alias: string; host: string; port: number; user: string; hostKeyAlias?: string };
export type Probe = {
  linux?: LinuxEnvironment;
  loadState: string; service: string; user: string; group: string | null;
  version: string | null; configPath: string | null;
  permissions: { uid: number; gid: number; mode: string } | null;
  config: any; listeners: string[]; diskMatchesRunning: boolean; layout?: string;
  install?: import('./xray-install.ts').InstallInspection;
};
export interface AdoptionTransport {
  resolve(alias: string): SshTarget;
  probe(target: SshTarget): Probe;
}
function fail(code: string, exitCode = 2): never { throw new AdoptionError(code, exitCode); }
export function parseSshConfig(alias: string, output: string): SshTarget {
  const fields = new Map(output.split(/\r?\n/).map(line => {
    const split = line.indexOf(' ');
    return [line.slice(0, split), line.slice(split + 1).trim()];
  }));
  const host = fields.get('hostname') ?? '';
  const user = fields.get('user') ?? '';
  const port = Number(fields.get('port'));
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.:_-]*$/.test(host) || !/^[a-zA-Z_][a-zA-Z0-9_.-]*\$?$/.test(user)
      || !Number.isInteger(port) || port < 1 || port > 65535) fail('SSH_TARGET_INVALID');
  return { alias, host, user, port };
}
export const openSshTransport: AdoptionTransport = {
  resolve(alias) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(alias)) fail('SSH_ALIAS_INVALID');
    const result = spawnSync('ssh', ['-G', alias], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (result.status !== 0) fail('SSH_CONFIG_UNAVAILABLE', 4);
    return parseSshConfig(alias, result.stdout);
  },
  probe(target) {
    const script = (readFileSync(new URL('./install-preflight.py', import.meta.url), 'utf8') + '\n'
      + readFileSync(new URL('./xray-adoption-probe.py', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
    const result = spawnSync('ssh', [...sshTargetArgs(target),
      'if [ "$(id -u)" = 0 ]; then python3 -B -; elif command -v sudo >/dev/null && sudo -n true 2>/dev/null; then sudo -n env SSH_CONNECTION="$SSH_CONNECTION" python3 -B -; else echo \'{"ok":false,"code":"ROOT_OR_SUDO_REQUIRED"}\'; fi'],
      { input: script, encoding: 'utf8', windowsHide: true, timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
    if (result.status !== 0) fail(/Permission denied/i.test(result.stderr ?? '') ? 'SSH_AUTH_FAILED' : 'SSH_UNAVAILABLE', 4);
    let body;
    try { body = JSON.parse(result.stdout); } catch { fail('REMOTE_RESPONSE_INVALID', 4); }
    if (!body.ok) fail(body.code === 'ROOT_OR_SUDO_REQUIRED' ? 'ROOT_OR_SUDO_REQUIRED' : 'REMOTE_LAYOUT_OR_PERMISSION_UNAVAILABLE', 4);
    return body.probe;
  }
};
export function sshTargetArgs(target: SshTarget): string[] {
  return ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=10',
    ...(target.hostKeyAlias ? ['-o', `HostKeyAlias=${target.hostKeyAlias}`, '-o', 'UpdateHostKeys=no'] : []),
    '-o', `HostName=${target.host}`, '-p', String(target.port), '-l', target.user, target.alias];
}

// Files are protected before secret content is created. Existing symlinks are refused.
export function privateDirectory(path: string): void {
  assertNoLinks(path);
  if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) fail('PRIVATE_PATH_UNSAFE');
  try { mkdirSync(path, { recursive: true, mode: 0o700 }); }
  catch { storageFailure('directory-create'); }
  protectPrivatePath(path, true);
}
function protectPrivatePath(path: string, directory: boolean): void {
  if (process.platform === 'win32') {
    const acl = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      fileURLToPath(new URL('./protect-private-path.ps1', import.meta.url)), '-LiteralPath', path],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    let report;
    try { report = JSON.parse(acl.stdout ?? ''); } catch { /* fail closed below */ }
    if (acl.status !== 0 || report?.ok !== true || report.stage !== 'acl-verified') {
      const error = new AdoptionError('PRIVATE_ACL_UNAVAILABLE', 4);
      error.details = { stage: report?.stage === 'acl-verify' ? 'acl-verify' : 'acl-apply', processExit: acl.status,
        systemCode: acl.error && 'code' in acl.error ? String(acl.error.code) : undefined,
        errorType: typeof report?.errorType === 'string' && /^[\w.]+$/.test(report.errorType) ? report.errorType : undefined,
        hresult: typeof report?.hresult === 'number' ? report.hresult : undefined };
      throw error;
    }
  } else chmodSync(path, directory ? 0o700 : 0o600);
}
function storageFailure(stage: string): never {
  const error = new AdoptionError('PRIVATE_STORAGE_UNAVAILABLE', 4);
  error.details = { stage };
  throw error;
}
function assertNoLinks(path: string): void {
  for (let current = resolve(path); dirname(current) !== current; current = dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail('PRIVATE_PATH_UNSAFE');
  }
}
function exclusiveExport(path: string, data: string): void {
  assertNoLinks(path);
  // For custom paths, protect the new empty file before putting credentials in it.
  try { writeFileSync(path, '', { flag: 'wx', mode: 0o600 }); }
  catch { storageFailure('private-file-create'); }
  protectPrivatePath(path, false);
  try { writeFileSync(path, data, { mode: 0o600 }); }
  catch { storageFailure('private-file-write'); }
}
export function privateWrite(path: string, data: string, replace = false): void {
  privateDirectory(dirname(path));
  if (existsSync(path) && (!replace || lstatSync(path).isSymbolicLink())) fail('OUTPUT_EXISTS');
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    exclusiveExport(temporary, data);
    if (replace) {
      try { renameSync(temporary, path); } catch { storageFailure('state-commit'); }
    }
    else {
      // Exclusive destination prevents an accidental overwrite by concurrent exports.
      exclusiveExport(path, data);
    }
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
type State = { schemaVersion: string; nodeId: string; target: SshTarget; hash: string; probe: Probe };
export type AdoptionOptions = { command: 'setup' | 'status' | 'export' | 'endpoint'; nodeId: string; ssh?: string;
  expectedHost?: string; plan?: boolean; json?: boolean; out?: string; client?: string; to?: string };
export type AdoptionResult = { schemaVersion: string; nodeId: string; operation: string; status: string;
  changed: boolean; checkedAt: string; [key: string]: unknown };
const digest = (config: unknown) => createHash('sha256').update(JSON.stringify(config)).digest('hex');

// Shared by endpoint commits and exports, including the entire export probe.
function withNodeLock(directory: string, action: () => AdoptionResult): AdoptionResult {
  assertNoLinks(directory);
  const lock = join(directory, 'operation.lock');
  const owner = randomUUID();
  // All participating writers/recovery operators must acquire this coordinator
  // first. No timeout-based stealing: an orphan requires quiescent manual recovery.
  const guard = join(directory, 'operation.guard');
  try { mkdirSync(guard, { mode: 0o700 }); } catch { fail('NODE_BUSY', 3); }
  try { writeFileSync(lock, owner, { flag: 'wx', mode: 0o600 }); }
  catch {
    try { rmdirSync(guard); } catch { /* Preserve evidence; subsequent operations fail closed. */ }
    fail('NODE_BUSY', 3);
  }
  let result: AdoptionResult | undefined;
  try { result = action(); return result; }
  finally {
    let cleanupStage = 'isolate';
    try {
      assertNoLinks(lock);
      // Never unlink the shared pathname after checking its contents. Isolate it
      // while the coordinator excludes all protocol participants, then validate.
      const released = join(guard, 'released.lock');
      renameSync(lock, released);
      cleanupStage = 'verify-owner';
      assertNoLinks(released);
      if (readFileSync(released, 'utf8') !== owner) throw new Error('LOCK_OWNER_CHANGED');
      cleanupStage = 'remove-isolated';
      unlinkSync(released);
      // An out-of-protocol replacement at the canonical path is preserved.
      cleanupStage = 'verify-canonical';
      if (existsSync(lock)) throw new Error('LOCK_REPLACED');
      cleanupStage = 'release-guard';
      rmdirSync(guard);
    } catch {
      // Never turn a successful commit into a false "changed:false" exception.
      // Never remove a lock whose owner has changed.
      if (result) {
        result.status = result.changed ? 'completed-cleanup-failed' : 'cleanup-failed';
        result.code = 'NODE_LOCK_CLEANUP_FAILED';
        result.committed = result.changed;
        result.recoveryRequired = true;
        result.lockCleanupStage = cleanupStage;
      }
    }
  }
}

// Only a previously authorized endpoint can supersede a historical install target.
export function verifiedAdoptedTarget(nodeId: string, root: string, resolved: SshTarget,
  previous: SshTarget, transport: AdoptionTransport): SshTarget {
  const path = resolve(root, 'local/private/cli-nodes', nodeId, 'state.local.json');
  assertNoLinks(path);
  if (!existsSync(path)) fail('SSH_TARGET_CHANGED', 3);
  const original = readFileSync(path, 'utf8');
  let state: State;
  try { state = JSON.parse(original); } catch { fail('LOCAL_STATE_INVALID'); }
  if (state.schemaVersion !== 'vpncp-adoption-v1' || state.nodeId !== nodeId
      || state.target.alias !== resolved.alias || state.target.host !== resolved.host
      || state.target.user !== resolved.user || state.target.port !== resolved.port
      || previous.alias !== resolved.alias || previous.user !== resolved.user || previous.port !== resolved.port
      || state.target.hostKeyAlias !== (previous.hostKeyAlias ?? previous.host)) fail('SSH_TARGET_CHANGED', 3);
  const target = { ...resolved, hostKeyAlias: state.target.hostKeyAlias };
  const probe = transport.probe(target);
  if (!probe.config || digest(probe.config) !== state.hash) fail('REMOTE_BASELINE_CHANGED', 3);
  if (probe.service !== 'active' || !probe.diskMatchesRunning) fail('RUNNING_CONFIG_UNVERIFIED', 3);
  if (readFileSync(path, 'utf8') !== original) fail('LOCAL_STATE_CHANGED', 3);
  return target;
}

export function runAdoption(options: AdoptionOptions, root = '.', transport = openSshTransport): AdoptionResult {
  if (options.command === 'export') {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(options.nodeId)) fail('NODE_ID_INVALID');
    const directory = resolve(root, 'local/private/cli-nodes', options.nodeId);
    if (!existsSync(join(directory, 'state.local.json'))) fail('SETUP_REQUIRED');
    return withNodeLock(directory, () => runAdoptionLocked(options, root, transport));
  }
  return runAdoptionLocked(options, root, transport);
}

function runAdoptionLocked(options: AdoptionOptions, root: string, transport: AdoptionTransport): AdoptionResult {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(options.nodeId)) fail('NODE_ID_INVALID');
  if (options.to && options.to !== 'v2rayn') fail('EXPORT_FORMAT_UNSUPPORTED');
  const directory = resolve(root, 'local/private/cli-nodes', options.nodeId);
  const statePath = join(directory, 'state.local.json');
  assertNoLinks(statePath);
  let state: State | undefined;
  let originalState: string | undefined;
  if (existsSync(statePath)) {
    try { originalState = readFileSync(statePath, 'utf8'); state = JSON.parse(originalState); } catch { fail('LOCAL_STATE_INVALID'); }
    if (state?.schemaVersion !== 'vpncp-adoption-v1' || state.nodeId !== options.nodeId) fail('LOCAL_STATE_INVALID');
  }
  const resolved = transport.resolve(options.ssh ?? state?.target.alias ?? options.nodeId);
  const sameConnection = (a: SshTarget, b: SshTarget) =>
    a.alias === b.alias && a.host === b.host && a.user === b.user && a.port === b.port;
  const updating = options.command === 'endpoint';
  if (updating) {
    if (!state) fail('SETUP_REQUIRED');
    if (!options.expectedHost || resolved.host !== options.expectedHost) fail('ENDPOINT_CONFIRMATION_REQUIRED', 3);
    if (resolved.alias !== state.target.alias || resolved.user !== state.target.user || resolved.port !== state.target.port)
      fail('SSH_TARGET_CHANGED', 3);
  } else if (state && !sameConnection(resolved, state.target)) fail('SSH_TARGET_CHANGED', 3);
  // A changed address must authenticate against the original known_hosts name.
  // The override is retained for every subsequent probe; SSH config cannot replace it.
  const target: SshTarget = { ...resolved, ...(state?.target.hostKeyAlias || updating
    ? { hostKeyAlias: state?.target.hostKeyAlias ?? state!.target.host } : {}) };
  const probe = transport.probe(target);
  const result: AdoptionResult = { schemaVersion: 'vpncp-result-v1', nodeId: options.nodeId,
    operation: options.command, status: 'checked', changed: false, checkedAt: new Date().toISOString(),
    ssh: 'connected', sshAlias: target.alias, service: probe.service, version: probe.version, configPath: probe.configPath,
    serviceUser: probe.user, permissions: probe.permissions, listeners: probe.listeners,
    managed: Boolean(state), unverified: ['external-tcp', 'proxy-https', 'cloud-firewall'],
    clients: [] };
  if (probe.linux) {
    result.linux = probe.linux;
    result.supportLevels = { discovery: 'metadata', adoption: probe.layout === 'single-file' ? 'available' : 'layout-dependent',
      firstInstallPlatform: supportsFirstInstallPlatform(probe.linux.os, probe.linux.release),
      configurationChanges: 'not-implemented', recovery: 'owned-first-install-transactions-only' };
  }
  if (probe.loadState === 'not-found') return { ...result, status: 'not-installed', installed: false, code: 'XRAY_NOT_INSTALLED' };
  if (probe.layout !== 'single-file' || !probe.config) return { ...result, status: 'unsupported', code: 'LAYOUT_UNSUPPORTED' };
  const candidates = exportCandidates(probe.config);
  result.clients = candidates.map(item => item.ref);
  result.status = probe.service === 'active' ? (state ? 'managed' : 'installed-running') : 'installed-stopped';
  result.diskMatchesRunning = probe.diskMatchesRunning;
  if (options.command === 'status') return result;
  if (!candidates.length) fail('NO_SUPPORTED_CLIENT');
  const hash = digest(probe.config);
  if (options.command === 'setup') {
    if (options.plan) return { ...result, status: 'planned', action: state?.hash === hash ? 'unchanged' : 'adopt' };
    if (state?.hash === hash) {
      privateDirectory(directory);
      protectPrivatePath(statePath, false);
      return { ...result, status: 'unchanged' };
    }
    privateDirectory(directory);
    return withNodeLock(directory, () => {
      if (existsSync(statePath)) {
        const current: State = JSON.parse(readFileSync(statePath, 'utf8'));
        if (JSON.stringify(current.target) !== JSON.stringify(target)) fail('SSH_TARGET_CHANGED', 3);
      }
      const data = JSON.stringify({ schemaVersion: 'vpncp-adoption-v1', nodeId: options.nodeId, target, hash, probe } satisfies State);
      const snapshot = join(directory, `${hash}.snapshot.local.json`);
      if (!existsSync(snapshot)) privateWrite(snapshot, data);
      privateWrite(statePath, data, true);
      return { ...result, status: 'adopted', managed: true, changed: true };
    });
  }
  if (!state) fail('SETUP_REQUIRED');
  if (state.hash !== hash) fail('REMOTE_BASELINE_CHANGED', 3);
  if (probe.service !== 'active' || !probe.diskMatchesRunning) fail('RUNNING_CONFIG_UNVERIFIED', 3);
  if (updating) {
    // Only this single state file changes. The install journal and snapshots remain historical.
    const original = originalState!;
    if (readFileSync(statePath, 'utf8') !== original) fail('LOCAL_STATE_CHANGED', 3);
    return withNodeLock(directory, () => {
      if (readFileSync(statePath, 'utf8') !== original) fail('LOCAL_STATE_CHANGED', 3);
      if (!sameConnection(transport.resolve(target.alias), resolved)) fail('SSH_TARGET_CHANGED', 3);
      if (readFileSync(statePath, 'utf8') !== original) fail('LOCAL_STATE_CHANGED', 3);
      const backup = resolve(root, 'backups', `endpoint-${Date.now()}-${randomUUID()}`,
        'local/private/cli-nodes', options.nodeId, 'state.local.json');
      privateWrite(backup, original);
      privateWrite(statePath, JSON.stringify({ ...state, target }), true);
      return { ...result, status: 'endpoint-updated', changed: true };
    });
  }
  const selected = options.client ? candidates.find(item => item.ref === options.client) : candidates.length === 1 ? candidates[0] : undefined;
  if (!selected) fail(options.client ? 'CLIENT_NOT_FOUND' : 'CLIENT_SELECTION_REQUIRED');
  const { inbound, client } = selected;
  const reality = inbound.streamSettings.realitySettings;
  if (!Array.isArray(reality.serverNames) || reality.serverNames.length !== 1
      || !Array.isArray(reality.shortIds) || reality.shortIds.length !== 1) fail('REALITY_PARAMETERS_AMBIGUOUS');
  const sni = reality.serverNames[0];
  const shortId = reality.shortIds[0];
  if (typeof sni !== 'string' || !/^[a-zA-Z0-9.-]+$/.test(sni)
      || typeof shortId !== 'string' || !/^(?:[a-fA-F0-9]{2}){0,8}$/.test(shortId)) fail('REALITY_PARAMETERS_INVALID');
  if (client.flow && client.flow !== 'xtls-rprx-vision') fail('FLOW_UNSUPPORTED');
  const publicKey = realityPublicKey(reality.privateKey);
  if (!probe.listeners.some(address => address.endsWith(`:${inbound.port}`))) fail('INBOUND_NOT_LISTENING');
  const uri = createShadowrocketLink({ inboundIndex: 0, protocol: 'vless', network: 'tcp', security: 'reality',
    port: inbound.port, serverAddress: target.host, serverName: sni, shortId, publicKey,
    fingerprint: 'chrome', includeFlow: Boolean(client.flow), clients: [] },
    { displayName: options.nodeId, id: client.id, flow: client.flow },
    { sniMode: 'explicit', allowUseServerNamesFromConfig: false, includeFlow: Boolean(client.flow) });
  const output = resolve(options.out ?? join(directory, `${selected.ref}.vless.txt`));
  if (readFileSync(statePath, 'utf8') !== originalState) fail('LOCAL_STATE_CHANGED', 3);
  if (!sameConnection(transport.resolve(target.alias), resolved)) fail('SSH_TARGET_CHANGED', 3);
  assertNoLinks(output);
  if (existsSync(output) && !lstatSync(output).isSymbolicLink() && readFileSync(output, 'utf8') === `${uri}\n`) {
    protectPrivatePath(output, false);
    return { ...result, status: 'unchanged', outputFile: output, client: selected.ref };
  }
  if (existsSync(output)) fail('OUTPUT_EXISTS');
  if (!options.out) privateDirectory(directory);
  exclusiveExport(output, `${uri}\n`);
  return { ...result, status: 'exported', changed: true, outputFile: output, client: selected.ref,
    format: 'vless-uri', fingerprint: 'chrome' };
}
export function realityPublicKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) fail('REALITY_PRIVATE_KEY_INVALID');
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), Buffer.from(value, 'base64url')]), format: 'der', type: 'pkcs8' });
  return createPublicKey(key.export({ type: 'pkcs8', format: 'pem' }))
    .export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url');
}
function exportCandidates(config: any): Array<{ ref: string; inbound: any; client: any }> {
  const result = [];
  for (const [i, inbound] of (config.inbounds ?? []).entries()) {
    if (inbound.protocol !== 'vless' || inbound.streamSettings?.security !== 'reality'
        || (inbound.listen && ['127.0.0.1', '::1', 'localhost'].includes(inbound.listen))
        || !['tcp', 'raw'].includes(inbound.streamSettings?.network ?? 'tcp')
        || !Number.isInteger(inbound.port) || inbound.port < 1 || inbound.port > 65535) continue;
    for (const [j, client] of (inbound.settings?.clients ?? []).entries()) {
      if (typeof client.id === 'string' && /^[0-9a-f-]{36}$/i.test(client.id)) result.push({ ref: `inbound-${i + 1}-client-${j + 1}`, inbound, client });
    }
  }
  return result;
}
