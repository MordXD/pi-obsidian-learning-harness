import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

export function readLogTarget(cwd: string): string | null {
  const config = join(cwd, ".pi", "mdlog.json");
  if (!existsSync(config)) return null;
  const parsed = JSON.parse(readFileSync(config, "utf8"));
  if (typeof parsed.file !== "string" || !parsed.file.trim()) throw new Error("mdlog.json: file must be a non-empty path");
  return resolve(cwd, parsed.file);
}

export function saveLogTarget(cwd: string, file: string): void {
  const config = join(cwd, ".pi", "mdlog.json");
  const previous = existsSync(config) ? JSON.parse(readFileSync(config, "utf8")) : {};
  mkdirSync(dirname(config), { recursive: true });
  const temporary = `${config}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ ...previous, file }, null, 2) + "\n", "utf8");
    renameSync(temporary, config);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function slugify(title: string): string {
  return title.toLowerCase().trim().replace(/[^a-z0-9а-яё]+/gi, "-").replace(/^-+|-+$/g, "") || "visual";
}

export function saveVisual(cwd: string, sub: string, title: string, ext: string, content: string): string {
  const base = resolve(cwd, "visuals");
  const dir = resolve(base, sub);
  if (dir !== base && !dir.startsWith(base + sep)) throw new Error("Visual subfolder must stay inside visuals/");
  mkdirSync(dir, { recursive: true });
  const slug = slugify(title);
  for (let version = 1; ; version++) {
    const file = join(dir, `${slug}${version === 1 ? "" : `-${version}`}.${ext}`);
    try {
      writeFileSync(file, content, { encoding: "utf8", flag: "wx" });
      return file;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

export function imageEmbed(note: string, file: string, caption: string): string {
  const rel = relative(dirname(note), file).split(sep).join("/");
  const label = caption.replace(/[\r\n]+/g, " ").replace(/([\\\[\]])/g, "\\$1");
  // Encode spaces and parentheses so a valid filename remains valid Markdown.
  const url = rel.split("/").map(part => encodeURIComponent(part).replace(/[()]/g, c => `%${c.charCodeAt(0).toString(16)}`)).join("/");
  return `![${label}](${url})`;
}

/** Arithmetic only. No eval, names, functions, or JS property access. */
export function calculate(expression: string): number {
  if (!expression.trim() || expression.length > 500) throw new Error("Invalid calculation length");
  const tokens = expression.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|\*\*|[()+*/-]|\S/gi) || [];
  let pos = 0;
  function atom(): number {
    if (tokens[pos] === "(") {
      pos++;
      const result = sum();
      if (tokens[pos++] !== ")") throw new Error("Missing closing parenthesis");
      return result;
    }
    const token = tokens[pos++];
    if (!token || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(token)) throw new Error("Expected a number");
    return Number(token);
  }
  function power(): number {
    const left = atom();
    if (tokens[pos] === "**") { pos++; return left ** unary(); }
    return left;
  }
  function unary(): number {
    if (tokens[pos] === "+") { pos++; return unary(); }
    if (tokens[pos] === "-") { pos++; return -unary(); }
    return power();
  }
  function product(): number {
    let result = unary();
    while (tokens[pos] === "*" || tokens[pos] === "/") {
      const op = tokens[pos++];
      const rhs = unary();
      result = op === "*" ? result * rhs : result / rhs;
    }
    return result;
  }
  function sum(): number {
    let result = product();
    while (tokens[pos] === "+" || tokens[pos] === "-") {
      const op = tokens[pos++];
      const rhs = product();
      result = op === "+" ? result + rhs : result - rhs;
    }
    return result;
  }
  const result = sum();
  if (pos !== tokens.length || !Number.isFinite(result)) throw new Error("Calculation is not a finite arithmetic expression");
  return result;
}

export function verifyNumericAnswer(
  calculation: { expression: string; tolerance?: number } | undefined,
  options: Array<{ value: string; numericValue?: number }>,
  correctValues: string[],
): void {
  if (!calculation) {
    if (options.some(o => o.numericValue !== undefined)) throw new Error("numericValue requires calculation");
    return;
  }
  const result = calculate(calculation.expression);
  const tolerance = calculation.tolerance ?? 1e-9 * Math.max(1, Math.abs(result));
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error("Invalid numeric tolerance");
  if (options.some(o => o.numericValue === undefined || !Number.isFinite(o.numericValue))) throw new Error("Every numerical option needs a finite numericValue in the same units");
  const matching = options.filter(o => Math.abs(o.numericValue! - result) <= tolerance).map(o => o.value);
  if (matching.length !== 1 || correctValues.length !== 1 || matching[0] !== correctValues[0]) {
    throw new Error(`Calculation yields ${result}; exactly one option must match and be marked correct`);
  }
}
