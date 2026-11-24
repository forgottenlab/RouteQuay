import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const clientNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const clientLimit = 64;

export type ClientAppendSelection = {
  inboundRef: string;
  clientRef: string;
  inboundIndex: number;
  clientIndex: number;
  email: string;
  flow?: 'xtls-rprx-vision';
};
export type ClientAppendPlan = ClientAppendSelection & { next: unknown; canonicalHash: string };
export type ClientChangePayload = {
  jobId: string;
  inboundIndex: number;
  port: number;
  configPath: string;
  baseline: unknown;
  next: unknown;
  receiptDir?: string;
};

type PlanFailure = { ok: false; code: string };
type PlanSuccess = { ok: true; selection: ClientAppendSelection };
type BuildSuccess = { ok: true; plan: ClientAppendPlan };

function failure(code: string): PlanFailure {
  return { ok: false, code };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(item => canonical(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

export function canonicalDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function isLocalLabel(value: string): boolean {
  return value.length >= 1 && value.length <= 80 && !/[\u0000-\u001f]/.test(value)
    && !value.includes('://') && !value.includes('-----BEGIN ') && !uuidPattern.test(value);
}

function supportedInbound(inbound: unknown): inbound is Record<string, unknown> {
  if (!isRecord(inbound) || inbound.protocol !== 'vless' || !isRecord(inbound.streamSettings)) return false;
  if (inbound.streamSettings.security !== 'reality') return false;
  if (typeof inbound.listen === 'string' && ['127.0.0.1', '::1', 'localhost'].includes(inbound.listen)) return false;
  const network = inbound.streamSettings.network ?? 'tcp';
  if (network !== 'tcp' && network !== 'raw') return false;
  return Number.isInteger(inbound.port) && Number(inbound.port) >= 1 && Number(inbound.port) <= 65535;
}

function selectInbound(config: unknown, inbound: string | undefined): { ok: true; config: Record<string, unknown>; index: number } | PlanFailure {
  if (!isRecord(config) || !Array.isArray(config.inbounds)) return failure('CLIENT_TARGET_UNSUPPORTED');
  const supported = config.inbounds.flatMap((item, index) => supportedInbound(item) ? [index] : []);
  if (!supported.length) return failure('NO_SUPPORTED_CLIENT');
  if (!inbound) {
    if (supported.length !== 1) return failure('INBOUND_SELECTION_REQUIRED');
    return { ok: true, config, index: supported[0]! };
  }
  const match = /^inbound-([1-9]\d*)$/.exec(inbound);
  if (!match) return failure('INBOUND_NOT_FOUND');
  const index = Number(match[1]) - 1;
  if (!supported.includes(index)) return failure('INBOUND_NOT_FOUND');
  return { ok: true, config, index };
}

function clientList(inbound: Record<string, unknown>): unknown[] | undefined {
  if (!isRecord(inbound.settings) || !Array.isArray(inbound.settings.clients)) return undefined;
  return inbound.settings.clients;
}

function sharedFlow(clients: unknown[]): 'xtls-rprx-vision' | '' | undefined {
  if (!clients.length) return 'xtls-rprx-vision';
  const values = clients.map(client => {
    if (!isRecord(client)) return undefined;
    if (client.flow === undefined || client.flow === '') return '';
    return client.flow === 'xtls-rprx-vision' ? 'xtls-rprx-vision' : undefined;
  });
  if (values.some(value => value === undefined) || !values.every(value => value === values[0])) return undefined;
  return values[0];
}

function usedEmails(config: Record<string, unknown>): Set<string> {
  const emails = new Set<string>();
  for (const inbound of config.inbounds as unknown[]) {
    if (!isRecord(inbound) || !isRecord(inbound.settings) || !Array.isArray(inbound.settings.clients)) continue;
    for (const client of inbound.settings.clients) {
      if (isRecord(client) && typeof client.email === 'string') emails.add(client.email);
    }
  }
  return emails;
}

function usedIds(config: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  for (const inbound of config.inbounds as unknown[]) {
    if (!isRecord(inbound) || !isRecord(inbound.settings) || !Array.isArray(inbound.settings.clients)) continue;
    for (const client of inbound.settings.clients) {
      if (isRecord(client) && typeof client.id === 'string') ids.add(client.id.toLowerCase());
    }
  }
  return ids;
}

export function describeClientAppend(config: unknown, input: { inbound?: string; name?: string } = {}): PlanSuccess | PlanFailure {
  const selected = selectInbound(config, input.inbound);
  if (!selected.ok) return selected;
  const inbound = (selected.config.inbounds as unknown[])[selected.index];
  if (!isRecord(inbound)) return failure('CLIENT_TARGET_UNSUPPORTED');
  const clients = clientList(inbound);
  if (!clients) return failure('CLIENT_TARGET_UNSUPPORTED');
  if (clients.length >= clientLimit) return failure('CLIENT_LIMIT');
  if (clients.some(client => !isRecord(client))) return failure('CLIENT_TARGET_UNSUPPORTED');
  const flow = sharedFlow(clients);
  if (flow === undefined) return failure('CLIENT_FLOW_INCONSISTENT');
  const email = input.name ?? `client-${clients.length + 1}`;
  if (!clientNamePattern.test(email)) return failure('CLIENT_NAME_INVALID');
  if (usedEmails(selected.config).has(email)) return failure('CLIENT_NAME_TAKEN');
  const selection: ClientAppendSelection = {
    inboundRef: `inbound-${selected.index + 1}`,
    clientRef: `inbound-${selected.index + 1}-client-${clients.length + 1}`,
    inboundIndex: selected.index,
    clientIndex: clients.length,
    email,
    ...(flow ? { flow } : {})
  };
  return { ok: true, selection };
}

export function buildClientAppend(config: unknown, input: { inbound?: string; name?: string } = {}): BuildSuccess | PlanFailure {
  const described = describeClientAppend(config, input);
  if (!described.ok) return described;
  const next = structuredClone(config) as Record<string, unknown>;
  const inbound = (next.inbounds as Record<string, unknown>[])[described.selection.inboundIndex];
  const clients = (inbound?.settings as Record<string, unknown>).clients as Record<string, unknown>[];
  const taken = usedIds(next);
  let id = '';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = randomUUID();
    if (!taken.has(candidate.toLowerCase())) { id = candidate; break; }
  }
  if (!uuidPattern.test(id)) return failure('CLIENT_ID_UNAVAILABLE');
  const client: Record<string, string> = { id, email: described.selection.email };
  if (described.selection.flow) client.flow = described.selection.flow;
  clients.push(client);
  return { ok: true, plan: { ...described.selection, next, canonicalHash: canonicalDigest(next) } };
}

export function sameClientDocument(left: unknown, right: unknown): boolean {
  return canonicalDigest(left) === canonicalDigest(right);
}

export function buildClientChangeScript(payload: ClientChangePayload): string {
  if (!/^[a-f0-9]{32}$/.test(payload.jobId)) return '';
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const python = readFileSync(new URL('./xray-add-client.py', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  return `#!/bin/bash
set -euo pipefail
umask 077
export ROUTEQUAY_CLIENT_PAYLOAD='${encoded}'
python3 - <<'PY'
${python}
PY
`;
}
