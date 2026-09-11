/**
 * Перенос по словам с учётом настоящей ширины символов.
 *
 * Строки возвращаются точными срезами исходного текста вместе со смещением,
 * поэтому по ним восстанавливается разметка: курсив не съезжает после
 * переноса, а поиск подсвечивает ровно найденное.
 *
 * Единственное исключение — перенос слова: он дописывает в конец строки дефис,
 * которого в книге нет. Строка тогда помечается, и вёрстка знает, что исходный
 * кусок на один знак короче.
 */

import { hyphenAt } from "./hyphen.js";
import { cutToWidth, strWidth } from "./width.js";

/**
 * Строка после переноса: текст, смещение в исходном абзаце и признак переноса.
 *
 * Третье значение — «в конце дописан дефис, которого в книге нет». Из-за него
 * договор о точном срезе гнётся, но ровно в одном месте: длина исходного куска
 * на единицу меньше длины текста. Вёрстке этого хватает, чтобы не съехало
 * начертание.
 */
export type WrapLine = readonly [string, number, boolean?];

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
  hyphens: boolean,
): { start: number; end: number; width: number } {
  let width = strWidth(text.slice(start, end));
  while (width > budget()) {
    // Сперва по-человечески, по слогам; и только если правила не дали ни
    // одного места — резать посередине буквы, как было всегда.
    const at = hyphens ? hyphenAt(text.slice(start, end), budget(), strWidth) : 0;
    if (at > 0) {
      lines.push([`${text.slice(start, start + at)}-`, start, true]);
      start += at;
      width = strWidth(text.slice(start, end));
      continue;
    }
    const head = cutToWidth(text.slice(start, end), budget());
    if (!head) break;
    lines.push([head, start]);
    start += head.length;
    width = strWidth(text.slice(start, end));
  }
  return { start, end, width };
}

/** Разбивает текст на строки заданной ширины. */
export function wrapWords(
  text: string,
  width: number,
  firstWidth?: number,
  hyphens = false,
): WrapLine[] {
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
      const put = pushWord(lines, text, start, end, budget, hyphens);
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
      // Слово целиком не влезло — может, влезет его начало. Ради этого
      // переносы и заводились: чем меньше остаётся пустого места в конце
      // строки, тем меньше потом растягивать промежутки.
      const запас = budget() - cw - strWidth(text.slice(ce, start));
      const at = hyphens ? hyphenAt(text.slice(start, end), запас, strWidth) : 0;
      lines.push(
        at > 0 ? [`${text.slice(cs, start + at)}-`, cs, true] : [text.slice(cs, ce), cs],
      );
      const put = pushWord(lines, text, at > 0 ? start + at : start, end, budget, hyphens);
      cs = put.start;
      ce = put.end;
      cw = put.width;
      if (cs >= ce) cs = null;
    }
  }
  if (cs !== null && ce > cs) lines.push([text.slice(cs, ce), cs]);
  return lines;
}
