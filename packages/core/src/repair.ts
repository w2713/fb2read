/**
 * Починка типичных поломок FB2 из реальных библиотек.
 *
 * Порядок правок повторяет эталонную реализацию: вложения вырезаются до
 * разбора, потом снимается пролог, управляющие байты, мусор по краям и
 * только затем чинятся сущности. Каждая правка называется вслух, чтобы
 * читатель увидел её в `--info`.
 */

import { NAME_TO_CODEPOINT } from "./encoding-tables.js";
import { latin1 } from "./encoding.js";

/** Где в файле лежит base64-вложение: границы данных и объявленный тип. */
export interface BinaryEntry {
  start: number;
  end: number;
  type: string;
}

export type BinaryIndex = Record<string, BinaryEntry>;

const BINARY_RE = /<binary\b([^>]*)>([\s\S]*?)<\/binary\s*>/g;
const BINARY_ID_RE = /id\s*=\s*["']([^"']+)["']/;
const BINARY_TYPE_RE = /content-type\s*=\s*["']([^"']+)["']/;
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
const ENTITY_RE = /&([#A-Za-z0-9]{1,32});/g;
const BARE_AMP_RE = /&(?![#A-Za-z0-9]{1,32};)/g;
const XML_DECL_RE = /^﻿?\s*<\?xml[^>]*\?>/;
const XML_ENTITIES = new Set(["amp", "lt", "gt", "quot", "apos"]);
const ESCAPE: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

/**
 * Убирает base64-вложения из разбираемого XML.
 *
 * Сами данные не хранятся: запоминаются только границы каждого вложения в
 * исходном файле, чтобы картинку можно было достать по требованию, не держа
 * книгу целиком в памяти. Работаем по latin1-строке, поэтому смещения
 * остаются байтовыми.
 */
export function stripBinaries(data: Uint8Array): {
  data: Uint8Array;
  count: number;
  images: BinaryIndex;
} {
  const text = latin1(data);
  const images: BinaryIndex = {};
  let count = 0;
  BINARY_RE.lastIndex = 0;
  for (let m = BINARY_RE.exec(text); m; m = BINARY_RE.exec(text)) {
    count += 1;
    const attrs = m[1]!;
    const id = BINARY_ID_RE.exec(attrs);
    if (!id) continue;
    const mime = BINARY_TYPE_RE.exec(attrs);
    const dataStart = m.index + m[0]!.indexOf(">", 0) + 1;
    images[id[1]!] = {
      start: dataStart,
      end: dataStart + m[2]!.length,
      type: mime ? mime[1]! : "",
    };
  }
  if (!count) return { data, count, images };

  // Вырезаем вложения из байтов, а не из строки: так не нужно обратное
  // преобразование целой книги.
  const out = new Uint8Array(data.length);
  let write = 0;
  let read = 0;
  BINARY_RE.lastIndex = 0;
  for (let m = BINARY_RE.exec(text); m; m = BINARY_RE.exec(text)) {
    out.set(data.subarray(read, m.index), write);
    write += m.index - read;
    read = m.index + m[0]!.length;
  }
  out.set(data.subarray(read), write);
  write += data.length - read;
  return { data: out.subarray(0, write), count, images };
}

/** `&nbsp;` и прочие HTML-сущности в символы, одиночный `&` в `&amp;`. */
export function fixEntities(text: string): { text: string; fixed: number } {
  let fixed = 0;
  let out = text.replace(ENTITY_RE, (whole, name: string) => {
    if (XML_ENTITIES.has(name) || name.startsWith("#")) return whole;
    const code = NAME_TO_CODEPOINT[name];
    fixed += 1;
    if (code === undefined) return `&amp;${name};`; // оставим видимым как текст
    const char = String.fromCodePoint(code);
    return ESCAPE[char] ?? char;
  });
  const bare = out.match(BARE_AMP_RE);
  if (bare) {
    fixed += bare.length;
    out = out.replace(BARE_AMP_RE, "&amp;");
  }
  return { text: out, fixed };
}

/** Приводит в чувство типичные поломки FB2. Возвращает текст и список правок. */
export function repair(text: string): { text: string; notes: string[] } {
  const notes: string[] = [];

  let body = text.replace(XML_DECL_RE, "").replace(/^\s+/, "");

  const cleaned = body.replace(CTRL_RE, "");
  if (cleaned !== body) {
    notes.push("убраны управляющие символы");
    body = cleaned;
  }

  const start = body.indexOf("<");
  if (start > 0) {
    body = body.slice(start);
    notes.push("отброшен мусор перед началом документа");
  }

  const tail = "</FictionBook>";
  const end = body.lastIndexOf(tail);
  if (end !== -1 && end + tail.length < body.length) {
    body = body.slice(0, end + tail.length);
    notes.push("отброшен мусор после конца документа");
  }

  const entities = fixEntities(body);
  if (entities.fixed) {
    notes.push(`исправлено сущностей и амперсандов: ${entities.fixed}`);
  }

  return { text: entities.text, notes };
}

/** Снимает пролог и управляющие байты, ничего больше не трогая. */
export function lightClean(text: string): { text: string; notes: string[] } {
  let body = text.replace(XML_DECL_RE, "").replace(/^\s+/, "");
  const stripped = body.replace(CTRL_RE, "");
  if (stripped !== body) {
    body = stripped;
    return { text: body, notes: ["убраны управляющие символы"] };
  }
  return { text: body, notes: [] };
}
