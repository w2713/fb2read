/**
 * Вёрстка: блоки книги в готовые строки экрана.
 *
 * Строка знает, из какого блока она вышла, — на этом держатся позиция
 * чтения, закладки и переход по оглавлению при любой ширине окна.
 */

import type { Block } from "./block.js";
import type { Span } from "./inline.js";
import { justify } from "./justify.js";
import { strWidth } from "./width.js";
import { wrapWords } from "./wrap.js";

/** Роль строки на экране: определяет цвет и начертание. */
export type LineAttr = "title" | "sub" | "text" | "dim";

/** Отрезок начертания внутри готовой строки: колонка, текст, вид. */
export type LineStyle = readonly [number, string, "em" | "strong"];

/** Готовая строка экрана. */
export interface Line {
  text: string;
  attr: LineAttr;
  /** Номер блока, из которого вышла строка. */
  block: number;
  styles: LineStyle[];
}

interface StyleRule {
  indent: number;
  first: number;
  center: boolean;
  attr: LineAttr;
  before: number;
  after: number;
}

/** Как выглядит каждый вид блока. */
export const STYLE: Readonly<Record<string, StyleRule>> = {
  title: { indent: 0, first: 0, center: true, attr: "title", before: 2, after: 1 },
  subtitle: { indent: 0, first: 0, center: true, attr: "sub", before: 1, after: 1 },
  p: { indent: 0, first: 3, center: false, attr: "text", before: 0, after: 0 },
  cite: { indent: 4, first: 4, center: false, attr: "dim", before: 0, after: 0 },
  v: { indent: 6, first: 4, center: false, attr: "dim", before: 0, after: 0 },
  author: { indent: 6, first: 6, center: false, attr: "dim", before: 0, after: 1 },
  image: { indent: 0, first: 0, center: true, attr: "dim", before: 1, after: 1 },
};

/** Переводит разметку абзаца в отрезки внутри готовой строки. */
function lineStyles(
  spans: readonly Span[],
  base: number,
  chunk: string,
  offset: number,
  column: number,
): LineStyle[] {
  if (!spans.length) return [];
  const start = base + offset;
  const end = start + chunk.length;
  const out: LineStyle[] = [];
  for (const [spanStart, spanEnd, kind] of spans) {
    const lo = Math.max(spanStart, start);
    const hi = Math.min(spanEnd, end);
    if (lo >= hi) continue;
    const at = lo - start;
    const fragment = chunk.slice(at, hi - start);
    if (fragment.trim()) out.push([column + strWidth(chunk.slice(0, at)), fragment, kind]);
  }
  return out;
}

/** Как верстать сверх обычного. */
export interface Look {
  /** Выключка по формату: ровный правый край. */
  justify?: boolean;
}

/**
 * Раскладывает блоки в строки.
 *
 * `spacing` — межстрочный интервал (1 обычный, 2 двойной): полезен при
 * крупном шрифте терминала, когда строк на экране мало.
 *
 * `look` пуст по умолчанию, и это важно: вывод `--dump` сверяется с эталонной
 * реализацией побайтно, а она ни выключки, ни переносов не знает. Всё новое
 * включается только по просьбе.
 */
export function layout(
  blocks: readonly Block[],
  width: number,
  spacing = 1,
  look: Look = {},
): Line[] {
  const out: Line[] = [];
  const columnWidth = Math.max(width, 20);

  const lastIsBlank = () => !out.length || !out[out.length - 1]!.text.trim();

  blocks.forEach((b, i) => {
    if (b.kind === "empty") {
      if (!lastIsBlank()) out.push({ text: "", attr: "text", block: i, styles: [] });
      return;
    }
    const st = STYLE[b.kind] ?? STYLE["p"]!;
    for (let n = 0; n < st.before; n++) {
      if (!lastIsBlank()) out.push({ text: "", attr: st.attr, block: i, styles: [] });
    }

    let base = 0;
    for (const para of b.text.split("\n")) {
      if (!para) {
        base += 1;
        continue;
      }
      if (st.center) {
        const chunks = wrapWords(para, columnWidth);
        for (const [chunk, offset] of chunks.length ? chunks : [["", 0] as const]) {
          const pad = Math.max(Math.floor((columnWidth - strWidth(chunk)) / 2), 0);
          out.push({
            text: " ".repeat(pad) + chunk,
            attr: st.attr,
            block: i,
            styles: lineStyles(b.spans, base, chunk, offset, pad),
          });
        }
      } else {
        const wrapped = wrapWords(para, columnWidth - st.indent, columnWidth - st.first);
        const chunks = wrapped.length ? wrapped : [["", 0] as const];
        chunks.forEach(([chunk, offset], n) => {
          const pad = n === 0 ? st.first : st.indent;
          const text = " ".repeat(pad) + chunk;
          const styles = lineStyles(b.spans, base, chunk, offset, pad);
          // Последнюю строку абзаца не выключают: иначе конец главы вышел бы
          // строкой из трёх слов, растянутой во всю ширину. Стихи не выключают
          // тоже — там ровный правый край не нужен и мешает.
          const stretch = look.justify && b.kind !== "v" && n < chunks.length - 1;
          const ready = stretch ? justify(text, styles, columnWidth) : { text, styles };
          out.push({ text: ready.text, attr: st.attr, block: i, styles: ready.styles });
        });
      }
      base += para.length + 1;
    }

    for (let n = 0; n < st.after; n++) {
      out.push({ text: "", attr: st.attr, block: i, styles: [] });
    }
  });

  while (out.length && !out[out.length - 1]!.text.trim()) out.pop();

  if (spacing > 1) {
    const spaced: Line[] = [];
    for (const line of out) {
      spaced.push(line);
      if (line.text.trim()) {
        for (let n = 0; n < spacing - 1; n++) {
          spaced.push({ text: "", attr: line.attr, block: line.block, styles: [] });
        }
      }
    }
    return spaced;
  }
  return out;
}
