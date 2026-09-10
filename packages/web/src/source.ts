/**
 * Источник байтов поверх файла из браузера.
 *
 * Ядро просит `ByteSource` и не знает, что за ним: в терминале там файл на
 * диске, здесь — то, что выбрали в проводнике, достали с полки или скачали с
 * сервера.
 *
 * `slice` не читает книгу целиком намеренно: картинки в FB2 лежат по байтовым
 * границам, и на телефоне тянуть в память сорок мегабайт ради одной обложки —
 * верный способ получить выгрузку вкладки.
 */

import { MemorySource, type ByteSource } from "@fb2read/core";

export { MemorySource };

export class BrowserFileSource implements ByteSource {
  readonly name: string;

  /**
   * Имя передаётся отдельно, потому что у `Blob` его нет.
   *
   * Из проводника приходит `File` — у него имя своё; с полки приходит `Blob`,
   * и имя лежит рядом, в записи о книге. Ленивое чтение при этом одинаково: у
   * `Blob` тот же `slice`, ради которого всё и затевалось.
   */
  constructor(
    private readonly blob: Blob,
    name?: string,
  ) {
    this.name = name ?? (blob instanceof File ? blob.name : "книга");
  }

  get size(): number {
    return this.blob.size;
  }

  async bytes(): Promise<Uint8Array> {
    return new Uint8Array(await this.blob.arrayBuffer());
  }

  async slice(start: number, end: number): Promise<Uint8Array> {
    return new Uint8Array(await this.blob.slice(start, end).arrayBuffer());
  }
}
