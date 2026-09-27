import { parseSkillBlock, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withStore } from "./lib/tutor-store";
import { registerCurriculumTools } from "./lib/curriculum-tools";
import { createHash } from "node:crypto";
import { TaskSchema, AssessmentFields, ResolveSupportSchema } from "./lib/tutor-schema";
const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value });
const CoverageAreaSchema = Type.Object({
  skill: Type.String({ minLength: 1, description: "Stable skill id, usually prefix:name" }),
  status: Type.Optional(Type.Union(["unprobed", "probed", "shaky", "solid"].map(v => Type.Literal(v)))),
  label: Type.Optional(Type.String()), prerequisites: Type.Optional(Type.Array(Type.String())), targetDepth: Type.Optional(Type.Integer({minimum:1,maximum:4})), priority: Type.Optional(Type.Integer({minimum:0,maximum:10})),
  note: Type.Optional(Type.String({ minLength: 1 })),
});
export default function tutor(pi: ExtensionAPI) {
  registerCurriculumTools(pi);
  pi.on("message_end", (event,ctx)=>{
    const message=event.message as any;
    if(message.role!=="user")return;
    let body=typeof message.content==="string"?message.content:(message.content||[]).filter((p:any)=>p.type==="text").map((p:any)=>p.text).join("\n");
    const parsed=parseSkillBlock(body);if(parsed)body=parsed.userMessage||"";
    if(!body.trim())return;
    const id=createHash("sha256").update(`${message.timestamp||0}|${body}`).digest("hex");
    try {withStore(ctx.cwd,s=>s.observe(id,body));}catch(error){ctx.ui.notify(`Не удалось сохранить реплику: ${String(error)}`,"warning");}
  });
  pi.on("before_agent_start", (event, ctx) => {
    const path = join(ctx.cwd, ".pi/skills/teach/references/turn-policy.md");
    if (!existsSync(path)) return;
    const refs=join(ctx.cwd,".pi/skills/teach/references");
    let policy = readFileSync(path, "utf8").trim();
    for (const file of ["learning-engine.md","startup.md"]) {
      const source=join(refs,file); if(existsSync(source))policy+="\n\n"+readFileSync(source,"utf8").trim();
    }
    const techniques=join(refs,"techniques.md");
    if(existsSync(techniques))policy+="\n\nTechnique index (retrieve chosen cards with learning-technique):\n"+(readFileSync(techniques,"utf8").match(/\*\*T\d{2}\.[^\n]+/g)||[]).join("\n");
    policy+="\n\nReference directory: "+refs+". Loaded sections above need no read calls.";
    try {
      const next=withStore(ctx.cwd,s=>s.summary());
      if((next.plan as any).missing || (next.plan as any).needsReview){const planning=join(refs,"process.md");if(existsSync(planning))policy+="\n\nPlanning protocol (already loaded):\n"+readFileSync(planning,"utf8");}
      if(!next.warning){
        const profile=join(ctx.cwd,next.profile);
        if(existsSync(profile)){const body=readFileSync(profile,"utf8");policy+="\n\nActive learner profile (preferences and history, not proof of mastery):\n"+body.slice(0,8000)+(body.length>8000?"\n[Truncated; read the profile only if more detail is needed.]":"");}
      }
      policy+="\n\nCurrent learning context (internal; do not print; no learning-next needed unless stale):\n"+JSON.stringify(next);
    }catch(error){policy+="\nLearning state unavailable: "+String(error)+". Restore context before making knowledge claims.";}
    const base = event.systemPrompt.replace(/\n<learning-turn-policy>[\s\S]*?<\/learning-turn-policy>/g, "");
    return { systemPrompt: `${base}\n<learning-turn-policy>\n${policy}\n</learning-turn-policy>` };
  });
  pi.on("session_start", (_event, ctx) => {
    try { withStore(ctx.cwd, s => s.start()); }
    catch (e) { ctx.ui.notify(`Учебное состояние не загружено: ${String(e)}`, "error"); }
  });
  pi.registerTool({ name: "learning-next", label: "Учебный контекст",
    description: "Compact context for the active learner/subject/topic. Use only when injected context is missing or stale. Assessment results already include fresh context. Use learning-inspect for a specific question or the map. Never print internal metadata in the lesson.",
    parameters: Type.Object({}),
    async execute(_id, _p, _signal, _update, ctx) { return text(withStore(ctx.cwd,s=>s.summary())); }
  });
  pi.registerTool({name:"learning-inspect",label:"Учебные данные",description:"Read a specific stored response, full coverage map, subject catalog for the active learner, or last five attempts. Does not expose another learner's answers.",
    parameters:Type.Object({view:Type.Union(["question","map","catalog","history","plan","plans","session"].map(v=>Type.Literal(v))),questionId:Type.Optional(Type.String())}),
    async execute(_id,p,_s,_u,ctx){return text(withStore(ctx.cwd,s=>s.inspect(p.view,p.questionId)));}
  });
  pi.registerTool({ name: "learning-assess", label: "Оценка рассуждения",
    description: "Assess a submitted quiz answer separately from automatic choice correctness. Pass responseId from the quiz result; the stored answer is linked automatically. Evidence is optional. A topic change is not an answer: use learning-record disposition=redirect. Pass task inline when the question was asked without task metadata, instead of failing first. Assessment is model judgment, not observed fact. Cancellation is not evidence. Optionally resolveSupport in the same transaction when local help is complete. Returns fresh context: no learning-next needed afterward. Does not publish feedback: explain the substantive result naturally in your next reply.",
    parameters: Type.Object({...AssessmentFields,
      responseId: Type.Optional(Type.String()), questionId: Type.Optional(Type.String()),
      task: Type.Optional(TaskSchema), resolveSupport: Type.Optional(ResolveSupportSchema) }),
    async execute(id, p, _signal, _update, ctx) {
      const {task,resolveSupport,...assessment}=p;
      return text(withStore(ctx.cwd,s=>s.review(id,{assessment,task,resolveSupport})));
    }
  });
  pi.registerTool({ name: "learning-record", label: "Учебные события",
    description: "Record internal context, task metadata, actual assistance or configurable spacing. Do not narrate bookkeeping. Quiz tools persist questions and answers automatically. Use kind=assistance only for a hint on an existing question: questionId + detail. For an explanation/demo without a current question use kind=instruction: skill, family, mode=worked/explanation, summary, verification. Record help before the learner answers.",
    // Keep a root object: some providers discard properties of a root anyOf.
    parameters: Type.Object({
      kind: Type.Union(["context", "task", "assistance", "instruction", "schedule", "coverage", "disposition", "support", "session", "survey-limit"].map(v => Type.Literal(v))),
      stage: Type.Optional(Type.Union(["survey","teach","review"].map(v=>Type.Literal(v)))),
      questionFormat: Type.Optional(Type.Union(["choice","open","adaptive"].map(v=>Type.Literal(v)))),
      optionCount: Type.Optional(Type.Integer({minimum:2,maximum:6})), scopeSkills: Type.Optional(Type.Array(Type.String(),{description:"[] surveys the entire plan"})),
      trigger: Type.Optional(Type.Union(["help_requested","explanation_confusion"].map(v=>Type.Literal(v)))),
      replace: Type.Optional(Type.Boolean()), reason: Type.Optional(Type.String({minLength:1})),
      topicId: Type.Optional(Type.String({minLength:1})), aliases: Type.Optional(Type.Array(Type.String({minLength:1}))),
      supportStatus: Type.Optional(Type.Union(["active","resolved","redirected"].map(v=>Type.Literal(v)))),
      focus: Type.Optional(Type.String({minLength:1,maxLength:300})), nextStep: Type.Optional(Type.String({minLength:1,maxLength:500})), basis: Type.Optional(Type.String({minLength:1,maxLength:500})),
      learnerName: Type.Optional(Type.String()), learnerId: Type.Optional(Type.String({minLength:1,description:"primary learner; separate id for another learner"})), subject: Type.Optional(Type.String({minLength:1})), experience: Type.Optional(Type.String()),
      disposition: Type.Optional(Type.Union(["redirect","invalid_question","skip"].map(v=>Type.Literal(v)))),
      topic: Type.Optional(Type.String({minLength:1})), goal: Type.Optional(Type.String({minLength:1})), deadline: Type.Optional(Type.String()),
      questionId: Type.Optional(Type.String({minLength:1})), task: Type.Optional(TaskSchema), detail: Type.Optional(Type.String({minLength:1})),
      skill: Type.Optional(Type.String({minLength:1})), family: Type.Optional(Type.String({minLength:1})),
      mode: Type.Optional(Type.Union([Type.Literal("worked"), Type.Literal("explanation")])),
      summary: Type.Optional(Type.String({minLength:1})), verification: Type.Optional(Type.String({minLength:1})),
      days: Type.Optional(Type.Array(Type.Number({minimum:1}), {minItems:1, maxItems:12})),
      areas: Type.Optional(Type.Array(CoverageAreaSchema, { minItems: 1, maxItems: 80, description: "Full topic coverage map: every area of the topic with its status. Merges areas with the current map. Explicit replace=true and reason are required to remove areas." })),
    }),
    async execute(id, p, _signal, _update, ctx) {
      const required: Record<string, string[]> = { session:["stage","questionFormat","scopeSkills"], "survey-limit":["skill","reason"], support:["supportStatus","nextStep","basis"], context:["learnerId","subject","topic","goal"], task:["questionId","task"], assistance:["questionId","detail"], instruction:["skill","family","mode","summary","verification"], schedule:["days"], coverage:["areas"], disposition:["questionId","disposition"] };
      if(p.kind==="assistance" && !p.questionId)throw new Error("assistance requires an existing questionId and detail. For an explanation without a pending question, use kind=instruction with skill, family, mode=worked/explanation, summary and verification.");
      if(p.kind==="support" && p.supportStatus==="active" && (!p.focus?.trim() || !p.trigger))throw new Error("Opening support requires focus and trigger");
      const fields = required[p.kind];
      if (!fields) throw new Error("Unknown learning-record kind");
      for (const key of fields) { const value = (p as any)[key]; if (value === undefined || value === null || typeof value === "string" && !value.trim()) throw new Error(`${p.kind} requires ${key}`); }
      if (p.kind === "schedule" && p.days.some((n, i) => !Number.isFinite(n) || n < 1 || i > 0 && n < p.days[i-1])) throw new Error("Intervals must be positive and ascending");
      if (p.kind === "context" && p.deadline && !Number.isFinite(Date.parse(p.deadline))) throw new Error("Invalid deadline");
      if (p.kind === "coverage") {
        const skills = new Set<string>();
        for (const area of p.areas) {
          if (skills.has(area.skill)) throw new Error(`Duplicate coverage area ${area.skill}: one status per area`);
          skills.add(area.skill);
        }
      }
      return text(withStore(ctx.cwd, s => { const {kind, ...data} = p; s.record(id, kind, data); return s.ack({ kind }); }));
    }
  });
  pi.registerTool({ name: "learning-board", label: "Доска",
    description: "Prepare a NEW self-contained Mermaid board frame for the current explanation. Always embed returned markdown in the next learner-facing reply so md-log appends it. Never edit or refer the learner back to an old frame. Same labels may recur. Does not write to the note itself.",
    parameters: Type.Object({ boardId: Type.String({minLength:1}), mermaid: Type.String({minLength:1}), focus: Type.String({minLength:1}) }),
    async execute(id, p, _signal, _update, ctx) {
      if (p.mermaid.includes("```") || !/^\s*(flowchart|graph)\s+(LR|TD|TB|RL|BT)\b/.test(p.mermaid)) throw new Error("Provide a bare flowchart/graph body without fences");
      const markdown = "```mermaid\n" + p.mermaid.trim() + "\n```";
      return text(withStore(ctx.cwd, s => {
        const before = s.state();
        const sequence = before.boards.count + 1;
        s.record(id, "board", p);
        return { id, markdown, focus: p.focus, frame: sequence, subject: before.activeSubject,
          instruction: "Include this entire frame next to the current explanation. Append only; do not manually write when md-log is active. The learner reads downward: draw a full frame again instead of pointing back up." };
      }));
    }
  });
}
