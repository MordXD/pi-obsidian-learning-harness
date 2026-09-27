import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { TaskSchema } from "./tutor-schema";
import { withStore } from "./tutor-store";
import { planHtml } from "./tutor-plan";
import { saveVisual, readLogTarget } from "./learning";
const text=(value:any)=>({content:[{type:"text" as const,text:JSON.stringify(value)}],details:value});
const Area=Type.Object({skill:Type.String({minLength:1}),label:Type.String({minLength:1}),prerequisites:Type.Array(Type.String()),targetDepth:Type.Integer({minimum:1,maximum:4}),note:Type.Optional(Type.String()),priority:Type.Optional(Type.Integer({minimum:0,maximum:10}))});
export function registerCurriculumTools(pi:ExtensionAPI) {
  pi.registerTool({name:"learning-plan",label:"План темы",description:"Save a versioned substantive plan: central idea, reasoned dependencies and session route. Read process.md and restore related history before planning. Areas merge by default; shrinking needs replace=true with reason. Existing plans require expectedVersion. Recording is not displaying; use learning-map to show it.",
    parameters:Type.Object({thesis:Type.String({minLength:1}),sources:Type.Optional(Type.Array(Type.Object({title:Type.String({minLength:1}),author:Type.Optional(Type.String()),location:Type.Optional(Type.String()),url:Type.Optional(Type.String()),skills:Type.Array(Type.String(),{minItems:1})}))),crossLinks:Type.Optional(Type.Array(Type.Object({topicId:Type.String({minLength:1}),relation:Type.String({minLength:1}),reason:Type.String({minLength:1})}))),notes:Type.Optional(Type.Array(Type.String())),areas:Type.Array(Area,{minItems:1,maxItems:80}),connections:Type.Array(Type.Object({from:Type.String(),to:Type.String(),reason:Type.String({minLength:1})})),sessions:Type.Array(Type.Object({title:Type.String({minLength:1}),goal:Type.String({minLength:1}),skills:Type.Array(Type.String(),{minItems:1})})),expectedVersion:Type.Optional(Type.Integer({minimum:1})),replace:Type.Optional(Type.Boolean()),reason:Type.Optional(Type.String())}),
    async execute(id,p,_s,_u,ctx){return text(withStore(ctx.cwd,s=>{const plan=s.savePlan(id,p as any);return {ok:true,version:plan.version,areas:plan.areas.length,next:"Use learning-map to deliver the plan and evidence; saving does not show it"};}));}
  });
  pi.registerTool({name:"learning-map",label:"Карта знаний",description:"Render the full saved plan, dependency graph, observed gaps, untested areas and session route as a self-contained HTML card. Does not claim mastery from the plan. Include returned markdown in your next reply; md-log tracks delivery to the active note.",
    parameters:Type.Object({height:Type.Optional(Type.Integer({minimum:200,maximum:1600}))}),
    async execute(id,p,_s,_u,ctx){
      return withStore(ctx.cwd,s=>{const previous=s.events().find((e:any)=>e.id===`board:${id}`)?.payload;
      if(previous?.result){if(JSON.stringify(previous.request)!==JSON.stringify(p))throw new Error("Conflicting visual request");return text(previous.result);}
      const plan=s.plan();if(!plan)throw new Error("No substantive plan: inspect plans/catalog, read process.md, then call learning-plan");const state=s.state();const file=saveVisual(ctx.cwd,"",state.topic||"learning-map","html",planHtml(plan,state.coverage,state.topic||"Карта знаний"));const note=readLogTarget(ctx.cwd);const path=relative(ctx.cwd,file).split(sep).join("/");const markdown='```artifact\nheight='+(p.height??900)+' title="Карта знаний"\n'+path+'\n```';const result={id,file,note,markdown,planVersion:plan.version,delivery:note?"prepared; include in next reply":"no connected note; connect md-log before delivery",instruction:"Include the card and explain why this route addresses the goal. Do not replace it with a list of themes."};s.record(id,"board",{boardId:id,format:"html",file,focus:"Topic map",planVersion:plan.version,request:p,result});return text(result);});
    }
  });
  pi.registerTool({name:"learning-response",label:"Ответ из разговора",description:"Link an actually observed user message to a task for explicit assessment. Does not grade or repeat the message in the note. Get messageId from learning-next. A complaint or preference is not an answer. Include the assistance actually given.",
    parameters:Type.Object({messageId:Type.String(),question:Type.String({minLength:1}),excerpt:Type.String({minLength:1}),task:TaskSchema}),
    async execute(id,p,_s,_u,ctx){return text(withStore(ctx.cwd,s=>s.conversationResponse(id,p.messageId,p.question,p.excerpt,p.task as any)));}
  });
  pi.registerTool({name:"learning-technique",label:"Приём объяснения",description:"Retrieve teaching technique cards when choosing or changing an explanation. Query by observed difficulty or specific T IDs. These are options, not a quota or proof of application. Apply a suitable action and look for its observable effect in the student's response.",
    parameters:Type.Object({query:Type.String({minLength:1}),ids:Type.Optional(Type.Array(Type.String(),{maxItems:4}))}),
    async execute(_id,p,_s,_u,ctx){const source=readFileSync(join(ctx.cwd,".pi/skills/teach/references/techniques.md"),"utf8");const cards=source.split(/(?=\*\*T\d{2}\.)/).filter(s=>/^\*\*T/.test(s)).map(s=>s.split(/\n## /)[0].trim());const terms=p.query.toLowerCase().split(/\s+/).filter(t=>t.length>2);const ranked=cards.map(card=>({card,score:terms.reduce((n,t)=>n+(card.toLowerCase().includes(t)?1:0),0)})).sort((a,b)=>b.score-a.score);return text({cards:p.ids?.length?cards.filter(c=>p.ids!.some(id=>c.startsWith(`**${id}.`))):ranked.filter(x=>x.score).slice(0,3).map(x=>x.card),catalog:cards.map(c=>c.split("**")[1]),instruction:"Choose by the actual difficulty. Explain enough to complete the reasoning step; do not announce technique IDs to the learner."});}
  });
}
