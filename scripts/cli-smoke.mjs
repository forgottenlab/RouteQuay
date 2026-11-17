import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const cli='apps/cli/src/vpncp.ts';
const help=spawnSync(process.execPath,[cli,'--help'],{encoding:'utf8'});
assert.equal(help.status,0);for(const command of ['setup','status','endpoint','export'])assert(help.stdout.includes(command));
const bad=spawnSync(process.execPath,[cli,'export','fixture','--to','unsupported','--json'],{encoding:'utf8'});
assert.equal(bad.status,2);assert.equal(JSON.parse(bad.stdout).code,'EXPORT_FORMAT_UNSUPPORTED');
console.log('CLI smoke PASS: help and safe parameter rejection; no SSH');
