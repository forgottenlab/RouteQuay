import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// Checkout state stays under the program root. An installed copy stores state
// outside that directory so update and uninstall can replace program files only.
export const INSTALL_MARKER = 'routequay-install.json';
export const INSTALL_SCHEMA = 'routequay-install-v1';

export class InstallLayoutError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'InstallLayoutError';
    this.code = code;
  }
}

export type InstallMarker = {
  schemaVersion: typeof INSTALL_SCHEMA;
  layout: 'windows-user';
  version: string;
  node: string;
  ownedFiles: string[];
};

export function defaultUserDataDir(home = homedir()): string {
  return join(home, '.routequay');
}

export function expandUserPath(input: string, home: string): string {
  if (input === '~') return home;
  if (input.startsWith('~/') || input.startsWith('~\\')) return join(home, input.slice(2));
  return input;
}

function markerPath(programRoot: string): string {
  return join(programRoot, INSTALL_MARKER);
}

export function readInstallMarker(programRoot: string): InstallMarker | null {
  let stat;
  try { stat = lstatSync(markerPath(programRoot)); }
  catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') return null;
    throw new InstallLayoutError('INSTALL_LAYOUT_INVALID');
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new InstallLayoutError('INSTALL_LAYOUT_INVALID');
  let body: unknown;
  try { body = JSON.parse(readFileSync(markerPath(programRoot), 'utf8')); }
  catch { throw new InstallLayoutError('INSTALL_LAYOUT_INVALID'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InstallLayoutError('INSTALL_LAYOUT_INVALID');
  const marker = body as Partial<InstallMarker>;
  if (marker.schemaVersion !== INSTALL_SCHEMA || marker.layout !== 'windows-user'
      || !Array.isArray(marker.ownedFiles) || marker.ownedFiles.some(item => typeof item !== 'string')) {
    throw new InstallLayoutError('INSTALL_LAYOUT_INVALID');
  }
  return marker as InstallMarker;
}

export function resolveStateRoot(programRoot: string, options: {
  dataDir?: string;
  configuredDataDir?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
} = {}): string {
  const home = options.home ?? homedir();
  const env = options.env ?? {};
  if (options.dataDir) return resolve(expandUserPath(options.dataDir, home));
  if (env.ROUTEQUAY_DATA_DIR) return resolve(expandUserPath(env.ROUTEQUAY_DATA_DIR, home));
  const marker = readInstallMarker(programRoot);
  if (marker) {
    const configured = options.configuredDataDir?.trim();
    return resolve(expandUserPath(configured || defaultUserDataDir(home), home));
  }
  return resolve(programRoot);
}
