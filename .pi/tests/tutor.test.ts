import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TutorStore, type Task } from "../extensions/lib/tutor-store";
import { saveLogTarget } from "../extensions/lib/learning";
import tutor from "../extensions/tutor";
const roots: string[] = []; const stores: TutorStore[] = [];
function setup() { const cwd = mkdtempSync(join(tmpdir(), "tutor-v2-")); roots.push(cwd); const s = new TutorStore(cwd); stores.push(s); return s; }
afterEach(() => { for(const s of stores.splice(0)) { try{s.close()}catch{} } for(const r of roots.splice(0)) rmSync(r,{recursive:true,force:true}); });
const task: Task = {skill:"impulse",family:"fir-response",mode:"independent",assistance:"none",rubric:["substitutes delayed impulse correctly"],verification:"checked by direct substitution"};
function question(s: TutorStore, id="q", t=task, mode="open") {s.question(id,{question:"Find the response",mode,task:t});}
function assess(s: TutorStore,id="q",result="correct",reasoning="sound") {s.assess("a-"+id,{questionId:id,result,reasoning,evidence:"2, -1, 3",nextCheck:"derive a different filter"} as any);}
function answer(s: TutorStore,id="q") {s.answer(id,{outcome:"pending_review",yourAnswer:"2, -1, 3 because only one tap is active"});}
test("answer closes waiting state before assessment, persists across restart",()=>{const s=setup();question(s);answer(s);const other=new TutorStore(s.cwd);stores.push(other);other.start();expect(other.state().pendingQuestion).toHaveLength(0);expect(other.state().pendingAssessments).toEqual(["q"]);expect(other.state().skills).toEqual({});});
test("duplicate delivery is idempotent; contradictory delivery fails",()=>{const s=setup();question(s);answer(s);answer(s);expect(s.events().filter(e=>e.kind==="answer")).toHaveLength(1);expect(()=>s.answer("q",{outcome:"incorrect"})).toThrow("Conflicting");});
test("cancelled and unavailable are not knowledge failures",()=>{const s=setup();question(s);s.answer("q",{outcome:"cancelled"});expect(s.state().pendingAssessments).toEqual([]);expect(()=>assess(s)).toThrow();expect(s.state().skills).toEqual({});});
test("correct choice with bad reasoning proposes self explanation",()=>{const s=setup();question(s,"q",task,"single-select");s.answer("q",{outcome:"correct",yourAnswer:"2, -1, 3",note:"I think coefficients change"});assess(s,"q","correct","partial");expect(s.recommend().candidates.some(c=>c.action==="self_explanation")).toBe(true);expect(s.state().skills.impulse.independent).toBe(false);});
test("worked assistance never becomes independent success",()=>{const s=setup();question(s,"q",{...task,assistance:"worked",mode:"completion"});answer(s);assess(s);expect(s.state().skills.impulse.independent).toBe(false);expect(s.recommend().candidates.some(c=>c.action==="completion")).toBe(true);});
test("hint before answer disqualifies independence, feedback after does not",()=>{const s=setup();question(s);s.record("h","assistance",{questionId:"q",detail:"look at tap 2"});answer(s);assess(s);expect(s.state().skills.impulse.independent).toBe(false);question(s,"q2");answer(s,"q2");s.record("h2","assistance",{questionId:"q2",detail:"feedback after submission"});assess(s,"q2");expect(s.state().skills.impulse.independent).toBe(true);});
test("assessment requires actual answer evidence and task metadata",()=>{const s=setup();question(s);answer(s);expect(()=>s.assess("bad",{questionId:"q",result:"correct",reasoning:"sound",evidence:"invented",nextCheck:"next"})).toThrow("exact excerpt");});
test("due retrieval and intervals are based on answer dates",()=>{const s=setup();question(s);answer(s);assess(s);const state=s.state();const due=Date.parse(state.skills.impulse.dueAt);expect(s.recommend(due+1).candidates.some(c=>c.action==="retrieval")).toBe(true);expect(s.state(due-1).reviewDue).toHaveLength(0);});
test("retention requires delayed independent retrieval",()=>{const s=setup();question(s);s.append("answer:q","answer",{id:"q",outcome:"pending_review",yourAnswer:"2, -1, 3"},"2026-01-01T00:00:00Z");assess(s);question(s,"q2",{...task,mode:"retrieval"});s.append("answer:q2","answer",{id:"q2",outcome:"pending_review",yourAnswer:"2, -1, 3"},"2026-01-03T00:00:00Z");assess(s,"q2");expect(s.state().skills.impulse.retained).toBe(true);});
test("mixed practice records method selection separately",()=>{const s=setup();question(s,"q",{...task,mode:"mixed"});answer(s);assess(s);expect(s.state().skills.impulse.methodSelection).toBe(true);});
test("question retains original note when active target changes",()=>{const s=setup();saveLogTarget(s.cwd,join(s.cwd,"a.md"));question(s);saveLogTarget(s.cwd,join(s.cwd,"b.md"));answer(s);expect(s.questions()[0].learnerNote).toBe("a.md");expect(s.state().learnerNote).toBe("b.md");});
test("projection rebuilt after deletion or stale write",()=>{const s=setup();question(s);answer(s);writeFileSync(join(s.cwd,".alvar/current.json"),"{}");s.start();expect(JSON.parse(readFileSync(join(s.cwd,".alvar/current.json"),"utf8")).pendingAssessments).toEqual(["q"]);});
test("legacy statuses imported once as unverified context",()=>{const s=setup();writeFileSync(join(s.cwd,".alvar/current.json"),JSON.stringify({topic:"old",pendingQuestion:{question:"old?"},reviewDue:[{idea:"old idea"}]}));s.start();s.start();expect(s.state().pendingQuestion).toEqual([]);expect(s.state().legacyNeedsReview.pendingQuestion.question).toBe("old?");expect(s.events().filter(e=>e.kind==="legacy")).toHaveLength(1);});
test("new board frames retained; tool never changes earlier lesson",async()=>{const s=setup();const note=join(s.cwd,"lesson.md");writeFileSync(note,"Old board\n");saveLogTarget(s.cwd,note);const tools=new Map();tutor({on(){},registerTool(t:any){tools.set(t.name,t)}} as any);const ctx={cwd:s.cwd};const run=(id:string,code:string)=>tools.get("learning-board").execute(id,{boardId:"filter",mermaid:code,focus:"active branch"},null,null,ctx);const a=await run("b1",'flowchart LR\n A["x"] --> B["y"]');const b=await run("b2",'flowchart LR\n A["2x"] --> B["2y"]');expect(a.details.markdown).toContain('A["x"]');expect(b.details.markdown).toContain('A["2x"]');expect(readFileSync(note,"utf8")).toBe("Old board\n");expect(s.events().filter(e=>e.kind==="board")).toHaveLength(2);});

test("resuming replaces stale pending question without grading",()=>{const s=setup();question(s);s.question("q2",{question:"Find response",mode:"open",task,replacesQuestionId:"q"});expect(s.state().pendingQuestion.map(q=>q.id)).toEqual(["q2"]);expect(s.state().pendingAssessments).toEqual([]);expect(()=>assess(s)).toThrow();});
test("choice without reasoning cannot be marked sound",()=>{const s=setup();question(s,"q",task,"single-select");answer(s);expect(()=>assess(s)).toThrow("no reasoning evidence");});
test("intervening explanation invalidates delayed retention claim",()=>{const s=setup();question(s);s.append("answer:q","answer",{id:"q",outcome:"pending_review",yourAnswer:"2, -1, 3"},"2026-01-01T00:00:00Z");assess(s);s.record("explain","instruction",{skill:task.skill,family:task.family,mode:"worked",summary:"showed response",verification:"substitution"});question(s,"q2",{...task,mode:"retrieval"});s.append("answer:q2","answer",{id:"q2",outcome:"pending_review",yourAnswer:"2, -1, 3"},"2026-01-03T00:00:00Z");assess(s,"q2");expect(s.state().skills.impulse.retained).toBe(false);});
test("unestablished prerequisites block mixed recommendation",()=>{const s=setup();question(s,"q",{...task,prerequisites:["missing"]});answer(s);assess(s);expect(s.recommend().candidates.some(c=>c.action==="check_prerequisite")).toBe(true);});
test("worked example without a quiz offers a completion step",()=>{const s=setup();s.record("explain","instruction",{skill:task.skill,family:task.family,mode:"worked",summary:"showed response",verification:"substitution"});expect(s.recommend().candidates.some(c=>c.action==="completion")).toBe(true);});

test("subjects stay separate: another subject never leaks into the active view",()=>{
 const s=setup();
 s.record("c1","context",{topic:"filters",goal:"lab"});
 question(s,"f1",{...task,skill:"filters:tap"});answer(s,"f1");assess(s,"f1");
 saveLogTarget(s.cwd,join(s.cwd,"persona.md"));
 s.record("c2","context",{topic:"persona",goal:"course"});
 question(s,"p1",{...task,skill:"persona:evidence"});answer(s,"p1");assess(s,"p1");
 question(s,"p2",{...task,skill:"persona:traits"});answer(s,"p2");
 const view=s.summary();
 expect(view.subject).toBe("persona");
 expect(view.pendingAssessments).toEqual(["p2"]);
 expect(Object.keys(s.state().skills)).toEqual(["persona:evidence"]);
 expect(Object.keys(s.inspect("catalog")).sort()).toEqual(["filters","persona"]);
 expect(view.candidates.some(c=>c.skill==="filters:tap")).toBe(false);
});
test("note and recorded topic mismatch is surfaced instead of mixed",()=>{
 const s=setup();
 s.record("c1","context",{topic:"filters",goal:"lab"});
 saveLogTarget(s.cwd,join(s.cwd,"persona.md"));
 question(s,"p1",{...task,skill:"persona:evidence"});answer(s,"p1");assess(s,"p1");
 expect(s.summary().warning).toContain("does not match");
});
test("subject without a board frame gets a reminder until one is recorded",()=>{
 const s=setup();
 s.record("c1","context",{topic:"persona",goal:"course"});
 expect(s.summary().boards).toMatchObject({count:0});
 expect(s.summary().boards.reminder).toContain("Mermaid board");
 s.record("b1","board",{boardId:"persona-flow",mermaid:"flowchart LR\n A[\"x\"] --> B[\"y\"]",focus:"active branch"});
 expect(s.summary().boards).toMatchObject({count:1,reminder:null});
});
test("unprobed coverage areas drive diagnosis instead of one found gap",()=>{
 const s=setup();
 s.record("c1","context",{topic:"persona",goal:"course"});
 s.record("cov","coverage",{areas:[{skill:"persona:evidence",status:"probed"},{skill:"persona:attribution",status:"unprobed"},{skill:"persona:defenses",status:"unprobed"}]});
 const view=s.summary();
 expect(view.coverage.unprobed).toEqual(["persona:evidence","persona:attribution","persona:defenses"]);
 expect(view.candidates[0]).toMatchObject({action:"probe_topic",areas:["persona:evidence","persona:attribution","persona:defenses"]});
});
test("assessment accepts an inline task and survives quote and case differences",()=>{
 const s=setup();
 s.record("c1","context",{topic:"persona",goal:"course"});
 s.question("q",{question:"Разбери кейс",mode:"open"});
 s.answer("q",{outcome:"pending_review",yourAnswer:"В понедельник он перебил руководителя три раза, поэтому он не уважает иерархию."});
 s.assess("a",{questionId:"q",result:"partial",reasoning:"partial",evidence:"«он ПЕРЕБИЛ руководителя   три раза»",nextCheck:"new case"},task);
 expect(s.questions()[0].task.skill).toBe("impulse");
 expect(s.state().skills.impulse.evidence[0].result).toBe("partial");
});
test("missing task metadata names the exact fix instead of failing silently",()=>{
 const s=setup();
 s.question("q",{question:"Find response",mode:"open"});
 s.answer("q",{outcome:"pending_review",yourAnswer:"2, -1, 3"});
 expect(()=>s.assess("a",{questionId:"q",result:"correct",reasoning:"sound",evidence:"2, -1, 3",nextCheck:"next"})).toThrow("kind=task");
});

test("learning-record exposes root properties and rejects incomplete branch before mutation",async()=>{
 const s=setup();const tools=new Map();tutor({on(){},registerTool(t:any){tools.set(t.name,t)}} as any);const t=tools.get("learning-record");
 expect(t.parameters.type).toBe("object");expect(t.parameters.properties.topic).toBeDefined();expect(t.parameters.properties.kind).toBeDefined();
 await expect(t.execute("bad",{kind:"context"},null,null,{cwd:s.cwd})).rejects.toThrow("requires learnerId");expect(s.events()).toHaveLength(0);
 await t.execute("good",{kind:"context",learnerId:"owner",subject:"psychology",topic:"personology",goal:"Learn for myself"},null,null,{cwd:s.cwd});expect(s.state().topic).toBe("personology");
});

test("learner and topic isolation includes identical skill ids and excludes cross learner assessment",()=>{
 const s=setup();s.record("owner","context",{learnerId:"owner",subject:"Psychology",topic:"analysis",goal:"learn"});question(s,"owner-q");answer(s,"owner-q");assess(s,"owner-q");
 s.record("guest","context",{learnerId:"guest",subject:"Psychology",topic:"analysis",goal:"learn"});expect(s.state().skills).toEqual({});expect(()=>s.assess("cross",{responseId:"owner-q",result:"correct",reasoning:"sound",nextCheck:"new"} as any)).toThrow("active learner");
 question(s,"guest-q");answer(s,"guest-q");assess(s,"guest-q","partial","partial");expect(s.state().skills.impulse.evidence).toHaveLength(1);
 s.record("topic","context",{learnerId:"guest",subject:"Psychology",topic:"other-topic",goal:"learn"});expect(s.state().skills).toEqual({});
 s.record("return","context",{learnerId:"owner",subject:"Psychology",topic:"analysis",goal:"learn"});expect(s.state().skills.impulse.independent).toBe(true);
});
test("response id alone links exact stored answer without a copying loop",()=>{
 const s=setup();question(s);answer(s);s.assess("no-copy",{responseId:"q",result:"correct",reasoning:"sound",nextCheck:"new case"} as any);expect(s.questions()[0].assessment.evidence).toContain("2, -1, 3");expect(s.state().skills.impulse.independent).toBe(true);
});
test("redirect removes a previously misgraded answer from evidence and reviews",()=>{
 const s=setup();question(s);answer(s);assess(s);s.record("redirect","disposition",{questionId:"q",disposition:"redirect"});expect(s.state().skills).toEqual({});expect(s.state().pendingAssessments).toEqual([]);expect(s.state().reviewDue).toEqual([]);expect(()=>assess(s)).toThrow();expect(s.questions()[0].answer.yourAnswer).toContain("2, -1, 3");
});
test("map does not accept declared mastery; recognition does not close depth three",()=>{
 const s=setup();s.record("map","coverage",{areas:[{skill:task.skill,status:"solid",targetDepth:3},{skill:"other",targetDepth:3}]});expect(s.state().coverage[0].status).toBe("unprobed");question(s,"q",task,"single-select");answer(s);assess(s,"q","correct","unobserved");expect(s.state().coverage[0]).toMatchObject({status:"probed",needsDepth:true,maxIndependentDepth:0});expect(s.recommend().candidates.some(c=>c.action==="probe_topic"&&c.areas.includes("other"))).toBe(true);
});
test("first gap preserves other branches and depth evidence",()=>{
 const s=setup();s.record("map","coverage",{areas:[{skill:task.skill,targetDepth:3},{skill:"alternatives",targetDepth:3},{skill:"validation",prerequisites:["alternatives"],targetDepth:4}]});question(s);answer(s);assess(s,"q","partial","partial");expect(s.state().coverage[0].status).toBe("shaky");expect(s.recommend().candidates.some(c=>c.action==="probe_topic"&&c.areas.includes("alternatives"))).toBe(true);expect(s.state().coverage[2].status).toBe("unprobed");
});
test("cyclic and missing prerequisites rejected without replacing map",()=>{
 const s=setup();expect(()=>s.record("bad","coverage",{areas:[{skill:"a",prerequisites:["b"]},{skill:"b",prerequisites:["a"]}]})).toThrow("cycle");expect(()=>s.record("bad2","coverage",{areas:[{skill:"a",prerequisites:["missing"]}]})).toThrow("Missing prerequisite");expect(s.state().coverage).toEqual([]);
});
test("repeating an explained case cannot become independent mastery",()=>{
 const s=setup();question(s,"a",{...task,caseId:"same"});answer(s,"a");assess(s,"a");question(s,"b",{...task,caseId:"same"});answer(s,"b");assess(s,"b");expect(s.state().skills.impulse.independent).toBe(false);
});
test("compact acknowledgements do not grow with recorded history",()=>{
 const s=setup();for(let i=0;i<24;i++){question(s,"q"+i,{...task,skill:"skill"+i});answer(s,"q"+i);assess(s,"q"+i);}
 expect(JSON.stringify(s.ack({responseId:"q23"})).length).toBeLessThan(100);expect(JSON.stringify(s.summary()).length).toBeLessThan(2200);expect(JSON.stringify(s.summary())).not.toContain("only one tap");
});

test("scholarly search failure gives a fallback and never claims topic absence",async()=>{
 const {searchSources}=await import("../extensions/learning-sources");
 await expect(searchSources("query",2,undefined,(async()=>({ok:false,status:503})) as any)).rejects.toThrow("do not infer the topic does not exist");
 const r=await searchSources("query",1,undefined,(async()=>({ok:true,json:async()=>({message:{items:[{title:["Paper"],DOI:"10.1/example",URL:"https://doi.org/10.1/example"}]}})})) as any);
 expect(r.kind).toBe("bibliographic_metadata");expect(r.results).toHaveLength(1);expect(r.next).toContain("before citing");
});


test("a contradicted audit cannot be stored as sound or confer mastery",()=>{
 const s=setup();question(s);answer(s);const before=s.events().length;
 expect(()=>s.assess("bad-audit",{questionId:"q",result:"correct",reasoning:"sound",nextCheck:"next",audit:[{observed:"coefficients change",expected:"coefficients are fixed",verdict:"contradicted"}]})).toThrow("cannot be sound");
 expect(s.events().length).toBe(before);expect(s.state().pendingAssessments).toEqual(["q"]);
});
test("correct outcome with contradicted reasoning is a map gap; other areas stay available",()=>{
 const s=setup();s.record("map-audit","coverage",{areas:[{skill:"impulse",targetDepth:3},{skill:"scaling",targetDepth:3}]});question(s);answer(s);
 s.assess("audit-ok",{questionId:"q",result:"correct",reasoning:"incorrect",nextCheck:"check scaling",audit:[{observed:"takes next sample",expected:"previous sample",verdict:"contradicted"}]});
 expect(s.state().coverage.find(a=>a.skill==="impulse").status).toBe("shaky");
 expect(s.recommend().candidates.some(c=>c.action==="probe_topic"&&c.areas.includes("scaling"))).toBe(true);
 expect(s.inspect("question","q").assessment.audit[0].observed).toBe("takes next sample");
});
test("insufficient evidence is not sound reasoning; unknown reasoning is not a confirmed map gap",()=>{
 const s=setup();s.record("m","coverage",{areas:[{skill:"impulse",targetDepth:3}]});question(s,"q",task,"single-select");answer(s);
 expect(()=>s.assess("a",{questionId:"q",result:"correct",reasoning:"sound",nextCheck:"ask why",audit:[{observed:"answer only",expected:"reasoning needed",verdict:"insufficient"}]})).toThrow();
 s.assess("b",{questionId:"q",result:"correct",reasoning:"unobserved",nextCheck:"ask why",audit:[{observed:"answer only",expected:"reasoning needed",verdict:"insufficient"}]});
 expect(s.state().coverage[0].status).toBe("probed");expect(s.state().skills.impulse.independent).toBe(false);
});

test("suspected cause stays separate from an observed error and helped success",()=>{
 const s=setup();s.record("map","coverage",{areas:[{skill:task.skill}]});question(s,"q",{...task,assistance:"worked"});answer(s);
 s.assess("a",{questionId:"q",result:"correct",reasoning:"partial",nextCheck:"distinguish index from arithmetic",audit:[{observed:"uses 5 for previous sample",expected:"previous sample is 2",verdict:"contradicted"}],diagnosis:{hypothesis:"reverses delay",status:"suspected",basis:"one substitution"}});
 const area=s.inspect("map")[0];expect(area.diagnosis.status).toBe("suspected");expect(area.observedErrors).toHaveLength(1);expect(area.assistedSuccess).toBe(true);expect(area.status).toBe("shaky");
});
test("unsupported causal diagnosis fails without mutating state",()=>{
 const s=setup();question(s);answer(s);const before=s.events().length;
 expect(()=>s.assess("a",{questionId:"q",result:"uncertain",reasoning:"unobserved",nextCheck:"clarify",diagnosis:{hypothesis:"index confusion",status:"supported",basis:"did not mention index"}})).toThrow("contradicted observed step");expect(s.events().length).toBe(before);
});

test("turn policy refreshes without a model read and does not accumulate in system prompt",()=>{
 const s=setup(), handlers=new Map();tutor({on(name:any,fn:any){handlers.set(name,fn)},registerTool(){}} as any);
 const hook=handlers.get("before_agent_start");expect(hook({systemPrompt:"base"},{cwd:s.cwd})).toBeUndefined();
 const dir=join(s.cwd,".pi/skills/teach/references");mkdirSync(dir,{recursive:true});writeFileSync(join(dir,"turn-policy.md"),"first policy");
 const first=hook({systemPrompt:"base"},{cwd:s.cwd});expect(first.systemPrompt).toContain("first policy");
 writeFileSync(join(dir,"turn-policy.md"),"updated policy");const next=hook(first,{cwd:s.cwd});expect(next.systemPrompt).toContain("updated policy");expect(next.systemPrompt).not.toContain("first policy");expect(next.systemPrompt.match(/<learning-turn-policy>/g)).toHaveLength(1);expect(next.systemPrompt.startsWith("base")).toBe(true);
});

test("support takes precedence over stale question and breadth, persists and isolates learners",()=>{
 const s=setup();s.record("c","context",{learnerId:"owner",subject:"signals",topic:"sampling",goal:"proof"});
 s.record("map","coverage",{areas:[{skill:"spectrum"},{skill:"fourier"}]});question(s);
 const data={supportStatus:"active",focus:"what is measured",nextStep:"one signal and its measured values",basis:"learner says does not understand samples"};s.record("help","support",data);
 expect(s.summary().candidates[0].action).toBe("explain_current");expect(s.recommend().candidates.some(c=>["resume","probe_topic","check_prerequisite"].includes(c.action))).toBe(false);
 const reopened=new TutorStore(s.cwd);try{expect(reopened.summary().candidates[0].focus).toBe(data.focus);}finally{reopened.close();}
 s.record("guest","context",{learnerId:"guest",subject:"signals",topic:"sampling",goal:"proof"});expect(s.state().support).toBe(null);
 s.record("back","context",{learnerId:"owner",subject:"signals",topic:"sampling",goal:"proof"});expect(s.state().support.supportStatus).toBe("active");
 s.record("done","support",{...data,supportStatus:"resolved",basis:"learner distinguished stored points from unmeasured curve"});expect(s.recommend().candidates.some(c=>c.action==="probe_topic")).toBe(true);
});
test("invalid support cannot mutate or grade learner state",()=>{
 const s=setup();const before=s.events().length;expect(()=>s.record("bad","support",{supportStatus:"active"})).toThrow();expect(s.events().length).toBe(before);expect(s.state().skills).toEqual({});
});

test("long Unicode topic projects without filesystem name overflow",()=>{
 const s=setup();s.record("long","context",{learnerId:"owner",subject:"Теория сигналов",topic:"Теорема Котельникова: дискретизация, копии спектра, восстановление".repeat(4),goal:"understand"});
 s.record("map","coverage",{areas:[{skill:"samples",label:"Отсчёты"}]});expect(s.state().coverage).toHaveLength(1);expect(s.state().topic).toContain("восстановление");
});
