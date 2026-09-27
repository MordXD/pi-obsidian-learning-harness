/** Teaching visuals: visible visuals/ folder, versioned filenames, Markdown embeds. */
import { withStore } from "../lib/tutor-store";
import { relative, sep } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { saveVisual, imageEmbed, readLogTarget } from "../lib/learning";

const RenderSvgParams = Type.Object({
  title: Type.String({ description: "Название картинки (станет именем файла)" }),
  svg: Type.String({
    description:
      "Полный код SVG: <svg viewBox=...>…</svg>. Тёмный фон, светлый текст, системный шрифт, без внешних ссылок.",
  }),
  sub: Type.Optional(
    Type.String({ description: "Подпапка внутри visuals/ (по умолчанию пусто)" }),
  ),
});

const HtmlPreviewParams = Type.Object({
  height: Type.Optional(Type.Integer({ minimum: 200, maximum: 1600, description: "Высота карточки Artifact Embed в px, по умолчанию 560" })),
  title: Type.String({ description: "Название превью (станет именем файла)" }),
  html: Type.String({
    description: "Полный HTML-документ (самодостаточный, без внешних зависимостей)",
  }),
  sub: Type.Optional(
    Type.String({ description: "Подпапка внутри visuals/ (по умолчанию пусто)" }),
  ),
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "render-svg",
    label: "Render SVG",
    description:
      "Сохраняет SVG-картинку в visuals/ и возвращает путь. Использовать для схем, диаграмм, иллюстраций и SVG-мемов (скилл visualize).",
    parameters: RenderSvgParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { title, svg, sub } = params;
      if (!/<svg[\s>]/i.test(svg)) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Ошибка: содержимое не похоже на SVG (нет тега <svg>). Отдай полный SVG-код.",
            },
          ],
          details: {},
        };
      }
      const note = readLogTarget(ctx.cwd);
      const file = saveVisual(ctx.cwd, sub ?? "", title, "svg", svg);
      const embed = note ? imageEmbed(note, file, title) : undefined;
      return {
        content: [
          {
            type: "text" as const,
            text: embed
              ? `SVG сохранён: ${file}\nУчебная заметка: ${note}\nВставь рядом с объяснением (без блока кода):\n${embed}\nПроверь, что эта вставка записалась в учебную заметку.`
              : `SVG сохранён: ${file}\nУчебная заметка не подключена. Подключи её через /md-log; вычисли путь относительно заметки и вставь изображение через ![подпись](путь).`,
          },
        ],
        details: { id:_toolCallId, file, note, embed },
      };
    },
  });

  pi.registerTool({
    name: "html-preview",
    label: "HTML Preview",
    description:
      "Сохраняет самодостаточный HTML (интерактивные примеры, слайды, визуализации) в visuals/ и возвращает готовый блок artifact для Obsidian Artifact Embed. Включи его в обычный ответ рядом с объяснением; md-log запишет его в заметку.",
    parameters: HtmlPreviewParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const previous=withStore(ctx.cwd,s=>s.events().find((e:any)=>e.id===`board:${_toolCallId}`)?.payload);
      if(previous?.result){if(JSON.stringify(previous.request)!==JSON.stringify(params))throw new Error("Conflicting visual request");return previous.result;}
      const { title, html, sub } = params;
      if (!/<!doctype html|<!DOCTYPE html|<html[\s>]/i.test(html)) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Ошибка: содержимое не похоже на HTML-документ. Отдай полный документ с <html>.",
            },
          ],
          details: {},
        };
      }
      const file = saveVisual(ctx.cwd, sub ?? "", title, "html", html);
      const note = readLogTarget(ctx.cwd);
      const vaultPath = relative(ctx.cwd, file).split(sep).join("/");
      const safeTitle = title.replace(/["<>\r\n`]/g, " ").trim();
      const embed = '```artifact\nheight=' + (params.height ?? 560) + ' title="' + safeTitle + '"\n' + vaultPath + '\n```';
      const result = {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ file, note, embed, instruction: note ? "Вставь этот блок artifact в обычный ответ рядом с объяснением. md-log запишет его; не дублируй запись вручную. Проверь вставку в заметке." : "Заметка не подключена: подключи /md-log и включи блок artifact в ответ. Пока сохранён только HTML." }),
          },
        ],
        details: { id:_toolCallId, file, note, embed },
      };
      withStore(ctx.cwd,s=>s.record(_toolCallId,"board",{boardId:_toolCallId,format:"html",file,focus:title,request:params,result}));
      return result;
    },
  });

  pi.registerCommand("visual", {
    description: "Визуализировать тему: /visual <тип> <тема> (тип: схема|диаграмма|svg|мем|html)",
    handler: async (args, ctx) => {
      const text = (args ?? "").trim();
      if (!text) {
        ctx.ui.notify("Укажи: /visual <тип> <тема>", "warning");
        return;
      }
      ctx.ui.notify("Готовлю визуализацию…", "info");
      pi.sendUserMessage(
        `Визуализируй: ${text}. Используй инструменты render-svg или html-preview (скилл visualize).`,
        { deliverAs: "followUp" },
      );
    },
  });
}
