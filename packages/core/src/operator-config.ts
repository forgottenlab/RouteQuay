import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { AdoptionError, privateWrite, type SshClientFiles } from './xray-adoption.ts';
import { defaultUserDataDir, expandUserPath } from './install-layout.ts';

export const OPERATOR_SCHEMA = 'routequay-operator-config-v1';
const importScheme = `${'vle'}${'ss'}://`;
const forbiddenKey = /^(?:password|passphrase|passwd|privatekey|private_key|secret|token|credential|credentials)$/i;
const nodeIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const aliasPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const hostPattern = /^[a-zA-Z0-9][a-zA-Z0-9.:_-]*$/;
const userPattern = /^[a-zA-Z_][a-zA-Z0-9_.-]*\$?$/;
const rootKeys = new Set(['schemaVersion', 'ssh', 'dataDir', 'nodes']);
const sshKeys = new Set(['configPath', 'knownHostsPath']);
const nodeKeys = new Set(['id', 'displayName', 'sshAlias', 'host', 'user', 'port', 'identityFile', 'authMethod']);

export type OperatorAuthMethod = 'ssh-config' | 'ssh-key' | 'agent';
export type OperatorNode = {
  id: string;
  displayName?: string;
  sshAlias?: string;
  host?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  authMethod?: OperatorAuthMethod;
};
export type OperatorConfig = {
  schemaVersion: typeof OPERATOR_SCHEMA;
  ssh?: { configPath?: string; knownHostsPath?: string };
  dataDir?: string;
  nodes: OperatorNode[];
};

function invalid(code = 'OPERATOR_CONFIG_INVALID'): never {
  throw new AdoptionError(code);
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function assertNoForbidden(value: unknown): void {
  if (typeof value === 'string') {
    if (value.toLowerCase().includes(importScheme) || value.includes('-----BEGIN ')) invalid('OPERATOR_CONFIG_FORBIDDEN_FIELD');
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoForbidden(item);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenKey.test(key)) invalid('OPERATOR_CONFIG_FORBIDDEN_FIELD');
      assertNoForbidden(child);
    }
  }
}

function assertPath(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 240 || /[\u0000-\u001f]/.test(value) || value.includes('://')) {
    invalid();
  }
  return value;
}

function assertNode(value: unknown): OperatorNode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!nodeKeys.has(key)) invalid();
  if (typeof input.id !== 'string' || !nodeIdPattern.test(input.id)) invalid();
  const node: OperatorNode = { id: input.id };
  if (input.displayName !== undefined) {
    if (typeof input.displayName !== 'string' || input.displayName.length < 1 || input.displayName.length > 80
        || /[\u0000-\u001f]/.test(input.displayName) || input.displayName.includes('://')) invalid();
    node.displayName = input.displayName;
  }
  if (input.sshAlias !== undefined) {
    if (typeof input.sshAlias !== 'string' || !aliasPattern.test(input.sshAlias)) invalid();
    node.sshAlias = input.sshAlias;
  }
  if (input.host !== undefined) {
    if (typeof input.host !== 'string' || !hostPattern.test(input.host)) invalid();
    node.host = input.host;
  }
  if (input.user !== undefined) {
    if (typeof input.user !== 'string' || !userPattern.test(input.user)) invalid();
    node.user = input.user;
  }
  if (input.port !== undefined) {
    if (typeof input.port !== 'number' || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535) invalid();
    node.port = input.port;
  }
  if (input.identityFile !== undefined) {
    const path = assertPath(input.identityFile);
    if (/^[A-Za-z0-9+/=_-]{80,}$/.test(path)) invalid('OPERATOR_CONFIG_FORBIDDEN_FIELD');
    node.identityFile = path;
  }
  if (input.authMethod !== undefined) {
    if (input.authMethod === 'password' || input.authMethod === 'password-temporary') invalid('OPERATOR_CONFIG_FORBIDDEN_FIELD');
    if (input.authMethod !== 'ssh-config' && input.authMethod !== 'ssh-key' && input.authMethod !== 'agent') invalid();
    node.authMethod = input.authMethod;
  }
  return node;
}

export function validateOperatorConfig(value: unknown): OperatorConfig {
  assertNoForbidden(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!rootKeys.has(key)) invalid();
  if (input.schemaVersion !== OPERATOR_SCHEMA) invalid();
  const config: OperatorConfig = { schemaVersion: OPERATOR_SCHEMA, nodes: [] };
  if (input.ssh !== undefined) {
    if (!input.ssh || typeof input.ssh !== 'object' || Array.isArray(input.ssh)) invalid();
    const ssh = input.ssh as Record<string, unknown>;
    for (const key of Object.keys(ssh)) if (!sshKeys.has(key)) invalid();
    config.ssh = {};
    if (ssh.configPath !== undefined) config.ssh.configPath = assertPath(ssh.configPath);
    if (ssh.knownHostsPath !== undefined) config.ssh.knownHostsPath = assertPath(ssh.knownHostsPath);
  }
  if (input.dataDir !== undefined) config.dataDir = assertPath(input.dataDir);
  if (!Array.isArray(input.nodes)) invalid();
  const ids = new Set<string>();
  for (const item of input.nodes) {
    const node = assertNode(item);
    if (ids.has(node.id)) invalid();
    ids.add(node.id);
    config.nodes.push(node);
  }
  return config;
}

export function operatorConfigPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const override = env.ROUTEQUAY_CONFIG?.trim();
  if (override) return resolve(expandUserPath(override, home));
  return join(defaultUserDataDir(home), 'config.json');
}

export function readOperatorConfig(path: string): OperatorConfig | null {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if (isMissing(error)) return null;
    invalid();
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 64 * 1024) invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
  catch { invalid(); }
  return validateOperatorConfig(parsed);
}

export function initOperatorConfig(programRoot: string, configPath: string): string {
  let existing;
  try { existing = lstatSync(configPath); }
  catch (error) {
    if (!isMissing(error)) invalid();
  }
  if (existing) {
    const error = new AdoptionError('OPERATOR_CONFIG_EXISTS');
    error.details = { stage: 'init-config', reason: configPath };
    throw error;
  }
  const templatePath = join(programRoot, 'examples', 'operator-config.example.json');
  let raw: string;
  try { raw = readFileSync(templatePath, 'utf8'); }
  catch { throw new AdoptionError('OPERATOR_CONFIG_TEMPLATE_MISSING'); }
  validateOperatorConfig(JSON.parse(raw));
  const body = raw.endsWith('\n') ? raw : `${raw}\n`;
  try { privateWrite(configPath, body); }
  catch (error) {
    if (error instanceof AdoptionError && error.code === 'OUTPUT_EXISTS') {
      const exists = new AdoptionError('OPERATOR_CONFIG_EXISTS');
      exists.details = { stage: 'init-config', reason: configPath };
      throw exists;
    }
    throw error;
  }
  return configPath;
}

function sshOperandPath(value: string, home: string): string {
  if (value !== value.trim() || value.startsWith('-')) invalid();
  const absolute = resolve(expandUserPath(value, home));
  if (absolute.length > 240 || absolute.startsWith('-') || /[\u0000-\u001f]/.test(absolute) || absolute.includes('://')) invalid();
  return absolute;
}

// Expands paths only. Existence is checked later, at the SSH spawn boundary.
export function operatorSshFiles(config: OperatorConfig | null, nodeId: string, home = homedir()): SshClientFiles {
  if (!config) return {};
  const files: SshClientFiles = {};
  if (config.ssh?.configPath) files.configFile = sshOperandPath(config.ssh.configPath, home);
  const identityFile = config.nodes.find(node => node.id === nodeId)?.identityFile;
  if (identityFile) files.identityFile = sshOperandPath(identityFile, home);
  return files;
}

export function applyOperatorSshAlias<T extends { nodeId: string; ssh?: string }>(options: T, config: OperatorConfig | null): T & { ssh?: string } {
  if (!config || options.ssh) return options;
  const alias = config.nodes.find(node => node.id === options.nodeId)?.sshAlias;
  if (!alias) return options;
  return { ...options, ssh: alias };
}
