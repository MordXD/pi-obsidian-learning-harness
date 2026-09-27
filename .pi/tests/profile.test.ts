import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,cpSync,rmSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {learningProfile} from '../learning-profile.mjs';

test('launcher forwards session arguments and loads only explicit resources without changing global settings',()=>{
 const root=mkdtempSync(join(tmpdir(),'learning profile ')),cwd=join(root,'vault'),agent=join(root,'agent'),bin=join(root,'bin');
 try {
  mkdirSync(cwd);mkdirSync(bin);mkdirSync(agent);mkdirSync(join(cwd,'.pi'));
  const source=resolve(import.meta.dir,'../..');
  cpSync(join(source,'pi-learn'),join(cwd,'pi-learn'));
  for(const file of ['learning-profile.mjs','learning-launcher.mjs'])cpSync(join(source,'.pi',file),join(cwd,'.pi',file));
  for(const file of ['tutor.ts','quiz.ts','md-log.ts','learning-sources.ts','visual-tools/index.ts','subagents/index.ts']){const path=join(cwd,'.pi/extensions',file);mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,'');}
  for(const name of ['teach','probe','learn-profile','learn-verify','learn-visual','unrelated']){const dir=join(cwd,'.pi/skills',name);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'SKILL.md'),'');}
  for(const file of ['bash-guard/index.ts','browser/index.ts','unrelated.ts']){const path=join(agent,'extensions',file);mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,'');}
  mkdirSync(join(agent,'skills/pdf-reader'),{recursive:true});writeFileSync(join(agent,'skills/pdf-reader/SKILL.md'),'');
  writeFileSync(join(bin,'pi'),'#!/usr/bin/env node\nconsole.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));',{mode:0o755});
  const profile=learningProfile(realpathSync(cwd),agent);
  expect(profile.extensions).toHaveLength(6);expect(profile.skills).toHaveLength(6);
  expect(profile.extensions.some(p=>p.includes('bash-guard'))).toBe(true);
  expect([...profile.skills,...profile.extensions].some(p=>/subagents|browser|unrelated/.test(p))).toBe(false);
  const result=spawnSync('sh',[join(cwd,'pi-learn'),'--session','example-id','a prompt with spaces'],{cwd:root,encoding:'utf8',env:{...process.env,PATH:bin+':'+process.env.PATH,PI_CODING_AGENT_DIR:agent}});
  expect(result.status).toBe(0);expect(JSON.parse(result.stdout)).toEqual({cwd:realpathSync(cwd),args:[...profile.args,'--session','example-id','a prompt with spaces']});
 } finally {rmSync(root,{recursive:true,force:true});}
});
