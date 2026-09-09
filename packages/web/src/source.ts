/**
 * Источник байтов поверх File из браузера.
 *
 * Ядро просит `ByteSource` и не знает, что за ним: в терминале там файл на
 * диске, здесь — то, что выбрали в проводнике или скачали с сервера.
 *
 * `slice` не читает книгу целиком намеренно: картинки в FB2 лежат по байтовым
 * границам, и на телефоне тянуть в память сорок мегабайт ради одной обложки —
 * верный способ получить выгрузку вкладки.
 */

import { MemorySource, type ByteSource } from "@fb2read/core";

export { MemorySource };

export class BrowserFileSource implements ByteSource {
  constructor(private readonly file: File) {}

  get name(): string {
    return this.file.name;
  }

  get size(): number {
    return this.file.size;
  }

  async bytes(): Promise<Uint8Array> {
    return new Uint8Array(await this.file.arrayBuffer());
  }

  async slice(start: number, end: number): Promise<Uint8Array> {
    return new Uint8Array(await this.file.slice(start, end).arrayBuffer());
  }
}
