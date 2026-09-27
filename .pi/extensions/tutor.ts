import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withStore } from "./lib/tutor-store";
import { TaskSchema, ReasoningAuditSchema, DiagnosisSchema } from "./lib/tutor-schema";
const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value });
const CoverageAreaSchema = Type.Object({
  skill: Type.String({ minLength: 1, description: "Stable skill id, usually prefix:name" }),
  status: Type.Optional(Type.Union(["unprobed", "probed", "shaky", "solid"].map(v => Type.Literal(v)))),
  label: Type.Optional(Type.String()), prerequisites: Type.Optional(Type.Array(Type.String())), targetDepth: Type.Optional(Type.Integer({minimum:1,maximum:4})), priority: Type.Optional(Type.Integer({minimum:0,maximum:10})),
  note: Type.Optional(Type.String({ minLength: 1 })),
});
export default function tutor(pi: ExtensionAPI) {
  pi.on("before_agent_start", (event, ctx) => {
    const path = join(ctx.cwd, ".pi/skills/teach/references/turn-policy.md");
    if (!existsSync(path)) return;
    const policy = readFileSync(path, "utf8").trim();
    const base = event.systemPrompt.replace(/\n<learning-turn-policy>[\s\S]*?<\/learning-turn-policy>/g, "");
    return { systemPrompt: `${base}\n<learning-turn-policy>\n${policy}\n</learning-turn-policy>` };
  });
  pi.on("session_start", (_event, ctx) => {
    try { withStore(ctx.cwd, s => s.start()); }
    catch (e) { ctx.ui.notify(`Учебное состояние не загружено: ${String(e)}`, "error"); }
  });
  pi.registerTool({ name: "learning-next", label: "Учебный контекст",
    description: "Compact context for the active learner/subject/topic. Call on resume or when choosing the next diagnostic action, not after every saved answer. Use learning-inspect for a specific question or the map. Never print internal metadata in the lesson.",
    parameters: Type.Object({}),
    async execute(_id, _p, _signal, _update, ctx) { return text(withStore(ctx.cwd,s=>{s.start();return s.summary();})); }
  });
  pi.registerTool({name:"learning-inspect",label:"Учебные данные",description:"Read a specific stored response, full coverage map, subject catalog for the active learner, or last five attempts. Does not expose another learner's answers.",
    parameters:Type.Object({view:Type.Union(["question","map","catalog","history"].map(v=>Type.Literal(v))),questionId:Type.Optional(Type.String())}),
    async execute(_id,p,_s,_u,ctx){return text(withStore(ctx.cwd,s=>s.inspect(p.view,p.questionId)));}
  });
  pi.registerTool({ name: "learning-assess", label: "Оценка рассуждения",
    description: "Assess a submitted quiz answer separately from automatic choice correctness. Pass responseId from the quiz result; the stored answer is linked automatically. Evidence is optional. A topic change is not an answer: use learning-record disposition=redirect. Pass task inline when the question was asked without task metadata, instead of failing first. Assessment is model judgment, not observed fact. Cancellation is not evidence. Does not publish feedback: explain the substantive result naturally in your next reply.",
    parameters: Type.Object({ diagnosis: Type.Optional(DiagnosisSchema), audit: Type.Optional(ReasoningAuditSchema), responseId: Type.Optional(Type.String({description:"Stable id returned by quiz; no copying the response needed"})), questionId: Type.Optional(Type.String()), result: Type.Union(["correct", "partial", "incorrect", "uncertain"].map(v => Type.Literal(v))),
      reasoning: Type.Union(["sound", "partial", "incorrect", "unobserved"].map(v => Type.Literal(v))), evidence: Type.Optional(Type.String({minLength:1,description:"Optional exact excerpt; omit to link the stored response"})), nextCheck: Type.String({minLength:1}),
      task: Type.Optional(TaskSchema) }),
    async execute(id, p, _signal, _update, ctx) { return text(withStore(ctx.cwd, s => { s.assess(id, p as any, (p as any).task); return s.ack({ responseId: p.responseId || p.questionId, result: p.result }); })); }
  });
  pi.registerTool({ name: "learning-record", label: "Учебные события",
    description: "Record internal context, task metadata, actual assistance or configurable spacing. Do not narrate bookkeeping. Quiz tools persist questions and answers automatically. Assistance must be recorded when given, before receiving the answer.",
    // Keep a root object: some providers discard properties of a root anyOf.
    parameters: Type.Object({
      kind: Type.Union(["context", "task", "assistance", "instruction", "schedule", "coverage", "disposition", "support"].map(v => Type.Literal(v))),
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
      areas: Type.Optional(Type.Array(CoverageAreaSchema, { minItems: 1, maxItems: 24, description: "Full topic coverage map: every area of the topic with its status. Replaces the previous map for this subject." })),
    }),
    async execute(id, p, _signal, _update, ctx) {
      const required: Record<string, string[]> = { support:["supportStatus","focus","nextStep","basis"], context:["learnerId","subject","topic","goal"], task:["questionId","task"], assistance:["questionId","detail"], instruction:["skill","family","mode","summary","verification"], schedule:["days"], coverage:["areas"], disposition:["questionId","disposition"] };
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
        return { markdown, focus: p.focus, frame: sequence, subject: before.activeSubject,
          instruction: "Include this entire frame next to the current explanation. Append only; do not manually write when md-log is active. The learner reads downward: draw a full frame again instead of pointing back up." };
      }));
    }
  });
}
