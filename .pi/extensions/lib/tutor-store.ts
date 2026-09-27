import { createRequire } from "node:module";
import { mkdirSync, readFileSync, existsSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { readLogTarget } from "./learning";
import { mergeAreas, validatePlan, type TeachingPlan, type SessionContract } from "./tutor-plan";

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
  private cachedSeq = -1;
  private cachedEvents: any[] = [];
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
  events() {
    const seq=this.db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM events").get().seq;
    if(seq!==this.cachedSeq){this.cachedEvents=this.db.prepare("SELECT * FROM events ORDER BY seq").all().map((r:any)=>({...r,payload:JSON.parse(r.payload)}));this.cachedSeq=seq;}
    return this.cachedEvents;
  }
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
    return { learnerName: context.learnerName || context.learnerId || "Основной ученик", learnerId: context.learnerId || "owner", subject: mismatch ? note : context.subject || context.topic || note || "general", topic: mismatch ? null : context.topic || null, topicId: mismatch ? null : context.topicId || context.topic || null, goal: mismatch ? null : context.goal || null, deadline: mismatch ? null : context.deadline || null, learnerNote: note, mismatch, experience: context.experience || null };
  }
  currentTopic() { return this.scope().topic; }
  question(id: string, data: any) {
    if (this.questions().some((q: any) => q.id === id)) return;
    const scope = this.scope();
    if (data.replacesQuestionId) {
      const old = this.questions().find((q: any) => q.id === data.replacesQuestionId);
      if (!old || old.answer || !this.sameScope(old.scope, scope)) throw new Error("Can only resume an unanswered question in the active learner/topic");
    }
    this.append(`question:${id}`, "question", { ...data, id, topic: scope.topic, scope, sessionId:this.contract()?.id||null, learnerNote: this.note(), task: data.task || null });
    this.project();
  }
  answer(id: string, data: any) {
    if (!this.questions().some((q: any) => q.id === id)) throw new Error(`Unknown question ${id}`);
    this.append(`answer:${id}`, "answer", { ...data, id }); this.project();
  }
  note() { const file = readLogTarget(this.cwd); return file ? relative(this.cwd, file) : null; }
  canonicalTopic(scope: any) {
    const contexts = this.events().filter((e:any)=>e.kind==="context" && (e.payload.learnerId||"owner")===scope?.learnerId && (e.payload.subject||e.payload.topic)===scope?.subject);
    const key = scope?.topicId || scope?.topic;
    const match = contexts.find((e:any)=>e.payload.topicId && [e.payload.topicId,e.payload.topic,...(e.payload.aliases||[])].includes(key));
    return match?.payload.topicId || key;
  }
  sameScope(a: any, b: any) { return a?.learnerId === b?.learnerId && a?.subject === b?.subject && this.canonicalTopic(a) === this.canonicalTopic(b); }
  scopedEvents() { const scope=this.scope(); return this.events().filter((e:any)=>e.payload.scope ? this.sameScope(e.payload.scope,scope) : e.payload.topic===scope.topic); }
  contract(): (SessionContract & {id:string}) | null {
    const scope=this.scope();
    if(scope.mismatch)return null;
    const e=this.scopedEvents().filter((e:any)=>e.kind==="session" && e.payload.scope.goal===scope.goal).at(-1);
    return e ? {...e.payload,id:e.id} : null;
  }
  activeSupport() {
    const scope=this.scope(), contract=this.contract();
    const p=this.scopedEvents().filter((e:any)=>e.kind==="support" && e.payload.scope?.goal===scope.goal).at(-1)?.payload;
    return p && (p.sessionId||null)===(contract?.id||null) ? p : null;
  }
  coverageAreas() {
    let areas:any[]=[];
    for(const e of this.scopedEvents()) {
      if(e.kind==="coverage" || e.kind==="plan") areas=mergeAreas(areas,e.payload.areas,e.payload.updateMode!=="merge");
    }
    return areas;
  }
  plan(): (TeachingPlan & {version:number}) | null { return this.scopedEvents().filter((e:any)=>e.kind==="plan").at(-1)?.payload || null; }
  savePlan(id:string, data:TeachingPlan & {expectedVersion?:number;replace?:boolean;reason?:string}) {
    const scope=this.scope(), old=this.plan();
    if(!scope.topic || scope.mismatch)throw new Error("Select context before planning");
    const previous=this.events().find((e:any)=>e.id===`plan:${id}`);
    if(previous) { if(JSON.stringify(previous.payload.request)!==JSON.stringify(data))throw new Error("Conflicting plan request"); return previous.payload; }
    if(old && data.expectedVersion!==old.version)throw new Error(`Plan changed: inspect plan and pass expectedVersion=${old.version}`);
    if(data.replace && !data.reason?.trim())throw new Error("Replacing a plan requires a reason for removed areas");
    const areas=mergeAreas(this.coverageAreas(),data.areas,Boolean(data.replace));
    const plan={sources:old?.sources,crossLinks:old?.crossLinks,notes:old?.notes,...data,areas,version:(old?.version||0)+1,scope,updateMode:"replace",request:data};
    validatePlan(plan);
    this.append(`plan:${id}`,"plan",plan);this.project();return plan;
  }
  legacyPlanPaths() {
    if(this.scope().learnerId!=="owner")return [];
    return [".alvar/maps",".alvar/sessions"].flatMap(dir=>existsSync(join(this.cwd,dir))?readdirSync(join(this.cwd,dir)).filter(f=>f.endsWith(".md")).map(f=>`${dir}/${f}`):[]);
  }
  observe(id:string, text:string) {
    if(!text.trim())return;
    this.append(`utterance:${id}`,"utterance",{text,scope:this.scope()});
  }
  conversationResponse(id:string, messageId:string, question:string, excerpt:string, task:Task) {
    const e=this.scopedEvents().find((e:any)=>e.id===messageId && e.kind==="utterance");
    if(!e || !excerpt.trim() || !normalizeExcerpt(e.payload.text).includes(normalizeExcerpt(excerpt)))throw new Error("Response must quote an observed user message in this learner/topic");
    this.question(id,{question,mode:"open",task,source:{messageId},context:"Response captured from the conversation; not a new quiz"});
    this.answer(id,{outcome:"pending_review",yourAnswer:e.payload.text});
    return {responseId:id,next:"Assess this actual response explicitly; do not infer mastery from a stored message"};
  }
  markDelivered(boardId:string, note:string) {
    const e=this.events().find((e:any)=>e.id===`board:${boardId}`);
    if(!e)return false;
    this.append(`delivered:${boardId}`,"visual-delivered",{boardId,note,scope:e.payload.scope,planVersion:e.payload.planVersion||null});
    this.project();return true;
  }
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
    if (kind === "context" && data.topicId) {
      const names=[data.topicId,data.topic,...(data.aliases||[])];
      for(const e of this.events().filter((e:any)=>e.kind==="context" && e.payload.learnerId===(data.learnerId||scope.learnerId) && e.payload.subject===data.subject && e.payload.topicId)) {
        if(e.payload.topicId!==data.topicId && [e.payload.topicId,e.payload.topic,...(e.payload.aliases||[])].some((n:string)=>names.includes(n)))throw new Error("Topic alias already belongs to another stable topic; do not merge unrelated histories");
      }
    }
    if (kind === "session") {
      if(!scope.topic || scope.mismatch)throw new Error("Select context before setting the session contract");
      if(!["survey","teach","review"].includes(data.stage) || !["choice","open","adaptive"].includes(data.questionFormat) || !Array.isArray(data.scopeSkills))throw new Error("Session requires stage, questionFormat and scopeSkills ([] means the whole plan)");
      if(data.questionFormat==="choice")data={...data,optionCount:data.optionCount??3};
      if(data.optionCount!==undefined && (!Number.isInteger(data.optionCount)||data.optionCount<2||data.optionCount>6))throw new Error("optionCount must be 2–6");
      const known=new Set(this.coverageAreas().map((a:any)=>a.skill));
      if(known.size && data.scopeSkills.some((s:string)=>!known.has(s)))throw new Error("Unknown area in session scope");
    }
    if (kind === "survey-limit") {
      if(!data.skill || !data.reason?.trim() || !this.coverageAreas().some((a:any)=>a.skill===data.skill))throw new Error("Survey limit requires an existing area and a reason; it is not an assessment");
    }
    if (kind === "support") {
      if (!scope.topic || scope.mismatch) throw new Error("Support requires context: call learning-record kind=context with learnerId, subject, topic and goal first; fields on kind=support do not switch context");
      if (!["active","resolved","redirected"].includes(data.supportStatus) || !data.focus?.trim() || !data.nextStep?.trim() || !data.basis?.trim()) throw new Error("Support requires status, focus, nextStep and basis");
    }
    if (kind === "coverage") {
      if (!Array.isArray(data.areas) || !data.areas.length) throw new Error("coverage requires areas");
      if(data.replace && !data.reason?.trim())throw new Error("Replacing coverage requires an explicit reason");
      const areas=mergeAreas(this.coverageAreas(),data.areas,Boolean(data.replace));
      const plan=this.plan();
      if(plan && JSON.stringify(areas.map(a=>[a.skill,a.label,a.prerequisites,a.targetDepth]))!==JSON.stringify(this.coverageAreas().map(a=>[a.skill,a.label,a.prerequisites,a.targetDepth])))throw new Error("Change plan structure through learning-plan with expectedVersion, connections and session route");
      data={...data,areas,updateMode:"replace"};
    }
    const stamped = kind === "context" ? { ...data, learnerName:data.learnerName || data.learnerId || scope.learnerName, learnerId:data.learnerId || scope.learnerId, subject:data.subject || data.topic, learnerNote:data.learnerNote ?? this.note() }
      : ["board","instruction","coverage","schedule","support","session","survey-limit"].includes(kind) ? {...data,scope,topic:scope.topic,...(["support","survey-limit"].includes(kind)?{sessionId:this.contract()?.id||null}:{}),...(kind==="support"?{returnTo:this.contract()}: {})} : data;
    this.append(`${kind}:${id}`,kind,stamped);this.project();
  }
  questions() {
    const qs = new Map<string, any>();
    let scope:any = {learnerId:"owner",subject:"general",topic:null};
    for (const e of this.events()) {
      const p = e.payload;
      if(e.kind==="context") scope={learnerId:p.learnerId||"owner",subject:p.subject||p.topic||"general",topic:p.topic||null,topicId:p.topicId||p.topic||null};
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
      const contradicts=a.result==="incorrect" || a.result==="partial" || ["incorrect","partial"].includes(a.reasoning);
      if(contradicts){s.unresolvedContradiction=q.id;s.currentIndependentDepth=0;s.streak=0;s.retained=false;s.methodSelection=false;}
      if(independent){if(!s.bestIndependent || depth>=s.bestIndependent.depth)s.bestIndependent={questionId:q.id,depth,at:q.answeredAt};s.unresolvedContradiction=null;s.currentIndependentDepth=Math.max(s.currentIndependentDepth||0,depth);s.streak++;}
      s.independent=Boolean(s.bestIndependent && !s.unresolvedContradiction);
      s.retained=Boolean(delayed || s.retained);s.methodSelection=Boolean(s.methodSelection || independent&&q.task.mode==="mixed");
      s.lastObservation={questionId:q.id,result:a.result,reasoning:a.reasoning,independent,at:q.answeredAt};
      if(independent){s.lastIndependentAt=q.answeredAt;s.lastIndependentSeq=q.answeredSeq;s.maxIndependentDepth=Math.max(s.maxIndependentDepth,depth);}
      if(delayed)s.lastRetainedAt=q.answeredAt;
      s.lastChecked=q.answeredAt;s.family=q.task.family;s.prerequisites=q.task.prerequisites||[];s.nextCheck=a.nextCheck;
      if(independent || contradicts || !s.dueAt)s.dueAt=new Date(Date.parse(q.answeredAt)+intervals[Math.min(Math.max(s.streak-1,0),intervals.length-1)]*DAY).toISOString();
      s.evidence.push({diagnosis:a.diagnosis || null,observedErrors:(a.audit || []).filter((v:any)=>v.verdict==="contradicted").map((v:any)=>({observed:v.observed,expected:v.expected})),assisted:!independent && (q.task.assistance!=="none" || q.hints.some((h:any)=>h.seq<q.answeredSeq)),questionId:q.id,at:q.answeredAt,result:a.result,reasoning:a.reasoning,depth,independent,delayed,excerpt:a.evidence});
    }
    const rawAreas=this.coverageAreas();
    const coverage=rawAreas.map((a:any)=>{const s=skills[a.skill]; const evidence=s?.evidence||[];const target=a.targetDepth||3;const latest=evidence.at(-1);const concern=evidence.find((e:any)=>e.questionId===s?.unresolvedContradiction)||latest;return {...a,lastChecked:s?.lastChecked||null,reviewDue:Boolean(s?.dueAt && Date.parse(s.dueAt)<=now),diagnosis:concern?.diagnosis || null,observedErrors:concern?.observedErrors || [],assistedSuccess:latest?.result==="correct" && Boolean(latest?.assisted),targetDepth:target,status:!latest?"unprobed":s.unresolvedContradiction?"shaky":s.independent&&s.currentIndependentDepth>=target?"solid":"probed",maxIndependentDepth:s?.maxIndependentDepth||0,checkedDepths:[...new Set(evidence.map((e:any)=>e.depth))],questionIds:evidence.map((e:any)=>e.questionId),needsDepth:!s || !s.independent || s.currentIndependentDepth<target};});
    const boards=events.filter((e:any)=>e.kind==="board" && (e.payload.scope ? this.sameScope(e.payload.scope,scope) : e.payload.topic===scope.topic));
    const delivered=events.filter((e:any)=>e.kind==="visual-delivered");
    const undelivered=boards.filter((e:any)=>!delivered.some((d:any)=>d.payload.boardId===e.id.slice(6)));
    const pending=questions.filter((q:any)=>q.answer&&!q.excluded&&!q.assessment&&!["cancelled","unavailable","superseded"].includes(q.answer.outcome));
    const contexts=all.filter((e:any)=>e.kind==="context"&&(e.payload.learnerId||"owner")===scope.learnerId);
    const subjects:Record<string,any>={};for(const e of contexts){const p=e.payload;const subject=p.subject||p.topic;const entry=subjects[subject] ||= {subject,topics:[]};const identity=this.canonicalTopic({learnerId:scope.learnerId,subject,topic:p.topic,topicId:p.topicId});entry.topics=entry.topics.filter((t:any)=>t.topicId!==identity);entry.topics.push({topic:p.topic,topicId:identity,note:p.learnerNote,aliases:p.aliases||[]});}
    const unprobed=coverage.filter((a:any)=>a.status==="unprobed").map((a:any)=>a.skill);
    return {support:this.activeSupport(),session:this.contract(),plan:this.plan(),version:4,...scope,activeSubject:scope.subject,subjectMismatch:scope.mismatch,subjects,source:".alvar/learning.sqlite",updatedAt:all.at(-1)?.at||null,skills,coverage,unprobed,
      pendingQuestion:questions.filter((q:any)=>!q.answer&&!q.excluded && (!q.scope.goal || q.scope.goal===scope.goal) && (!this.contract() || q.sessionId===this.contract()!.id)).map((q:any)=>({id:q.id,question:q.question,learnerNote:q.learnerNote})),
      pendingAssessments:pending.map((q:any)=>q.id),
      reviewDue:Object.values(skills).filter((s:any)=>Date.parse(s.dueAt)<=now),
      boards:{count:boards.length,deliveredCount:delivered.length,pending:undelivered.map((e:any)=>({id:e.id.slice(6),file:e.payload.file,planVersion:e.payload.planVersion})),lastFocus:boards.at(-1)?.payload.focus||null,reminder:undelivered.length?"Prepared visuals are not confirmed in the note; deliver the relevant frame before claiming it was shown":delivered.length?null:"Use an HTML board or an explicitly requested Mermaid graph when it explains a relationship"},
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
    if(s.session?.stage==="survey" && !s.subjectMismatch) {
      const selected=s.session.scopeSkills.length?s.coverage.filter((a:any)=>s.session!.scopeSkills.includes(a.skill)):s.coverage;
      const limits=this.scopedEvents().filter((e:any)=>e.kind==="survey-limit" && e.payload.sessionId===s.session!.id);
      const remaining=selected.filter((a:any)=>(a.status==="unprobed" || a.reviewDue) && !limits.some((e:any)=>e.payload.skill===a.skill));
      if(remaining.length)candidates.push({action:"probe_topic",areas:remaining.slice(0,3).map((a:any)=>a.skill),questionFormat:s.session.questionFormat,optionCount:s.session.optionCount,blockedPrerequisites:remaining.map((a:any)=>({skill:a.skill,missing:(a.prerequisites||[]).filter((p:string)=>s.coverage.find((b:any)=>b.skill===p)?.status!=="solid")})),reason:"Survey the remaining branches without teaching every prerequisite first. Probe an accessible property or record survey-limit with a concrete reason. Do not count a blocked check as mastery."});
      else if(selected.length)candidates.push({action:"summarize_survey",limits:limits.map((e:any)=>({skill:e.payload.skill,reason:e.payload.reason})),reason:"Show the full plan with observed gaps and untested limits. Then agree the teaching route; do not silently switch modes."});
      return {subject:s.subject,coverage:s.coverage,boards:s.boards,candidates:candidates.slice(0,6),policy:"Keep the agreed survey and format. A dont_know answer is evidence, not a request to enter support."};
    }
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
    const recent=active.filter((q:any)=>q.answer&&!q.excluded&&q.mode!=="open" && (!s.session || q.sessionId===s.session.id)).slice(-3);
    const openRecommended=recent.length>=2&&recent.slice(-2).every((q:any)=>q.answer.outcome==="correct" && q.task?.skill===recent.at(-1)?.task?.skill) || recent.some((q:any)=>/слишком легк|слишком лёгк|too easy/i.test(q.answer?.note||""));
    return {version:3,learnerId:s.learnerId,profile:s.learnerId==="owner"?".alvar/LEARNER.md":`.alvar/learners/${encodeURIComponent(s.learnerId)}/PROFILE.md`,subject:s.subject,topic:s.topic,goal:s.goal,note:s.learnerNote,experience:s.experience,
      session:s.session,support:s.support,
      plan:s.plan?{version:s.plan.version,thesis:s.plan.thesis,sessions:s.plan.sessions,needsReview:(s.plan as any).scope.goal!==s.goal,inspect:"learning-inspect view=plan"}:{missing:true,restore:"Inspect plans/catalog for related history; read process.md and build a substantive plan before a new survey"},
      recentUserMessages:this.scopedEvents().filter((e:any)=>e.kind==="utterance").slice(-3).map((e:any)=>({messageId:e.id,text:e.payload.text.slice(0,300)})),
      boards:s.boards,
      warning:s.subjectMismatch?"Active note does not match declared topic: select context before teaching":null,
      pendingAssessments:s.pendingAssessments.slice(0,3),pendingQuestion:s.pendingQuestion.slice(0,1).map(q=>({id:q.id,question:q.question.slice(0,240)})),
      coverage:{total:s.coverage.length,solid:s.coverage.filter((a:any)=>a.status==="solid").length,unprobed:s.unprobed.slice(0,6),needsDepth:s.coverage.filter((a:any)=>a.needsDepth).slice(0,6).map((a:any)=>a.skill)},
      quizPolicy:s.session?.questionFormat==="choice"?`Keep ${s.session.optionCount} options as requested. Recognition does not prove independent mastery; deeper checks can follow the survey.`:openRecommended?"An open case may add reasoning evidence; this is advisory and never overrides an agreed format. Do not repeat an explained item as independent evidence.":"Match task depth to expertise. Ambiguous cases may legitimately have insufficient data.",
      candidates:this.recommend(Date.now(),subject).candidates.slice(0,3)};
  }
  ack(extra:Record<string,unknown>={}) {return {ok:true,...extra};}
  inspect(view:string, questionId?:string) {
    if(view==="question") {const q=this.activeQuestions().find((q:any)=>q.id===questionId);if(!q)throw new Error("Question not in active learner/topic");return {responseId:q.id,question:q.question,context:q.context,task:q.task,answer:q.answer?{outcome:q.answer.outcome,text:q.answer.yourAnswer,note:q.answer.note}:null,assessment:q.assessment,excluded:q.excluded};}
    if(view==="map")return this.state().coverage;
    if(view==="plan")return this.plan();
    if(view==="session")return {session:this.contract(),support:this.activeSupport()};
    if(view==="plans")return {saved:this.scopedEvents().filter((e:any)=>e.kind==="plan").map((e:any)=>({version:e.payload.version,thesis:e.payload.thesis})),legacyPaths:this.legacyPlanPaths(),warning:"Legacy paths are pointers, not proof of matching learner/topic or mastery. Read the relevant plan and register it explicitly."};
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
      const mapName=createHash("sha256").update(JSON.stringify([state.learnerId,state.subject,this.canonicalTopic(state)])).digest("hex");
      if(state.plan){const dir=join(this.cwd,".alvar/plans");mkdirSync(dir,{recursive:true});const file=join(dir,mapName+".json"),temp=file+"."+randomUUID()+".tmp";writeFileSync(temp,JSON.stringify(state.plan,null,2)+"\n");renameSync(temp,file);}
      const mapPath=join(mapDir,mapName+".md");
      const mapText="# "+[state.learnerId,state.subject,state.topic].join(" / ")+"\n\n"+state.coverage.map((a:any)=>`- ${a.label||a.skill}: ${a.status}; depth ${a.maxIndependentDepth}/${a.targetDepth}; evidence: ${a.questionIds.join(", ")||"none"}`).join("\n")+"\n";
      const mapTemp=mapPath+"."+randomUUID()+".tmp";writeFileSync(mapTemp,mapText);renameSync(mapTemp,mapPath);
      if(state.coverage.length) {
        const clean=(value:string)=>value.replace(/[\/\\:\x00-\x1f]/g,"-").replace(/^[. ]+|[. ]+$/g,"").slice(0,80)||"Без названия";
        const subjectDir=join(this.cwd,"Предметы",clean(state.subject));mkdirSync(subjectDir,{recursive:true});
        const suffix=createHash("sha256").update(JSON.stringify([state.learnerId,state.subject,this.canonicalTopic(state)])).digest("hex").slice(0,8);
        const filename=clean(state.topic||"Тема")+" — "+clean(state.learnerName)+" — "+suffix+".md";
        const labels:Record<string,string>={unprobed:"Не проверяли",probed:"Проверено частично; самостоятельность ещё не подтверждена",shaky:"Наблюдалось затруднение",solid:"Есть самостоятельное подтверждение"};
        const safeText=(t:string)=>t.replace(/[\r\n|]/g," ");
        const diagram=["```mermaid","flowchart TD",...state.coverage.map((a:any,i:number)=>` n${i}["${safeText(a.label||a.skill).replace(/"/g,"'")}"]`),...state.coverage.flatMap((a:any,i:number)=>(a.prerequisites||[]).map((key:string)=>` n${state.coverage.findIndex((b:any)=>b.skill===key)} --> n${i}`)),"```"].join("\n");
        const table="| Тема | Что наблюдалось |\n| --- | --- |\n"+state.coverage.map((a:any)=>`| ${safeText(a.label||a.skill)} | ${labels[a.status]} |`).join("\n");
        const visible=`# ${safeText(state.topic||"Карта темы")}\n\nУченик: ${safeText(state.learnerName)}.\n\n${state.plan?`**Главная идея:** ${state.plan.thesis}\n\n${state.plan.sessions.map((s:any,i:number)=>`${i+1}. **${s.title}** — ${s.goal}`).join("\n")}\n\n`:""}${diagram}\n\n${table}\n\nКарта помогает выбрать следующий шаг; к темам можно возвращаться по мере надобности.\n\n`+(state.learnerNote?`Конспект: [[${state.learnerNote.replace(/\.md$/i,"")}]]\n`:"");
        const destination=join(subjectDir,filename),temp=destination+"."+randomUUID()+".tmp";writeFileSync(temp,visible);renameSync(temp,destination);
        const catalog=allCatalog(this.events(),c=>this.canonicalTopic(c));
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

function allCatalog(events:any[],canonical:(scope:any)=>string) {const unique=new Map();for(const e of events)if(e.kind==="context"&&e.payload.subject&&e.payload.learnerId){const c=e.payload;unique.set(JSON.stringify([c.learnerId,c.subject,canonical(c)]),c);}return [...unique.values()];}
