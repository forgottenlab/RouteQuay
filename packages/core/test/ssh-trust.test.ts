import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSshConfig, sshTargetArgs } from '../src/xray-adoption.ts';
test('strict host trust survives a changed connection address',()=>{
 const target={alias:'fixture',host:'192.0.2.20',user:'admin',port:22,hostKeyAlias:'192.0.2.10'};
 const args=sshTargetArgs(target);
 for(const value of ['StrictHostKeyChecking=yes','HostKeyAlias=192.0.2.10','HostName=192.0.2.20','UpdateHostKeys=no','BatchMode=yes'])assert(args.includes(value));
 assert(!args.includes('StrictHostKeyChecking=no'));
 assert(!args.includes('-F'));
 assert(!args.includes('-i'));
});
test('operator SSH files do not relax pinned host trust',()=>{
 const target={alias:'fixture',host:'192.0.2.20',user:'admin',port:22,hostKeyAlias:'192.0.2.10'};
 const configFile='fixture-ssh-config';
 const identityFile='fixture identity';
 const args=sshTargetArgs(target,{configFile,identityFile});
 assert.equal(args[0],'-F');
 assert.equal(args[1],configFile);
 assert.equal(args[2],'-i');
 assert.equal(args[3],identityFile);
 for(const value of ['StrictHostKeyChecking=yes','IdentitiesOnly=yes','HostKeyAlias=192.0.2.10','HostName=192.0.2.20','UpdateHostKeys=no','BatchMode=yes','ForwardAgent=no'])assert(args.includes(value));
 assert(!args.includes('StrictHostKeyChecking=no'));
 assert(args.indexOf('-F')<args.indexOf('StrictHostKeyChecking=yes'));
 assert(args.indexOf('IdentitiesOnly=yes')<args.indexOf('HostName=192.0.2.20'));
 assert(!args.some(arg=>arg.startsWith('IdentityFile=')));
});
test('invalid SSH endpoints fail before transport',()=>{
 assert.throws(()=>parseSshConfig('fixture','hostname -unsafe\nuser admin\nport 0'));
});
