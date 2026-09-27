/** Real Pi loader and optional live, synthetic two-turn scenario. No private vault copied. */
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {dirname,join,resolve} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {mkdtempSync,mkdirSync,cpSync,readFileSync,writeFileSync,realpathSync,existsSync,readdirSync} from 'node:fs';
const args=process.argv.slice(2), source=resolve(args[0]||process.cwd()), provider=args[1], modelId=args[2], thinking=args[3]||'medium';
const bin=execFileSync('which',['pi'],{encoding:'utf8'}).trim();
let packageRoot=dirname(realpathSync(bin));
while(!existsSync(join(packageRoot,'package.json'))&&dirname(packageRoot)!==packageRoot)packageRoot=dirname(packageRoot);
const sdkPath=join(packageRoot,'dist/index.js');
const {DefaultResourceLoader,SettingsManager,ModelRuntime,SessionManager,createAgentSession}=await import(pathToFileURL(sdkPath));
const {AuthStorage}=await import(pathToFileURL(join(dirname(sdkPath),'core/auth-storage.js')));
const root=mkdtempSync(join(tmpdir(),'pi-learning-smoke-')),agentDir=join(root,'agent'),cwd=join(root,'vault');
mkdirSync(agentDir);mkdirSync(cwd);mkdirSync(join(cwd,'.pi'));mkdirSync(join(cwd,'.alvar'));
for(const part of ['extensions','skills','agents'])if(existsSync(join(source,'.pi',part)))cpSync(join(source,'.pi',part),join(cwd,'.pi',part),{recursive:true});
writeFileSync(join(cwd,'lesson.md'),'');writeFileSync(join(cwd,'.pi/mdlog.json'),JSON.stringify({file:join(cwd,'lesson.md')}));
writeFileSync(join(cwd,'.alvar/LEARNER.md'),'# Synthetic learner\nGoal: understand a small filter lab. Knows sums and arrays. Prefers complete explanations, visual maps and three-choice survey questions. No previous mastery is assumed.\n');
const settings=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}});settings.setProjectTrusted(true);
// Prove that unrelated auto-discovered extensions/skills are excluded by the same profile as pi-learn.
mkdirSync(join(agentDir,'extensions'));writeFileSync(join(agentDir,'extensions/unrelated.ts'),'throw new Error("Unrelated extension must not load");');
mkdirSync(join(agentDir,'skills/unrelated'),{recursive:true});writeFileSync(join(agentDir,'skills/unrelated/SKILL.md'),'---\nname: unrelated\ndescription: Must not be advertised\n---\nUnrelated');
const {learningProfile}=await import(pathToFileURL(join(source,'.pi/learning-profile.mjs')));
const profile=learningProfile(cwd,agentDir);
const loader=new DefaultResourceLoader({cwd,agentDir,settingsManager:settings,noContextFiles:true,noExtensions:true,noSkills:true,noPromptTemplates:true,additionalExtensionPaths:profile.extensions,additionalSkillPaths:profile.skills});await loader.reload();
const actualExtensions=loader.getExtensions().extensions.map(e=>resolve(e.path)).sort();
if(JSON.stringify(actualExtensions)!==JSON.stringify([...profile.extensions].sort()))throw new Error('Learning profile extension set mismatch');
const actualSkills=loader.getSkills().skills.map(s=>resolve(s.filePath)).sort();
if(JSON.stringify(actualSkills)!==JSON.stringify([...profile.skills].sort()))throw new Error('Learning profile skill set mismatch');
const loaded=loader.getExtensions();
const sourceHashes={};for(const file of readdirSync(join(cwd,".pi"),{recursive:true}).sort()){const name=String(file);try{const bytes=readFileSync(join(cwd,".pi",name));if(name!=="mdlog.json")sourceHashes[name]=createHash("sha256").update(bytes).digest("hex");}catch(error){if(error.code!=="EISDIR")throw error;}}
const report={piVersion:JSON.parse(readFileSync(join(dirname(sdkPath),'../package.json'),'utf8')).version,provider,model:modelId,thinking,extensions:loaded.extensions.map(e=>e.path.replace(cwd,'<vault>')),sourceHashes,errors:loaded.errors,skills:loader.getSkills().skills.map(s=>s.name),root};
console.log(JSON.stringify({...report,sourceHashes:undefined,sourceFileCount:Object.keys(sourceHashes).length}));
if(loaded.errors.length)process.exitCode=1;
if(!provider || loaded.errors.length)process.exit();
// Credentials are loaded into memory only; neither secrets nor global settings are copied to the fixture/output.
const userAgent=process.env.PI_CODING_AGENT_DIR||join(homedir(),'.pi/agent');
const authPath=join(userAgent,'auth.json');
const credentials=AuthStorage.inMemory(existsSync(authPath)?JSON.parse(readFileSync(authPath,'utf8')):{});
const runtime=await ModelRuntime.create({credentials,modelsPath:join(userAgent,'models.json'),modelsStorePath:join(agentDir,'models-cache.json'),allowModelNetwork:false});
const model=runtime.getModel(provider,modelId);if(!model)throw new Error('Requested model is not configured');
const {session}=await createAgentSession({cwd,agentDir,model,thinkingLevel:thinking,modelRuntime:runtime,resourceLoader:loader,sessionManager:SessionManager.inMemory(cwd),settingsManager:settings});
const trace=[],errors=[];let calls=0,questions=0,phase=0;
const ui=new Proxy({notify(message,type){errors.push({message,type});},custom:async()=>{questions++;return questions===1?{dontKnow:true,answers:[],note:''}:undefined;},editor:async()=>undefined},{get(t,k){return k in t?t[k]:()=>undefined;}});
session.subscribe(e=>{if(['tool_execution_start','tool_execution_end','message_end'].includes(e.type))trace.push({phase,...e});if(e.type==='message_end' && e.message?.role==='assistant' && ['error','aborted'].includes(e.message.stopReason))errors.push({stopReason:e.message.stopReason,message:e.message.errorMessage});if(e.type==='tool_execution_start'){calls++;if(calls>45||questions>3)void session.abort();}if(e.type==='tool_execution_end')console.log(JSON.stringify({phase,tool:e.toolName,error:e.isError}));});
await session.bindExtensions({uiContext:ui,mode:'interactive',onError:e=>errors.push(e)});
session.setActiveToolsByName(session.getAllTools().map(t=>t.name).filter(n=>['read','write','edit','quiz','quiz-open','html-preview','render-svg'].includes(n)||n.startsWith('learning-')));
console.log(JSON.stringify({activeTools:session.getActiveToolNames()}));
const prompts=[
 '/skill:teach Я основной ученик. Хочу обзорную диагностику темы «скользящее среднее как фильтр» для понимания учебной лабораторной. Знаю массивы и суммы. Покажи карту темы с зависимостями и маршрутом занятий, затем начинай диагностику по всей карте, вопросы с тремя вариантами. После пропуска вопроса остановись до моей следующей реплики.',
 'Останови обзор на минуту. Я не понял, почему усреднение трёх соседних отсчётов ослабляет чередующийся сигнал. Объясни на конкретных числах и рисунке; покажи промежуточные шаги. Сейчас вопрос не задавай, после объяснения я сам отвечу.'
];
let timedOut=false;const timer=setTimeout(()=>{timedOut=true;void session.abort();},240000);
try{for(const prompt of prompts){await session.prompt(prompt);phase++;questions=0;if(calls>45||timedOut)break;}}
finally{clearTimeout(timer);report.provider=session.model?.provider;report.model=session.model?.id;report.thinking=session.thinkingLevel;report.toolErrors=trace.filter(e=>e.type==="tool_execution_end"&&e.isError).length;report.timedOut=timedOut;report.systemPromptHash=createHash("sha256").update(session.systemPrompt).digest("hex");report.tools=session.getActiveToolNames();report.calls=calls;report.notifications=errors;report.traceFile=join(root,'trace.json');writeFileSync(report.traceFile,JSON.stringify(trace,null,2));writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2));session.dispose();console.log(JSON.stringify({completed:true,root,calls,errors:errors.length}));}
