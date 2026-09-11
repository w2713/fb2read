/**
 * Поиск по всей книге сразу.
 *
 * Регистр не важен, ё и е считаются одной буквой: иначе половина книг
 * ищется не так, как их набирали. Приведение сохраняет длину строки,
 * поэтому смещения совпадений годятся для исходного текста.
 */

import type { Block } from "./block.js";

/** Совпадение: номер блока и смещение внутри его текста. */
export interface Match {
  block: number;
  offset: number;
}

/** Приводит текст к виду для поиска, сохраняя длину строки. */
export function normalize(text: string): string {
  let out = "";
  for (const ch of text) {
    const lower = ch.toLowerCase();
    // Регистр меняем только там, где длина не поехала: ß → ss сдвинуло бы
    // все смещения, а подсветка рисуется по ним.
    out += lower.length === ch.length ? lower : ch;
  }
  return out.replaceAll("ё", "е");
}

/** Текст со схлопнутыми пробелами и путь обратно к исходным местам. */
export interface Squeezed {
  text: string;
  /** Где стоит в исходном тексте i-й символ сжатого; длиннее текста на единицу. */
  at: number[];
}

/**
 * Схлопывает подряд идущие пробелы, помня, откуда каждый символ.
 *
 * Нужно из-за выключки: она расширяет промежутки между словами, и запрос из
 * двух слов перестаёт совпадать с готовой строкой — в ней между ними теперь
 * несколько пробелов. Искать по сжатому, а подсвечивать по настоящим местам —
 * и запрос находится, и подсветка ложится куда надо.
 *
 * Схлопывается только обычный пробел: неразрывный поставлен нарочно, и
 * выключка его не трогает.
 */
export function squeeze(text: string): Squeezed {
  let out = "";
  const at: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    at.push(i);
    out += text[i];
    if (text[i] === " ") while (text[i + 1] === " ") i += 1;
  }
  at.push(text.length);
  return { text: out, at };
}

/** Все совпадения в книге по порядку. */
export function findMatches(blocks: readonly Block[], query: string): Match[] {
  const needle = normalize(query.trim());
  if (!needle) return [];
  const found: Match[] = [];
  blocks.forEach((block, index) => {
    if (!block.text) return;
    const hay = normalize(block.text);
    let at = hay.indexOf(needle);
    while (at >= 0) {
      found.push({ block: index, offset: at });
      at = hay.indexOf(needle, at + needle.length);
    }
  });
  return found;
}

/** Кусочек текста вокруг совпадения — для списка результатов. */
export function matchContext(block: Block, offset: number, width = 64): string {
  const text = block.text;
  const start = Math.max(offset - Math.floor(width / 3), 0);
  const end = Math.min(start + width, text.length);
  const piece = text.slice(start, end).trim();
  return (start ? "…" : "") + piece + (end < text.length ? "…" : "");
}
