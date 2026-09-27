import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {learningProfile} from './learning-profile.mjs';
const profile=learningProfile(fileURLToPath(new URL('../',import.meta.url)));
const args=process.argv.slice(2);
if(args.length===1&&args[0]==='--print-profile')console.log(JSON.stringify(profile,null,2));
else {
  const child=spawn('pi',[...profile.args,...args],{cwd:profile.cwd,stdio:'inherit'});
  child.on('error',error=>{console.error(error.message);process.exitCode=1;});
  child.on('exit',(code,signal)=>{if(signal){process.removeAllListeners(signal);process.kill(process.pid,signal);}else process.exitCode=code??1;});
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
}
