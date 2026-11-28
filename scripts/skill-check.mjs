import fs from 'node:fs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const skillPath = '.agents/skills/routequay/SKILL.md';
const skill = fs.readFileSync(skillPath, 'utf8');
assert.equal(skill.startsWith('---\n'), true);
const frontEnd = skill.indexOf('\n---\n', 4);
assert.equal(frontEnd > 4, true);
const front = skill.slice(4, frontEnd);
assert.match(front, /^name:\s*routequay\s*$/m);
assert.match(front, /^description:/m);
assert.equal(/\b(?:Cursor|Codex|Claude|ChatGPT)\b/.test(skill), false);

const shareScheme = ['vle', 'ss://'].join('');
const fences = [...skill.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map(match => match[1]).join('\n');
assert.equal(fences.includes('allowed-commands:'), true);
assert.equal(skill.includes(shareScheme), true);
assert.equal(fences.includes(shareScheme), false);
assert.equal(new RegExp(shareScheme + '\\S').test(skill), false);
assert.equal(/-----BEGIN/.test(skill), false);
assert.equal(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/i.test(skill), false);
for (const secret of ['id_ed25519', '~/.ssh', 'identityFile', 'knownHostsPath', 'configPath']) {
  assert.equal(skill.includes(secret), false, secret);
}
for (const rule of ['UUID', '私钥', '密码', '--plan', '--apply', 'minClientVer', 'REALITY', 'inbound-N-client-N']) {
  assert.equal(skill.includes(rule), true, rule);
}

const allowed = fences.match(/allowed-commands:[ \t]*([^\n]+)/);
assert.ok(allowed);
const commands = allowed[1].split(/\s+/);
assert.deepEqual(commands, ['setup', 'status', 'endpoint', 'export', 'pull', 'add-client', 'group', 'init-config', 'harden']);
const help = spawnSync(process.execPath, ['apps/cli/src/vpncp.ts', '--help'], { encoding: 'utf8' });
assert.equal(help.status, 0);
for (const command of [...commands, 'add-member', 'remove-member', 'vless-qr', 'mihomo-provider', 'mihomo-profile', 'sing-box']) {
  assert.equal(help.stdout.includes(command), true, command);
  assert.equal(skill.includes(command), true, command);
}
assert.equal(help.stdout.includes(shareScheme), false);

const template = fs.readFileSync('examples/operator-config.example.json', 'utf8');
for (const field of ['configPath', 'knownHostsPath', 'identityFile', 'id_ed25519', '.ssh']) {
  assert.equal(template.includes(field), false, field);
}
const runtime = fs.readFileSync('scripts/runtime-manifest.mjs', 'utf8');
assert.equal(runtime.includes('SKILL.md'), false);
assert.equal(runtime.includes('.agents/skills'), false);

const readmeZh = fs.readFileSync('README.zh-CN.md', 'utf8');
const readmeEn = fs.readFileSync('README.md', 'utf8');
const roadmap = fs.readFileSync('docs/ROADMAP.zh-CN.md', 'utf8');
const installZh = fs.readFileSync('docs/INSTALL.zh-CN.md', 'utf8');
const installEn = fs.readFileSync('docs/INSTALL.md', 'utf8');
for (const doc of [readmeZh, readmeEn, roadmap, installZh, installEn]) {
  assert.equal(doc.includes('.agents/skills/routequay/'), true);
}
assert.equal(readmeZh.includes('可选'), true);
assert.equal(readmeZh.includes('本机'), true);
assert.equal(readmeEn.includes('optional'), true);
assert.equal(readmeEn.includes('local'), true);
assert.equal(roadmap.includes('Path B'), true);
assert.equal(roadmap.includes('当前这一步'), true);
assert.equal(roadmap.includes('主机防火墙'), true);
assert.equal(roadmap.includes('GitHub Release'), true);
assert.equal(roadmap.includes('不安装到'), true);
assert.equal(roadmap.includes('放在服务器上的 skill'), false);
assert.equal(installZh.includes('远端'), true);
assert.equal(installEn.includes('remote host'), true);

const smoke = fs.readFileSync('scripts/cli-smoke.mjs', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
assert.equal(smoke.includes('scripts/skill-check.mjs'), true);
assert.equal(pkg.scripts['test:skill'], 'node scripts/skill-check.mjs');
assert.equal(pkg.scripts.check.includes('npm run test:skill'), true);
const allowlist = fs.readFileSync('scripts/check-candidate.mjs', 'utf8');
assert.equal(allowlist.includes(skillPath), true);
assert.equal(allowlist.includes('scripts/skill-check.mjs'), true);

console.log('Skill text PASS: local skill, docs, template, and help agree; examples have no secret material');
