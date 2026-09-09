/** Источник байтов поверх файла на диске. */

import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { ByteSource } from "@fb2read/core";

export class FileSource implements ByteSource {
  readonly name: string;
  readonly size: number;
  private cache: Uint8Array | null = null;

  constructor(private readonly path: string) {
    this.name = basename(path);
    this.size = statSync(path).size;
  }

  async bytes(): Promise<Uint8Array> {
    this.cache ??= new Uint8Array(readFileSync(this.path));
    return this.cache;
  }

  /** Читает кусок файла, не поднимая книгу целиком: так грузятся картинки. */
  async slice(start: number, end: number): Promise<Uint8Array> {
    if (this.cache) return this.cache.subarray(start, end);
    const length = Math.max(Math.min(end, this.size) - start, 0);
    if (!length) return new Uint8Array(0);
    const buffer = new Uint8Array(length);
    const fd = openSync(this.path, "r");
    try {
      const read = readSync(fd, buffer, 0, length, start);
      return buffer.subarray(0, read);
    } finally {
      closeSync(fd);
    }
  }
}
