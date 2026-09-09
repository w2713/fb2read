/**
 * Перенос по словам с учётом настоящей ширины символов.
 *
 * Строки возвращаются точными срезами исходного текста вместе со смещением,
 * поэтому по ним восстанавливается разметка: курсив не съезжает после
 * переноса, а поиск подсвечивает ровно найденное.
 */

import { cutToWidth, strWidth } from "./width.js";

/** Строка после переноса: текст и смещение в исходном абзаце. */
export type WrapLine = readonly [string, number];

/**
 * Кладёт слово, разрезая его, если оно шире строки.
 *
 * `budget` возвращает доступную ширину текущей строки: у первой строки
 * абзаца отступ свой, поэтому и ширина своя.
 */
function pushWord(
  lines: WrapLine[],
  text: string,
  start: number,
  end: number,
  budget: () => number,
): { start: number; end: number; width: number } {
  let width = strWidth(text.slice(start, end));
  while (width > budget()) {
    const head = cutToWidth(text.slice(start, end), budget());
    if (!head) break;
    lines.push([head, start]);
    start += head.length;
    width = strWidth(text.slice(start, end));
  }
  return { start, end, width };
}

/** Разбивает текст на строки заданной ширины. */
export function wrapWords(text: string, width: number, firstWidth?: number): WrapLine[] {
  const rest = Math.max(width, 1);
  const first = Math.max(firstWidth === undefined ? rest : firstWidth, 1);
  const lines: WrapLine[] = [];
  const budget = () => (lines.length ? rest : first);

  let cs: number | null = null;
  let ce = 0;
  let cw = 0;
  for (const m of text.matchAll(/\S+/gu)) {
    const start = m.index;
    const end = start + m[0].length;
    if (cs === null) {
      const put = pushWord(lines, text, start, end, budget);
      cs = put.start;
      ce = put.end;
      cw = put.width;
      if (cs >= ce) cs = null;
      continue;
    }
    // Промежуток между словами не обязан быть одним пробелом.
    const grow = strWidth(text.slice(ce, end));
    if (cw + grow <= budget()) {
      ce = end;
      cw += grow;
    } else {
      lines.push([text.slice(cs, ce), cs]);
      const put = pushWord(lines, text, start, end, budget);
      cs = put.start;
      ce = put.end;
      cw = put.width;
      if (cs >= ce) cs = null;
    }
  }
  if (cs !== null && ce > cs) lines.push([text.slice(cs, ce), cs]);
  return lines;
}
