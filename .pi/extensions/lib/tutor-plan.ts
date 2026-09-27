import type { CoverageArea } from "./tutor-store";

export type SessionContract = {
  stage: "survey" | "teach" | "review";
  questionFormat: "choice" | "open" | "adaptive";
  optionCount?: number;
  scopeSkills: string[];
};
export type TeachingPlan = {
  thesis: string;
  sources?: Array<{title:string;author?:string;location?:string;url?:string;skills:string[]}>;
  crossLinks?: Array<{topicId:string;relation:string;reason:string}>;
  notes?: string[];
  areas: CoverageArea[];
  connections: Array<{ from: string; to: string; reason: string }>;
  sessions: Array<{ title: string; goal: string; skills: string[] }>;
};

export function mergeAreas(previous: CoverageArea[], incoming: CoverageArea[], replace = false): CoverageArea[] {
  if(!Array.isArray(incoming) || !incoming.length)throw new Error("A map needs at least one area");
  const result=new Map<string,CoverageArea>(replace?[]:previous.map(a=>[a.skill,a]));
  const seen=new Set<string>();
  for(const area of incoming) {
    if(!area.skill?.trim() || seen.has(area.skill))throw new Error("Duplicate or empty coverage skill");
    if(area.targetDepth!==undefined && (!Number.isInteger(area.targetDepth)||area.targetDepth<1||area.targetDepth>4))throw new Error("Target depth must be 1–4");
    seen.add(area.skill); result.set(area.skill,{...result.get(area.skill),...area,status:"unprobed"});
  }
  const visited=new Set<string>(), stack=new Set<string>();
  function visit(key:string) {
    if(stack.has(key))throw new Error("Coverage prerequisites form a cycle");
    if(visited.has(key))return;
    const area=result.get(key); if(!area)throw new Error(`Missing prerequisite area ${key}`);
    stack.add(key); for(const p of area.prerequisites||[])visit(p); stack.delete(key);visited.add(key);
  }
  for(const key of result.keys())visit(key);
  return [...result.values()];
}

export function validatePlan(plan:TeachingPlan) {
  if(!plan.thesis?.trim() || !plan.sessions?.length)throw new Error("A substantive plan needs a central idea and a session route");
  const ids=new Set(plan.areas.map(a=>a.skill));
  for(const source of plan.sources||[])if(!source.title?.trim() || !source.skills?.length || source.skills.some(k=>!ids.has(k)))throw new Error("Sources must name a title and existing plan areas");
  for(const link of plan.crossLinks||[])if(!link.topicId?.trim()||!link.relation?.trim()||!link.reason?.trim())throw new Error("Cross-topic links need a target, relation and reason");
  const covered=new Set<string>();
  for(const s of plan.sessions) {
    if(!s.title?.trim() || !s.goal?.trim() || !s.skills?.length || s.skills.some(k=>!ids.has(k)))throw new Error("Every session needs a goal and existing skills");
    s.skills.forEach(k=>covered.add(k));
  }
  if([...ids].some(k=>!covered.has(k)))throw new Error("Every plan area must appear in the session route");
  for(const edge of plan.connections||[])if(!ids.has(edge.from)||!ids.has(edge.to)||!edge.reason?.trim() || !plan.areas.find(a=>a.skill===edge.to)?.prerequisites?.includes(edge.from))throw new Error("Explain an actual prerequisite edge using existing nodes");
  for(const a of plan.areas)for(const p of a.prerequisites||[])if(!plan.connections?.some(e=>e.from===p&&e.to===a.skill))throw new Error(`Explain why ${p} is a prerequisite for ${a.skill}`);
}

export const statusLabels: Record<string,string> = {
  unprobed:"Не проверяли", probed:"Проверено частично", shaky:"Наблюдалось затруднение", solid:"Есть самостоятельное подтверждение",
};
const escape=(value:unknown)=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
function lines(text:string, limit=24) {
  const rows:string[]=[];let line="";
  for(const word of text.split(/\s+/)) {if(line && (line+" "+word).length>limit){rows.push(line);line="";}line+=(line?" ":"")+word;}
  if(line)rows.push(line);return rows;
}

/** Self-contained overview: dependency graph, evidence and route are different views. */
export function planHtml(plan:TeachingPlan & {version:number}, coverage:any[], title:string) {
  const levels=new Map<string,number>();
  function level(a:any):number {if(levels.has(a.skill))return levels.get(a.skill)!;const n=Math.max(-1,...(a.prerequisites||[]).map((k:string)=>level(coverage.find(b=>b.skill===k))))+1;levels.set(a.skill,n);return n;}
  coverage.forEach(level);
  const nodes=new Map<string,{x:number;y:number;h:number;label:string[]}>(), cursors=new Map<number,number>();
  for(const a of coverage){const col=levels.get(a.skill)!;const label=lines(a.label||a.skill);const h=Math.max(72,30+label.length*20);const y=cursors.get(col)||20;nodes.set(a.skill,{x:20+col*300,y,h,label});cursors.set(col,y+h+34);}
  const width=280+Math.max(0,...levels.values())*300, height=Math.max(160,...cursors.values());
  const edges=coverage.flatMap(a=>(a.prerequisites||[]).map((k:string)=>{const from=nodes.get(k)!,to=nodes.get(a.skill)!;const x=from.x+240,y=from.y+from.h/2,tx=to.x,ty=to.y+to.h/2;return `<path d="M${x},${y} C${x+30},${y} ${tx-30},${ty} ${tx},${ty}" marker-end="url(#arrow)"/>`;})).join("");
  const boxes=coverage.map(a=>{const n=nodes.get(a.skill)!;return `<g class="${escape(a.reviewDue?"probed":a.status)}"><title>${escape(a.label||a.skill)} — ${escape(statusLabels[a.status])}</title><rect x="${n.x}" y="${n.y}" width="240" height="${n.h}" rx="8"/>${n.label.map((l,i)=>`<text x="${n.x+12}" y="${n.y+25+i*20}">${escape(l)}</text>`).join("")}</g>`;}).join("");
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>
body{margin:0;padding:24px;background:var(--background-primary,#151719);color:var(--text-normal,#eceff1);font:16px/1.6 var(--font-text,system-ui)}p{max-width:85ch}h2{font-size:1.2rem;margin-top:1.8em}.graph{overflow:auto}svg{display:block;max-width:100%;height:auto}button{font:inherit;color:inherit;background:var(--background-secondary,#23272c);border:1px solid #777;border-radius:6px;padding:5px 12px;margin:0 6px 10px 0;cursor:pointer}path{fill:none;stroke:#8b949e;stroke-width:2}marker path{fill:#8b949e}rect{fill:var(--background-secondary,#23272c);stroke:#8b949e;stroke-width:2}.solid rect{stroke:#6cce99}.shaky rect{stroke:#edae67}.probed rect{stroke:#88baff}text{fill:var(--text-normal,#eceff1);font-size:15px}table{border-collapse:collapse;width:100%}th,td{padding:10px;text-align:left;border-bottom:1px solid #555;vertical-align:top}small{color:var(--text-muted,#aaa)}li{margin:.5em 0}
</style><body><p><strong>Главная идея:</strong> ${escape(plan.thesis)}</p><p>Стрелка ведёт от предпосылки к зависящей теме. Серый — не проверяли; синий — проверено частично; оранжевый — наблюдалось затруднение; зелёный — есть самостоятельное подтверждение.</p><div aria-label="Масштаб карты"><button id="fit">Вписать</button><button id="larger">Крупнее</button><button id="smaller">Мельче</button><small>При увеличении граф прокручивается по горизонтали.</small></div><div class="graph"><svg role="img" aria-label="Граф зависимостей темы" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10z"/></marker></defs>${edges}${boxes}</svg></div><h2>Что проверено и где нужна помощь</h2><table><thead><tr><th>Область</th><th>Наблюдение</th><th>Следующий шаг</th></tr></thead><tbody>${coverage.map(a=>`<tr><td>${escape(a.label||a.skill)}</td><td>${escape(statusLabels[a.status])}${a.lastChecked?"; последнее наблюдение "+escape(a.lastChecked.slice(0,10)):""}${a.reviewDue?"; нужна повторная проверка":""}${a.assistedSuccess?"; последний ответ получен с помощью":""}${a.observedErrors?.length?": "+a.observedErrors.map((e:any)=>escape(e.observed)+" → "+escape(e.expected)).join("; "):""}</td><td>${escape(a.note|| (a.status==="unprobed"?"Проверить доступное свойство":"Проверить применение на новом случае"))}</td></tr>`).join("")}</tbody></table><h2>Почему темы связаны</h2><ul>${plan.connections.map(e=>`<li>${escape(coverage.find(a=>a.skill===e.from)?.label||e.from)} → ${escape(coverage.find(a=>a.skill===e.to)?.label||e.to)}: ${escape(e.reason)}</li>`).join("")}</ul><h2>Маршрут занятий</h2><ol>${plan.sessions.map(s=>`<li><strong>${escape(s.title)}</strong> — ${escape(s.goal)}<br><small>${s.skills.map(k=>escape(coverage.find(a=>a.skill===k)?.label||k)).join(" · ")}</small></li>`).join("")}</ol>${plan.sources?.length?'<h2>Источники</h2><ul>'+plan.sources.map(s=>'<li>'+escape([s.author,s.title,s.location,s.url].filter(Boolean).join(' · '))+'</li>').join('')+'</ul>':''}${plan.crossLinks?.length?'<h2>Связи с другими темами</h2><ul>'+plan.crossLinks.map(l=>'<li>'+escape(l.topicId)+' — '+escape(l.relation)+': '+escape(l.reason)+'</li>').join('')+'</ul>':''}${plan.notes?.length?'<h2>Открытые вопросы и границы модели</h2><ul>'+plan.notes.map(n=>'<li>'+escape(n)+'</li>').join('')+'</ul>':''}<p><small>Версия плана ${plan.version}. Маршрут не является доказательством освоения; состояния основаны на сохранённых ответах, а давность и помощь требуют учёта.</small></p><script>(()=>{const graph=document.querySelector('.graph'),svg=graph.querySelector('svg');let scale=1;const draw=()=>{svg.style.maxWidth='none';svg.style.width=(${width}*scale)+'px';};document.getElementById('fit').onclick=()=>{scale=Math.min(1,graph.clientWidth/${width});draw();};document.getElementById('larger').onclick=()=>{if(svg.style.maxWidth!=='none')scale=Math.min(1,graph.clientWidth/${width});scale=Math.min(2,scale*1.25);draw();};document.getElementById('smaller').onclick=()=>{if(svg.style.maxWidth!=='none')scale=Math.min(1,graph.clientWidth/${width});scale=Math.max(.2,scale/1.25);draw();};})();</script></body></html>`;
}
