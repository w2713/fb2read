/**
 * Веб-API, на которые опирается ядро.
 *
 * Типы DOM сюда намеренно не подключены: тогда случайно нельзя обратиться
 * ни к document, ни к process. Здесь объявлено ровно то, что есть и в Node,
 * и в Bun, и в браузере, — и этот список служит перечнем допущений ядра.
 */

interface TextDecoderOptions {
  fatal?: boolean;
  ignoreBOM?: boolean;
}

declare class TextDecoder {
  constructor(label?: string, options?: TextDecoderOptions);
  readonly encoding: string;
  decode(input?: ArrayBufferView | ArrayBuffer): string;
}

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

interface SubtleCrypto {
  digest(algorithm: string, data: ArrayBufferView | ArrayBuffer): Promise<ArrayBuffer>;
}

interface Crypto {
  readonly subtle: SubtleCrypto;
}

declare const crypto: Crypto;

