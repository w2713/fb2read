/**
 * Кодировки: определение объявленной и декодирование байтов в строку.
 *
 * Питон перебирает utf-8, cp1251, koi8-r, cp1252 и utf-16, пока текст не
 * разберётся. Здесь то же самое, но однобайтовые кодировки декодируются
 * своими таблицами: Bun не знает меток windows-1251 и koi8-r в TextDecoder,
 * так что без таблиц половина русских книг не открылась бы вовсе.
 * Заодно таблицы дают обратное преобразование, а TextEncoder умеет только UTF-8.
 */

import { CP1251, KOI8_R, CP1252 } from "./encoding-tables.js";

/** Кодировки в том же порядке, в каком их перебирает эталонная реализация. */
export const ENCODINGS = ["utf-8", "cp1251", "koi8-r", "cp1252", "utf-16"] as const;

export type Encoding = (typeof ENCODINGS)[number];

const SINGLE_BYTE: Readonly<Record<string, readonly number[]>> = {
  "cp1251": CP1251,
  "windows-1251": CP1251,
  "koi8-r": KOI8_R,
  "cp1252": CP1252,
  "windows-1252": CP1252,
};

/** Ошибка декодирования — аналог UnicodeDecodeError. */
export class DecodeError extends Error {
  constructor(
    readonly encoding: string,
    readonly offset: number,
  ) {
    super(`байт ${offset} не разбирается в кодировке ${encoding}`);
    this.name = "DecodeError";
  }
}

function decodeSingleByte(bytes: Uint8Array, table: readonly number[], label: string): string {
  // Собираем кусками: одна большая склейка через apply падает на длинных книгах.
  const out: string[] = [];
  const chunk: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const code = table[bytes[i]!]!;
    if (code < 0) throw new DecodeError(label, i);
    chunk.push(code);
    if (chunk.length === 8192) {
      out.push(String.fromCharCode(...chunk));
      chunk.length = 0;
    }
  }
  if (chunk.length) out.push(String.fromCharCode(...chunk));
  return out.join("");
}

/**
 * Декодирует байты. Строгий режим бросает DecodeError, как Python с errors="strict".
 */
export function decode(bytes: Uint8Array, encoding: string, strict = true): string {
  const label = encoding.toLowerCase();
  const table = SINGLE_BYTE[label];
  if (table) {
    if (!strict) {
      let text = "";
      for (const b of bytes) {
        const code = table[b]!;
        text += String.fromCharCode(code < 0 ? 0xfffd : code);
      }
      return text;
    }
    return decodeSingleByte(bytes, table, label);
  }
  try {
    return new TextDecoder(label, { fatal: strict }).decode(bytes);
  } catch (e) {
    if (e instanceof TypeError) throw new DecodeError(label, 0); // метка неизвестна рантайму
    throw new DecodeError(label, 0);
  }
}

/** Кодирует строку в однобайтовую кодировку — нужно тестам и экспорту. */
export function encodeLegacy(text: string, encoding: string): Uint8Array {
  const label = encoding.toLowerCase();
  if (label === "utf-8" || label === "utf8") return new TextEncoder().encode(text);
  const table = SINGLE_BYTE[label];
  if (!table) throw new Error(`неизвестная кодировка ${encoding}`);
  const back = new Map<number, number>();
  for (let b = 255; b >= 0; b--) {
    const code = table[b]!;
    if (code >= 0) back.set(code, b);
  }
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const b = back.get(text.charCodeAt(i));
    if (b === undefined) throw new Error(`символ ${text[i]} не представим в ${encoding}`);
    out[i] = b;
  }
  return out;
}

const DECLARED_RE = /encoding=["']([\w-]+)["']/;

/** Кодировка, объявленная в XML-прологе, если она там есть. */
export function declaredEncoding(bytes: Uint8Array): string | null {
  const head = latin1(bytes.subarray(0, 200));
  const m = DECLARED_RE.exec(head);
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * Байты как строка один-к-одному: код символа равен значению байта.
 *
 * Нужна там, где по тексту надо ходить регулярками, а смещения обязаны
 * остаться байтовыми — например при вырезании <binary> из FB2.
 */
export function latin1(bytes: Uint8Array): string {
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    out.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  }
  return out.join("");
}

/** Обратное к latin1: строка с кодами 0..255 в байты. */
export function fromLatin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}
