import {test,expect,afterEach} from "bun:test";
import {mkdtempSync,rmSync,readFileSync,writeFileSync,mkdirSync,cpSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {TutorStore,withStore,type Task} from "../extensions/lib/tutor-store";
import {planHtml} from "../extensions/lib/tutor-plan";
import {saveLogTarget} from "../extensions/lib/learning";
import tutor from "../extensions/tutor";
import quiz from "../extensions/quiz";
import logger from "../extensions/md-log";
import visuals from "../extensions/visual-tools/index";
const roots:string[]=[], stores:TutorStore[]=[];
function setup(){const cwd=mkdtempSync(join(tmpdir(),"curriculum-"));roots.push(cwd);const s=new TutorStore(cwd);stores.push(s);s.record("context","context",{learnerId:"owner",subject:"Signals",topic:"Filters",goal:"Understand the lab"});return s;}
afterEach(()=>{for(const s of stores.splice(0))try{s.close()}catch{};for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
const task:Task={skill:"a",family:"filters",mode:"independent",assistance:"none",rubric:["explain the transition"],verification:"direct substitution",depth:4};
const plan={thesis:"The output is a weighted sum of delayed inputs.",areas:[{skill:"a",label:"Samples",status:"unprobed" as const,prerequisites:[],targetDepth:3},{skill:"b",label:"Impulse response",status:"unprobed" as const,prerequisites:["a"],targetDepth:3},{skill:"c",label:"Frequency response",status:"unprobed" as const,prerequisites:["b"],targetDepth:3}],connections:[{from:"a",to:"b",reason:"Trace one nonzero input"},{from:"b",to:"c",reason:"Combine weighted delayed harmonics"}],sessions:[{title:"Time",goal:"Trace the response",skills:["a","b"]},{title:"Frequency",goal:"Predict a graph",skills:["c"]}]};
function survey(s:TutorStore){s.savePlan("p",plan);s.record("session","session",{stage:"survey",questionFormat:"choice",optionCount:3,scopeSkills:[]});}
function response(s:TutorStore,id:string,skill:string,mode="open",result="correct",reasoning="sound") {s.question(id,{question:"What changes?",mode,task:{...task,skill}});s.answer(id,{outcome:result==="correct"?"correct":"dont_know",yourAnswer:result==="correct"?"It shifts by one sample":"Не знаю",note:mode==="open"?undefined:"The input moved"});s.assess(id,{questionId:id,result,reasoning,nextCheck:"new case"} as any);}
function harness(s:TutorStore){const handlers=new Map<string,Function[]>(),tools=new Map<string,any>(),commands=new Map<string,any>();const pi={on(n:string,f:Function){handlers.set(n,[...(handlers.get(n)||[]),f]);},registerTool(t:any){tools.set(t.name,t);},registerCommand(n:string,c:any){commands.set(n,c)},events:{on(){},emit(){}}};const ctx:any={cwd:s.cwd,hasUI:true,ui:{notify(){},custom:async()=>({dontKnow:false,note:"because",answers:[{label:"one",value:"one",index:1}]}),editor:async()=>"answer"}};tutor(pi as any);quiz(pi as any);logger(pi as any);visuals(pi as any);return {tools,ctx,commands,fire(n:string,e:any={}){for(const f of handlers.get(n)||[])f(e,ctx)},async call(n:string,p:any,id:string){const result=await tools.get(n).execute(id,p,null,null,ctx);for(const f of handlers.get("tool_execution_end")||[])f({toolName:n,toolCallId:id,result},ctx);return result;},before(prompt="base"){return handlers.get("before_agent_start")![0]({systemPrompt:prompt},ctx)}};}
const choice={question:"How many?",shuffle:false,options:[{label:"one",value:"one"},{label:"two",value:"two"},{label:"three",value:"three"}],correctAnswer:"one",explanation:"One is present.",task};

test("multi-turn survey preserves breadth, choice format, support return and restarts",async()=>{
 const s=setup();survey(s);const h=harness(s);
 for(const id of ["recognition1","recognition2"])response(s,id,"a","single-select");
 expect((await h.call("quiz",choice,"choice3")).details.status).toBe("answered");
 expect((await h.call("quiz-open",{question:"derive",task},"open")).details.status).toBe("unavailable");
 s.assess("choice3",{questionId:"choice3",result:"correct",reasoning:"unobserved",nextCheck:"later reasoning"});
 response(s,"gap","a","single-select","uncertain","unobserved");
 expect(s.recommend().candidates.some(c=>c.action==="probe_topic"&&c.areas.includes("b"))).toBe(true);
 expect(s.activeSupport()).toBeNull();
 s.record("help","support",{supportStatus:"active",focus:"one delay",nextStep:"trace an object",basis:"Explain this step",trigger:"help_requested"});
 expect(s.recommend().candidates[0].action).toBe("explain_current");
 const reopened=new TutorStore(s.cwd);stores.push(reopened);expect(reopened.contract()?.optionCount).toBe(3);
 reopened.record("help-done","support",{supportStatus:"resolved",focus:"one delay",nextStep:"return to survey",basis:"Student correctly explained the delayed input",trigger:"help_requested"});
 expect(reopened.recommend().candidates.some(c=>c.action==="probe_topic"&&c.areas.includes("b"))).toBe(true);
 reopened.record("limit","survey-limit",{skill:"b",reason:"Cannot yet trace the input; application is not tested"});
 expect(reopened.recommend().candidates.some(c=>c.action==="probe_topic"&&c.areas.includes("c"))).toBe(true);
 expect(reopened.state().coverage.find(a=>a.skill==="b").status).toBe("unprobed");
});

test("new session goal resets support and pending question without erasing knowledge",()=>{const s=setup();survey(s);response(s,"proof","a");s.question("unfinished",{question:"old",mode:"open",task});s.record("help","support",{supportStatus:"active",focus:"old",nextStep:"old",basis:"old"});s.record("new-context","context",{learnerId:"owner",subject:"Signals",topic:"Filters",goal:"Survey another goal"});expect(s.activeSupport()).toBeNull();expect(s.contract()).toBeNull();expect(s.state().skills.a.independent).toBe(true);expect(s.state().pendingQuestion).toHaveLength(0);s.record("new-session","session",{stage:"review",questionFormat:"adaptive",scopeSkills:[]});expect(s.recommend().candidates[0].action).not.toBe("explain_current");});

test("topic aliases restore evidence and plans without merging other learners",()=>{const s=setup();survey(s);response(s,"proof","a");s.record("rename","context",{learnerId:"owner",subject:"Signals",topic:"Lab 1",topicId:"fir-lab",aliases:["Filters"],goal:"Understand the lab"});expect(s.state().skills.a.independent).toBe(true);expect(s.plan()?.thesis).toBe(plan.thesis);expect(s.contract()?.stage).toBe("survey");s.record("other","context",{learnerId:"owner",subject:"Signals",topic:"Another topic",goal:"other"});expect(s.inspect("catalog").Signals.topics).toHaveLength(2);s.record("guest","context",{learnerId:"guest",subject:"Signals",topic:"Lab 1",topicId:"fir-lab",aliases:["Filters"],goal:"learn"});expect(s.state().skills).toEqual({});expect(s.plan()).toBeNull();});

test("aliases reject accidental collision",()=>{const s=setup();s.record("a","context",{learnerId:"owner",subject:"Signals",topic:"Filters",topicId:"a",goal:"learn"});expect(()=>s.record("bad","context",{learnerId:"owner",subject:"Signals",topic:"Other",topicId:"b",aliases:["Filters"],goal:"learn"})).toThrow("already belongs");});

test("coverage merges branches and plans require optimistic version and explained edges",()=>{const s=setup();survey(s);s.record("small","coverage",{areas:[{skill:"a",note:"check sign"}]});expect(s.state().coverage).toHaveLength(3);expect(s.state().coverage.find(a=>a.skill==="a").label).toBe("Samples");expect(()=>s.record("erase","coverage",{areas:[plan.areas[0]],replace:true})).toThrow("reason");expect(()=>s.savePlan("stale",plan)).toThrow("expectedVersion");expect(()=>s.savePlan("missing-edge",{...plan,expectedVersion:1,connections:[]})).toThrow("Explain why");const updated=s.savePlan("p2",{...plan,expectedVersion:1,thesis:"A more precise idea"});expect(updated.version).toBe(2);expect(s.savePlan("p2",{...plan,expectedVersion:1,thesis:"A more precise idea"}).version).toBe(2);expect(s.inspect("plans").saved).toHaveLength(2);});

test("weaker success preserves mastery; actual contradiction remains until independent repair",()=>{const s=setup();survey(s);response(s,"proof","a");const due=s.state().skills.a.dueAt;response(s,"choice","a","single-select");expect(s.state().coverage[0].status).toBe("solid");expect(s.state().skills.a.dueAt).toBe(due);response(s,"wrong","a","open","partial","incorrect");expect(s.state().coverage[0].status).toBe("shaky");response(s,"easy","a","single-select");expect(s.state().coverage[0].status).toBe("shaky");expect(s.state().skills.a.bestIndependent.questionId).toBe("proof");response(s,"repair","a");expect(s.state().coverage[0].status).toBe("solid");});

test("ordinary messages are observable but never auto-graded; invented excerpt rejected",()=>{const s=setup();const h=harness(s);h.fire("message_end",{message:{role:"user",timestamp:1,content:"The delay stores the previous input."}});expect(s.state().skills).toEqual({});const msg=s.summary().recentUserMessages[0];expect(()=>s.conversationResponse("bad",msg.messageId,"What is stored?","invented",task)).toThrow("observed");s.conversationResponse("answer",msg.messageId,"What is stored?","previous input",task);expect(s.state().pendingAssessments).toEqual(["answer"]);s.assess("grade",{questionId:"answer",result:"correct",reasoning:"sound",nextCheck:"new case"});expect(s.state().skills.a.independent).toBe(true);});

test("full map is delivered once to the active note even when the tutor forgets its embed",async()=>{const s=setup();survey(s);const note=join(s.cwd,"lesson.md");saveLogTarget(s.cwd,note);s.record("note-context","context",{learnerId:"owner",subject:"Signals",topic:"Filters",goal:"Understand the lab"});const h=harness(s);h.fire("session_start");const r=await h.call("learning-map",{},"map");expect(s.state().boards.deliveredCount).toBe(0);const html=readFileSync(r.details.file,"utf8");expect(html).toContain(plan.thesis);expect(html).toContain("Trace one nonzero input");expect(html).toContain("Маршрут занятий");h.fire("message_end",{message:{role:"assistant",timestamp:1,content:"Start with inputs because the response depends on them."}});const text=readFileSync(note,"utf8");expect(text).toContain(r.details.markdown);expect(s.state().boards.deliveredCount).toBe(1);h.fire("message_end",{message:{role:"assistant",timestamp:1,content:"Start with inputs because the response depends on them."}});expect(readFileSync(note,"utf8")).toBe(text);});

test("HTML delivery is tracked, skipped on user interruption, and does not follow a changed note",async()=>{const s=setup();const first=join(s.cwd,"first.md");saveLogTarget(s.cwd,first);const h=harness(s);h.fire("session_start");const r=await h.call("html-preview",{title:"delay",html:"<html><body>delay</body></html>"},"html");h.fire("message_end",{message:{role:"assistant",timestamp:1,content:"Read this transition."}});expect(readFileSync(first,"utf8")).toContain(r.details.embed);expect(s.state().boards.deliveredCount).toBe(1);const interrupted=await h.call("html-preview",{title:"old",html:"<html>old</html>"},"old");h.fire("message_end",{message:{role:"user",timestamp:2,content:"Change topic"}});h.fire("message_end",{message:{role:"assistant",timestamp:3,content:"New topic"}});expect(readFileSync(first,"utf8")).not.toContain(interrupted.details.embed);await h.call("html-preview",{title:"pending",html:"<html>pending</html>"},"pending");const second=join(s.cwd,"second.md");await h.commands.get("md-log").handler(second,h.ctx);h.fire("message_end",{message:{role:"assistant",timestamp:4,content:"A different note"}});expect(readFileSync(second,"utf8")).not.toContain("```artifact");});

test("runtime reload restores the contract and only injects planning when missing",()=>{const s=setup();const dir=join(s.cwd,".pi/skills/teach/references");mkdirSync(dir,{recursive:true});writeFileSync(join(dir,"turn-policy.md"),"TURN");writeFileSync(join(dir,"process.md"),"SUBSTANTIVE PLAN");const h=harness(s);const before=h.before().systemPrompt;expect(before).toContain("SUBSTANTIVE PLAN");survey(s);const next=h.before(before).systemPrompt;expect(next.match(/<learning-turn-policy>/g)).toHaveLength(1);expect(next).not.toContain("SUBSTANTIVE PLAN");expect(next).toContain('"questionFormat":"choice"');expect(next).toContain(plan.thesis);});

test("map safely renders labels and keeps untested and gaps distinct",()=>{const areas=plan.areas.map((a,i)=>({...a,label:i? a.label:'<script>alert(1)</script>',status:i?"shaky":"unprobed"}));const html=planHtml({...plan,version:1},areas,"map");expect(html).not.toContain("<script>alert(1)</script>");expect(html).toContain("&lt;script&gt;");expect(html).toContain("Не проверяли");expect(html).toContain("Наблюдалось затруднение");});


test("plan edits cannot silently detach coverage from its session route",()=>{const s=setup();survey(s);expect(()=>s.record("extra","coverage",{areas:[{skill:"d",label:"Other"}]})).toThrow("learning-plan");expect(s.state().coverage).toHaveLength(3);});

test("shallower evidence retains accurate provenance and cannot repair deeper contradiction",()=>{const s=setup();s.record("map","coverage",{areas:[{skill:"a",targetDepth:4}]});response(s,"deep","a");const shallow=(id:string)=>{s.question(id,{question:"explain",mode:"open",task:{...task,depth:2}});s.answer(id,{outcome:"pending_review",yourAnswer:"explanation"});s.assess(id,{questionId:id,result:"correct",reasoning:"sound",nextCheck:"deeper"});};shallow("shallow");expect(s.state().skills.a.bestIndependent).toMatchObject({questionId:"deep",depth:4});expect(s.state().coverage[0].status).toBe("solid");response(s,"wrong","a","open","incorrect","incorrect");shallow("repair");expect(s.state().coverage[0].status).toBe("probed");expect(s.state().coverage[0].needsDepth).toBe(true);expect(s.state().skills.a.maxIndependentDepth).toBe(4);});

test("replayed visual tools reuse the frame and reject conflicting parameters",async()=>{const s=setup();survey(s);const h=harness(s);const params={title:"diagram",html:"<html>one</html>"};const a=await h.call("html-preview",params,"html");const b=await h.call("html-preview",params,"html");expect(b.details.file).toBe(a.details.file);await expect(h.call("html-preview",{...params,title:"changed"},"html")).rejects.toThrow("Conflicting");const m=await h.call("learning-map",{},"map");expect((await h.call("learning-map",{},"map")).details.file).toBe(m.details.file);expect(s.state().boards.count).toBe(2);expect(s.state().boards.pending).toHaveLength(2);});

test("failed note append retains multiple prepared frames for a successful retry",async()=>{const s=setup();survey(s);const note=join(s.cwd,"lesson.md");saveLogTarget(s.cwd,note);const h=harness(s);h.fire("session_start");const a=await h.call("html-preview",{title:"one",html:"<html>one</html>"},"one");const b=await h.call("html-preview",{title:"two",html:"<html>two</html>"},"two");rmSync(note);mkdirSync(note);const message={role:"assistant",timestamp:4,content:"Compare both drawings."};h.fire("message_end",{message});expect(s.state().boards.deliveredCount).toBe(0);rmSync(note,{recursive:true});h.fire("message_end",{message});expect(readFileSync(note,"utf8")).toContain(a.details.embed);expect(readFileSync(note,"utf8")).toContain(b.details.embed);expect(s.state().boards.deliveredCount).toBe(2);expect(s.state().boards.pending).toHaveLength(0);});

test("open format is preserved and a new session cancels stale support",async()=>{const s=setup();survey(s);s.record("help","support",{supportStatus:"active",focus:"sample",nextStep:"trace",basis:"explain"});s.record("open","session",{stage:"review",questionFormat:"open",scopeSkills:[]});expect(s.activeSupport()).toBeNull();const h=harness(s);expect((await h.call("quiz",choice,"choice")).details.status).toBe("unavailable");expect((await h.call("quiz-open",{question:"explain",task},"open")).details.status).toBe("pending_review");});


test("plan sources and cross-topic context survive updates and goal changes request review",()=>{const s=setup();s.savePlan("p",{...plan,sources:[{title:"Sample textbook",location:"Chapter 2",skills:["a"]}],crossLinks:[{topicId:"arrays",relation:"builds on",reason:"Indexed samples"}],notes:["Boundary cases remain open"]});s.savePlan("update",{...plan,expectedVersion:1});expect(s.plan()?.sources).toHaveLength(1);expect(s.plan()?.notes).toContain("Boundary cases remain open");s.record("new-goal","context",{learnerId:"owner",subject:"Signals",topic:"Filters",goal:"Prove stability"});expect(s.summary().plan).toMatchObject({needsReview:true});});

test("a fresh survey includes overdue branches without erasing prior evidence",()=>{const s=setup();survey(s);response(s,"past","a");const future=Date.now()+40*86400000;const state=s.state(future);expect(state.coverage[0].status).toBe("solid");expect(state.coverage[0].reviewDue).toBe(true);expect(s.recommend(future).candidates.some(c=>c.action==="probe_topic"&&c.areas.includes("a"))).toBe(true);expect(planHtml({...plan,version:1},state.coverage,"map")).toContain("нужна повторная проверка");});


test("explanation without a question directs the tutor to instruction without fabricating evidence",async()=>{const s=setup();const h=harness(s);await expect(h.call("learning-record",{kind:"assistance",skill:"a",summary:"A demo"},"bad-help")).rejects.toThrow("use kind=instruction");await h.call("learning-record",{kind:"instruction",skill:"a",family:"filters",mode:"worked",summary:"A demo of delay",verification:"checked against array"},"demo");expect(s.state().skills).toEqual({});expect(s.state().recentInstructions).toHaveLength(1);});

test("dont-know is explicit in model-visible results for both quiz formats",async()=>{
 const s=setup(),h=harness(s);h.ctx.ui.editor=async()=>"не знаю";
 const open=await h.call("quiz-open",{question:"Explain",task},"unknown-open");
 expect(open.content[0].text).toContain("responseId: unknown-open");expect(open.content[0].text).toContain("outcome: dont_know");
 h.ctx.ui.custom=async()=>({dontKnow:true,note:"",answers:[]});
 const closed=await h.call("quiz",choice,"unknown-choice");
 expect(JSON.parse(closed.content[0].text)).toMatchObject({responseId:"unknown-choice",outcome:"dont_know"});
 const result=await h.call("learning-assess",{responseId:"unknown-open",result:"uncertain",reasoning:"unobserved",nextCheck:"clarify prerequisites"},"review-unknown");
 expect(result.details.context.pendingAssessments).toEqual(["unknown-choice"]);
});

test("one conversation review registers, assesses and resolves help with fresh context",async()=>{
 const s=setup();survey(s);s.observe("actual","The output is the sum divided by three.");
 s.record("help","support",{supportStatus:"active",trigger:"help_requested",focus:"mean",basis:"requested example",nextStep:"explain"});
 const h=harness(s),request={messageId:"utterance:actual",question:"Explain the mean",excerpt:"sum divided by three",task:{...task,mode:"completion",assistance:"worked"},assessment:{result:"correct",reasoning:"sound",nextCheck:"new independent case"},resolveSupport:{basis:"Explained the demonstrated step",nextStep:"Return to survey"}};
 const result=await h.call("learning-response",request,"combined");
 expect(result.details.responseId).toBe("combined");expect(result.details.context.pendingAssessments).toEqual([]);
 expect(result.details.context.support).toMatchObject({supportStatus:"resolved",trigger:"help_requested",focus:"mean"});
 expect(s.state().skills.a.independent).toBe(false);
 const count=s.events().length;await h.call("learning-response",request,"combined");expect(s.events()).toHaveLength(count);
 await expect(h.call("learning-response",{...request,assessment:{...request.assessment,result:"incorrect"}},"combined")).rejects.toThrow("Conflicting review");
});

test("failed combined review rolls back question, answer, assessment and support",async()=>{
 const s=setup();s.observe("actual","I think it is three");const h=harness(s),count=s.events().length;
 const base={messageId:"utterance:actual",question:"Explain",excerpt:"three",task,assessment:{result:"correct",reasoning:"sound",evidence:"invented evidence",nextCheck:"another case"}};
 await expect(h.call("learning-response",base,"rollback")).rejects.toThrow("Evidence");
 expect(s.events()).toHaveLength(count);expect(s.questions()).toHaveLength(0);
 await expect(h.call("learning-response",{...base,assessment:{...base.assessment,evidence:"three"},resolveSupport:{basis:"finished",nextStep:"survey"}},"rollback")).rejects.toThrow("No active support");
 expect(s.events()).toHaveLength(count);
 const valid=await h.call("learning-response",{...base,assessment:{...base.assessment,evidence:"three"}},"rollback");
 expect(valid.details.responseId).toBe("rollback");
});

test("combined review cannot link a different learner's utterance or close old-session help",async()=>{
 const s=setup();s.observe("owner","a clear explanation");
 s.record("guest","context",{learnerId:"guest",subject:"Signals",topic:"Filters",goal:"Understand the lab"});
 const h=harness(s),count=s.events().length;
 await expect(h.call("learning-response",{messageId:"utterance:owner",question:"Explain",excerpt:"clear",task,assessment:{result:"correct",reasoning:"sound",nextCheck:"transfer"}},"leak")).rejects.toThrow("observed user message");
 expect(s.events()).toHaveLength(count);
 s.record("help","support",{supportStatus:"active",trigger:"help_requested",focus:"a",basis:"help",nextStep:"example"});
 s.record("fresh","session",{stage:"review",questionFormat:"open",scopeSkills:[]});
 await expect(h.call("learning-record",{kind:"support",supportStatus:"resolved",basis:"done",nextStep:"continue"},"stale")).rejects.toThrow("No active support");
});

test("inferred assessment returns its actual responseId and context without a follow-up read",async()=>{
 const s=setup(),h=harness(s);s.question("only",{question:"Explain",mode:"open",task});s.answer("only",{outcome:"pending_review",yourAnswer:"three"});
 const result=await h.call("learning-assess",{result:"partial",reasoning:"unobserved",nextCheck:"ask why"},"inferred");
 expect(result.details.responseId).toBe("only");expect(result.details.context.pendingAssessments).toEqual([]);
 const count=s.events().length;await h.call("learning-assess",{result:"partial",reasoning:"unobserved",nextCheck:"ask why"},"inferred");expect(s.events()).toHaveLength(count);
});

test("learning-next does not regenerate projection files",async()=>{
 const s=setup(),h=harness(s);const file=join(s.cwd,".alvar/current.json");writeFileSync(file,"sentinel");
 await h.call("learning-next",{},"read-only");expect(readFileSync(file,"utf8")).toBe("sentinel");
});

test("startup injects essential guidance, IDs and only the active learner profile",()=>{
 const s=setup();cpSync(resolve(import.meta.dir,"../skills"),join(s.cwd,".pi/skills"),{recursive:true});
 writeFileSync(join(s.cwd,".alvar/LEARNER.md"),"OWNER_PRIVATE_PREFERENCE");
 s.observe("recent","My actual response");const h=harness(s);const first=h.before().systemPrompt;
 expect(first).toContain("Учебная среда уже подготовлена");expect(first).toContain("utterance:recent");expect(first).toContain("OWNER_PRIVATE_PREFERENCE");expect(first).toContain("Technique index");
 s.record("guest","context",{learnerId:"guest",subject:"Signals",topic:"Filters",goal:"Learn"});
 const second=h.before(first).systemPrompt;
 expect(second).not.toContain("OWNER_PRIVATE_PREFERENCE");expect(second).not.toContain("utterance:recent");
 expect(second.split("<learning-turn-policy>")).toHaveLength(2);
});

test("support closure without repeated trigger or focus can be replayed safely",async()=>{
 const s=setup(),h=harness(s);
 s.record("help","support",{supportStatus:"active",trigger:"explanation_confusion",focus:"mean",basis:"confused",nextStep:"example"});
 const request={kind:"support",supportStatus:"resolved",basis:"step explained",nextStep:"new example"};
 await h.call("learning-record",request,"close");const count=s.events().length;
 await h.call("learning-record",request,"close");expect(s.events()).toHaveLength(count);
 expect(s.activeSupport()).toMatchObject({supportStatus:"resolved",trigger:"explanation_confusion",focus:"mean"});
});
