# Learner files

All session state lives in the **learner's working directory**, not in this skill repo.

```
.alvar/
  learning.sqlite           # authoritative events
  current.json              # generated continuation and evidence
  evidence.md               # generated internal evidence view
  LEARNER.md                 # how this mind wants to be taught
  graph.md                   # межтемный граф: связи между картами и solid ground
  maps/<slug>.md             # probe results for one goal
  sessions/<date>-<slug>.md  # plan + steps + quizzes

```

Create `.alvar/` on first use. Это внутреннее состояние, не учебный конспект.

Учебные изображения: `visuals/`. Не создавай `.alvar/visuals/` или `.altar/visuals/`.
Учебный Markdown — фактически читаемая учеником заметка, например `Заметки/Моя тема.md`. Вставляй туда `![подпись](visuals/<файл>.svg)` рядом с объяснением; для заметки в подпапке скорректируй относительный путь. Запись визуала только в служебном журнале недостаточна. Сохраняй в учебной заметке рассуждения ученика, но не технические статусы и операции с файлами.

## Global graph

`.alvar/graph.md` — межтемный граф знаний. Узел = тема/карта; ребро = тип связи (`опирается на`, `аналогия`, `противоречит`) + строка-пояснение. Обновляется при каждом новом плане и когда связь всплывает в ходе сессии. Сюда же — опоры на solid ground из LEARNER.md.

```markdown
# Graph
\`\`\`mermaid
graph TD
  T[example-topic] -.аналогия.-> M[another-topic]
\`\`\`
- T → M: петля сканирования как модель многоканальности (узел B)
```

## LEARNER.md

If missing, run `learn-profile` or write a stub from `assets/LEARNER.md` and ask 3–5 questions to fill it. Do not invent a personality.

Read LEARNER.md at the start of every `teach` session. It controls:

- voice and density
- how they want struggle
- what they already treat as solid
- whether they want visuals, mermaid, LaTeX, or a long markdown log

## Map file

```markdown
# Map — <goal>

Updated: <ISO date>
Goal: <one sentence>

## Strands
| strand | status | evidence |
|--------|--------|----------|
| line integrals | known | Q2 correct, explained work |
| Stokes | edge | recognized statement, missed Faraday link |
| differential forms | unknown | said so |
| SR field mix | unknown | answered "I don't know" |

Status: `known` | `edge` | `unknown` | `blocked`
Depth: для каждой нити — уровень лестницы (см. process.md), где бурение остановилось: дно/пол

## Quiz log
- Q1 [line integrals] C — correct
```

## Session file

```markdown
# Session — <goal>
Date:
Model:
Goal:

## Plan
\`\`\`mermaid
graph TD
  A[covector] --> B[1-form]
  B --> C[wedge]
\`\`\`

Sessions: 1) A→B · 2) C→…

## Sources
- <author> — <title>, гл./§, <URL>: nodes leaning on it

## Log
### Node: covector
- taught:
- source:
- visual:
- quiz:
- result: observed answer and reasoning
- assistance: assisted | practiced | independent | retained
- next check:
```

Keep these files updated as you go. They are internal persistence, separate from the learner-facing Markdown / Obsidian note.

## Единая актуальная точка продолжения

Следуй [learning-engine.md](learning-engine.md). Источник событий — `.alvar/learning.sqlite`; `current.json` и `evidence.md` генерируются инструментами. Не обновляй их вручную и не дублируй актуальные оценки в карте. Карты, граф и сессионные планы — содержательный контекст; оценки подтверждаются идентификаторами вопросов в базе.

При возобновлении вызывай `learning-next`, затем читай нужный исторический контекст. Старое ожидание из legacyNeedsReview требует сверки с реальными ответами. Инструмент возвращает отдельно вопросы без ответа и ответы без оценки. Активный учебный Markdown определяется `.pi/mdlog.json`; меняй его через `/md-log`. Автоматический лог уже записывает ответы и объяснения: не добавляй их второй раз вручную.

Доски всегда добавляются новым полным кадром рядом с текущим объяснением, даже если повторяют старую схему. Не меняй предыдущие кадры и не проси листать вверх.
