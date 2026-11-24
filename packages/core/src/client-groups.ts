import { isLocalLabel } from './xray-client.ts';

export const groupSchema = 'routequay-client-groups-v1';
export const groupFileName = 'groups.local.json';
export const groupLimit = 32;
export const groupMemberLimit = 64;
export const clientRefPattern = /^inbound-[1-9]\d*-client-[1-9]\d*$/;

const groupNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const fileKeys = ['schemaVersion', 'nodeId', 'groups'];
const groupKeys = ['name', 'members'];

export class GroupStoreError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'GroupStoreError';
    this.code = code;
  }
}

export type ClientGroup = { name: string; members: string[] };
export type ClientGroupFile = { schemaVersion: typeof groupSchema; nodeId: string; groups: ClientGroup[] };
export type GroupMutation = {
  action: 'create' | 'rename' | 'remove' | 'add-member' | 'remove-member';
  name: string;
  newName?: string;
  client?: string;
  knownRefs?: ReadonlySet<string>;
};

function invalid(): never {
  throw new GroupStoreError('GROUP_STORE_INVALID');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isGroupName(value: string): boolean {
  return groupNamePattern.test(value) && isLocalLabel(value);
}

export function emptyClientGroupFile(nodeId: string): ClientGroupFile {
  return { schemaVersion: groupSchema, nodeId, groups: [] };
}

export function parseClientGroupFile(value: unknown, nodeId: string): ClientGroupFile {
  if (!isRecord(value) || Object.keys(value).some(key => !fileKeys.includes(key))) invalid();
  if (value.schemaVersion !== groupSchema || value.nodeId !== nodeId || !Array.isArray(value.groups)) invalid();
  if (value.groups.length > groupLimit) invalid();
  const names = new Set<string>();
  const groups: ClientGroup[] = [];
  for (const item of value.groups) {
    if (!isRecord(item) || Object.keys(item).some(key => !groupKeys.includes(key))) invalid();
    if (typeof item.name !== 'string' || !isGroupName(item.name) || names.has(item.name)) invalid();
    if (!Array.isArray(item.members) || item.members.length > groupMemberLimit) invalid();
    const seen = new Set<string>();
    const members: string[] = [];
    for (const member of item.members) {
      if (typeof member !== 'string' || !clientRefPattern.test(member) || seen.has(member)) invalid();
      seen.add(member);
      members.push(member);
    }
    names.add(item.name);
    groups.push({ name: item.name, members });
  }
  return { schemaVersion: groupSchema, nodeId, groups };
}

export function serializeClientGroupFile(file: ClientGroupFile): string {
  const groups = file.groups.map(group => ({ name: group.name, members: [...group.members] }));
  return `${JSON.stringify({ schemaVersion: groupSchema, nodeId: file.nodeId, groups })}\n`;
}

export function applyGroupAction(file: ClientGroupFile, input: GroupMutation): { file: ClientGroupFile; changed: boolean; status: string } {
  if (input.action === 'create') {
    if (!isGroupName(input.name)) throw new GroupStoreError('GROUP_NAME_INVALID');
    if (file.groups.some(group => group.name === input.name)) throw new GroupStoreError('GROUP_EXISTS');
    if (file.groups.length >= groupLimit) throw new GroupStoreError('GROUP_LIMIT');
    return { file: { ...file, groups: [...file.groups, { name: input.name, members: [] }] }, changed: true, status: 'created' };
  }
  const index = file.groups.findIndex(group => group.name === input.name);
  if (input.action === 'rename') {
    if (!input.newName || !isGroupName(input.newName)) throw new GroupStoreError('GROUP_NAME_INVALID');
    if (index < 0) throw new GroupStoreError('GROUP_NOT_FOUND');
    if (input.newName === input.name) return { file, changed: false, status: 'unchanged' };
    if (file.groups.some(group => group.name === input.newName)) throw new GroupStoreError('GROUP_EXISTS');
    const groups = file.groups.slice();
    groups[index] = { name: input.newName, members: [...groups[index]!.members] };
    return { file: { ...file, groups }, changed: true, status: 'renamed' };
  }
  if (index < 0) throw new GroupStoreError('GROUP_NOT_FOUND');
  const current = file.groups[index]!;
  if (input.action === 'remove') {
    return { file: { ...file, groups: file.groups.filter(group => group.name !== input.name) }, changed: true, status: 'removed' };
  }
  const ref = input.client ?? '';
  if (!clientRefPattern.test(ref)) throw new GroupStoreError('CLIENT_NOT_FOUND');
  if (input.action === 'add-member') {
    if (!input.knownRefs?.has(ref)) throw new GroupStoreError('CLIENT_NOT_FOUND');
    if (current.members.includes(ref)) return { file, changed: false, status: 'unchanged' };
    if (current.members.length >= groupMemberLimit) throw new GroupStoreError('GROUP_MEMBER_LIMIT');
    const groups = file.groups.slice();
    groups[index] = { name: current.name, members: [...current.members, ref] };
    return { file: { ...file, groups }, changed: true, status: 'member-added' };
  }
  if (!current.members.includes(ref)) throw new GroupStoreError('GROUP_MEMBER_MISSING');
  const groups = file.groups.slice();
  groups[index] = { name: current.name, members: current.members.filter(member => member !== ref) };
  return { file: { ...file, groups }, changed: true, status: 'member-removed' };
}
