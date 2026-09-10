/**
 * Переходы по найденному.
 *
 * Сам поиск живёт в ядре: он одинаков для терминала и браузера, и там же
 * решено, что ё и е — одна буква, а регистр не важен. Здесь остаётся только
 * порядок обхода, и он повторяет терминальный: после нового запроса читатель
 * оказывается на ближайшем совпадении вперёд, а не в начале книги.
 */

import type { Match } from "@fb2read/core";

/** Первое совпадение отсюда и дальше; если таких нет — самое первое в книге. */
export function firstFrom(matches: readonly Match[], block: number): number {
  const at = matches.findIndex((match) => match.block >= block);
  return at < 0 ? 0 : at;
}

/**
 * Соседнее совпадение по кругу.
 *
 * Про заход на новый круг говорится вслух: иначе читатель, дошедший до конца
 * книги, решит, что поиск сломался и показывает одно и то же.
 */
export function step(
  index: number,
  delta: number,
  count: number,
): { index: number; wrapped: boolean } {
  if (count <= 0) return { index: 0, wrapped: false };
  const next = index + delta;
  return { index: ((next % count) + count) % count, wrapped: next < 0 || next >= count };
}
