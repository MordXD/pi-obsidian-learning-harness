/** Learner-facing Markdown log. Internal learning state stays in .alvar/. */
import { parseSkillBlock, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { createHash } from "node:crypto";
import { readLogTarget, saveLogTarget } from "./lib/learning";
import { withStore } from "./lib/tutor-store";

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(p => p?.type === "text" && typeof p.text === "string").map(p => p.text).join("\n\n");
}
function callout(type: string, label: string, body = ""): string {
  return [`> [!${type}] ${label}`, ...body.split("\n").map(line => line ? `> ${line}` : ">")].join("\n") + "\n\n";
}

export default function (pi: ExtensionAPI) {
  let target: string | null = null;
  let activeCwd: string | null = null;
  let notify: ((message: string, level: "warning" | "error" | "info") => void) | undefined;
  let lastWriteError = "";
  const seen = new Set<string>();
  const quizTargets = new Map<string, string>();
  const askTargets = new Map<string, string>();
  const completedAsks = new Set<string>();
  let pendingBoards: Array<{id:string;markdown:string;note:string|null}> = [];

  function append(text: string, file = target): boolean {
    if (!file) return false;
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, text, "utf8");
      lastWriteError = "";
      return true;
    } catch (error) {
      const message = `Не удалось записать конспект ${file}: ${String(error)}`;
      if (message !== lastWriteError) notify?.(message, "error");
      lastWriteError = message;
      return false;
    }
  }
  function ensureWritableNote(file: string): void {
    // Obsidian already displays the filename as the note title.
    // Connecting a note must not add a second title or alter existing content.
    if (!append("", file)) throw new Error("Не удалось открыть конспект для записи");
  }

  pi.on("session_start", (_event, ctx) => {
    target = null;
    activeCwd = ctx.cwd;
    seen.clear();
    quizTargets.clear();
    askTargets.clear();
    completedAsks.clear();
    pendingBoards = [];
    lastWriteError = "";
    notify = (message, level) => ctx.ui.notify(message, level);
    try {
      const file = readLogTarget(ctx.cwd);
      if (file) { ensureWritableNote(file); target = file; }
    } catch (error) {
      notify(`Конспект не подключён: ${String(error)}`, "error");
    }
  });

  pi.on("message_end", event => {
    if (!target) return;
    const msg = event.message as { role?: string; content?: unknown; timestamp?: number };
    // A new user turn may change the subject or interrupt an unfinished explanation.
    // Never attach its predecessor's prepared board to the new reply.
    if (msg.role === "user") pendingBoards = [];
    if (msg.role !== "user" && msg.role !== "assistant") return;
    let text = extractText(msg.content).trim();
    if (!text) return;
    if (msg.role === "user") {
      const parsed = parseSkillBlock(text);
      if (parsed) text = parsed.userMessage?.trim() || "";
      if (!text) return;
    }
    const hash = createHash("sha256").update(text).digest("hex");
    const signature = `${target}|${msg.role}|${msg.timestamp ?? 0}|${hash}`;
    if (seen.has(signature)) return;
    let entry = msg.role === "user" ? callout("you", "Ты", text) : text + "\n\n";
    const frames=msg.role==="assistant" ? pendingBoards.filter(f=>f.note===target) : [];
    for(const frame of frames)if(!text.includes(frame.markdown))entry+=frame.markdown+"\n\n";
    // Only a successful note append counts as delivery. Keep frames for a retry on failure.
    if (append(entry)) {
      seen.add(signature);
      if(msg.role==="assistant") {
        for(const frame of frames)if(activeCwd && target) {
          try {withStore(activeCwd,s=>s.markDelivered(frame.id,target!));}
          catch(error){notify?.(`Доска записана, но подтверждение доставки не сохранено: ${String(error)}`,"warning");}
        }
        pendingBoards=[];
      }
    }
  });

  // Preference/clarification dialogs are tool interactions, not user messages.
  // Record only their learner-facing content, never arbitrary tool output/thinking.
  pi.on("tool_execution_start", event => {
    if (event.toolName !== "ask_user_question" || !target || completedAsks.has(event.toolCallId) || askTargets.has(event.toolCallId)) return;
    const args = event.args as { question?: string; details?: string; options?: Array<{label: string}> };
    if (!args?.question) return;
    const options = args.options?.map((o, i) => `${i + 1}. ${o.label}`).join("\n");
    if (append(callout("question", "Вопрос", [args.question, args.details, options].filter(Boolean).join("\n\n")))) askTargets.set(event.toolCallId, target);
  });
  pi.on("tool_execution_end", event => {
    if (["learning-board","learning-map","html-preview"].includes(event.toolName)) {
      const details=(event.result as any)?.details;
      const markdown=details?.markdown || details?.embed;
      if(typeof markdown==="string" && !event.isError) {
        const id=details.id || event.toolCallId;
        pendingBoards=pendingBoards.filter(f=>f.id!==id);
        pendingBoards.push({id,markdown,note:details.note===undefined?target:details.note});
      }
      return;
    }
    if (event.toolName !== "ask_user_question" || completedAsks.has(event.toolCallId)) return;
    const d = (event.result as any)?.details;
    const file = askTargets.get(event.toolCallId) || target;
    if (!file || !d?.question) return;
    if (!askTargets.has(event.toolCallId)) {
      if (!append(callout("question", "Вопрос", [d.question, d.context].filter(Boolean).join("\n\n")), file)) return;
      askTargets.set(event.toolCallId, file);
    }
    const answer = d.status === "answered"
      ? (d.answers || []).map((a: any) => a.label || a.value || "").filter(Boolean).join("\n")
      : d.status === "cancelled" ? "Вопрос пропущен." : "Не удалось получить ответ.";
    if (append(callout(d.status === "answered" ? "you" : "note", d.status === "answered" ? "Ты" : "Вопрос", answer), file)) {
      completedAsks.add(event.toolCallId); askTargets.delete(event.toolCallId);
    }
  });

  pi.events.on("mdlog:quiz-question", data => {
    const q = data as { id?: string; question?: string; context?: string; options?: string[]; mode?: string };
    if (!target || !q?.question) return;
    const options = q.options?.map((o, i) => `${i + 1}. ${o}`).join("\n") || "";
    const parts = [q.question, q.context, options].filter(Boolean);
    if (append(callout("quiz", q.mode === "open" ? "Задача" : "Вопрос", parts.join("\n\n"))) && q.id) quizTargets.set(q.id, target);
  });

  pi.events.on("mdlog:quiz-answer", data => {
    const a = data as {
      id?: string; outcome?: "correct" | "incorrect" | "dont_know" | "cancelled" | "unavailable" | "pending_review";
      yourAnswer?: string; correctAnswer?: string; isCorrect?: boolean; dontKnow?: boolean;
      note?: string; explanation?: string; message?: string;
    };
    let file = a.id ? quizTargets.get(a.id) : target;
    if (!file && a.id && activeCwd) {
      try { const note = withStore(activeCwd, s => s.questions().find(q => q.id === a.id)?.learnerNote); if (note) file = resolve(activeCwd, note); }
      catch (e) { notify?.(`Не удалось восстановить конспект вопроса: ${String(e)}`, "error"); }
    }
    // An unavailable question that was never published must not pollute the note.
    if (!file) return;
    const outcome = a.outcome ?? (a.dontKnow ? "dont_know" : a.isCorrect ? "correct" : "incorrect");
    const labels = {
      correct: ["correct", "Верно"], incorrect: ["incorrect", "Неверно"],
      dont_know: ["question", "Пока не знаю"], cancelled: ["note", "Вопрос пропущен"],
      unavailable: ["warning", "Вопрос недоступен"], pending_review: ["you", "Твоё решение"],
    };
    const [type, label] = labels[outcome];
    const lines: string[] = [];
    if (a.yourAnswer) lines.push(`Твой ответ: ${a.yourAnswer}`);
    if (a.note) lines.push(`Твоё рассуждение:\n${a.note}`);
    if (a.correctAnswer && outcome !== "cancelled" && outcome !== "unavailable" && outcome !== "pending_review") lines.push(`Правильный ответ: ${a.correctAnswer}`);
    if (a.explanation && outcome !== "cancelled" && outcome !== "unavailable" && outcome !== "pending_review") lines.push(a.explanation);
    if (a.message) lines.push(a.message);
    if (append(callout(type, label, lines.join("\n\n")), file) && a.id) quizTargets.delete(a.id);
  });

  pi.registerCommand("md-log", {
    description: "Подключить и запомнить учебный Markdown: /md-log <абсолютный путь.md>",
    handler: async (args, ctx) => {
      notify = (message, level) => ctx.ui.notify(message, level);
      const raw = (args ?? "").trim();
      if (!isAbsolute(raw) || !raw.toLowerCase().endsWith(".md")) {
        ctx.ui.notify("Укажи абсолютный путь к файлу .md", "warning");
        return;
      }
      const file = resolve(raw);
      try {
        ensureWritableNote(file);
        saveLogTarget(ctx.cwd, file);
        if(target!==file)pendingBoards=[];
        target = file;
        activeCwd = ctx.cwd;
        withStore(ctx.cwd, s => { s.start(); });
        ctx.ui.notify(`Конспект: ${file}`, "info");
      } catch (error) {
        ctx.ui.notify(`Не удалось подключить конспект: ${String(error)}`, "error");
      }
    },
  });
  pi.on("session_shutdown", () => { target = null; seen.clear(); quizTargets.clear(); pendingBoards = []; notify = undefined; });
}
