/**
 * Разбор XML: единственное место, где импортируется парсер.
 *
 * Дерево приводится к виду ElementTree — text у элемента и tail у ребёнка, —
 * потому что весь разбор FB2 и EPUB написан в этих понятиях. Парсер выбран
 * строгий: на битом документе он падает, и на этом держится починка.
 */

import { parseXml as parseStrict, XmlElement, XmlText, XmlCdata, XmlDocument } from "@rgrove/parse-xml";
import { declaredEncoding, decode, DecodeError, ENCODINGS } from "./encoding.js";
import { lightClean, repair, stripBinaries, type BinaryIndex } from "./repair.js";

/** Элемент дерева в понятиях ElementTree. */
export interface XmlEl {
  /** Имя тега без пространства имён. */
  tag: string;
  /** Атрибуты как есть, с префиксами (`l:href`). */
  attrs: Record<string, string>;
  /** Текст до первого ребёнка. */
  text: string;
  /** Текст после этого элемента внутри родителя. */
  tail: string;
  children: XmlEl[];
}

/** Имя тега или атрибута без пространства имён и без префикса. */
export function local(name: string): string {
  const brace = name.lastIndexOf("}");
  const bare = brace === -1 ? name : name.slice(brace + 1);
  const colon = bare.lastIndexOf(":");
  return colon === -1 ? bare : bare.slice(colon + 1);
}

/** Значение атрибута по локальному имени. */
export function attr(el: XmlEl, name: string, fallback = ""): string {
  const direct = el.attrs[name];
  if (direct !== undefined) return direct;
  for (const key of Object.keys(el.attrs)) {
    if (local(key) === name) return el.attrs[key]!;
  }
  return fallback;
}

/** Элемент и все его потомки в порядке документа — аналог Element.iter(). */
export function* iter(el: XmlEl): Generator<XmlEl> {
  yield el;
  for (const child of el.children) yield* iter(child);
}

/** Первый потомок, удовлетворяющий условию, или undefined. */
export function findIn(el: XmlEl, test: (e: XmlEl) => boolean): XmlEl | undefined {
  for (const node of iter(el)) if (test(node)) return node;
  return undefined;
}

function convert(node: XmlElement): XmlEl {
  const attrs: Record<string, string> = {};
  for (const [key, value] of Object.entries(node.attributes)) attrs[key] = value;
  const el: XmlEl = { tag: local(node.name), attrs, text: "", children: [], tail: "" };
  let last: XmlEl | null = null;
  for (const child of node.children) {
    if (child instanceof XmlElement) {
      const converted = convert(child);
      el.children.push(converted);
      last = converted;
    } else if (child instanceof XmlText || child instanceof XmlCdata) {
      if (last) last.tail += child.text;
      else el.text += child.text;
    }
  }
  return el;
}

function rootOf(doc: XmlDocument): XmlEl {
  const root = doc.root;
  if (!root) throw new Error("в документе нет корневого элемента");
  return convert(root);
}

/** Строгий разбор строки: бросает исключение на любой неправильности. */
export function parseText(text: string): XmlEl {
  return rootOf(parseStrict(text));
}

/** Результат разбора книги: дерево, список правок и указатель на вложения. */
export interface ParseResult {
  root: XmlEl;
  notes: string[];
  images: BinaryIndex;
}

/**
 * Разбирает XML, переживая кривую кодировку, мусор и битые сущности.
 *
 * Сначала честная попытка, потом перебор кодировок, и для каждой — сперва
 * лёгкая чистка, затем полная починка. Порядок ровно как в эталоне, иначе
 * `--info` показывал бы другие правки.
 */
export function parseXml(input: Uint8Array): ParseResult {
  const notes: string[] = [];
  const stripped = stripBinaries(input);
  if (stripped.count) notes.push(`вложений пропущено при разборе: ${stripped.count}`);
  const data = stripped.data;
  const images = stripped.images;

  try {
    // Первая, честная попытка: кодировка берётся из пролога, как её читает
    // ElementTree по байтам. Удалось — значит книга целая, правок нет.
    return { root: parseText(decode(data, declaredEncoding(data) ?? "utf-8")), notes, images };
  } catch {
    // Не вышло — дальше перебираем кодировки и чиним.
  }

  for (const enc of ENCODINGS) {
    let text: string;
    try {
      text = decode(data, enc);
    } catch (e) {
      if (e instanceof DecodeError) continue;
      throw e;
    }
    for (const attempt of ["as-is", "repair"] as const) {
      const cleaned = attempt === "as-is" ? lightClean(text) : repair(text);
      let root: XmlEl;
      try {
        root = parseText(cleaned.text);
      } catch {
        continue;
      }
      if (enc !== "utf-8") notes.push(`кодировка определена как ${enc}`);
      notes.push(...cleaned.notes);
      return { root, notes, images };
    }
  }

  throw new Error("не удалось разобрать XML: файл повреждён или это не FB2");
}

/** Плоский текст элемента вместе с вложенной разметкой. */
export function textOf(el: XmlEl): string {
  const parts: string[] = [];
  const walk = (node: XmlEl) => {
    if (node.text) parts.push(node.text);
    for (const child of node.children) {
      if (child.tag !== "image") walk(child);
      if (child.tail) parts.push(child.tail);
    }
  };
  walk(el);
  return parts.join("").replace(/\s+/g, " ").trim();
}
