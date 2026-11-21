import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const manifest=JSON.parse(fs.readFileSync('docs/SOURCE-SNAPSHOT.json','utf8'));
const allowed=new Set(['LICENSE',...manifest.files.map(x=>x.path),...[".gitignore",".gitattributes",".editorconfig","AGENTS.md","package.json","package-lock.json","tsconfig.json","README.md","README.zh-CN.md","docs/TESTING.zh-CN.md","docs/ROADMAP.zh-CN.md","docs/DEVELOPMENT.md","docs/LICENSE-REVIEW.md","docs/SOURCE-SNAPSHOT.json","packages/core/test/ssh-trust.test.ts","packages/exporters/src/client-connection.ts","packages/exporters/src/mihomo-yaml.ts","packages/exporters/src/vless-qr.ts","packages/exporters/test/mihomo-export.test.ts","packages/exporters/test/vless-qr.test.ts","scripts/cli-smoke.mjs","scripts/check-candidate.mjs"]]);
const excluded=new Set(['.git','.ai','node_modules','backups','local','exports','logs','secrets','.npm-cache']);
const files=[];
function visit(dir='.') {for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
 const p=path.posix.join(dir,entry.name); if(excluded.has(p))continue;
 assert(!entry.isSymbolicLink(),'Unexpected symlink: '+p);
 if(entry.isDirectory())visit(p);else files.push(p);
}}
visit();
const fixtureIds=new Set(['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','123e4567-e89b-12d3-a456-426614174000']);
for(const f of files){assert(allowed.has(f),'Unexpected candidate file: '+f);const s=fs.readFileSync(f,'utf8');
 assert(!/[A-Z]:[\\/](?:Users|Codex)[\\/]/i.test(s),'Workstation path: '+f);
 assert(!/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{20,}|sk-proj-[A-Za-z0-9_-]{20,}/.test(s),'Credential pattern: '+f);
 for(const m of s.matchAll(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi))assert(fixtureIds.has(m[0].toLowerCase()),'Non-fixture UUID: '+f);
 for(const m of s.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)){const ip=m[0];assert(ip==='0.0.0.0'||ip.startsWith('127.')||ip.startsWith('192.0.2.')||ip.startsWith('198.51.100.')||ip.startsWith('203.0.113.'),'Non-example address: '+f);}
 if(f.endsWith('.md'))for(const m of s.matchAll(/\]\(([^)]+)\)/g)){if(!/^(?:https?:|#)/.test(m[1]))assert(fs.existsSync(path.resolve(path.dirname(f),m[1])),'Broken relative link: '+f);}
}
for(const f of allowed)assert(files.includes(f),'Missing candidate file: '+f);
console.log('Candidate allowlist/path/credential-pattern/link checks PASS: '+files.length+' files');
