/**
 * Источник байтов книги.
 *
 * Ядро не знает ни про файловую систему, ни про File из браузера: обе стороны
 * дают эту обёртку. `slice` есть с самого начала, потому что картинки из FB2
 * читаются по байтовым границам в момент показа, а не при открытии книги.
 */

export interface ByteSource {
  /** Имя файла — для заголовка книги, когда в ней нет названия. */
  readonly name: string;
  readonly size: number;
  bytes(): Promise<Uint8Array>;
  slice(start: number, end: number): Promise<Uint8Array>;
}

/** Источник поверх готового массива байтов: тесты, буфер обмена, сеть. */
export class MemorySource implements ByteSource {
  constructor(
    readonly name: string,
    private readonly data: Uint8Array,
  ) {}

  get size(): number {
    return this.data.length;
  }

  async bytes(): Promise<Uint8Array> {
    return this.data;
  }

  async slice(start: number, end: number): Promise<Uint8Array> {
    return this.data.subarray(start, end);
  }
}
