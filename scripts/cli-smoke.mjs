import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const cli='apps/cli/src/vpncp.ts';
const help=spawnSync(process.execPath,[cli,'--help'],{encoding:'utf8'});
assert.equal(help.status,0);for(const command of ['routequay','vpncp','setup','status','endpoint','export','vless-qr','mihomo-provider','mihomo-profile','sing-box'])assert(help.stdout.includes(command));
assert.equal(help.stdout.includes('vless://'),false);
const bad=spawnSync(process.execPath,[cli,'export','fixture','--to','unsupported','--json'],{encoding:'utf8'});
assert.equal(bad.status,2);assert.equal(JSON.parse(bad.stdout).code,'EXPORT_FORMAT_UNSUPPORTED');
const clash=spawnSync(process.execPath,[cli,'export','fixture','--to','clash','--json'],{encoding:'utf8'});
assert.equal(clash.status,2);assert.equal(JSON.parse(clash.stdout).code,'EXPORT_FORMAT_UNSUPPORTED');
for (const format of ['vless-qr','mihomo-provider','mihomo-profile','sing-box']) {
  const accepted=spawnSync(process.execPath,[cli,'export','fixture','--to',format,'--json'],{encoding:'utf8'});
  assert.equal(accepted.status,2);assert.equal(JSON.parse(accepted.stdout).code,'SETUP_REQUIRED');
  assert.equal(accepted.stdout.includes('vless://'),false);
}
console.log('CLI smoke PASS: help and safe parameter rejection; no SSH');
