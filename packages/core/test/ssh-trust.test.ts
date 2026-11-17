import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSshConfig, sshTargetArgs } from '../src/xray-adoption.ts';
test('strict host trust survives a changed connection address',()=>{
 const target={alias:'fixture',host:'192.0.2.20',user:'admin',port:22,hostKeyAlias:'192.0.2.10'};
 const args=sshTargetArgs(target);
 for(const value of ['StrictHostKeyChecking=yes','HostKeyAlias=192.0.2.10','HostName=192.0.2.20','UpdateHostKeys=no','BatchMode=yes'])assert(args.includes(value));
 assert(!args.includes('StrictHostKeyChecking=no'));
});
test('invalid SSH endpoints fail before transport',()=>{
 assert.throws(()=>parseSshConfig('fixture','hostname -unsafe\nuser admin\nport 0'));
});
