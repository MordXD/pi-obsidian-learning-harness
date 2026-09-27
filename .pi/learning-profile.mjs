/** Explicit resources for a learning launch; global settings/auth remain untouched. */
import {existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
export function learningProfile(cwd, agentDir=process.env.PI_CODING_AGENT_DIR||join(homedir(),'.pi/agent')) {
  cwd=resolve(cwd); agentDir=resolve(agentDir);
  const extensions=['tutor.ts','quiz.ts','md-log.ts','learning-sources.ts','visual-tools/index.ts'].map(p=>join(cwd,'.pi/extensions',p));
  const skills=['teach','probe','learn-profile','learn-verify','learn-visual'].map(p=>join(cwd,'.pi/skills',p,'SKILL.md'));
  for(const path of [...extensions,...skills])if(!existsSync(path))throw new Error(`Required learning resource is missing: ${path}`);
  const optionalExtensions=['bash-guard/index.ts','web-search/index.ts','web-fetch/index.ts','ask-user-question.ts','orca-prefill.ts','orca-agent-status.ts','orca-titlebar-spinner.ts'];
  const missingOptional=[];
  for(const path of optionalExtensions){const full=join(agentDir,'extensions',path);if(existsSync(full))extensions.push(full);else missingOptional.push(path);}
  const pdf=join(agentDir,'skills/pdf-reader/SKILL.md');
  if(existsSync(pdf))skills.push(pdf);else missingOptional.push('pdf-reader');
  const args=['--no-extensions','--no-skills','--no-prompt-templates',...extensions.flatMap(p=>['--extension',p]),...skills.flatMap(p=>['--skill',p])];
  return {cwd,agentDir,extensions,skills,missingOptional,args};
}
