/**
 * Сколько знакомест занимает текст в терминале.
 *
 * Политика та же, что в эталоне: иероглифы и эмодзи — два знакоместа,
 * диакритика и нулевой ширины — ноль, всё прочее — одно. Спорные символы
 * (ambiguous) считаются узкими, потому что так их рисует большинство
 * терминалов с кириллицей.
 */

import { eastAsianWidth } from "get-east-asian-width";

const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0xfeff, 0xfe0f]);
const COMBINING = /\p{M}/u;

/** Ширина одного символа по его коду. */
export function codePointWidth(code: number): number {
  // Латиница и кириллица — здесь, до всяких таблиц: это быстрый путь,
  // на котором держится скорость вёрстки русских книг.
  if (code < 0x300) return 1;
  if (ZERO_WIDTH.has(code)) return 0;
  if (COMBINING.test(String.fromCodePoint(code))) return 0;
  return eastAsianWidth(code);
}

/** Сколько знакомест занимает символ. */
export function charWidth(ch: string): number {
  const code = ch.codePointAt(0);
  return code === undefined ? 0 : codePointWidth(code);
}

/** Ширина строки в знакоместах. */
export function strWidth(text: string): number {
  let total = 0;
  for (const ch of text) total += charWidth(ch);
  return total;
}

/** Обрезает строку так, чтобы она заняла не больше width знакомест. */
export function cutToWidth(text: string, width: number): string {
  if (width <= 0) return "";
  let total = 0;
  let end = 0;
  for (const ch of text) {
    const w = charWidth(ch);
    if (total + w > width) break;
    total += w;
    end += ch.length;
  }
  return text.slice(0, end);
}
