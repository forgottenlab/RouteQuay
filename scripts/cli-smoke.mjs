import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const cli='apps/cli/src/vpncp.ts';
const help=spawnSync(process.execPath,[cli,'--help'],{encoding:'utf8'});
assert.equal(help.status,0);for(const command of ['routequay','vpncp','setup','status','endpoint','export','pull','add-client','group','add-member','remove-member','init-config','vless-qr','mihomo-provider','mihomo-profile','sing-box'])assert(help.stdout.includes(command));
assert.equal(help.stdout.includes('vless://'),false);
const bad=spawnSync(process.execPath,[cli,'export','fixture','--to','unsupported','--json'],{encoding:'utf8'});
assert.equal(bad.status,2);assert.equal(JSON.parse(bad.stdout).code,'EXPORT_FORMAT_UNSUPPORTED');
const clash=spawnSync(process.execPath,[cli,'export','fixture','--to','clash','--json'],{encoding:'utf8'});
assert.equal(clash.status,2);assert.equal(JSON.parse(clash.stdout).code,'EXPORT_FORMAT_UNSUPPORTED');
const pull=spawnSync(process.execPath,[cli,'pull','fixture','--json'],{encoding:'utf8'});
assert.equal(pull.status,2);assert.equal(JSON.parse(pull.stdout).code,'SETUP_REQUIRED');
assert.equal(pull.stdout.includes('vless://'),false);
const grouped=spawnSync(process.execPath,[cli,'group','fixture','list','--json'],{encoding:'utf8'});
assert.equal(grouped.status,2);assert.equal(JSON.parse(grouped.stdout).code,'SETUP_REQUIRED');
assert.equal(grouped.stdout.includes('vless://'),false);
for (const format of ['vless-qr','mihomo-provider','mihomo-profile','sing-box']) {
  const accepted=spawnSync(process.execPath,[cli,'export','fixture','--to',format,'--json'],{encoding:'utf8'});
  assert.equal(accepted.status,2);assert.equal(JSON.parse(accepted.stdout).code,'SETUP_REQUIRED');
  assert.equal(accepted.stdout.includes('vless://'),false);
}
const skillCheck = spawnSync(process.execPath, ['scripts/skill-check.mjs'], { encoding: 'utf8' });
assert.equal(skillCheck.status, 0, skillCheck.stdout + skillCheck.stderr);
console.log('CLI smoke PASS: help and safe parameter rejection; no SSH');
