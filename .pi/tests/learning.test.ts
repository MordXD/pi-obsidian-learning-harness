import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EventEmitter } from "node:events";
import quizExtension from "../extensions/quiz";
import logExtension from "../extensions/md-log";
import visualsExtension from "../extensions/visual-tools/index";
import { calculate, verifyNumericAnswer, saveVisual, imageEmbed, readLogTarget, saveLogTarget } from "../extensions/lib/learning";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function workspace() { const r = mkdtempSync(join(tmpdir(), "pi-learning-test-")); roots.push(r); return r; }
function harness(cwd = workspace()) {
  const handlers = new Map<string, Function[]>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const bus = new EventEmitter();
  const events: Array<{ name: string; data: any }> = [];
  const notifications: any[] = [];
  const pi = {
    on(name: string, cb: Function) { handlers.set(name, [...(handlers.get(name) || []), cb]); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(name: string, cmd: any) { commands.set(name, cmd); },
    events: {
      on(name: string, cb: (...args: any[]) => void) { bus.on(name, cb); return () => bus.off(name, cb); },
      emit(name: string, data: any) { events.push({ name, data }); bus.emit(name, data); },
    },
  };
  const ctx: any = { cwd, hasUI: true, ui: {
    notify: (...args: any[]) => notifications.push(args),
    custom: async () => ({ dontKnow: false, note: "Сначала вычислил разность", answers: [{ label: "3 кГц", value: "three", index: 2 }] }),
    editor: async () => "Сначала раскрою скобки.\nВыход удваивается по линейности.",
  } };
  return { pi, ctx, tools, events, notifications, commands,
    fire(name: string, event = {}) { for (const cb of handlers.get(name) || []) cb(event, ctx); },
    async call(name: string, params: any, id = "question-1", signal?: AbortSignal) {
      return tools.get(name).execute(id, params, signal, undefined, ctx);
    },
  };
}
const numeric = () => ({
  question: "Частота дискретизации 10 кГц, вход 7 кГц. Частота алиаса?", shuffle: false,
  options: [{ label: "7 кГц", value: "seven", numericValue: 7 }, { label: "3 кГц", value: "three", numericValue: 3 }, { label: "5 кГц", value: "five", numericValue: 5 }],
  correctAnswer: "three", calculation: { expression: "10 - 7" }, explanation: "Видимая частота: $10-7=3$ кГц.",
});

describe("arithmetic and question validation", () => {
  test("arithmetic respects precedence, units converted explicitly, unary and exponents", () => {
    expect(calculate("10-7")).toBe(3);
    expect(calculate("1 / (50 * 10 ** -6) / 1000")).toBeCloseTo(20);
    expect(calculate("2**3**2")).toBe(512);
    expect(calculate("-2**2")).toBe(-4);
    expect(calculate("(3 + 4)*2 - .5 + 1e-3")).toBeCloseTo(13.501);
  });
  test("rejects arbitrary code, malformed and non-finite expressions", () => {
    for (const expr of ["process.exit()", "1/0", "1 +", "2 3", "(2+3", "", "NaN", "1;2"]) expect(() => calculate(expr)).toThrow();
  });
  test("rejects wrong key, missing solution and ambiguous numerical options", () => {
    const p = numeric();
    expect(() => verifyNumericAnswer(p.calculation, p.options, ["five"])).toThrow();
    expect(() => verifyNumericAnswer(p.calculation, p.options.filter(o => o.value !== "three"), ["seven"])).toThrow();
    expect(() => verifyNumericAnswer(p.calculation, [...p.options, { value: "duplicate", numericValue: 3 }], ["three"])).toThrow();
  });
  test("accepts deliberate rounded answers and rejects negative tolerance", () => {
    expect(() => verifyNumericAnswer({expression:"1/3",tolerance:0.005}, [{value:"a",numericValue:.33},{value:"b",numericValue:.5}], ["a"])).not.toThrow();
    expect(() => verifyNumericAnswer({expression:"1",tolerance:-1}, [{value:"a",numericValue:1}], ["a"])).toThrow();
  });
  test("invalid questions never publish or open the UI", async () => {
    const h = harness(); quizExtension(h.pi as any);
    let opened = 0; h.ctx.ui.custom = async () => { opened++; };
    const params = numeric();
    const variants = [
      {...params,correctAnswer:"missing"}, {...params,correctAnswer:["three","five"]},
      {...params,correctAnswer:"five"}, {...params,options:params.options.filter(o=>o.value!=="three")},
      {...params,explanation:" "}, {...params,options:[params.options[0],params.options[0]]},
      {...params,options:params.options.map(o=>({...o,label:"same"}))},
    ];
    for (const p of variants) expect((await h.call("quiz",p)).details.status).toBe("unavailable");
    expect(h.events).toHaveLength(0); expect(opened).toBe(0);
  });
  test("quoted serialized key is normalized without changing grading", async () => {
    const h=harness(); quizExtension(h.pi as any);
    const r=await h.call("quiz",{...numeric(),correctAnswer:'"three"'});
    expect(r.details.correct).toBe(true);
  });
});

describe("durable learner log", () => {
  test("binding persists after restart and preserves other settings", async () => {
    const h=harness(); logExtension(h.pi as any); h.fire("session_start");
    mkdirSync(join(h.ctx.cwd,".pi"),{recursive:true}); writeFileSync(join(h.ctx.cwd,".pi/mdlog.json"),JSON.stringify({custom:42,file:"old.md"}));
    const note=join(h.ctx.cwd,"Новый конспект.md"); await h.commands.get("md-log").handler(note,h.ctx);
    expect(readLogTarget(h.ctx.cwd)).toBe(note);
    expect(JSON.parse(readFileSync(join(h.ctx.cwd,".pi/mdlog.json"),"utf8")).custom).toBe(42);
    h.fire("session_shutdown"); h.fire("session_start");
    h.fire("message_end",{message:{role:"assistant",timestamp:1,content:[{type:"text",text:"Объяснение"}]}});
    expect(readFileSync(note,"utf8")).toContain("Объяснение");
  });
  test("quiz notes, idk and context survive in Markdown without incorrect grade", async () => {
    const h=harness(); const note=join(h.ctx.cwd,"lesson.md"); saveLogTarget(h.ctx.cwd,note);
    logExtension(h.pi as any); quizExtension(h.pi as any);h.fire("session_start");
    h.ctx.ui.custom=async()=>({dontKnow:true,note:"Не понимаю фазу.\nПочему поворот?",answers:[]});
    const r=await h.call("quiz",{...numeric(),details:"Начальная фаза равна нулю"});
    const text=readFileSync(note,"utf8");
    expect(r.details.correct).toBeUndefined(); expect(r.details.dontKnow).toBe(true);
    expect(text).toContain("Не понимаю фазу."); expect(text).toContain("Почему поворот?"); expect(text).toContain("Начальная фаза");
    expect(text).toContain("Пока не знаю"); expect(text).not.toContain("Неверно"); expect(text).not.toContain("PI");
  });
  test("correct and incorrect choices have distinct outcomes", async()=>{
    const h=harness();quizExtension(h.pi as any);
    expect((await h.call("quiz",numeric(),"a")).details.correct).toBe(true);
    h.ctx.ui.custom=async()=>({dontKnow:false,note:"думал иначе",answers:[{label:"5 кГц",value:"five",index:3}]});
    expect((await h.call("quiz",numeric(),"b")).details.correct).toBe(false);
    expect(h.events.filter(e=>e.name==="mdlog:quiz-answer").map(e=>e.data.outcome)).toEqual(["correct","incorrect"]);
  });
  test("cancelled question is recorded without leaking solution",async()=>{
    const h=harness();const note=join(h.ctx.cwd,"lesson.md");saveLogTarget(h.ctx.cwd,note);
    logExtension(h.pi as any);quizExtension(h.pi as any);h.fire("session_start");h.ctx.ui.custom=async()=>null;
    await h.call("quiz",numeric());const text=readFileSync(note,"utf8");
    expect(text).toContain("Вопрос пропущен");expect(text).not.toContain("Правильный ответ:");expect(text).not.toContain("Неверно");
  });
  test("write errors notify and failed messages are not lost to deduplication",async()=>{
    const h=harness();const note=join(h.ctx.cwd,"lesson.md");saveLogTarget(h.ctx.cwd,note);logExtension(h.pi as any);h.fire("session_start");
    rmSync(note);mkdirSync(note);const event={message:{role:"assistant",timestamp:1,content:"Не потерять"}};
    h.fire("message_end",event);expect(h.notifications.some(n=>n[1]==="error")).toBe(true);
    rmSync(note,{recursive:true});h.fire("message_end",event);h.fire("message_end",event);
    expect(readFileSync(note,"utf8").match(/Не потерять/g)).toHaveLength(1);
  });
  test("question answer stays with its original note when target changes",async()=>{
    const h=harness();const a=join(h.ctx.cwd,"a.md"),b=join(h.ctx.cwd,"b.md");saveLogTarget(h.ctx.cwd,a);
    logExtension(h.pi as any);quizExtension(h.pi as any);h.fire("session_start");
    h.ctx.ui.custom=async()=>{await h.commands.get("md-log").handler(b,h.ctx);return {dontKnow:true,note:"пояснение",answers:[]};};
    await h.call("quiz",numeric());expect(readFileSync(a,"utf8")).toContain("пояснение");expect(readFileSync(b,"utf8")).not.toContain("пояснение");
  });
  test("invalid config is surfaced, not silently ignored",()=>{
    const h=harness();mkdirSync(join(h.ctx.cwd,".pi"));writeFileSync(join(h.ctx.cwd,".pi/mdlog.json"),"{");
    logExtension(h.pi as any);h.fire("session_start");expect(h.notifications.some(n=>n[1]==="error")).toBe(true);
  });
});

describe("independent responses and serialization",()=>{
  test("open answer is preserved ungraded, without provided solution",async()=>{
    const h=harness();const note=join(h.ctx.cwd,"lesson.md");saveLogTarget(h.ctx.cwd,note);logExtension(h.pi as any);quizExtension(h.pi as any);h.fire("session_start");
    const r=await h.call("quiz-open",{question:"Докажи линейность"});
    expect(r.details.status).toBe("pending_review");expect(r.details.correct).toBeUndefined();
    const text=readFileSync(note,"utf8");expect(text).toContain("Выход удваивается по линейности");expect(text).not.toContain("Правильный ответ");
  });
  test("open response distinguishes idk, empty, cancellation and unavailable UI",async()=>{
    const h=harness();quizExtension(h.pi as any);
    for(const [raw,status] of [["не знаю","dont_know"],[" ","cancelled"],[undefined,"cancelled"]]){
      h.ctx.ui.editor=async()=>raw;expect((await h.call("quiz-open",{question:"Почему?"}, `open-${status}-${String(raw)}`)).details.status).toBe(status);
    }
    h.ctx.hasUI=false;expect((await h.call("quiz-open",{question:"Почему?"}, "no-ui")).details.status).toBe("unavailable");
  });
  test("queued quizzes publish only when displayed and abort before publication",async()=>{
    const h=harness();quizExtension(h.pi as any);let release:any;
    h.ctx.ui.custom=()=>new Promise(r=>{release=r});
    const first=h.call("quiz",numeric(),"first");await new Promise(r=>setTimeout(r,0));
    const controller=new AbortController();const second=h.call("quiz-open",{question:"Второй?"},"second",controller.signal);
    await new Promise(r=>setTimeout(r,0));expect(h.events.filter(e=>e.name==="mdlog:quiz-question")).toHaveLength(1);
    controller.abort();release(null);await first;expect((await second).details.status).toBe("cancelled");
    expect(h.events.filter(e=>e.name==="mdlog:quiz-question")).toHaveLength(1);
  });
});

describe("visual delivery",()=>{
  test("visible folder and versioned files preserve previous image",()=>{
    const cwd=workspace();const a=saveVisual(cwd,"","Схема","svg","first"),b=saveVisual(cwd,"","Схема","svg","second");
    expect(a).not.toBe(b);expect(a).toBe(join(cwd,"visuals/схема.svg"));expect(readFileSync(a,"utf8")).toBe("first");expect(readFileSync(b,"utf8")).toBe("second");
    expect(existsSync(join(cwd,".alvar/visuals"))).toBe(false);
  });
  test("rejects escape from visuals folder",()=>{
    const cwd=workspace();expect(()=>saveVisual(cwd,"../../elsewhere","a","svg","bad")).toThrow();
  });
  test("relative image embed resolves for nested notes and encodes spaces",()=>{
    const cwd=workspace(),note=join(cwd,"telecom/lesson.md"),file=saveVisual(cwd,"sub folder","Круг","svg","<svg/>");
    const embed=imageEmbed(note,file,"Круг [ось]");const dest=embed.match(/\]\((.*)\)$/)![1];
    expect(resolve(join(cwd,"telecom"),decodeURIComponent(dest))).toBe(file);expect(embed).toContain("../visuals/sub%20folder/");
  });
  test("render-svg returns embed for actual configured learner note",async()=>{
    const h=harness();const note=join(h.ctx.cwd,"telecom/lesson.md");saveLogTarget(h.ctx.cwd,note);visualsExtension(h.pi as any);
    const result=await h.call("render-svg",{title:"Круг",svg:'<svg xmlns="http://www.w3.org/2000/svg"></svg>'});
    expect(result.details.note).toBe(note);expect(result.details.embed).toContain("../visuals/");expect(existsSync(result.details.file)).toBe(true);
  });
});

test("replayed open tool call returns durable answer without asking twice", async()=>{
 const h=harness();quizExtension(h.pi as any);let calls=0;h.ctx.ui.editor=async()=>{calls++;return "Reasoned answer"};
 const a=await h.call("quiz-open",{question:"Why?"},"stable-open");const b=await h.call("quiz-open",{question:"Why?"},"stable-open");
 expect(calls).toBe(1);expect(a).toEqual(b);
});
test("replayed choice returns durable answer without asking twice", async()=>{
 const h=harness();quizExtension(h.pi as any);let calls=0;h.ctx.ui.custom=async()=>{calls++;return {dontKnow:false,answers:[{label:"3 кГц",value:"three",index:2}]}};
 const a=await h.call("quiz",numeric(),"stable-choice");const b=await h.call("quiz",numeric(),"stable-choice");expect(calls).toBe(1);expect(a).toEqual(b);
});
test("repeated board is appended with new explanation without changing old frame",()=>{
 const h=harness();const note=join(h.ctx.cwd,"board.md");saveLogTarget(h.ctx.cwd,note);logExtension(h.pi as any);h.fire("session_start");
 const board='```mermaid\nflowchart LR\n A["x"] --> B["y"]\n```';
 h.fire("message_end",{message:{role:"assistant",timestamp:1,content:board+"\nFirst explanation"}});const previous=readFileSync(note,"utf8");
 h.fire("message_end",{message:{role:"assistant",timestamp:2,content:board+"\nNext explanation"}});const next=readFileSync(note,"utf8");
 expect(next.startsWith(previous)).toBe(true);expect(next.match(/```mermaid/g)).toHaveLength(2);expect(next.indexOf("Next explanation")).toBeGreaterThan(next.lastIndexOf("```mermaid"));
});

test("connecting and reconnecting a note never inserts a duplicate title", async()=>{
 const h=harness();logExtension(h.pi as any);
 const note=join(h.ctx.cwd,"Lesson.md");
 await h.commands.get("md-log").handler(note,h.ctx);
 expect(readFileSync(note,"utf8")).toBe("");
 const content="# A deliberate heading\n\nLesson content\n";
 writeFileSync(note,content);
 await h.commands.get("md-log").handler(note,h.ctx);
 h.fire("session_start");
 expect(readFileSync(note,"utf8")).toBe(content);
});

test("clarification dialogs record question and response exactly once in original note", async()=>{
 const h=harness();const a=join(h.ctx.cwd,"a.md"),b=join(h.ctx.cwd,"b.md");saveLogTarget(h.ctx.cwd,a);logExtension(h.pi as any);h.fire("session_start");
 const start={toolName:"ask_user_question",toolCallId:"ask-1",args:{question:"What goal?",details:"Choose a route",options:[{label:"For myself"}]}};
 h.fire("tool_execution_start",start);h.fire("tool_execution_start",start);
 await h.commands.get("md-log").handler(b,h.ctx);
 const end={toolName:"ask_user_question",toolCallId:"ask-1",result:{details:{question:"What goal?",status:"answered",answers:[{type:"text",label:"For myself"}]}}};
 h.fire("tool_execution_end",end);h.fire("tool_execution_end",end);
 const text=readFileSync(a,"utf8");expect(text.match(/What goal/g)).toHaveLength(1);expect(text).toContain("> [!you] Ты\n> For myself");expect(readFileSync(b,"utf8")).toBe("");
});
test("arbitrary tool output is not written into lesson",()=>{
 const h=harness();const note=join(h.ctx.cwd,"note.md");saveLogTarget(h.ctx.cwd,note);logExtension(h.pi as any);h.fire("session_start");
 h.fire("tool_execution_end",{toolName:"bash",toolCallId:"bash",result:{content:[{type:"text",text:"internal"}],details:{question:"technical",status:"answered"}}});expect(readFileSync(note,"utf8")).toBe("");
});
test("a prepared board frame reaches the note even when the reply forgot the mermaid block",()=>{
 const h=harness();const note=join(h.ctx.cwd,"board.md");saveLogTarget(h.ctx.cwd,note);logExtension(h.pi as any);h.fire("session_start");
 const board='```mermaid\nflowchart LR\n A["x"] --> B["y"]\n```';
 h.fire("tool_execution_end",{toolName:"learning-board",toolCallId:"b1",result:{details:{markdown:board}}});
 h.fire("message_end",{message:{role:"assistant",timestamp:1,content:"Explanation without a frame"}});
 const first=readFileSync(note,"utf8");
 expect(first).toContain("Explanation without a frame");expect(first.match(/```mermaid/g)).toHaveLength(1);
 h.fire("message_end",{message:{role:"assistant",timestamp:2,content:"Next explanation with the frame\n\n"+board}});
 expect(readFileSync(note,"utf8").match(/```mermaid/g)).toHaveLength(2);
});

test("obvious answer length cue is rejected before showing UI",async()=>{
 const h=harness();quizExtension(h.pi as any);let shown=0;h.ctx.ui.custom=async()=>{shown++;return null};
 const p={question:"Which explanation?",options:[{label:"Short wrong",value:"no"},{label:"Another wrong",value:"no2"},{label:"Wrong too",value:"no3"},{label:"The only detailed scientific correct answer. ".repeat(8),value:"yes"}],correctAnswer:"yes",explanation:"Why"};
 const result=await h.call("quiz",p);expect(result.details.status).toBe("unavailable");expect(shown).toBe(0);
});


test("HTML artifacts use vault paths and append new cards without replacing previous files", async()=>{
 const h=harness();const note=join(h.ctx.cwd,"nested/lesson.md");saveLogTarget(h.ctx.cwd,note);
 visualsExtension(h.pi as any);logExtension(h.pi as any);h.fire("session_start");
 const first=await h.call("html-preview",{title:'Доска "A"',html:"<!doctype html><html><body>First</body></html>",height:600});
 const second=await h.call("html-preview",{title:'Доска "A"',html:"<!doctype html><html><body>Second</body></html>"});
 expect(first.details.embed).toContain('```artifact\nheight=600 title="Доска  A"\nvisuals/');
 expect(first.details.embed).not.toContain("../");expect(first.details.note).toBe(note);
 h.fire("message_end",{message:{role:"assistant",timestamp:10,content:first.details.embed+"\nExplanation"}});
 const before=readFileSync(note,"utf8");
 h.fire("message_end",{message:{role:"assistant",timestamp:11,content:second.details.embed+"\nNext explanation"}});
 expect(readFileSync(note,"utf8").startsWith(before)).toBe(true);
 expect(readFileSync(note,"utf8").match(/```artifact/g)).toHaveLength(2);
 expect(first.details.file).not.toBe(second.details.file);
 expect(readFileSync(first.details.file,"utf8")).toContain("First");
});

test("assessment internals and thinking stay out of lesson while teaching and map remain",()=>{
 const h=harness();const note=join(h.ctx.cwd,"lesson.md");saveLogTarget(h.ctx.cwd,note);logExtension(h.pi as any);h.fire("session_start");
 h.fire("tool_execution_end",{toolName:"learning-assess",toolCallId:"a",result:{content:[{type:"text",text:'{"diagnosis":"private hypothesis"}'}],details:{audit:[{observed:"private step"}]}}});
 h.fire("message_end",{message:{role:"assistant",content:[{type:"thinking",thinking:"private planning"},{type:"toolCall",name:"learning-assess",arguments:{audit:"private audit"}},{type:"text",text:'Здесь нужен предыдущий отсчёт.\n\n```mermaid\nflowchart LR\n A[Отсчёты] --> B[Фильтр]\n```'}]}});
 const text=readFileSync(note,"utf8");expect(text).not.toContain("private");expect(text).not.toContain("audit");expect(text).toContain("предыдущий отсчёт");expect(text).toContain("```mermaid");
});

test("an interrupted old board is not appended after learner asks to change explanation",()=>{
 const h=harness();const note=join(h.ctx.cwd,"interrupted.md");saveLogTarget(h.ctx.cwd,note);logExtension(h.pi as any);h.fire("session_start");
 h.fire("tool_execution_end",{toolName:"learning-board",toolCallId:"old",result:{details:{markdown:'```mermaid\nflowchart LR\n A[Old advanced proof] --> B[sinc]\n```'}}});
 h.fire("message_end",{message:{role:"user",timestamp:1,content:"I do not know the basics"}});
 h.fire("message_end",{message:{role:"assistant",timestamp:2,content:"Let us look at one measurement"}});
 const text=readFileSync(note,"utf8");expect(text).toContain("one measurement");expect(text).not.toContain("sinc");
});
