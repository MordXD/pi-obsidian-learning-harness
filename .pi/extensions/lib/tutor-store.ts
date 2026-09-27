import { createRequire } from "node:module";
import { mkdirSync, readFileSync, existsSync, writeFileSync, renameSync } from "node:fs";
import { join, relative } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { readLogTarget } from "./learning";

const require = createRequire(import.meta.url);
export type Task = { skill: string; family: string; prerequisites?: string[]; mode: "worked" | "completion" | "independent" | "mixed" | "retrieval"; shownSteps?: string[]; remainingSteps?: string[]; rubric: string[]; assistance: "none" | "hint" | "worked"; verification: string; depth?: number; caseId?: string; alternativeCheck?: string; probe?: {alternatives:string[];separatesBy:string} };
export type Diagnosis = { hypothesis:string; status:"suspected"|"supported"|"rejected"; basis:string };
export type Assessment = { diagnosis?: Diagnosis; questionId: string; responseId?: string; result: "correct" | "partial" | "incorrect" | "uncertain"; reasoning: "sound" | "partial" | "incorrect" | "unobserved"; evidence?: string; nextCheck: string; audit?: Array<{observed:string;expected:string;verdict:"supported"|"contradicted"|"insufficient"}> };
export type CoverageStatus = "unprobed" | "probed" | "shaky" | "solid";
export type CoverageArea = { skill: string; status: CoverageStatus; note?: string; label?: string; prerequisites?: string[]; targetDepth?: number; priority?: number };
const DAY = 86400000;

/** Compare learner evidence without punishing quotes, dashes or wrapping. */
function normalizeExcerpt(value: string): string {
  return value.toLowerCase().replace(/[«»„“”"'`´]/g, " ").replace(/\s+/g, " ").trim();
}
export class TutorStore {
  db: any;
  constructor(public cwd: string) {
    mkdirSync(join(cwd, ".alvar"), { recursive: true });
    // Pi runs on Node; Bun is also supported by the existing test runner.
    if ((globalThis as any).Bun) {
      const { Database } = require("bun:sqlite");
      this.db = new Database(join(cwd, ".alvar", "learning.sqlite"));
    } else {
      const { DatabaseSync } = require("node:sqlite");
      this.db = new DatabaseSync(join(cwd, ".alvar", "learning.sqlite"));
    }
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    if (!this.db.prepare("SELECT value FROM meta WHERE key='schema'").get()) {
      this.db.prepare("INSERT INTO meta VALUES('schema','1')").run();
    }
    const version = this.db.prepare("SELECT value FROM meta WHERE key='schema'").get().value;
    if (version !== "1") throw new Error(`Unsupported learning schema ${version}`);
  }
  close() { this.db.close(); }
  events() { return this.db.prepare("SELECT * FROM events ORDER BY seq").all().map((r: any) => ({ ...r, payload: JSON.parse(r.payload) })); }
  append(id: string, kind: string, payload: any, at = new Date().toISOString()) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.db.prepare("SELECT kind,payload FROM events WHERE id=?").get(id);
      if (previous) {
        if (previous.kind !== kind || previous.payload !== JSON.stringify(payload)) throw new Error(`Conflicting event ${id}`);
      } else this.db.prepare("INSERT INTO events(id,kind,at,payload) VALUES(?,?,?,?)").run(id, kind, at, JSON.stringify(payload));
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  start() {
    if (!this.events().length && existsSync(join(this.cwd, ".alvar/current.json"))) {
      const legacy = JSON.parse(readFileSync(join(this.cwd, ".alvar/current.json"), "utf8"));
      // Historical claims remain explicitly unverified, never converted into scored attempts.
      this.append("legacy-import", "legacy", legacy);
    }
    this.project();
  }
  scope() {
    const events = this.events();
    const context = events.filter((e: any) => e.kind === "context").at(-1)?.payload || {};
    const note = this.note();
    const mismatch = Boolean(context.topic && note && context.learnerNote !== note);
    return { learnerName: context.learnerName || context.learnerId || "Основной ученик", learnerId: context.learnerId || "owner", subject: mismatch ? note : context.subject || context.topic || note || "general", topic: mismatch ? null : context.topic || null, goal: mismatch ? null : context.goal || null, deadline: mismatch ? null : context.deadline || null, learnerNote: note, mismatch, experience: context.experience || null };
  }
  currentTopic() { return this.scope().topic; }
  question(id: string, data: any) {
    if (this.questions().some((q: any) => q.id === id)) return;
    const scope = this.scope();
    if (data.replacesQuestionId) {
      const old = this.questions().find((q: any) => q.id === data.replacesQuestionId);
      if (!old || old.answer || !this.sameScope(old.scope, scope)) throw new Error("Can only resume an unanswered question in the active learner/topic");
    }
    this.append(`question:${id}`, "question", { ...data, id, topic: scope.topic, scope, learnerNote: this.note(), task: data.task || null });
    this.project();
  }
  answer(id: string, data: any) {
    if (!this.questions().some((q: any) => q.id === id)) throw new Error(`Unknown question ${id}`);
    this.append(`answer:${id}`, "answer", { ...data, id }); this.project();
  }
  note() { const file = readLogTarget(this.cwd); return file ? relative(this.cwd, file) : null; }
  sameScope(a: any, b: any) { return a?.learnerId === b?.learnerId && a?.subject === b?.subject && a?.topic === b?.topic; }
  activeQuestions() { const scope = this.scope(); return this.questions().filter((q: any) => this.sameScope(q.scope, scope)); }
  assess(id: string, value: Assessment, task?: Task) {
    const active = this.activeQuestions();
    const qid = value.responseId || value.questionId || (active.filter((q: any) => q.answer && !q.assessment && !q.excluded && !["cancelled","unavailable","superseded"].includes(q.answer.outcome)).length === 1 ? active.find((q: any) => q.answer && !q.assessment && !q.excluded && !["cancelled","unavailable","superseded"].includes(q.answer.outcome))?.id : null);
    let q = active.find((q: any) => q.id === qid);
    if (!q?.answer || q.excluded || ["cancelled", "unavailable", "superseded"].includes(q.answer.outcome)) throw new Error("Assessment requires a submitted answer in the active learner/topic; use responseId from quiz result or learning-next");
    if (q.answer.outcome === "dont_know" && value.result === "correct") throw new Error("No answer is not a correct answer");
    if (q.mode !== "open" && !q.answer.note?.trim() && value.reasoning !== "unobserved") throw new Error("Choice alone provides no reasoning evidence; set reasoning=unobserved");
    if (value.audit !== undefined) {
      if (!Array.isArray(value.audit) || !value.audit.length || value.audit.length > 3 || value.audit.some(a=>!a.observed?.trim() || !a.expected?.trim() || !["supported","contradicted","insufficient"].includes(a.verdict))) throw new Error("Audit needs 1–3 concrete observed/expected checks with a valid verdict");
      if (value.reasoning === "sound" && value.audit.some(a=>a.verdict!=="supported")) throw new Error("Reasoning cannot be sound while its audit contains a contradiction or insufficient evidence; revise the assessment or the check");
    }
    if (value.diagnosis) {
      const d=value.diagnosis;
      if (!d.hypothesis?.trim() || !d.basis?.trim() || !["suspected","supported","rejected"].includes(d.status)) throw new Error("Diagnosis requires hypothesis, status and observed basis");
      if (d.status === "supported" && !value.audit?.some(a=>a.verdict==="contradicted")) throw new Error("A supported gap cause requires a contradicted observed step; uncertainty alone is not a diagnosis");
    }
    if (!q.task && task) { this.append(`task:${q.id}`, "task", { questionId:q.id, task }); q = this.questions().find((item:any)=>item.id===q.id); }
    if (!q.task) throw new Error("Attach task metadata with learning-record kind=task or pass task inline");
    const actual = [q.answer.yourAnswer, q.answer.note].filter(Boolean).join("\n");
    if (value.evidence && !normalizeExcerpt(actual).includes(normalizeExcerpt(value.evidence))) throw new Error("Evidence must be an exact excerpt; omit evidence to link the full stored response automatically");
    this.append(`assessment:${id}`, "assessment", { ...value, questionId:q.id, responseId:q.id, evidence:value.evidence || actual.slice(0,240) }); this.project();
  }
  record(id: string, kind: string, data: any) {
    const scope = this.scope();
    if (["task","assistance","disposition"].includes(kind)) {
      const q = this.activeQuestions().find((q:any)=>q.id===data.questionId);
      if (!q) throw new Error("Unknown question in the active learner/topic");
      if (kind === "task" && q.assessment) throw new Error("Cannot change assessed task metadata");
      if (kind === "assistance" && !data.detail?.trim()) throw new Error("Describe the actual help");
      if (kind === "disposition" && !["redirect","invalid_question","skip"].includes(data.disposition)) throw new Error("Invalid disposition");
    }
    if (kind === "support") {
      if (!scope.topic || scope.mismatch) throw new Error("Support requires context: call learning-record kind=context with learnerId, subject, topic and goal first; fields on kind=support do not switch context");
      if (!["active","resolved","redirected"].includes(data.supportStatus) || !data.focus?.trim() || !data.nextStep?.trim() || !data.basis?.trim()) throw new Error("Support requires status, focus, nextStep and basis");
    }
    if (kind === "coverage") {
      if (!Array.isArray(data.areas) || !data.areas.length) throw new Error("coverage requires areas");
      const ids = new Set(data.areas.map((a:any)=>a.skill));
      if(ids.size!==data.areas.length) throw new Error("Duplicate coverage skill");
      const visited=new Set(), stack=new Set();
      const visit=(key:string)=>{ if(stack.has(key))throw new Error("Coverage prerequisites form a cycle"); if(visited.has(key))return; stack.add(key); const area=data.areas.find((a:any)=>a.skill===key); for(const prereq of area?.prerequisites||[]) {if(!ids.has(prereq))throw new Error(`Missing prerequisite area ${prereq}`);visit(prereq);} stack.delete(key);visited.add(key); };
      for(const key of ids) visit(key as string);
    }
    const stamped = kind === "context" ? { ...data, learnerName:data.learnerName || data.learnerId || scope.learnerName, learnerId:data.learnerId || scope.learnerId, subject:data.subject || data.topic, learnerNote:data.learnerNote ?? this.note() }
      : ["board","instruction","coverage","schedule","support"].includes(kind) ? {...data,scope,topic:scope.topic} : data;
    this.append(`${kind}:${id}`,kind,stamped);this.project();
  }
  questions() {
    const qs = new Map<string, any>();
    let scope:any = {learnerId:"owner",subject:"general",topic:null};
    for (const e of this.events()) {
      const p = e.payload;
      if(e.kind==="context") scope={learnerId:p.learnerId||"owner",subject:p.subject||p.topic||"general",topic:p.topic||null};
      if(e.kind==="scope-assignment") { for(const qid of p.questionIds||[]) if(qs.has(qid)) qs.get(qid).scope=p.scope; }
      if(e.kind==="disposition" && qs.has(p.questionId)) qs.get(p.questionId).excluded=p.disposition;
      if (e.kind === "question") {
        const old = qs.get(p.replacesQuestionId);
        if (old) old.answer = { outcome: "superseded", replacement: p.id };
        qs.set(p.id, { ...p, scope:p.scope||{...scope}, at: e.at, hints: [] });
      }
      if (e.kind === "answer" && qs.has(p.id)) Object.assign(qs.get(p.id), { answer: p, answeredAt: e.at, answeredSeq: e.seq });
      if (["task","task-audit"].includes(e.kind) && qs.has(p.questionId)) qs.get(p.questionId).task = p.task;
      if (e.kind === "assistance" && qs.has(p.questionId)) qs.get(p.questionId).hints.push({ ...p, at: e.at, seq: e.seq });
      if (e.kind === "assessment" && qs.has(p.questionId)) Object.assign(qs.get(p.questionId), { assessment: p, assessedAt: e.at });
    }
    return [...qs.values()];
  }
  state(now = Date.now()) {
    const all = this.events(), scope = this.scope();
    const events = all.filter((e:any)=>!e.payload.scope || this.sameScope(e.payload.scope,scope));
    const questions = this.activeQuestions();
    const legacy = all.find((e:any)=>e.kind==="legacy")?.payload;
    const intervals=events.filter((e:any)=>e.kind==="schedule").at(-1)?.payload.days || [1,3,7,14,30];
    const skills:Record<string,any>={};
    for(const q of questions) {
      if(!q.task || !q.assessment || q.imported || q.excluded)continue;
      const a=q.assessment;
      const s=skills[q.task.skill] ||= {skill:q.task.skill,subject:scope.subject,evidence:[],streak:0,maxIndependentDepth:0,independent:false,retained:false,methodSelection:false};
      const repeatedCase=Boolean(q.task.caseId && questions.some((old:any)=>old.id!==q.id && old.task?.caseId===q.task.caseId && old.answeredSeq<q.answeredSeq));
      const priorExposure=events.some((e:any)=>e.kind==="instruction" && e.payload.skill===q.task.skill && e.seq<q.answeredSeq && (!s.lastIndependentSeq || e.seq>s.lastIndependentSeq));
      const independent=!repeatedCase && a.result==="correct" && a.reasoning==="sound" && q.mode==="open" && q.task.assistance==="none" && !q.hints.some((h:any)=>h.seq<q.answeredSeq) && ["independent","mixed","retrieval"].includes(q.task.mode);
      const depth=q.mode!=="open" ? 1 : Math.min(q.task.depth || 3,4);
      const delayed=Boolean(independent && !priorExposure && q.task.mode==="retrieval" && s.lastIndependentAt && Date.parse(q.answeredAt)-Date.parse(s.lastIndependentAt)>=intervals[0]*DAY);
      s.streak=independent?s.streak+1:0;s.independent=independent;s.retained=delayed;s.methodSelection=independent&&q.task.mode==="mixed";
      if(independent){s.lastIndependentAt=q.answeredAt;s.lastIndependentSeq=q.answeredSeq;s.maxIndependentDepth=Math.max(s.maxIndependentDepth,depth);}
      if(delayed)s.lastRetainedAt=q.answeredAt;
      s.lastChecked=q.answeredAt;s.family=q.task.family;s.prerequisites=q.task.prerequisites||[];s.nextCheck=a.nextCheck;
      s.dueAt=new Date(Date.parse(q.answeredAt)+intervals[Math.min(Math.max(s.streak-1,0),intervals.length-1)]*DAY).toISOString();
      s.evidence.push({diagnosis:a.diagnosis || null,observedErrors:(a.audit || []).filter((v:any)=>v.verdict==="contradicted").map((v:any)=>({observed:v.observed,expected:v.expected})),assisted:!independent && (q.task.assistance!=="none" || q.hints.some((h:any)=>h.seq<q.answeredSeq)),questionId:q.id,at:q.answeredAt,result:a.result,reasoning:a.reasoning,depth,independent,delayed,excerpt:a.evidence});
    }
    const rawAreas=events.filter((e:any)=>e.kind==="coverage" && (e.payload.scope ? this.sameScope(e.payload.scope,scope) : e.payload.topic===scope.topic)).at(-1)?.payload.areas || [];
    const coverage=rawAreas.map((a:any)=>{const s=skills[a.skill]; const evidence=s?.evidence||[];const target=a.targetDepth||3;const latest=evidence.at(-1);return {...a,diagnosis:latest?.diagnosis || null,observedErrors:latest?.observedErrors || [],assistedSuccess:latest?.result==="correct" && Boolean(latest?.assisted),targetDepth:target,status:!latest?"unprobed":latest.result!=="correct" || ["incorrect","partial"].includes(latest.reasoning)?"shaky":s.independent&&s.maxIndependentDepth>=target?"solid":"probed",maxIndependentDepth:s?.maxIndependentDepth||0,checkedDepths:[...new Set(evidence.map((e:any)=>e.depth))],questionIds:evidence.map((e:any)=>e.questionId),needsDepth:!s || !s.independent || s.maxIndependentDepth<target};});
    const boards=events.filter((e:any)=>e.kind==="board" && (e.payload.scope ? this.sameScope(e.payload.scope,scope) : e.payload.topic===scope.topic));
    const pending=questions.filter((q:any)=>q.answer&&!q.excluded&&!q.assessment&&!["cancelled","unavailable","superseded"].includes(q.answer.outcome));
    const contexts=all.filter((e:any)=>e.kind==="context"&&(e.payload.learnerId||"owner")===scope.learnerId);
    const subjects:Record<string,any>={};for(const e of contexts){const p=e.payload;subjects[p.subject||p.topic]={subject:p.subject||p.topic,note:p.learnerNote,topic:p.topic};}
    const unprobed=coverage.filter((a:any)=>a.status==="unprobed").map((a:any)=>a.skill);
    return {support:events.filter((e:any)=>e.kind==="support").at(-1)?.payload || null,version:3,...scope,activeSubject:scope.subject,subjectMismatch:scope.mismatch,subjects,source:".alvar/learning.sqlite",updatedAt:all.at(-1)?.at||null,skills,coverage,unprobed,
      pendingQuestion:questions.filter((q:any)=>!q.answer&&!q.excluded).map((q:any)=>({id:q.id,question:q.question,learnerNote:q.learnerNote})),
      pendingAssessments:pending.map((q:any)=>q.id),
      reviewDue:Object.values(skills).filter((s:any)=>Date.parse(s.dueAt)<=now),
      boards:{count:boards.length,lastFocus:boards.at(-1)?.payload.focus||null,reminder:boards.length?null:"Use a Mermaid board when a relation benefits from a diagram; no mandatory quota"},
      historicalEvidence:questions.filter((q:any)=>q.imported&&q.assessment&&!q.excluded).map((q:any)=>({questionId:q.id,assessment:q.assessment,source:q.source,excludedFromScheduling:true})),
      recentInstructions:events.filter((e:any)=>e.kind==="instruction").slice(-8).map((e:any)=>({...e.payload,at:e.at})),
      legacyNeedsReview:scope.learnerId==="owner"&&legacy?{topic:legacy.topic,pendingQuestion:all.some((e:any)=>e.kind==="legacy-reconciled")?null:legacy.pendingQuestion,reviewDue:legacy.reviewDue}:null};
  }
  recommend(now=Date.now(), subject?:string|null) {
    const s=this.state(now),candidates:any[]=[];
    if(subject && subject!==s.subject) return {subject,coverage:[],boards:s.boards,candidates:[{action:"switch_context",reason:"Select learner, subject and topic explicitly"}]};
    if(s.subjectMismatch)candidates.push({action:"select_context",reason:"Active note does not match declared topic; do not resume the previous subject"});
    for(const id of s.pendingAssessments)candidates.push({action:"assess",responseId:id});
    if(s.support?.supportStatus==="active" && !s.subjectMismatch) {
      candidates.unshift({action:"explain_current",focus:s.support.focus,nextStep:s.support.nextStep,reason:"Stay with this concrete difficulty; no breadth or prerequisite exam until learner meaning is observed or learner redirects"});
      return {subject:s.subject,coverage:s.coverage,boards:s.boards,candidates:candidates.slice(0,6),policy:"Explain the current object; assessment bookkeeping stays internal. No automatic promotion after arithmetic or an explanation."};
    }
    for(const q of s.pendingQuestion)candidates.push({action:"resume",questionId:q.id});
    if(!s.coverage.length)candidates.push({action:"map_topic",reason:"Declare the target areas and dependencies before diagnostic questions"});
    const ready=s.coverage.filter((a:any)=>(a.prerequisites||[]).every((p:string)=>s.coverage.find((b:any)=>b.skill===p)?.status==="solid"));
    const unprobed=ready.filter((a:any)=>a.status==="unprobed").sort((a:any,b:any)=>(b.priority||0)-(a.priority||0));
    if(unprobed.length)candidates.push({action:"probe_topic",areas:unprobed.slice(0,3).map((a:any)=>a.skill),reason:"Unexamined area: sample it before drilling an already identified gap"});
    const deeper=ready.filter((a:any)=>a.status==="probed"&&a.needsDepth);
    if(deeper.length)candidates.push({action:"probe_deeper",skill:deeper[0].skill,depth:Math.min(Math.max(2,...deeper[0].checkedDepths.map((n:number)=>n+1)),deeper[0].targetDepth),reason:"Recognition is not independent analysis; use a new open case"});
    for(const skill of Object.values(s.skills) as any[]) {
      const last=skill.evidence.at(-1);
      if(Date.parse(skill.dueAt)<=now)candidates.push({action:"retrieval",skill:skill.skill,nextCheck:skill.nextCheck});
      else if(last.result==="correct"&&last.reasoning!=="sound")candidates.push({action:"self_explanation",skill:skill.skill});
      else if(last.result==="incorrect")candidates.push({action:"worked",skill:skill.skill});
      else if(!last.independent)candidates.push({action:"completion",skill:skill.skill});
      else {const missing=skill.prerequisites.filter((p:string)=>!s.skills[p]?.independent); const families=[...new Set((Object.values(s.skills) as any[]).filter(v=>v.independent&&v.prerequisites.every((p:string)=>s.skills[p]?.independent)).map(v=>v.family))];candidates.push(missing.length?{action:"check_prerequisite",skill:skill.skill,prerequisites:missing}:{action:families.length>1?"mixed":"independent_variant",skill:skill.skill,families});}
    }
    for(const i of s.recentInstructions)if(!s.skills[i.skill]&&!candidates.some(c=>c.skill===i.skill))candidates.push({action:"completion",skill:i.skill});
    return {subject:s.subject,coverage:s.coverage,boards:s.boards,candidates:candidates.slice(0,6),policy:"Advisory. Diagnose breadth and depth; follow learner questions. Intervals are heuristics."};
  }
  summary(subject?:string|null) {
    const s=this.state();
    const active=this.activeQuestions();
    const recent=active.filter((q:any)=>q.answer&&!q.excluded&&q.mode!=="open").slice(-3);
    const openRecommended=recent.length>=2&&recent.slice(-2).every((q:any)=>q.answer.outcome==="correct") || active.some((q:any)=>/слишком легк|слишком лёгк|too easy/i.test(q.answer?.note||""));
    return {version:3,learnerId:s.learnerId,profile:s.learnerId==="owner"?".alvar/LEARNER.md":`.alvar/learners/${encodeURIComponent(s.learnerId)}/PROFILE.md`,subject:s.subject,topic:s.topic,goal:s.goal,note:s.learnerNote,experience:s.experience,
      boards:s.boards,
      warning:s.subjectMismatch?"Active note does not match declared topic: select context before teaching":null,
      pendingAssessments:s.pendingAssessments.slice(0,3),pendingQuestion:s.pendingQuestion.slice(0,1).map(q=>({id:q.id,question:q.question.slice(0,240)})),
      coverage:{total:s.coverage.length,solid:s.coverage.filter((a:any)=>a.status==="solid").length,unprobed:s.unprobed.slice(0,6),needsDepth:s.coverage.filter((a:any)=>a.needsDepth).slice(0,6).map((a:any)=>a.skill)},
      quizPolicy:openRecommended?"Use a NEW open case; easy choices have low diagnostic value. Do not repeat an explained item as independent evidence.":"Match task depth to expertise. Ambiguous cases may legitimately have insufficient data.",
      candidates:this.recommend(Date.now(),subject).candidates.slice(0,3)};
  }
  ack(extra:Record<string,unknown>={}) {return {ok:true,...extra};}
  inspect(view:string, questionId?:string) {
    if(view==="question") {const q=this.activeQuestions().find((q:any)=>q.id===questionId);if(!q)throw new Error("Question not in active learner/topic");return {responseId:q.id,question:q.question,context:q.context,task:q.task,answer:q.answer?{outcome:q.answer.outcome,text:q.answer.yourAnswer,note:q.answer.note}:null,assessment:q.assessment,excluded:q.excluded};}
    if(view==="map")return this.state().coverage;
    if(view==="catalog")return this.state().subjects;
    if(view==="history")return this.activeQuestions().slice(-5).map((q:any)=>({id:q.id,skill:q.task?.skill,result:q.assessment?.result,excluded:q.excluded}));
    throw new Error("Unknown view");
  }
  project() {
    // Serialize projection writes with event writers; replay repairs a crash after COMMIT.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const state = this.state();
      const path = join(this.cwd, ".alvar/current.json");
      const temp = `${path}.${randomUUID()}.tmp`;
      writeFileSync(temp, JSON.stringify(state, null, 2) + "\n"); renameSync(temp, path);
      const view = join(this.cwd, ".alvar/evidence.md");
      const rows = Object.values(state.skills).map((s: any) => `## ${s.skill}\n${s.evidence.map((e: any) => `- ${e.at}: ${e.result}; reasoning=${e.reasoning}; independent=${e.independent}; retained=${e.delayed}; question=${e.questionId}`).join("\n")}\nNext: ${s.nextCheck}\nDue: ${s.dueAt}`);
      const tmp = `${view}.${randomUUID()}.tmp`; writeFileSync(tmp, "# Learning evidence (generated)\n\n" + rows.join("\n\n") + "\n"); renameSync(tmp, view);
      const mapDir=join(this.cwd,".alvar","maps-v3");mkdirSync(mapDir,{recursive:true});
      const mapName=createHash("sha256").update(JSON.stringify([state.learnerId,state.subject,state.topic])).digest("hex");
      const mapPath=join(mapDir,mapName+".md");
      const mapText="# "+[state.learnerId,state.subject,state.topic].join(" / ")+"\n\n"+state.coverage.map((a:any)=>`- ${a.label||a.skill}: ${a.status}; depth ${a.maxIndependentDepth}/${a.targetDepth}; evidence: ${a.questionIds.join(", ")||"none"}`).join("\n")+"\n";
      const mapTemp=mapPath+"."+randomUUID()+".tmp";writeFileSync(mapTemp,mapText);renameSync(mapTemp,mapPath);
      if(state.coverage.length) {
        const clean=(value:string)=>value.replace(/[\/\\:\x00-\x1f]/g,"-").replace(/^[. ]+|[. ]+$/g,"").slice(0,80)||"Без названия";
        const subjectDir=join(this.cwd,"Предметы",clean(state.subject));mkdirSync(subjectDir,{recursive:true});
        const suffix=createHash("sha256").update(JSON.stringify([state.learnerId,state.subject,state.topic])).digest("hex").slice(0,8);
        const filename=clean(state.topic||"Тема")+" — "+clean(state.learnerName)+" — "+suffix+".md";
        const labels:Record<string,string>={unprobed:"Ещё разберём",probed:"Продолжим на новом примере",shaky:"Разберём подробнее",solid:"Получается самостоятельно"};
        const safeText=(t:string)=>t.replace(/[\r\n|]/g," ");
        const diagram=["```mermaid","flowchart TD",...state.coverage.map((a:any,i:number)=>` n${i}["${safeText(a.label||a.skill).replace(/"/g,"'")}"]`),...state.coverage.flatMap((a:any,i:number)=>(a.prerequisites||[]).map((key:string)=>` n${state.coverage.findIndex((b:any)=>b.skill===key)} --> n${i}`)),"```"].join("\n");
        const table="| Тема | Куда движемся |\n| --- | --- |\n"+state.coverage.map((a:any)=>`| ${safeText(a.label||a.skill)} | ${labels[a.status]} |`).join("\n");
        const visible=`# ${safeText(state.topic||"Карта темы")}\n\nУченик: ${safeText(state.learnerName)}.\n\n${diagram}\n\n${table}\n\nКарта помогает выбрать следующий шаг; к темам можно возвращаться по мере надобности.\n\n`+(state.learnerNote?`Конспект: [[${state.learnerNote.replace(/\.md$/i,"")}]]\n`:"");
        const destination=join(subjectDir,filename),temp=destination+"."+randomUUID()+".tmp";writeFileSync(temp,visible);renameSync(temp,destination);
        const catalog=allCatalog(this.events());
        const overview=join(this.cwd,"Предметы","Обзор.md");
        let index="# Предметы\n\n"+catalog.map((c:any)=>`- **${safeText(c.subject)} / ${safeText(c.topic)}** — ${safeText(c.learnerName||c.learnerId||"Основной ученик")}`+(c.learnerNote?`: [[${c.learnerNote.replace(/\.md$/i,"")}]]`:"")).join("\n")+"\n\nКарты диагностики находятся в папках предметов рядом с этим обзором.\n";
        const libraryPath=join(this.cwd,".alvar/library.json");
        if(existsSync(libraryPath)){const library=JSON.parse(readFileSync(libraryPath,"utf8"));index+="\n## Архив конспектов\n";for(const subject of [...new Set(library.map((x:any)=>x.subject))]){index+="\n### "+safeText(String(subject))+"\n\n";for(const item of library.filter((x:any)=>x.subject===subject))index+=`- [[${item.note.replace(/\.md$/i,"")}]]\n`;}}
        const it=overview+"."+randomUUID()+".tmp";writeFileSync(it,index);renameSync(it,overview);
      }
      this.db.exec("COMMIT");
    } catch(e) { this.db.exec("ROLLBACK"); throw e; }
  }
}
export function withStore<T>(cwd: string, fn: (store: TutorStore) => T): T { const store = new TutorStore(cwd); try { return fn(store); } finally { store.close(); } }

function allCatalog(events:any[]) {const unique=new Map();for(const e of events)if(e.kind==="context"&&e.payload.subject&&e.payload.learnerId){const c=e.payload;unique.set(JSON.stringify([c.learnerId,c.subject,c.topic]),c);}return [...unique.values()];}
