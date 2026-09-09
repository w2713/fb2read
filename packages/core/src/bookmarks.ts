/**
 * Закладки: подпись по тексту и выгрузка в markdown.
 *
 * Ядро только собирает текст — куда его положить, решает платформа: файл в
 * терминале, скачивание в браузере.
 */

import type { Block } from "./block.js";
import type { Bookmark } from "./state.js";

/** Имя закладки берём из текста, к которому она поставлена. */
export function bookmarkLabel(blocks: readonly Block[], block: number): string {
  for (const item of blocks.slice(block, block + 6)) {
    if (item.text && item.kind !== "image") return item.text.slice(0, 80);
  }
  return `абзац ${block}`;
}

/** Имя файла для выгрузки закладок. */
export function bookmarksFileName(title: string): string {
  const name = title.replace(/[^\p{L}\p{N}_\- ]+/gu, "").trim() || "закладки";
  return `${name} — закладки.md`;
}

/** Закладки вместе с цитатами в markdown. */
export function bookmarksMarkdown(
  book: { title: string; author: string; blocks: readonly Block[] },
  marks: readonly Bookmark[],
): string {
  const lines: string[] = [`# ${book.title}`, ""];
  if (book.author) lines.push(`*${book.author}*`, "");

  const sorted = [...marks].filter((m) => !m.deleted).sort((a, b) => a.block - b.block);
  for (const mark of sorted) {
    const percent = typeof mark.percent === "number" ? mark.percent : 0;
    lines.push(`## ${percent}% — ${mark.name ?? ""}`, "");
    let quoted = 0;
    for (const item of book.blocks.slice(mark.block, mark.block + 8)) {
      if (quoted >= 3) break;
      if (item.text && ["p", "cite", "v"].includes(item.kind)) {
        lines.push("> " + item.text, "");
        quoted += 1;
      }
    }
  }
  return lines.join("\n");
}
