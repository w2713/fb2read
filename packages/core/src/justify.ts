/**
 * Выключка по формату: ровный правый край колонки.
 *
 * Промежутки между словами расширяются, пока строка не займёт всю ширину.
 * Ни терминала, ни настроек здесь нет — только текст и ширина, поэтому всё
 * проверяется без экрана.
 *
 * Тонкость, ради которой модуль и заведён отдельно: отрезок начертания хранит
 * не смещение, а колонку и сам текст (`LineStyle` в `layout.ts`). Значит, при
 * вставке пробелов курсиву надо и колонку сдвинуть, и текст переписать — если
 * промежуток разошёлся у него внутри, пробелов в нём стало больше. Забыть об
 * этом значит положить курсив на чужие буквы.
 */

import type { LineStyle } from "./layout.js";
import { strWidth } from "./width.js";

/** Строка после выключки. */
export interface Justified {
  text: string;
  styles: LineStyle[];
}

/** Промежуток между словами: где начинается и где кончается. */
interface Gap {
  from: number;
  to: number;
}

/**
 * Промежутки, которые можно расширять.
 *
 * Отступ в начале строки не трогается: он задан видом блока, и растягивать его
 * значит сдвигать красную строку. Неразрывный пробел промежутком не считается —
 * он для того и поставлен, чтобы остаться собой.
 */
function gaps(text: string): Gap[] {
  const out: Gap[] = [];
  const first = text.search(/\S/u);
  if (first < 0) return out;
  const last = text.length - [...text].reverse().join("").search(/\S/u);

  let at = first;
  while (at < last) {
    if (text[at] === " ") {
      const from = at;
      while (at < last && text[at] === " ") at += 1;
      out.push({ from, to: at });
    } else {
      at += 1;
    }
  }
  return out;
}

/**
 * Сколько пробелов добавить в каждый промежуток.
 *
 * Остаток раздаётся правым промежуткам: строка тогда начинается обычно, а
 * широкие места уходят к концу, где глаз их замечает меньше. Раздавать его
 * левым — значит получить заметную дыру сразу после красной строки.
 */
function share(need: number, count: number): number[] {
  const base = Math.floor(need / count);
  const extra = need % count;
  return Array.from({ length: count }, (_, i) => base + (i >= count - extra ? 1 : 0));
}

/**
 * Расширяет промежутки строки до заданной ширины.
 *
 * Возвращает строку как есть, если расширять нечего: промежутков нет (одно
 * слово), строка уже не уже ширины или шире неё.
 *
 * Решение «эту строку выключать, а эту нет» принимается не здесь: последнюю
 * строку абзаца, заголовки и стихи отсеивает вёрстка, потому что только она
 * знает, какая строка последняя и какого вида блок.
 */
export function justify(text: string, styles: readonly LineStyle[], width: number): Justified {
  const need = width - strWidth(text);
  const places = gaps(text);
  if (need <= 0 || !places.length) return { text, styles: [...styles] };

  const add = share(need, places.length);

  // Куда переезжает каждая позиция строки. Длиннее текста на единицу: нужен и
  // конец последнего отрезка.
  const moved = new Array<number>(text.length + 1);
  let out = "";
  let at = 0;
  places.forEach((gap, n) => {
    for (; at < gap.to; at += 1) {
      moved[at] = out.length;
      out += text[at];
    }
    out += " ".repeat(add[n]!);
  });
  for (; at < text.length; at += 1) {
    moved[at] = out.length;
    out += text[at];
  }
  moved[text.length] = out.length;

  return { text: out, styles: styles.map((style) => shift(style, text, out, moved)) };
}

/** Переносит отрезок начертания в расширенную строку. */
function shift(style: LineStyle, text: string, out: string, moved: number[]): LineStyle {
  const [column, fragment, kind] = style;
  const start = indexAt(text, column);
  const end = start + fragment.length;
  // Отрезок пришёл не из этой строки — оставляем как есть, портить нечего.
  if (text.slice(start, end) !== fragment) return style;
  const from = moved[start]!;
  return [strWidth(out.slice(0, from)), out.slice(from, moved[end]!), kind];
}

/**
 * Где в строке начинается эта колонка.
 *
 * Колонка считается в знакоместах, а срез строки — в единицах UTF-16: на
 * широких символах это разные числа.
 */
function indexAt(text: string, column: number): number {
  let width = 0;
  let index = 0;
  for (const ch of text) {
    if (width >= column) break;
    width += strWidth(ch);
    index += ch.length;
  }
  return index;
}
