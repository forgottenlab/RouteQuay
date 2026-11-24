import { spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, rmdirSync, unlinkSync, writeFileSync
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listRuntimeFiles } from './runtime-manifest.mjs';

export const INSTALL_MARKER = 'routequay-install.json';
export const INSTALL_SCHEMA = 'routequay-install-v1';
export const USER_PATH_SCOPE = 'User';
export const USER_PATH_READ_COMMAND = "[Environment]::GetEnvironmentVariable('Path','User')";
export const USER_PATH_WRITE_COMMAND = "[Environment]::SetEnvironmentVariable('Path',$env:ROUTEQUAY_USER_PATH,'User')";
export const npmCiArgs = ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'];

export class InstallerError extends Error {
  constructor(code, reason) {
    super(code);
    this.name = 'InstallerError';
    this.code = code;
    if (reason) this.reason = reason;
  }
}

function fail(code, reason) {
  throw new InstallerError(code, reason);
}

export function parseMinimumNode(range) {
  const match = /^\s*>=\s*(\d+)\.(\d+)\.(\d+)\s*$/.exec(range ?? '');
  if (!match) fail('NODE_RANGE_UNSUPPORTED');
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), range: `>=${match[1]}.${match[2]}.${match[3]}` };
}

export function nodeVersionSatisfies(actual, minimum) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(actual ?? '').trim());
  if (!match) return false;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
  const required = [minimum.major, minimum.minor, minimum.patch];
  for (let index = 0; index < 3; index += 1) {
    if (parts[index] > required[index]) return true;
    if (parts[index] < required[index]) return false;
  }
  return true;
}

export function splitPath(value) {
  return String(value ?? '').split(';').map(part => part.trim()).filter(part => part.length > 0);
}

export function pathKey(entry) {
  return entry.replace(/[\\/]+$/, '').replaceAll('/', '\\').toLowerCase();
}

export function mergeUserPath(current, directory) {
  const key = pathKey(directory);
  const kept = splitPath(current).filter(part => pathKey(part) !== key);
  return [directory, ...kept].join(';');
}

export function removeUserPath(current, directory) {
  const key = pathKey(directory);
  return splitPath(current).filter(part => pathKey(part) !== key).join(';');
}

export function resolvePathCommand(pathValue, command, exists = existsSync) {
  const extensions = ['.cmd', '.exe', '.bat'];
  for (const dir of splitPath(pathValue)) {
    for (const extension of extensions) {
      const candidate = join(dir, `${command}${extension}`);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

export function memoryPathStore(initial = '') {
  let value = initial;
  return {
    scope: USER_PATH_SCOPE,
    read() { return value; },
    write(next) { value = String(next); }
  };
}

export function filePathStore(file) {
  return {
    scope: USER_PATH_SCOPE,
    read() { return existsSync(file) ? readFileSync(file, 'utf8') : ''; },
    write(next) { writeFileSync(file, String(next)); }
  };
}

function powershellUserPath(action, value) {
  const script = action === 'read' ? USER_PATH_READ_COMMAND : USER_PATH_WRITE_COMMAND;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ROUTEQUAY_USER_PATH: value ?? '' }
  });
  if (result.status !== 0) fail('USER_PATH_UPDATE_FAILED');
  return (result.stdout ?? '').replace(/\r?\n$/, '');
}

export function windowsUserPathStore() {
  if (process.platform !== 'win32') fail('USER_PATH_WINDOWS_ONLY');
  return {
    scope: USER_PATH_SCOPE,
    read() { return powershellUserPath('read'); },
    write(next) { powershellUserPath('write', next); }
  };
}

const NPM_REASON_LIMIT = 600;
const cmdToken = /^[A-Za-z0-9_.=@/-]+$/;

function windowsCommandShell(env) {
  for (const key of ['ComSpec', 'comspec', 'COMSPEC']) {
    const value = env?.[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return 'cmd.exe';
}

function assertNpmCiToken(token) {
  if (!cmdToken.test(token)) fail('NPM_CI_ARGS_UNSAFE');
}

// Node.js returns EINVAL when spawn/spawnSync is given a .cmd or .bat file
// without a shell (CVE-2024-27980). Volta's npm.cmd hits that path.
// cmd.exe /d /s /c is the documented way to run that shim. Arguments stay
// a fixed token list so the command string is not a general shell.
export function npmCiInvocation(platform = process.platform, env = process.env) {
  for (const token of ['npm.cmd', ...npmCiArgs]) assertNpmCiToken(token);
  if (platform === 'win32') {
    const command = ['npm.cmd', ...npmCiArgs].join(' ');
    return {
      file: windowsCommandShell(env),
      args: ['/d', '/s', '/c', `"${command}"`],
      options: { windowsVerbatimArguments: true }
    };
  }
  return { file: 'npm', args: [...npmCiArgs], options: {} };
}

export function directBatchSpawnIsInvalid(file, options = {}) {
  const base = String(file ?? '').replace(/^.*[\\/]/, '');
  if (!/\.(?:cmd|bat)$/i.test(base)) return false;
  if (options.shell === true) return false;
  if (typeof options.shell === 'string' && options.shell.trim()) return false;
  return true;
}

function asText(value) {
  if (typeof value === 'string') return value;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return value.toString('utf8');
  return '';
}

export function publicNpmFailureReason(result) {
  const parts = [];
  const error = result?.error;
  if (error) {
    const code = typeof error.code === 'string' ? error.code : '';
    const message = typeof error.message === 'string' ? error.message : '';
    const line = [code, message].filter(Boolean).join(': ');
    if (line) parts.push(line);
  }
  const stderr = asText(result?.stderr).trim();
  const stdout = asText(result?.stdout).trim();
  if (stderr) parts.push(stderr);
  else if (stdout) parts.push(stdout);
  if (!parts.length) {
    if (result && result.status !== undefined && result.status !== null) return `npm exited ${result.status}`;
    return 'npm ci failed without a status';
  }
  return sanitizeNpmReason(parts.join('\n'));
}

function sanitizeNpmReason(value) {
  const cleaned = value
    .replaceAll('\u0000', '')
    .replace(/\r\n/g, '\n')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted]')
    .replace(/vless:\/\/\S+/gi, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/((?:_authToken|token|password|passphrase)\s*[=:]\s*)\S+/gi, '$1[redacted]')
    .replace(/\b(?:ghp|gho)_[A-Za-z0-9]{16,}\b/g, '[redacted]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{16,}\b/g, '[redacted]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[redacted]')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  if (cleaned.length <= NPM_REASON_LIMIT) return cleaned;
  return `${cleaned.slice(0, NPM_REASON_LIMIT)}…`;
}

export function defaultRunNpm(dest, spawn = spawnSync) {
  const planned = npmCiInvocation();
  const result = spawn(planned.file, planned.args, {
    cwd: dest,
    encoding: 'utf8',
    windowsHide: true,
    ...planned.options
  });
  if (!result || result.status !== 0) fail('NPM_CI_FAILED', publicNpmFailureReason(result));
}

function readPackage(root) {
  try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')); }
  catch { fail('PACKAGE_MANIFEST_INVALID'); }
}

function overlaps(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function assertDisjoint(left, right, code) {
  if (overlaps(left, right) || overlaps(right, left)) fail(code);
}

function assertOwnedRelative(rel) {
  if (typeof rel !== 'string' || rel.length === 0 || rel.includes('\0') || isAbsolute(rel)) fail('INSTALL_PATH_UNSAFE');
  const parts = rel.replaceAll('\\', '/').split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..')) fail('INSTALL_PATH_UNSAFE');
}

function assertInside(parent, target) {
  const rel = relative(resolve(parent), resolve(target));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) fail('INSTALL_PATH_UNSAFE');
}

function markerFile(dest) {
  return join(dest, INSTALL_MARKER);
}

function readMarker(dest) {
  const path = markerFile(dest);
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if (error && error.code === 'ENOENT') return null;
    fail('INSTALL_LAYOUT_INVALID');
  }
  if (stat.isSymbolicLink() || !stat.isFile()) fail('INSTALL_LAYOUT_INVALID');
  let body;
  try { body = JSON.parse(readFileSync(path, 'utf8')); }
  catch { fail('INSTALL_LAYOUT_INVALID'); }
  if (!body || body.schemaVersion !== INSTALL_SCHEMA || body.layout !== 'windows-user' || !Array.isArray(body.ownedFiles)) {
    fail('INSTALL_LAYOUT_INVALID');
  }
  for (const rel of body.ownedFiles) assertOwnedRelative(rel);
  return body;
}

function isEmptyDirectory(path) {
  if (!existsSync(path)) return true;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
  return readdirSync(path).length === 0;
}

function requireUserStore(pathStore) {
  if (!pathStore || pathStore.scope !== USER_PATH_SCOPE) fail('USER_PATH_REQUIRED');
}

function writeMarker(dest, marker) {
  const path = markerFile(dest);
  assertInside(dest, path);
  writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`);
}

function assertRuntimeSources(sourceRoot, names) {
  for (const rel of names) {
    assertOwnedRelative(rel);
    const from = join(sourceRoot, rel);
    let stat;
    try { stat = lstatSync(from); }
    catch { fail('RUNTIME_FILE_MISSING'); }
    if (stat.isSymbolicLink() || !stat.isFile()) fail('RUNTIME_FILE_MISSING');
  }
}

function copyRuntime(sourceRoot, dest, names) {
  assertRuntimeSources(sourceRoot, names);
  for (const rel of names) {
    const target = join(dest, rel);
    assertInside(dest, target);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(sourceRoot, rel), target);
  }
}

function removeEmptyDirectories(dir) {
  if (!existsSync(dir)) return;
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) return;
  for (const name of readdirSync(dir)) {
    removeEmptyDirectories(join(dir, name));
  }
  if (readdirSync(dir).length === 0) rmdirSync(dir);
}

function removeOwnedFile(dest, rel) {
  assertOwnedRelative(rel);
  const target = join(dest, rel);
  assertInside(dest, target);
  let stat;
  try { stat = lstatSync(target); }
  catch (error) {
    if (error && error.code === 'ENOENT') return;
    fail('INSTALL_PATH_UNSAFE');
  }
  if (stat.isSymbolicLink()) fail('INSTALL_PATH_UNSAFE');
  if (stat.isFile()) unlinkSync(target);
}

function defaultDataDir(home) {
  return join(home, '.routequay');
}

function resolveDataDir(options, home) {
  return resolve(options.dataDir ?? defaultDataDir(home));
}

export function installRuntime(options) {
  const action = options.action;
  if (!['install', 'update', 'uninstall'].includes(action)) fail('ACTION_UNSUPPORTED');
  const home = options.home ?? homedir();
  const dest = resolve(options.dest ?? '');
  if (!options.dest) fail('DEST_REQUIRED');
  const dataDir = resolveDataDir(options, home);
  assertDisjoint(dest, dataDir, 'DATA_DIR_OVERLAPS_PROGRAM_DIR');
  const sourceRoot = action === 'uninstall' ? dest : resolve(options.sourceRoot ?? '');
  if (action !== 'uninstall') {
    if (!options.sourceRoot) fail('SOURCE_REQUIRED');
    assertDisjoint(sourceRoot, dest, 'SOURCE_OVERLAPS_DEST');
  }
  const manifest = readPackage(sourceRoot);
  const minimum = parseMinimumNode(manifest.engines?.node);
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  if (!nodeVersionSatisfies(nodeVersion, minimum)) fail('NODE_TOO_OLD');
  if (action === 'uninstall') return uninstallRuntime(dest, dataDir, options.pathStore);
  if (options.confirmPath) requireUserStore(options.pathStore);
  const existing = readMarker(dest);
  if (action === 'install' && existing) fail('ALREADY_INSTALLED');
  if (action === 'update' && !existing) fail('NOT_INSTALLED');
  if (action === 'install' && !isEmptyDirectory(dest)) fail('DEST_NOT_EMPTY');
  const names = listRuntimeFiles();
  copyRuntime(sourceRoot, dest, names);
  if (!options.skipNpm) (options.runNpm ?? defaultRunNpm)(dest);
  const previous = existing?.ownedFiles ?? [];
  writeMarker(dest, {
    schemaVersion: INSTALL_SCHEMA,
    layout: 'windows-user',
    name: 'routequay',
    version: manifest.version,
    node: minimum.range,
    ownedFiles: names,
    pathScope: USER_PATH_SCOPE,
    userData: 'outside-program-directory'
  });
  if (action === 'update') {
    for (const rel of previous) {
      if (!names.includes(rel) && rel !== INSTALL_MARKER) removeOwnedFile(dest, rel);
    }
  }
  let pathUpdated = false;
  if (options.confirmPath) {
    options.pathStore.write(mergeUserPath(options.pathStore.read(), dest));
    pathUpdated = true;
  }
  return { dest, dataDir, pathUpdated, removed: false };
}

function uninstallRuntime(dest, dataDir, pathStore) {
  if (pathStore) requireUserStore(pathStore);
  const marker = readMarker(dest);
  if (!marker) fail('NOT_INSTALLED');
  for (const rel of [...marker.ownedFiles, INSTALL_MARKER]) {
    assertOwnedRelative(rel);
    const target = join(dest, rel);
    assertInside(dest, target);
    let stat;
    try { stat = lstatSync(target); }
    catch (error) {
      if (error instanceof InstallerError) throw error;
      if (error && error.code === 'ENOENT') continue;
      fail('INSTALL_PATH_UNSAFE');
    }
    if (stat.isSymbolicLink() || !stat.isFile()) fail('INSTALL_PATH_UNSAFE');
  }
  const modules = join(dest, 'node_modules');
  if (existsSync(modules) || linked(modules)) {
    assertInside(dest, modules);
    const stat = lstatSync(modules);
    if (stat.isSymbolicLink()) fail('INSTALL_PATH_UNSAFE');
  }
  for (const rel of marker.ownedFiles) removeOwnedFile(dest, rel);
  if (existsSync(modules)) rmSync(modules, { recursive: true, force: true });
  removeOwnedFile(dest, INSTALL_MARKER);
  removeEmptyDirectories(dest);
  if (pathStore) pathStore.write(removeUserPath(pathStore.read(), dest));
  return { dest, dataDir, pathUpdated: Boolean(pathStore), removed: true };
}

function linked(path) {
  try { return lstatSync(path).isSymbolicLink(); }
  catch (error) {
    if (error && error.code === 'ENOENT') return false;
    fail('INSTALL_PATH_UNSAFE');
  }
}

export function parseInstallArgs(argv) {
  const [action, ...rest] = argv;
  if (!['install', 'update', 'uninstall'].includes(action ?? '')) fail('ACTION_UNSUPPORTED');
  const options = { action, confirmPath: false, skipNpm: false };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = () => {
      const next = rest[++index];
      if (!next || next.startsWith('--')) fail('OPTION_VALUE_REQUIRED');
      return next;
    };
    if (flag === '--source') options.sourceRoot = value();
    else if (flag === '--dest') options.dest = value();
    else if (flag === '--data-dir') options.dataDir = value();
    else if (flag === '--path-file') options.pathFile = value();
    else if (flag === '--confirm-path') {
      const chosen = value();
      if (chosen !== 'yes' && chosen !== 'no') fail('CONFIRM_PATH_INVALID');
      options.confirmPath = chosen === 'yes';
    } else if (flag === '--skip-npm') options.skipNpm = true;
    else fail('UNKNOWN_OPTION');
  }
  if (!options.dest) fail('DEST_REQUIRED');
  if (action !== 'uninstall' && !options.sourceRoot) fail('SOURCE_REQUIRED');
  return options;
}

function storeFor(args) {
  if (args.pathFile) return filePathStore(args.pathFile);
  const wantsPath = args.confirmPath || args.action === 'uninstall';
  if (!wantsPath) return undefined;
  return windowsUserPathStore();
}

function runCli(argv) {
  try {
    const args = parseInstallArgs(argv);
    const result = installRuntime({ ...args, pathStore: storeFor(args), skipNpm: args.skipNpm });
    console.log(JSON.stringify({
      ok: true,
      action: args.action,
      dest: result.dest,
      pathUpdated: result.pathUpdated,
      removed: result.removed
    }));
  } catch (error) {
    const code = error instanceof InstallerError ? error.code : 'INSTALL_FAILED';
    const body = { ok: false, code };
    if (error instanceof InstallerError && error.reason) body.reason = error.reason;
    console.log(JSON.stringify(body));
    process.exitCode = 2;
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) runCli(process.argv.slice(2));
