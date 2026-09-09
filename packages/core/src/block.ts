/**
 * Блок — единица книги после разбора: абзац, заголовок, стих, картинка.
 *
 * Позиция чтения хранится номером блока, а не строкой и не байтом, поэтому
 * книга открывается на том же месте при любой ширине окна и любом шрифте.
 */

import type { Ref, Span } from "./inline.js";

export type { Ref, Span };

/** Вид блока: определяет отступы, центрирование и начертание при вёрстке. */
export type BlockKind =
  | "title"
  | "subtitle"
  | "p"
  | "cite"
  | "v"
  | "author"
  | "image"
  | "empty";

export interface Block {
  kind: BlockKind;
  text: string;
  /** Уровень вложенности заголовка: 0 — книга, дальше разделы. */
  level: number;
  /** Сноски абзаца: маркер и идентификатор цели. */
  refs: Ref[];
  /** Начертание: начало, конец, вид. */
  spans: Span[];
  /** Где лежит картинка: идентификатор в FB2, путь в EPUB. */
  src: string;
}

/** Запись оглавления: заголовок, уровень и номер блока. */
export interface TocEntry {
  title: string;
  level: number;
  block: number;
}

export function makeBlock(
  kind: BlockKind,
  text: string,
  level = 0,
  refs: Ref[] = [],
  spans: Span[] = [],
  src = "",
): Block {
  return { kind, text, level, refs, spans, src };
}
