/**
 * Закладки: постановка, снятие, порядок.
 *
 * Правила те же, что в терминале, и это не прихоть: закладка, поставленная на
 * ноутбуке, приезжает в браузер через тот же сервер, и расходись они в
 * мелочах — расходились бы и книги на двух устройствах.
 *
 * Главное правило — снятая закладка не выбрасывается, а помечается снятой.
 * Иначе при следующей синхронизации она вернулась бы с устройства, которое о
 * снятии не знает, и снять её было бы нельзя вовсе.
 *
 * Здесь только решения о списке, без DOM и без хранилища: то и другое
 * проверяется отдельно, а это — обычными тестами.
 */

import { bookmarkLabel, progressPercent, type Block, type Bookmark } from "@fb2read/core";

/** Закладки, которые видит читатель: надгробия ему показывать незачем. */
export function liveMarks(marks: readonly Bookmark[]): Bookmark[] {
  return marks.filter((mark) => !mark.deleted);
}

/** Стоит ли закладка на этом блоке. */
export function marked(marks: readonly Bookmark[], block: number): boolean {
  return liveMarks(marks).some((mark) => mark.block === block);
}

/** Снимает закладку, оставляя след: когда именно её сняли. */
export function removeMark(
  marks: readonly Bookmark[],
  block: number,
  now = Date.now() / 1000,
): Bookmark[] {
  return marks.map((mark) => (mark.block === block ? { block, at: now, deleted: true } : mark));
}

/**
 * Ставит закладку или снимает уже стоящую.
 *
 * Надгробие на том же блоке заменяется новой закладкой целиком: поставить
 * заново — обычное дело, и помнить о прошлом снятии больше незачем.
 */
export function toggleMark(
  marks: readonly Bookmark[],
  block: number,
  blocks: readonly Block[],
  now = Date.now() / 1000,
): Bookmark[] {
  if (marked(marks, block)) return removeMark(marks, block, now);
  return [
    ...marks.filter((mark) => mark.block !== block),
    {
      block,
      name: bookmarkLabel(blocks, block),
      percent: progressPercent(block, blocks.length) ?? 0,
      at: now,
    },
  ];
}

/** Список для показа: по порядку книги, а не по времени постановки. */
export function sortedMarks(marks: readonly Bookmark[]): Bookmark[] {
  return liveMarks(marks).sort((a, b) => a.block - b.block);
}
