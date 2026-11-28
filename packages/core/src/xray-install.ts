import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { connect } from 'node:net';
import { supportsFirstInstallPlatform, type LinuxEnvironment } from './linux-compatibility.ts';
import { AdoptionError, createOpenSshTransport, prepareSshConnect, privateDirectory, privateWrite, runAdoption, verifiedAdoptedTarget,
  type AdoptionOptions, type AdoptionResult, type AdoptionTransport, type Probe, type SshClientFiles, type SshTarget } from './xray-adoption.ts';

// Digests retrieved from the official tagged GitHub release API, 2026-11-16.
export const xrayRelease = { version: '26.11.9', assets: {
  x86_64: { name: 'Xray-linux-64.zip', sha256: 'b651f7e1d9966ee2c1b1ee1bf8b52c72771824d3065dce96bbc8bcc19ed95f82' },
  aarch64: { name: 'Xray-linux-arm64-v8a.zip', sha256: '64ed6858982a7f5eb85d88b811089063bd4f17561f4c8f44e0f1dc8e6f6430be' }
} };
export type InstallInspection = LinuxEnvironment & { systemd: boolean; root: boolean;
  filesystem: { standardDirectories: boolean; safePaths: boolean; writable: boolean;
    posixPermissions: boolean; serviceAccountFiles: boolean; nologin: boolean };
  sudo: boolean; missingCommands: string[]; freeMiB: number; existing: string[]; units: string[];
  processes: string[]; loadState: string; inspectionComplete: boolean; listeners: string[];
  firewall: string; baseline: string; sshEndpoint: string[] };
export type SetupOptions = AdoptionOptions & { apply?: boolean; port?: number; clientName?: string;
  serverName?: string; realityTarget?: string; version?: string; readyTimeout?: number };
export type InstallPlan = { action: 'install'; nodeId: string; target: SshTarget; baseline: string;
  platform: LinuxEnvironment; filesystem: InstallInspection['filesystem']; dependencyPolicy: 'existing-tools-only';
  endpoint: string[]; port: number; clientName: string; serverName: string; realityTarget: string;
  version: string; asset: { name: string; sha256: string }; readyTimeout: number; firewall: string };
export interface InstallTransport extends AdoptionTransport {
  execute(target: SshTarget, script: string): { status: number | null; stdout: string };
  receipt(target: SshTarget, id: string): string;
}
export function createInstallTransport(files: SshClientFiles = {}): InstallTransport {
  return {
    ...createOpenSshTransport(files),
    execute(target, script) {
      const result = spawnSync('ssh', [...prepareSshConnect(target, files),
        'if [ "$(id -u)" = 0 ]; then bash -s; else sudo -n env SSH_CONNECTION="$SSH_CONNECTION" bash -s; fi'],
        { input: script, encoding: 'utf8', windowsHide: true, timeout: 240000, maxBuffer: 1024 * 1024 });
      // Only the fixed result marker is interpreted. Never return raw shell errors.
      return { status: result.status, stdout: result.stdout ?? '' };
    },
    receipt(target, id) {
      if (!/^[a-f0-9]{32}$/.test(id)) throw new AdoptionError('TRANSACTION_ID_INVALID');
      const script = `p=/var/backups/vpn-control-plane-${id}; check() { if [ "$(id -u)" = 0 ]; then test "$@"; else sudo -n test "$@"; fi; }; if check -f "$p/installed"; then echo installed; elif check -f "$p/recovered"; then echo recovered; elif check -d "$p"; then echo pending; else echo absent; fi`;
      const result = spawnSync('ssh', [...prepareSshConnect(target, files), script], { encoding: 'utf8', timeout: 15000, windowsHide: true });
      return result.status === 0 ? result.stdout.trim() : 'unknown';
    }
  };
}
export const installTransport = createInstallTransport();
function bringBackAfterAdopt(adopted: AdoptionResult, options: SetupOptions, root: string,
  transport: InstallTransport): AdoptionResult {
  try {
    const pulled = runAdoption({ command: 'pull', nodeId: options.nodeId, ssh: options.ssh, client: options.client }, root, transport);
    return { ...adopted, outputFile: pulled.outputFile, outputFiles: pulled.outputFiles, outputDirectory: pulled.outputDirectory };
  } catch (error) {
    return { ...adopted, status: 'adopted-local-handoff-failed', code: 'ADOPTION_LOCAL_HANDOFF_FAILED', changed: true,
      localHandoffCode: error instanceof AdoptionError ? error.code : 'LOCAL_OPERATION_FAILED' };
  }
}
function refuse(code: string, details?: AdoptionError['details']): never {
  const error = new AdoptionError(code, 3);
  error.details = details;
  throw error;
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function readInstallJournal(text: string, nodeId: string): { id: string; target: SshTarget } {
  let item;
  try { item = JSON.parse(text); } catch { refuse('TRANSACTION_RECOVERY_REQUIRED'); }
  const record = (value: any) => value && typeof value === 'object' && !Array.isArray(value);
  const target = (value: any) => record(value)
    && typeof value.alias === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value.alias)
    && typeof value.host === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9.:_-]*$/.test(value.host)
    && typeof value.user === 'string' && /^[a-zA-Z_][a-zA-Z0-9_.-]*\$?$/.test(value.user)
    && Number.isInteger(value.port) && value.port >= 1 && value.port <= 65535
    && (value.hostKeyAlias === undefined || (typeof value.hostKeyAlias === 'string'
      && /^[a-zA-Z0-9][a-zA-Z0-9.:_-]*$/.test(value.hostKeyAlias)));
  if (!record(item) || item.schemaVersion !== 'vpncp-install-operation-v1'
      || typeof item.id !== 'string' || !/^[a-f0-9]{32}$/.test(item.id)
      || !target(item.target) || !record(item.plan) || item.plan.action !== 'install'
      || item.plan.nodeId !== nodeId || !target(item.plan.target)
      || !equal(item.target, item.plan.target)
      || typeof item.plan.baseline !== 'string' || !/^[a-f0-9]{64}$/.test(item.plan.baseline)) {
    refuse('TRANSACTION_RECOVERY_REQUIRED');
  }
  return item;
}
export function installPlan(options: SetupOptions, target: SshTarget, probe: Probe): InstallPlan {
  const info = probe.install;
  if (!info || info.loadState !== 'not-found' || probe.loadState !== 'not-found'
      || info.existing.length || info.units.length || info.processes.length) refuse('INSTALL_LAYOUT_UNSUPPORTED');
  if (!supportsFirstInstallPlatform(info.os, info.release)) refuse('INSTALL_OS_UNSUPPORTED', {
    stage: 'platform', reason: '首次安装支持 Debian 13 和 Ubuntu 24.04 LTS。可继续只读发现及受支持布局的接管。' });
  if (!info.systemd || info.serviceManager !== 'systemd') refuse('INSTALL_SERVICE_MANAGER_UNSUPPORTED', {
    stage: 'capabilities', reason: '首次安装要求正在运行的 systemd。仅有 systemctl 命令或发行版标识不足以确认。' });
  if (!/^[a-f0-9]{64}$/.test(info.baseline)) refuse('INSTALL_BASELINE_INVALID');
  if (!info.root) refuse('INSTALL_ROOT_OR_SUDO_REQUIRED');
  if (info.missingCommands.length || info.freeMiB < 256) refuse('INSTALL_PREREQUISITES_MISSING', {
    stage: 'capabilities', missingCommands: info.missingCommands.filter(name => /^[a-z0-9-]+$/.test(name)),
    reason: '需要所列现有工具和至少 256 MiB 可用空间。预检和安装器均不自动安装软件包。' });
  if (!info.inspectionComplete) refuse('INSTALL_LAYOUT_UNSUPPORTED');
  const fs = info.filesystem;
  if (!fs || !fs.standardDirectories || !fs.safePaths || !fs.writable || !fs.posixPermissions
      || !fs.serviceAccountFiles || !fs.nologin) refuse('INSTALL_FILESYSTEM_UNSUPPORTED', {
    stage: 'capabilities', reason: '需要安全可写的标准目录、POSIX 权限接口、可写账号数据库及 nologin。' });
  if (!Object.hasOwn(xrayRelease.assets, info.arch)) refuse('INSTALL_ARCH_UNSUPPORTED');
  const asset = xrayRelease.assets[info.arch as keyof typeof xrayRelease.assets];
  const port = options.port ?? 8443;
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === target.port
      || Number(info.sshEndpoint[1]) === port) refuse('INSTALL_PORT_INVALID');
  if (info.listeners.some(line => new RegExp(`:${port}(?:\\s|$)`).test(line))) refuse('INSTALL_PORT_IN_USE');
  if (info.sshEndpoint.length !== 2 || !/^[a-fA-F0-9:.]+$/.test(info.sshEndpoint[0])) refuse('SSH_ENDPOINT_UNVERIFIED');
  if (options.version && options.version !== xrayRelease.version) refuse('INSTALL_VERSION_UNSUPPORTED');
  const serverName = options.serverName ?? 'www.cloudflare.com';
  const realityTarget = options.realityTarget ?? `${serverName}:443`;
  if (!/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(serverName)
      || !/^[a-zA-Z0-9][a-zA-Z0-9.-]*:(?:[1-9][0-9]{0,4})$/.test(realityTarget)
      || Number(realityTarget.split(':')[1]) > 65535) refuse('REALITY_TARGET_INVALID');
  const readyTimeout = options.readyTimeout ?? 30;
  if (!Number.isInteger(readyTimeout) || readyTimeout < 1 || readyTimeout > 90) refuse('READY_TIMEOUT_INVALID');
  const clientName = options.clientName ?? 'client-1';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(clientName)) refuse('CLIENT_NAME_INVALID');
  return { action: 'install', nodeId: options.nodeId, target, baseline: info.baseline, endpoint: info.sshEndpoint,
    platform: { os: info.os, release: info.release, arch: info.arch, serviceManager: info.serviceManager, packageManager: info.packageManager },
    filesystem: info.filesystem, dependencyPolicy: 'existing-tools-only',
    port, clientName, serverName, realityTarget, version: xrayRelease.version, asset, readyTimeout, firewall: info.firewall };
}
export function generateInstallScript(plan: InstallPlan, id: string): string {
  if (!/^[a-f0-9]{32}$/.test(id)) refuse('TRANSACTION_ID_INVALID');
  const pair = generateKeyPairSync('x25519');
  const key = pair.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('base64url');
  const config = { log: { loglevel: 'warning' }, inbounds: [{ tag: 'vpncp-reality', listen: '0.0.0.0', port: plan.port,
    protocol: 'vless', settings: { decryption: 'none', clients: [{ id: randomUUID(), email: plan.clientName, flow: 'xtls-rprx-vision' }] },
    streamSettings: { network: 'tcp', security: 'reality', realitySettings: {
      target: plan.realityTarget, serverNames: [plan.serverName], privateKey: key, shortIds: [randomBytes(8).toString('hex')] } } }],
    outbounds: [{ protocol: 'freedom', tag: 'direct' }] };
  const transaction = readFileSync(new URL('./first-install-transaction.sh', import.meta.url), 'utf8');
  const preflight = readFileSync(new URL('./install-preflight.py', import.meta.url), 'utf8');
  const implementation = readFileSync(new URL('./xray-install.sh', import.meta.url), 'utf8');
  // All shell inputs have been validated by installPlan. Secrets travel only via SSH stdin.
  return `#!/bin/bash
set -euo pipefail
NODE_ID='${plan.nodeId}'
JOB_ID='${id}'
PUBLIC_IP='${plan.endpoint[0]}'
SSH_PORT='${plan.endpoint[1]}'
XRAY_PORT='${plan.port}'
DEPLOY_DIR='/var/lib/vpncp-${id}'
XRAY_CONFIG_PATH='/usr/local/etc/xray/config.json'
CLIENT_LINKS_PATH='/usr/local/etc/xray/vpncp-install.json'
ALLOW_DEPLOY=true
XRAY_RELEASE_SHA256='${plan.asset.sha256}'
XRAY_VERSION='${plan.version}'
XRAY_ASSET='${plan.asset.name}'
READY_TIMEOUT='${plan.readyTimeout}'
ACCOUNT='vcp-${id.slice(0, 12)}'
SERVER_NAME='${plan.serverName}'
REALITY_TARGET='${plan.realityTarget}'
${transaction}
verify_install_baseline() {
python3 - <<'PREFLIGHT'
${preflight}
info=inspect_install(${plan.port})
assert info['baseline'] == '${plan.baseline}' and info['freeMiB'] >= 256
PREFLIGHT
}
${implementation}
`.replace(/\r\n/g, '\n')
    .replace('__CONFIG_BASE64__', Buffer.from(JSON.stringify(config)).toString('base64'));
}
export async function checkTcp(host: string, port: number): Promise<string> {
  return new Promise(resolveResult => {
    const socket = connect({ host, port });
    const finish = (value: string) => { socket.destroy(); resolveResult(value); };
    socket.setTimeout(5000, () => finish('unreachable'));
    socket.once('connect', () => finish('reachable'));
    socket.once('error', () => finish('unreachable'));
  });
}

export async function runSetup(options: SetupOptions, root = '.', transport: InstallTransport = installTransport,
  confirm?: (plan: InstallPlan) => Promise<boolean>, tcp = checkTcp): Promise<AdoptionResult & { plan?: InstallPlan }> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(options.nodeId)) refuse('NODE_ID_INVALID');
  const directory = resolve(root, 'local/private/cli-install', options.nodeId);
  const journal = resolve(directory, 'operation.local.json');
  if (existsSync(journal)) {
    const previous = readInstallJournal(readFileSync(journal, 'utf8'), options.nodeId);
    let boundTarget = transport.resolve(options.ssh ?? previous.target.alias);
    const moved = !equal(previous.target, boundTarget);
    if (moved) boundTarget = verifiedAdoptedTarget(options.nodeId, root, boundTarget, previous.target, transport);
    const state = transport.receipt(boundTarget, previous.id);
    if (moved ? state !== 'installed' : !['recovered', 'installed'].includes(state)) refuse('TRANSACTION_RECOVERY_REQUIRED');
  }
  // Existing managed/adoptable nodes always use the verified adoption path.
  const status = runAdoption({ ...options, command: 'status' }, root, transport);
  status.operation = 'setup';
  if (status.status === 'unsupported') return { ...status, action: 'inspect' };
  if (status.status !== 'not-installed') {
    const adopted = runAdoption(options, root, transport);
    if (options.plan || adopted.status !== 'adopted') return adopted;
    return bringBackAfterAdopt(adopted, options, root, transport);
  }
  const target = transport.resolve(String(status.sshAlias));
  const probe = transport.probe(target);
  const plan = installPlan(options, target, probe);
  if (options.plan) return { ...status, status: 'planned', code: undefined, action: 'install', firstInstallReady: true, plan };
  if (!options.apply && (!confirm || !await confirm(plan))) throw new AdoptionError('INSTALL_APPROVAL_REQUIRED');
  if (!equal(transport.resolve(target.alias), target)) refuse('SSH_TARGET_CHANGED');
  const fresh = installPlan(options, target, transport.probe(target));
  if (!equal(fresh, plan)) refuse('INSTALL_BASELINE_CHANGED');
  privateDirectory(directory);
  const lock = resolve(directory, 'operation.lock');
  try { writeFileSync(lock, '', { flag: 'wx', mode: 0o600 }); } catch { refuse('NODE_BUSY'); }
  try {
    const id = randomUUID().replaceAll('-', '');
    privateWrite(journal, JSON.stringify({ schemaVersion: 'vpncp-install-operation-v1', id, target, plan }), true);
    const result = transport.execute(target, generateInstallScript(plan, id));
    const receipt = transport.receipt(target, id);
    if (receipt !== 'installed') {
      return { ...status, status: receipt === 'recovered' ? 'failed-restored' : result.status === 70 ? 'rollback-failed' : 'unknown',
        code: receipt === 'recovered' ? 'INSTALL_FAILED_RESTORED' : result.status === 70 ? 'INSTALL_ROLLBACK_FAILED' : 'INSTALL_STATE_UNKNOWN',
        failedStage: result.stdout.match(/VPNCP_FAILED:([a-z-]+):restored/)?.[1] ?? 'unknown',
        recoveryReceipt: `/var/backups/vpn-control-plane-${id}`, changed: receipt !== 'recovered' };
    }
    let adopted;
    let exported;
    try {
      adopted = runAdoption({ ...options, command: 'setup', plan: false }, root, transport);
      if (!adopted.managed || adopted.service !== 'active' || adopted.diskMatchesRunning !== true) refuse('POST_INSTALL_READINESS_UNVERIFIED');
      exported = runAdoption({ command: 'pull', nodeId: options.nodeId, ssh: options.ssh }, root, transport);
    } catch (error) {
      return { ...status, status: 'installed-local-state-incomplete', code: 'INSTALL_LOCAL_HANDOFF_FAILED', changed: true,
        localHandoffCode: error instanceof AdoptionError ? error.code : 'LOCAL_OPERATION_FAILED',
        recoveryReceipt: `/var/backups/vpn-control-plane-${id}` };
    }
    const externalTcp = await tcp(target.host, plan.port);
    return { ...adopted, status: 'installed', changed: true, outputFile: exported.outputFile,
      outputFiles: exported.outputFiles, outputDirectory: exported.outputDirectory,
      localReadiness: 'ready', externalTcp, proxyHttps: 'not-verified', unverified: ['proxy-https', 'cloud-firewall'],
      networkStatus: externalTcp === 'reachable' ? 'tcp-reachable-proxy-unverified' : 'local-ready-external-unreachable',
      diagnostics: externalTcp === 'reachable' ? [] : [{ code: 'CHECK_FIREWALL_AND_CLOUD_RULES',
        message: `核对主机 nftables 与云安全组的 TCP ${plan.port} 入站规则；本次未修改规则。需要时另执行 routequay harden --plan。` }],
      recoveryReceipt: `/var/backups/vpn-control-plane-${id}`, commandAcknowledged: result.status === 0 };
  } finally { unlinkSync(lock); }
}
