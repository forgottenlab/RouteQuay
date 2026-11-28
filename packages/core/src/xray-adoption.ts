import { spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientConnectionSpec, defaultExportFileName, exportFormats, isExportFormat, validateClientExportFields, type ExportFormat } from '../../exporters/src/client-connection.ts';
import { renderClientExport } from '../../exporters/src/mihomo-yaml.ts';
import { renderVlessQrPng } from '../../exporters/src/vless-qr.ts';
import { applyGroupAction, emptyClientGroupFile, groupFileName, GroupStoreError, parseClientGroupFile, serializeClientGroupFile, type ClientGroupFile, type GroupMutation } from './client-groups.ts';
import { buildClientAppend, buildClientChangeScript, canonicalDigest, describeClientAppend, isLocalLabel, type ClientChangePayload } from './xray-client.ts';

type ExportBody = string | Buffer;
import { supportsFirstInstallPlatform, type LinuxEnvironment } from './linux-compatibility.ts';

export class AdoptionError extends Error {
  code: string;
  exitCode: number;
  details?: { stage: string; processExit?: number | null; systemCode?: string; errorType?: string; hresult?: number;
    reason?: string; missingCommands?: string[] };
  constructor(code: string, exitCode = 2) { super(code); this.code = code; this.exitCode = exitCode; }
}
export type SshTarget = { alias: string; host: string; port: number; user: string; hostKeyAlias?: string };
// Paths only. They are not part of the saved connection identity.
export type SshClientFiles = { configFile?: string; identityFile?: string };
export const SSH_CONFIG_MAX_BYTES = 256 * 1024;
export const SSH_IDENTITY_MAX_BYTES = 32 * 1024;
export type Probe = {
  linux?: LinuxEnvironment;
  loadState: string; service: string; user: string; group: string | null;
  version: string | null; configPath: string | null;
  permissions: { uid: number; gid: number; mode: string } | null;
  config: any; listeners: string[]; diskMatchesRunning: boolean; layout?: string;
  install?: import('./xray-install.ts').InstallInspection;
};
export type ClientApplyStatus = 'ROUTEQUAY_CLIENT_APPLIED' | 'ROUTEQUAY_CLIENT_RESTORED' | 'ROUTEQUAY_CLIENT_REFUSED' | 'ROUTEQUAY_CLIENT_ROLLBACK_FAILED';
export type ClientApplyResult = {
  status: ClientApplyStatus | 'UNRECOGNIZED';
  remoteExit?: number | null;
  errorType?: string;
};
export interface AdoptionTransport {
  resolve(alias: string): SshTarget;
  probe(target: SshTarget): Probe;
  applyClient?(target: SshTarget, payload: ClientChangePayload): ClientApplyResult;
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
function assertSshOperand(path: string | undefined, code: string, maxBytes: number, allowEmpty: boolean): void {
  if (path === undefined) return;
  if (typeof path !== 'string' || path.length < 1 || path.length > 240 || path !== path.trim() || path.startsWith('-')
      || /[\u0000-\u001f]/.test(path) || path.includes('://')) fail(code, 4);
  let stat;
  try { stat = lstatSync(path); }
  catch { fail(code, 4); }
  if (stat.isSymbolicLink() || !stat.isFile()) fail(code, 4);
  if (stat.size > maxBytes || (!allowEmpty && stat.size < 1)) fail(code, 4);
  if (code === 'SSH_IDENTITY_UNAVAILABLE' && process.platform !== 'win32' && (stat.mode & 0o077) !== 0) fail(code, 4);
}
// Stat only. File bytes are never read, returned, or logged.
export function assertSshClientFiles(files: SshClientFiles = {}): void {
  assertSshOperand(files.configFile, 'SSH_CONFIG_UNAVAILABLE', SSH_CONFIG_MAX_BYTES, true);
  assertSshOperand(files.identityFile, 'SSH_IDENTITY_UNAVAILABLE', SSH_IDENTITY_MAX_BYTES, false);
}
export function sshResolveArgs(alias: string, files: SshClientFiles = {}): string[] {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(alias)) fail('SSH_ALIAS_INVALID');
  return [...(files.configFile ? ['-F', files.configFile] : []), '-G', alias];
}
export function prepareSshResolve(alias: string, files: SshClientFiles = {}): string[] {
  const args = sshResolveArgs(alias, files);
  assertSshClientFiles(files);
  return args;
}
const remoteErrorPattern = /^ROUTEQUAY_CLIENT_ERROR ([A-Za-z_][A-Za-z0-9_]{0,63})$/;
function remoteErrorType(stderr: string): string | undefined {
  for (const line of stderr.split(/\r?\n/)) {
    const match = remoteErrorPattern.exec(line.trim());
    if (match?.[1]) return match[1];
  }
  return undefined;
}
// Stdout must be exactly one known marker. Only the exception class is kept from stderr.
export function readClientApplyResult(output: { stdout?: string | null; stderr?: string | null; status?: number | null }): ClientApplyResult {
  const marker = (output.stdout ?? '').trim();
  const allowed: ClientApplyStatus[] = ['ROUTEQUAY_CLIENT_APPLIED', 'ROUTEQUAY_CLIENT_RESTORED', 'ROUTEQUAY_CLIENT_REFUSED', 'ROUTEQUAY_CLIENT_ROLLBACK_FAILED'];
  const errorType = remoteErrorType(output.stderr ?? '');
  return {
    status: allowed.includes(marker as ClientApplyStatus) ? marker as ClientApplyStatus : 'UNRECOGNIZED',
    remoteExit: output.status ?? null,
    ...(errorType ? { errorType } : {})
  };
}
export function createOpenSshTransport(files: SshClientFiles = {}): AdoptionTransport {
  return {
    resolve(alias) {
      const args = prepareSshResolve(alias, files);
      const result = spawnSync('ssh', args, { encoding: 'utf8', windowsHide: true, timeout: 10000 });
      if (result.status !== 0) fail('SSH_CONFIG_UNAVAILABLE', 4);
      return parseSshConfig(alias, result.stdout);
    },
    probe(target) {
      const script = (readFileSync(new URL('./install-preflight.py', import.meta.url), 'utf8') + '\n'
        + readFileSync(new URL('./xray-adoption-probe.py', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
      const result = spawnSync('ssh', [...prepareSshConnect(target, files),
        'if [ "$(id -u)" = 0 ]; then python3 -B -; elif command -v sudo >/dev/null && sudo -n true 2>/dev/null; then sudo -n env SSH_CONNECTION="$SSH_CONNECTION" python3 -B -; else echo \'{"ok":false,"code":"ROOT_OR_SUDO_REQUIRED"}\'; fi'],
        { input: script, encoding: 'utf8', windowsHide: true, timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
      if (result.status !== 0) fail(/Permission denied/i.test(result.stderr ?? '') ? 'SSH_AUTH_FAILED' : 'SSH_UNAVAILABLE', 4);
      let body;
      try { body = JSON.parse(result.stdout); } catch { fail('REMOTE_RESPONSE_INVALID', 4); }
      if (!body.ok) fail(body.code === 'ROOT_OR_SUDO_REQUIRED' ? 'ROOT_OR_SUDO_REQUIRED' : 'REMOTE_LAYOUT_OR_PERMISSION_UNAVAILABLE', 4);
      return body.probe;
    },
    applyClient(target, payload) {
      const script = buildClientChangeScript(payload);
      if (!script) fail('TRANSACTION_ID_INVALID');
      const result = spawnSync('ssh', [...prepareSshConnect(target, files),
        'if [ "$(id -u)" = 0 ]; then bash -s; else sudo -n env SSH_CONNECTION="$SSH_CONNECTION" bash -s; fi'],
        { input: script, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 64 * 1024 });
      if (!(result.stdout ?? '').trim() && /Permission denied/i.test(result.stderr ?? '')) fail('SSH_AUTH_FAILED', 4);
      return readClientApplyResult(result);
    }
  };
}
export const openSshTransport = createOpenSshTransport();
// Command-line safety options are applied after -F, so the selected SSH config cannot relax them.
// -i sets IdentityFile as its own argument. The path is not saved on the adopted target.
export function sshTargetArgs(target: SshTarget, files: SshClientFiles = {}): string[] {
  return [...(files.configFile ? ['-F', files.configFile] : []),
    ...(files.identityFile ? ['-i', files.identityFile] : []),
    '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=10',
    ...(files.identityFile ? ['-o', 'IdentitiesOnly=yes'] : []),
    ...(target.hostKeyAlias ? ['-o', `HostKeyAlias=${target.hostKeyAlias}`, '-o', 'UpdateHostKeys=no'] : []),
    '-o', `HostName=${target.host}`, '-p', String(target.port), '-l', target.user, target.alias];
}
export function prepareSshConnect(target: SshTarget, files: SshClientFiles = {}): string[] {
  assertSshClientFiles(files);
  return sshTargetArgs(target, files);
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
function exclusiveExport(path: string, data: ExportBody): void {
  assertNoLinks(path);
  // For custom paths, protect the new empty file before putting credentials in it.
  try { writeFileSync(path, '', { flag: 'wx', mode: 0o600 }); }
  catch { storageFailure('private-file-create'); }
  protectPrivatePath(path, false);
  try { writeFileSync(path, data, { mode: 0o600 }); }
  catch { storageFailure('private-file-write'); }
}
function exportBodiesEqual(existing: Buffer, body: ExportBody): boolean {
  const next = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  return existing.length === next.length && existing.equals(next);
}
function commitExportFile(directory: string, output: string, body: ExportBody, customOut: boolean): 'unchanged' | 'exported' {
  assertNoLinks(output);
  if (existsSync(output) && !lstatSync(output).isSymbolicLink() && exportBodiesEqual(readFileSync(output), body)) {
    protectPrivatePath(output, false);
    return 'unchanged';
  }
  if (existsSync(output)) fail('OUTPUT_EXISTS');
  if (!customOut) privateDirectory(directory);
  exclusiveExport(output, body);
  return 'exported';
}
// Canonical bring-back files are the current local copies. Identical bytes stay
// in place and are re-protected. Different bytes are replaced. Symlinks are refused.
function replacePrivateFile(path: string, body: ExportBody): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const backup = `${path}.${randomUUID()}.bak`;
  try {
    exclusiveExport(temporary, body);
    if (process.platform === 'win32') {
      renameSync(path, backup);
      try { renameSync(temporary, path); }
      catch {
        try { if (!existsSync(path) && existsSync(backup)) renameSync(backup, path); } catch { /* Keep the backup if restore fails. */ }
        storageFailure('state-commit');
      }
      if (existsSync(backup)) unlinkSync(backup);
    } else renameSync(temporary, path);
    protectPrivatePath(path, false);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
function commitBringBackFile(output: string, body: ExportBody): 'unchanged' | 'exported' {
  assertNoLinks(output);
  if (existsSync(output)) {
    const current = lstatSync(output);
    if (current.isSymbolicLink() || !current.isFile()) fail('PRIVATE_PATH_UNSAFE');
    if (exportBodiesEqual(readFileSync(output), body)) {
      protectPrivatePath(output, false);
      return 'unchanged';
    }
    replacePrivateFile(output, body);
    return 'exported';
  }
  exclusiveExport(output, body);
  return 'exported';
}
function exportFormatLabel(format: ExportFormat): string {
  if (format === 'v2rayn') return 'vless-uri';
  if (format === 'vless-qr') return 'vless-qr-png';
  return format;
}
function renderExportBody(format: ExportFormat, spec: Parameters<typeof renderClientExport>[1]): ExportBody {
  return format === 'vless-qr' ? renderVlessQrPng(spec) : renderClientExport(format, spec);
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
export type AdoptionOptions = { command: 'setup' | 'status' | 'export' | 'endpoint' | 'pull' | 'add-client'; nodeId: string; ssh?: string;
  expectedHost?: string; plan?: boolean; apply?: boolean; json?: boolean; out?: string; client?: string; group?: string; to?: string; dataDir?: string;
  inbound?: string; name?: string; ownerLabel?: string; remark?: string; };
export type ClientGroupCommand = { nodeId: string; action: GroupMutation['action'] | 'list'; name?: string; newName?: string; client?: string; };
export type AdoptionResult = { schemaVersion: string; nodeId: string; operation: string; status: string;
  changed: boolean; checkedAt: string; [key: string]: unknown };
export function configDigest(config: unknown): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

// Shared by endpoint commits and exports, including the entire export probe.
export function withNodeLock(directory: string, action: () => AdoptionResult): AdoptionResult {
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
  if (!probe.config || configDigest(probe.config) !== state.hash) fail('REMOTE_BASELINE_CHANGED', 3);
  if (probe.service !== 'active' || !probe.diskMatchesRunning) fail('RUNNING_CONFIG_UNVERIFIED', 3);
  if (readFileSync(path, 'utf8') !== original) fail('LOCAL_STATE_CHANGED', 3);
  return target;
}

export function runAdoption(options: AdoptionOptions, root = '.', transport = openSshTransport): AdoptionResult {
  if (options.command === 'export' || options.command === 'pull' || options.command === 'add-client') {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(options.nodeId)) fail('NODE_ID_INVALID');
    const directory = resolve(root, 'local/private/cli-nodes', options.nodeId);
    if (!existsSync(join(directory, 'state.local.json'))) fail('SETUP_REQUIRED');
    if (options.command === 'add-client' && options.plan) return runAdoptionLocked(options, root, transport);
    return withNodeLock(directory, () => runAdoptionLocked(options, root, transport));
  }
  return runAdoptionLocked(options, root, transport);
}

function runAdoptionLocked(options: AdoptionOptions, root: string, transport: AdoptionTransport): AdoptionResult {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(options.nodeId)) fail('NODE_ID_INVALID');
  if (options.command === 'export') {
    if (options.to && !isExportFormat(options.to)) fail('EXPORT_FORMAT_UNSUPPORTED');
  } else if (options.command !== 'pull' && options.to && options.to !== 'v2rayn') fail('EXPORT_FORMAT_UNSUPPORTED');
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
  if (probe.loadState === 'not-found') {
    const early = { ...result, status: 'not-installed', installed: false, code: 'XRAY_NOT_INSTALLED' };
    return options.command === 'status' ? withLocalGroups(early, directory, options.nodeId) : early;
  }
  if (probe.layout !== 'single-file' || !probe.config) {
    const early = { ...result, status: 'unsupported', code: 'LAYOUT_UNSUPPORTED' };
    return options.command === 'status' ? withLocalGroups(early, directory, options.nodeId) : early;
  }
  const candidates = exportCandidates(probe.config);
  result.clients = candidates.map(item => item.ref);
  result.status = probe.service === 'active' ? (state ? 'managed' : 'installed-running') : 'installed-stopped';
  result.diskMatchesRunning = probe.diskMatchesRunning;
  if (options.command === 'status') return withLocalGroups(result, directory, options.nodeId);
  if (options.command === 'add-client') {
    return completeAddClient({ options, root, transport, directory, statePath, state, originalState, target, resolved, probe, result, sameConnection });
  }
  if (!candidates.length) fail('NO_SUPPORTED_CLIENT');
  const hash = configDigest(probe.config);
  if (options.command === 'setup') {
    if (options.plan) return { ...result, status: 'planned', action: state?.hash === configDigest(probe.config) ? 'unchanged' : 'adopt' };
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
  if (state.hash !== configDigest(probe.config)) fail('REMOTE_BASELINE_CHANGED', 3);
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
  if (options.client && options.group) fail('CONFLICTING_OPTIONS');
  const exportFormat = options.to ?? 'v2rayn';
  if (!isExportFormat(exportFormat)) fail('EXPORT_FORMAT_UNSUPPORTED');
  const groupedRefs = options.group ? groupMemberRefs(directory, options.nodeId, options.group) : undefined;
  const selectedList = groupedRefs
    ? groupedRefs.map(ref => {
      const found = candidates.find(item => item.ref === ref);
      if (!found) fail('CLIENT_NOT_FOUND');
      return found;
    })
    : [options.client ? candidates.find(item => item.ref === options.client) : candidates.length === 1 ? candidates[0] : undefined];
  if (selectedList.some(item => !item)) fail(options.client ? 'CLIENT_NOT_FOUND' : 'CLIENT_SELECTION_REQUIRED');
  const chosen = selectedList as Array<{ ref: string; inbound: any; client: any }>;
  const specs = chosen.map(item => ({ ref: item.ref, spec: connectionSpec(options.nodeId, target.host, probe, item) }));
  if (readFileSync(statePath, 'utf8') !== originalState) fail('LOCAL_STATE_CHANGED', 3);
  if (!sameConnection(transport.resolve(target.alias), resolved)) fail('SSH_TARGET_CHANGED', 3);
  if (options.group) {
    const membership = { group: options.group, members: specs.map(item => item.ref) };
    if (options.command === 'pull') {
      const targetDirectory = options.out ? resolve(options.out) : directory;
      for (const item of specs) {
        for (const format of exportFormats) assertNoLinks(resolve(join(targetDirectory, defaultExportFileName(item.ref, format))));
      }
      const parts = specs.map(item => writeBringBackFiles(directory, options.out, item.ref, item.spec));
      const outputFiles = parts.flatMap(part => part.outputFiles);
      return { ...result, status: parts.some(part => part.changed) ? 'exported' : 'unchanged',
        changed: parts.some(part => part.changed), outputFiles, outputDirectory: parts[0]?.outputDirectory,
        ...membership, formats: [...new Set(parts.flatMap(part => part.formats))], fingerprint: 'chrome' };
    }
    const wrote = writeGroupExport(directory, options.out, exportFormat, specs);
    return { ...result, status: wrote.changed ? 'exported' : 'unchanged', changed: wrote.changed,
      outputFiles: wrote.outputFiles, outputDirectory: wrote.outputDirectory, ...membership,
      format: exportFormatLabel(exportFormat), fingerprint: 'chrome' };
  }
  const selected = chosen[0]!;
  const spec = specs[0]!.spec;
  if (options.command === 'pull') {
    const wrote = writeBringBackFiles(directory, options.out, selected.ref, spec);
    return { ...result, status: wrote.changed ? 'exported' : 'unchanged', changed: wrote.changed, outputFile: wrote.outputFile,
      outputFiles: wrote.outputFiles, outputDirectory: wrote.outputDirectory, client: selected.ref,
      formats: wrote.formats, fingerprint: 'chrome' };
  }
  const body = renderExportBody(exportFormat, spec);
  const output = resolve(options.out ?? join(directory, defaultExportFileName(selected.ref, exportFormat)));
  const wrote = commitExportFile(directory, output, body, Boolean(options.out));
  return { ...result, status: wrote, changed: wrote === 'exported', outputFile: output, client: selected.ref,
    format: exportFormatLabel(exportFormat), fingerprint: 'chrome' };
}
type ClientSpec = ReturnType<typeof clientConnectionSpec>;
function writeBringBackFiles(directory: string, out: string | undefined, ref: string, spec: ClientSpec): {
  changed: boolean; outputFile?: string; outputFiles: Array<{ format: string; path: string; status: string }>;
  outputDirectory: string; formats: string[];
} {
  const targetDirectory = out ? resolve(out) : directory;
  if (out) {
    assertNoLinks(targetDirectory);
    if (!existsSync(targetDirectory)) fail('OUTPUT_DIRECTORY_MISSING');
    const current = lstatSync(targetDirectory);
    if (current.isSymbolicLink() || !current.isDirectory()) fail('PRIVATE_PATH_UNSAFE');
  }
  privateDirectory(targetDirectory);
  const planned = exportFormats.map(format => ({
    format,
    output: resolve(join(targetDirectory, defaultExportFileName(ref, format))),
    body: renderExportBody(format, spec)
  }));
  for (const file of planned) assertNoLinks(file.output);
  const outputFiles = planned.map(file => ({
    format: exportFormatLabel(file.format),
    path: file.output,
    status: commitBringBackFile(file.output, file.body)
  }));
  return { changed: outputFiles.some(file => file.status === 'exported'),
    outputFile: outputFiles.find(file => file.format === 'vless-uri')?.path, outputFiles,
    outputDirectory: targetDirectory, formats: outputFiles.map(file => file.format) };
}
function connectionSpec(nodeId: string, server: string, probe: Probe, selected: { ref: string; inbound: any; client: any }): ClientSpec {
  const { inbound, client } = selected;
  const reality = inbound.streamSettings?.realitySettings && typeof inbound.streamSettings.realitySettings === 'object'
    ? inbound.streamSettings.realitySettings : {};
  const fields = validateClientExportFields({
    network: inbound.streamSettings?.network ?? 'tcp',
    flow: client.flow,
    serverNames: reality.serverNames,
    shortIds: reality.shortIds,
    decryption: inbound.settings?.decryption
  });
  if (!fields.ok) fail(fields.code);
  const publicKey = realityPublicKey(reality.privateKey);
  if (!probe.listeners.some((address: string) => address.endsWith(`:${inbound.port}`))) fail('INBOUND_NOT_LISTENING');
  return clientConnectionSpec({
    nodeId, clientRef: selected.ref, server, port: inbound.port, uuid: client.id,
    publicKey, network: fields.network, flow: fields.flow, serverName: fields.serverName, shortId: fields.shortId,
    encryption: fields.encryption
  });
}
function exportDisposition(output: string, body: ExportBody): 'unchanged' | 'new' {
  assertNoLinks(output);
  if (!existsSync(output)) return 'new';
  const current = lstatSync(output);
  if (current.isSymbolicLink() || !current.isFile()) fail('PRIVATE_PATH_UNSAFE');
  if (exportBodiesEqual(readFileSync(output), body)) return 'unchanged';
  fail('OUTPUT_EXISTS');
}
function writeGroupExport(directory: string, out: string | undefined, format: ExportFormat, specs: Array<{ ref: string; spec: ClientSpec }>): {
  changed: boolean; outputFiles: Array<{ format: string; path: string; status: string }>; outputDirectory: string;
} {
  const customOut = Boolean(out);
  const outputDirectory = customOut ? resolve(out!) : directory;
  if (customOut) {
    assertNoLinks(outputDirectory);
    if (!existsSync(outputDirectory)) fail('OUTPUT_DIRECTORY_MISSING');
    const current = lstatSync(outputDirectory);
    if (current.isSymbolicLink() || !current.isDirectory()) fail('PRIVATE_PATH_UNSAFE');
    privateDirectory(outputDirectory);
  }
  const planned = specs.map(item => ({
    output: resolve(join(outputDirectory, defaultExportFileName(item.ref, format))),
    body: renderExportBody(format, item.spec)
  }));
  for (const file of planned) exportDisposition(file.output, file.body);
  const outputFiles = planned.map(file => ({
    format: exportFormatLabel(format),
    path: file.output,
    status: commitExportFile(directory, file.output, file.body, customOut)
  }));
  return { changed: outputFiles.some(file => file.status === 'exported'), outputFiles, outputDirectory };
}
const metadataSchema = 'routequay-client-metadata-v1';
const journalSchema = 'routequay-client-change-v1';
const clientRefPattern = /^inbound-[1-9]\d*-client-[1-9]\d*$/;
type ClientMetaEntry = { ref: string; ownerLabel?: string; remark?: string };
type ClientMetadata = { schemaVersion: typeof metadataSchema; nodeId: string; clients: ClientMetaEntry[] };
type ClientJournal = { schemaVersion: typeof journalSchema; id: string; nodeId: string; baselineCanonical: string;
  expectedCanonical: string; inboundIndex: number; clientIndex: number; configPath: string; port: number };
function labelText(value: string | undefined, code: string): string | undefined {
  if (value === undefined) return undefined;
  if (!isLocalLabel(value)) fail(code);
  return value;
}
function readClientMetadata(path: string, nodeId: string): ClientMetadata | undefined {
  if (!existsSync(path)) return undefined;
  assertNoLinks(path);
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch { fail('METADATA_INVALID'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('METADATA_INVALID');
  const input = parsed as Record<string, unknown>;
  if (Object.keys(input).some(key => !['schemaVersion', 'nodeId', 'clients'].includes(key))) fail('METADATA_INVALID');
  if (input.schemaVersion !== metadataSchema || input.nodeId !== nodeId || !Array.isArray(input.clients)) fail('METADATA_INVALID');
  const clients: ClientMetaEntry[] = [];
  for (const item of input.clients) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('METADATA_INVALID');
    const entry = item as Record<string, unknown>;
    if (Object.keys(entry).some(key => !['ref', 'ownerLabel', 'remark'].includes(key))) fail('METADATA_INVALID');
    if (typeof entry.ref !== 'string' || !clientRefPattern.test(entry.ref)) fail('METADATA_INVALID');
    const stored: ClientMetaEntry = { ref: entry.ref };
    if (entry.ownerLabel !== undefined) {
      if (typeof entry.ownerLabel !== 'string' || !isLocalLabel(entry.ownerLabel)) fail('METADATA_INVALID');
      stored.ownerLabel = entry.ownerLabel;
    }
    if (entry.remark !== undefined) {
      if (typeof entry.remark !== 'string' || !isLocalLabel(entry.remark)) fail('METADATA_INVALID');
      stored.remark = entry.remark;
    }
    if (!stored.ownerLabel && !stored.remark) fail('METADATA_INVALID');
    clients.push(stored);
  }
  return { schemaVersion: metadataSchema, nodeId, clients };
}
function storeClientMetadata(path: string, nodeId: string, ref: string, ownerLabel?: string, remark?: string): string | undefined {
  if (!ownerLabel && !remark) return undefined;
  const current = readClientMetadata(path, nodeId) ?? { schemaVersion: metadataSchema, nodeId, clients: [] };
  const entry: ClientMetaEntry = { ref, ...(ownerLabel ? { ownerLabel } : {}), ...(remark ? { remark } : {}) };
  const clients = [...current.clients.filter(item => item.ref !== ref), entry];
  privateWrite(path, `${JSON.stringify({ schemaVersion: metadataSchema, nodeId, clients })}\n`, true);
  return path;
}
function readClientJournal(path: string, nodeId: string): ClientJournal | undefined {
  if (!existsSync(path)) return undefined;
  assertNoLinks(path);
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch { fail('CLIENT_CHANGE_RECOVERY_REQUIRED', 3); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('CLIENT_CHANGE_RECOVERY_REQUIRED', 3);
  const input = parsed as Record<string, unknown>;
  const keys = ['schemaVersion', 'id', 'nodeId', 'baselineCanonical', 'expectedCanonical', 'inboundIndex', 'clientIndex', 'configPath', 'port'];
  if (Object.keys(input).some(key => !keys.includes(key))) fail('CLIENT_CHANGE_RECOVERY_REQUIRED', 3);
  const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (input.schemaVersion !== journalSchema || input.nodeId !== nodeId || typeof input.id !== 'string' || !/^[a-f0-9]{32}$/.test(input.id)
      || !hash(input.baselineCanonical) || !hash(input.expectedCanonical)
      || !Number.isInteger(input.inboundIndex) || Number(input.inboundIndex) < 0
      || !Number.isInteger(input.clientIndex) || Number(input.clientIndex) < 0
      || typeof input.configPath !== 'string' || !input.configPath.startsWith('/')
      || !Number.isInteger(input.port) || Number(input.port) < 1 || Number(input.port) > 65535) {
    fail('CLIENT_CHANGE_RECOVERY_REQUIRED', 3);
  }
  return input as ClientJournal;
}
function removeClientJournal(path: string): void {
  if (!existsSync(path)) return;
  assertNoLinks(path);
  unlinkSync(path);
}
function remoteConfigPath(probe: Probe): string {
  if (typeof probe.configPath !== 'string' || !probe.configPath.startsWith('/') || probe.configPath.length > 240
      || /[\u0000-\u001f]/.test(probe.configPath)) fail('LAYOUT_UNSUPPORTED');
  return probe.configPath;
}
function clientSpec(nodeId: string, target: SshTarget, probe: Probe, inboundIndex: number, clientIndex: number, ref: string): ClientSpec {
  const config = probe.config;
  const inbound = config?.inbounds?.[inboundIndex];
  const client = inbound?.settings?.clients?.[clientIndex];
  if (!inbound || !client || typeof client.id !== 'string') fail('CLIENT_CHANGE_UNVERIFIED', 3);
  const reality = inbound.streamSettings?.realitySettings && typeof inbound.streamSettings.realitySettings === 'object'
    ? inbound.streamSettings.realitySettings : {};
  const fields = validateClientExportFields({
    network: inbound.streamSettings?.network ?? 'tcp', flow: client.flow, serverNames: reality.serverNames,
    shortIds: reality.shortIds, decryption: inbound.settings?.decryption
  });
  if (!fields.ok) fail(fields.code);
  if (!probe.listeners.some(address => address.endsWith(`:${inbound.port}`))) fail('INBOUND_NOT_LISTENING');
  return clientConnectionSpec({
    nodeId, clientRef: ref, server: target.host, port: inbound.port, uuid: client.id,
    publicKey: realityPublicKey(reality.privateKey), network: fields.network, flow: fields.flow,
    serverName: fields.serverName, shortId: fields.shortId, encryption: fields.encryption
  });
}
function rememberAdoptedConfig(directory: string, statePath: string, nodeId: string, target: SshTarget, probe: Probe): void {
  const hash = configDigest(probe.config);
  const data = JSON.stringify({ schemaVersion: 'vpncp-adoption-v1', nodeId, target, hash, probe } satisfies State);
  const snapshot = join(directory, `${hash}.snapshot.local.json`);
  if (!existsSync(snapshot)) privateWrite(snapshot, data);
  privateWrite(statePath, data, true);
}
type AddClientContext = { options: AdoptionOptions; root: string; transport: AdoptionTransport; directory: string;
  statePath: string; state: State | undefined; originalState: string | undefined; target: SshTarget; resolved: SshTarget;
  probe: Probe; result: AdoptionResult; sameConnection: (a: SshTarget, b: SshTarget) => boolean };
function completeAddClient(input: AddClientContext): AdoptionResult {
  const { options, transport, directory, statePath, state, originalState, target, resolved, probe, result, sameConnection } = input;
  if (!state || !originalState) fail('SETUP_REQUIRED');
  if (result.supportLevels && typeof result.supportLevels === 'object') {
    (result.supportLevels as { configurationChanges: string }).configurationChanges = 'append-vless-client';
  }
  const ownerLabel = labelText(options.ownerLabel, 'CLIENT_LABEL_INVALID');
  const remark = labelText(options.remark, 'CLIENT_LABEL_INVALID');
  const metadataPath = join(directory, 'clients.local.json');
  const journalPath = join(directory, 'client-change.local.json');
  const journal = readClientJournal(journalPath, options.nodeId);
  const currentCanonical = canonicalDigest(probe.config);
  const finishRef = journal ? `inbound-${journal.inboundIndex + 1}-client-${journal.clientIndex + 1}` : undefined;
  if (journal && journal.expectedCanonical === currentCanonical && finishRef) {
    if (options.plan) {
      return { ...result, status: 'planned', changed: false, client: finishRef, plan: {
        action: 'finish-client', inbound: `inbound-${journal.inboundIndex + 1}`, client: finishRef,
        preservesExistingClients: true, rotatesReality: false, changesMinClientVer: false } };
    }
    if (!options.apply) fail('CLIENT_APPROVAL_REQUIRED');
    return finishLandedClient(input, journal, probe, metadataPath, journalPath, ownerLabel, remark);
  }
  if (journal && journal.baselineCanonical !== currentCanonical) fail('CLIENT_CHANGE_RECOVERY_REQUIRED', 3);
  if (configDigest(probe.config) !== state.hash) fail('REMOTE_BASELINE_CHANGED', 3);
  const described = describeClientAppend(probe.config, { inbound: options.inbound, name: options.name });
  if (!described.ok) fail(described.code);
  const plan = { action: 'add-client', inbound: described.selection.inboundRef, client: described.selection.clientRef,
    preservesExistingClients: true, rotatesReality: false, changesMinClientVer: false };
  if (options.plan) return { ...result, status: 'planned', changed: false, client: described.selection.clientRef, plan };
  if (!options.apply) fail('CLIENT_APPROVAL_REQUIRED');
  if (probe.service !== 'active' || !probe.diskMatchesRunning) fail('RUNNING_CONFIG_UNVERIFIED', 3);
  readClientMetadata(metadataPath, options.nodeId);
  const configPath = remoteConfigPath(probe);
  const inbound = probe.config.inbounds[described.selection.inboundIndex];
  if (!probe.listeners.some((address: string) => address.endsWith(`:${inbound.port}`))) fail('INBOUND_NOT_LISTENING');
  if (readFileSync(statePath, 'utf8') !== originalState) fail('LOCAL_STATE_CHANGED', 3);
  if (!sameConnection(transport.resolve(target.alias), resolved)) fail('SSH_TARGET_CHANGED', 3);
  const built = buildClientAppend(probe.config, { inbound: options.inbound, name: options.name });
  if (!built.ok) fail(built.code);
  if (journal) removeClientJournal(journalPath);
  const jobId = randomUUID().replaceAll('-', '');
  const nextJournal: ClientJournal = { schemaVersion: journalSchema, id: jobId, nodeId: options.nodeId,
    baselineCanonical: currentCanonical, expectedCanonical: built.plan.canonicalHash,
    inboundIndex: built.plan.inboundIndex, clientIndex: built.plan.clientIndex, configPath, port: inbound.port };
  privateWrite(journalPath, JSON.stringify(nextJournal), true);
  const again = transport.probe(target);
  if (canonicalDigest(again.config) !== currentCanonical) fail('REMOTE_BASELINE_CHANGED', 3);
  if (!transport.applyClient) fail('CLIENT_CHANGE_UNSUPPORTED', 4);
  const payload: ClientChangePayload = { jobId, inboundIndex: built.plan.inboundIndex, port: inbound.port, configPath,
    baseline: structuredClone(probe.config), next: built.plan.next };
  const applied = transport.applyClient(target, payload);
  const fresh = transport.probe(target);
  const freshCanonical = canonicalDigest(fresh.config);
  if (applied.status === 'ROUTEQUAY_CLIENT_APPLIED' && freshCanonical === built.plan.canonicalHash) {
    return finishLandedClient(input, nextJournal, fresh, metadataPath, journalPath, ownerLabel, remark);
  }
  if ((applied.status === 'ROUTEQUAY_CLIENT_RESTORED' || applied.status === 'ROUTEQUAY_CLIENT_REFUSED') && freshCanonical === currentCanonical) {
    removeClientJournal(journalPath);
    fail(applied.status === 'ROUTEQUAY_CLIENT_REFUSED' ? 'CLIENT_CHANGE_REFUSED' : 'CLIENT_CHANGE_RESTORED',
      applied.status === 'ROUTEQUAY_CLIENT_REFUSED' ? 3 : 4);
  }
  if (applied.status === 'ROUTEQUAY_CLIENT_ROLLBACK_FAILED') {
    if (freshCanonical === currentCanonical) removeClientJournal(journalPath);
    failClientApply('CLIENT_CHANGE_ROLLBACK_FAILED', applied);
  }
  failClientApply('CLIENT_CHANGE_UNKNOWN', applied);
}
function failClientApply(code: string, applied: ClientApplyResult): never {
  const error = new AdoptionError(code, 4);
  const parts = [`remote ${applied.status}`];
  if (applied.errorType) parts.push(applied.errorType);
  if (typeof applied.remoteExit === 'number') parts.push(`exit ${applied.remoteExit}`);
  error.details = {
    stage: 'apply-client',
    ...(applied.remoteExit !== undefined ? { processExit: applied.remoteExit } : {}),
    ...(applied.errorType ? { errorType: applied.errorType } : {}),
    reason: parts.join(' · ')
  };
  throw error;
}
function finishLandedClient(input: AddClientContext, journal: ClientJournal, probe: Probe, metadataPath: string,
  journalPath: string, ownerLabel?: string, remark?: string): AdoptionResult {
  const { options, directory, statePath, target, result } = input;
  const ref = `inbound-${journal.inboundIndex + 1}-client-${journal.clientIndex + 1}`;
  rememberAdoptedConfig(directory, statePath, options.nodeId, target, probe);
  let metadataFile: string | undefined;
  try { metadataFile = storeClientMetadata(metadataPath, options.nodeId, ref, ownerLabel, remark); }
  catch (error) {
    if (!(error instanceof AdoptionError)) throw error;
    return { ...result, status: 'client-added-local-handoff-failed', changed: true, code: 'CLIENT_LOCAL_HANDOFF_FAILED',
      localHandoffCode: error.code, client: ref };
  }
  result.service = probe.service;
  result.diskMatchesRunning = probe.diskMatchesRunning;
  result.listeners = probe.listeners;
  result.version = probe.version;
  result.clients = exportCandidates(probe.config).map(item => item.ref);
  result.client = ref;
  result.managed = true;
  result.changed = true;
  if (probe.service !== 'active' || !probe.diskMatchesRunning) {
    return { ...result, status: 'client-added-local-handoff-failed', code: 'RUNNING_CONFIG_UNVERIFIED',
      localHandoffCode: 'RUNNING_CONFIG_UNVERIFIED', ...(metadataFile ? { metadataFile } : {}) };
  }
  try {
    const spec = clientSpec(options.nodeId, target, probe, journal.inboundIndex, journal.clientIndex, ref);
    const wrote = writeBringBackFiles(directory, undefined, ref, spec);
    removeClientJournal(journalPath);
    return { ...result, status: 'client-added', outputFile: wrote.outputFile, outputFiles: wrote.outputFiles,
      outputDirectory: wrote.outputDirectory, formats: wrote.formats, fingerprint: 'chrome',
      ...(metadataFile ? { metadataFile } : {}) };
  } catch (error) {
    return { ...result, status: 'client-added-local-handoff-failed', code: 'CLIENT_LOCAL_HANDOFF_FAILED',
      localHandoffCode: error instanceof AdoptionError ? error.code : 'LOCAL_OPERATION_FAILED',
      ...(metadataFile ? { metadataFile } : {}) };
  }
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
function groupPathFor(directory: string): string {
  return join(directory, groupFileName);
}
function storedGroups(path: string, nodeId: string): ClientGroupFile {
  assertNoLinks(path);
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return emptyClientGroupFile(nodeId);
    fail('GROUP_STORE_INVALID');
  }
  if (stat.isSymbolicLink()) fail('PRIVATE_PATH_UNSAFE');
  if (!stat.isFile() || stat.size < 1 || stat.size > 64 * 1024) fail('GROUP_STORE_INVALID');
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
  catch { fail('GROUP_STORE_INVALID'); }
  try { return parseClientGroupFile(parsed, nodeId); }
  catch (error) {
    if (error instanceof GroupStoreError) fail(error.code);
    throw error;
  }
}
function writeStoredGroups(path: string, file: ClientGroupFile): void {
  assertNoLinks(path);
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) fail('PRIVATE_PATH_UNSAFE');
  } catch (error) {
    if (!(error instanceof AdoptionError) && !(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
      fail('GROUP_STORE_INVALID');
    }
    if (error instanceof AdoptionError) throw error;
  }
  privateWrite(path, serializeClientGroupFile(file), true);
}
function withLocalGroups(result: AdoptionResult, directory: string, nodeId: string): AdoptionResult {
  return { ...result, groups: storedGroups(groupPathFor(directory), nodeId).groups };
}
function groupMemberRefs(directory: string, nodeId: string, name: string): string[] {
  const found = storedGroups(groupPathFor(directory), nodeId).groups.find(group => group.name === name);
  if (!found) fail('GROUP_NOT_FOUND');
  if (!found.members.length) fail('GROUP_EMPTY');
  return [...found.members];
}
function knownClientRefs(state: State): Set<string> {
  return new Set(exportCandidates(state.probe?.config ?? {}).map(item => item.ref));
}
export function runClientGroups(command: ClientGroupCommand, root = '.'): AdoptionResult {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(command.nodeId)) fail('NODE_ID_INVALID');
  const directory = resolve(root, 'local/private/cli-nodes', command.nodeId);
  const statePath = join(directory, 'state.local.json');
  const groupPath = groupPathFor(directory);
  assertNoLinks(statePath);
  if (!existsSync(statePath)) fail('SETUP_REQUIRED');
  const originalState = readFileSync(statePath, 'utf8');
  let state: State;
  try { state = JSON.parse(originalState); }
  catch { fail('LOCAL_STATE_INVALID'); }
  if (state.schemaVersion !== 'vpncp-adoption-v1' || state.nodeId !== command.nodeId) fail('LOCAL_STATE_INVALID');
  const knownRefs = knownClientRefs(state);
  const base: AdoptionResult = { schemaVersion: 'vpncp-result-v1', nodeId: command.nodeId, operation: 'group',
    action: command.action, status: 'listed', changed: false, checkedAt: new Date().toISOString() };
  if (command.action === 'list') {
    const stored = storedGroups(groupPath, command.nodeId);
    let present = false;
    try { present = lstatSync(groupPath).isFile() && !lstatSync(groupPath).isSymbolicLink(); }
    catch { present = false; }
    return { ...base, groups: stored.groups, ...(present ? { groupFile: groupPath } : {}) };
  }
  if (!command.name) fail('USAGE');
  const name = command.name;
  return withNodeLock(directory, () => {
    if (readFileSync(statePath, 'utf8') !== originalState) fail('LOCAL_STATE_CHANGED', 3);
    const stored = storedGroups(groupPath, command.nodeId);
    let applied: ReturnType<typeof applyGroupAction>;
    try {
      applied = applyGroupAction(stored, {
        action: command.action as GroupMutation['action'], name, newName: command.newName, client: command.client, knownRefs
      });
    } catch (error) {
      if (error instanceof GroupStoreError) fail(error.code);
      throw error;
    }
    if (applied.changed) writeStoredGroups(groupPath, applied.file);
    if (readFileSync(statePath, 'utf8') !== originalState) fail('LOCAL_STATE_CHANGED', 3);
    return { ...base, status: applied.status, changed: applied.changed, groups: applied.file.groups, groupFile: groupPath,
      group: command.action === 'rename' && applied.changed ? command.newName : name,
      ...(command.client ? { client: command.client } : {}) };
  });
}
