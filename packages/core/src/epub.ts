/**
 * Разбор EPUB в те же блоки, что и FB2.
 *
 * Порядок чтения берётся из spine, оглавление из nav или NCX, ссылки на
 * сноски работают между файлами книги: ключ якоря — путь к документу плюс
 * идентификатор внутри него.
 */

import { makeBlock, type Block, type TocEntry } from "./block.js";
import { inlineRuns, type Span } from "./inline.js";
import { parseXml, attr, iter, local, textOf, type XmlEl } from "./xml.js";
import { zipRead } from "./zip.js";

const XHTML_SKIP = new Set(["head", "script", "style", "title", "meta", "link", "svg"]);
const XHTML_HEADINGS: Readonly<Record<string, number>> = {
  h1: 0,
  h2: 1,
  h3: 2,
  h4: 3,
  h5: 4,
  h6: 5,
};
const XHTML_PARAGRAPHS = new Set(["p", "dd", "dt", "pre", "figcaption", "td", "th", "caption", "address"]);
const XHTML_BREAKS = new Set(["section", "article", "div", "figure", "table", "aside"]);
const BLOCKISH = new Set([
  ...XHTML_PARAGRAPHS,
  ...Object.keys(XHTML_HEADINGS),
  ...XHTML_BREAKS,
  "blockquote",
  "ul",
  "ol",
  "hr",
  "dl",
]);

/** Каталог пути в стиле posixpath.dirname. */
function dirname(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
}

/** Нормализация пути: убирает `.` и `..`, как posixpath.normpath. */
function normpath(path: string): string {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length && parts[parts.length - 1] !== "..") parts.pop();
      else if (!absolute) parts.push("..");
      continue;
    }
    parts.push(part);
  }
  const joined = parts.join("/");
  if (absolute) return "/" + joined;
  return joined || ".";
}

/** Приводит ссылку внутри книги к пути от корня архива. */
export function epubPath(base: string, href: string): string {
  let target = href.split("#")[0]!;
  try {
    target = decodeURIComponent(target);
  } catch {
    // Кривой процент-код оставляем как есть: лучше так, чем уронить книгу.
  }
  if (!target) return base;
  const joined = target.startsWith("/") ? target : base ? `${base}/${target}` : target;
  // lstrip("./") эталона снимает с начала любые точки и слэши разом,
  // поэтому и ведущий "/", и остаток "../" исчезают.
  return normpath(joined).replace(/^[./]+/, "");
}

/** Ключ якоря: путь к файлу плюс идентификатор внутри него. */
export function epubKey(doc: string, href: string): string {
  const hash = href.indexOf("#");
  const anchor = hash === -1 ? "" : href.slice(hash + 1);
  const target = href.startsWith("#") ? doc : epubPath(dirname(doc), href);
  return anchor ? `${target}#${anchor}` : target;
}

interface ManifestItem {
  href: string;
  type: string;
  props: string;
}

/** Всё, что даёт разбор EPUB. */
export interface EpubResult {
  blocks: Block[];
  toc: TocEntry[];
  anchors: Record<string, number>;
  repairs: string[];
  title: string;
  author: string;
  series: string;
}

/** Разбирает EPUB из байтов архива. */
export function parseEpub(data: Uint8Array): EpubResult {
  const blocks: Block[] = [];
  const toc: TocEntry[] = [];
  const anchors: Record<string, number> = {};
  const repairs: string[] = [];
  let title = "";
  let author = "";
  let series = "";
  let level = 0;
  const style: Array<"cite"> = [];

  const readXml = (name: string): XmlEl => {
    const content = zipRead(data, name);
    if (!content) throw new Error(`в EPUB нет файла ${name}`);
    const parsed = parseXml(content);
    repairs.push(...parsed.notes);
    return parsed.root;
  };

  const add = (
    kind: Block["kind"],
    text = "",
    refs: Block["refs"] = [],
    spans: Block["spans"] = [],
    src = "",
  ): number => {
    const effective = style.length && (kind === "p" || kind === "v") ? style[style.length - 1]! : kind;
    blocks.push(makeBlock(effective, text, level, refs, spans, src));
    return blocks.length - 1;
  };

  const paragraph = (el: XmlEl, doc: string, kind: Block["kind"] = "p", prefix = ""): number | null => {
    const run = inlineRuns(el, (h) => epubKey(doc, h));
    let text = run.text;
    if (!text) return null;
    let spans: Span[] = run.spans;
    if (prefix) {
      const shift = prefix.length;
      text = prefix + text;
      spans = spans.map(([a, b, k]) => [a + shift, b + shift, k] as const);
    }
    return add(kind, text, run.refs, spans);
  };

  const hasBlocks = (el: XmlEl): boolean => {
    for (const child of iter(el)) {
      if (child !== el && BLOCKISH.has(child.tag.toLowerCase())) return true;
    }
    return false;
  };

  const xhtml = (el: XmlEl, doc: string): void => {
    const tag = el.tag.toLowerCase();
    if (XHTML_SKIP.has(tag)) return;
    const nodeId = attr(el, "id");
    if (nodeId) {
      const key = `${doc}#${nodeId}`;
      if (!(key in anchors)) anchors[key] = blocks.length;
    }

    if (tag in XHTML_HEADINGS) {
      const index = paragraph(el, doc, "title");
      if (index !== null) {
        toc.push({ level: XHTML_HEADINGS[tag]!, title: blocks[index]!.text, block: index });
      }
    } else if (XHTML_PARAGRAPHS.has(tag)) {
      paragraph(el, doc);
    } else if (tag === "blockquote") {
      style.push("cite");
      add("empty");
      for (const child of el.children) xhtml(child, doc);
      style.pop();
      add("empty");
    } else if (tag === "ul" || tag === "ol") {
      let number = 0;
      for (const child of el.children) {
        if (child.tag.toLowerCase() === "li") {
          number += 1;
          paragraph(child, doc, "p", tag === "ol" ? `${number}. ` : "• ");
        } else {
          xhtml(child, doc);
        }
      }
      add("empty");
    } else if (tag === "hr") {
      add("empty");
    } else if (tag === "img" || tag === "image") {
      const src = attr(el, "src") || attr(el, "href");
      const target = src ? epubPath(dirname(doc), src) : "";
      const alt = attr(el, "alt").trim();
      add("image", alt ? `[ ${alt} ]` : "[ иллюстрация ]", [], [], target);
    } else if (tag === "br") {
      return;
    } else if (tag === "div" && !hasBlocks(el)) {
      paragraph(el, doc);
    } else {
      for (const child of el.children) xhtml(child, doc);
      if (XHTML_BREAKS.has(tag)) add("empty");
    }
  };

  const container = readXml("META-INF/container.xml");
  const rootfile = [...iter(container)].find(
    (el) => el.tag === "rootfile" && attr(el, "full-path"),
  );
  const opfName = rootfile ? attr(rootfile, "full-path") : "";
  if (!opfName) throw new Error("в EPUB не указан файл описания");
  const opf = readXml(opfName);
  const base = dirname(opfName);

  const manifest: Record<string, ManifestItem> = {};
  const spine: string[] = [];
  for (const el of iter(opf)) {
    const tag = el.tag;
    if (tag === "item" && attr(el, "id")) {
      manifest[attr(el, "id")] = {
        href: epubPath(base, attr(el, "href")),
        type: attr(el, "media-type"),
        props: attr(el, "properties"),
      };
    } else if (tag === "itemref" && attr(el, "idref")) {
      spine.push(attr(el, "idref"));
    }
  }

  for (const el of iter(opf)) {
    const tag = el.tag;
    if (tag === "title" && !title) {
      title = textOf(el);
    } else if (tag === "creator" && !author) {
      author = textOf(el);
    } else if (tag === "meta") {
      const name = attr(el, "name");
      const prop = attr(el, "property");
      if (name === "calibre:series" && !series) series = attr(el, "content");
      else if (prop === "belongs-to-collection" && !series) series = textOf(el);
    }
  }

  const documents = spine
    .filter((id) => id in manifest && manifest[id]!.type.includes("html"))
    .map((id) => manifest[id]!.href);
  if (!documents.length) throw new Error("в EPUB нет текстовых документов");

  for (const doc of documents) {
    let root: XmlEl;
    try {
      root = readXml(doc);
    } catch {
      continue; // битый файл книги пропускаем, остальное читается
    }
    if (!(doc in anchors)) anchors[doc] = blocks.length;
    const body = [...iter(root)].find((el) => el.tag.toLowerCase() === "body") ?? root;
    level = 1;
    xhtml(body, doc);
    add("empty");
  }

  // --- оглавление -------------------------------------------------------
  type RawEntry = { level: number; title: string; key: string };

  const tocFromNav = (navDoc: string): RawEntry[] => {
    let root: XmlEl;
    try {
      root = readXml(navDoc);
    } catch {
      return [];
    }
    const navs = [...iter(root)].filter((el) => el.tag.toLowerCase() === "nav");
    const chosen =
      navs.find((n) => Object.entries(n.attrs).some(([k, v]) => local(k) === "type" && v === "toc")) ??
      navs[0];
    if (!chosen) return [];

    const entries: RawEntry[] = [];
    const walk = (node: XmlEl, depth: number): void => {
      for (const child of node.children) {
        const tag = child.tag.toLowerCase();
        if (tag === "li") {
          const link = [...iter(child)].find((e) => e.tag.toLowerCase() === "a");
          if (link) {
            const href = attr(link, "href");
            if (href) entries.push({ level: depth, title: textOf(link), key: epubKey(navDoc, href) });
          }
          for (const sub of child.children) {
            if (["ol", "ul"].includes(sub.tag.toLowerCase())) walk(sub, depth + 1);
          }
        } else if (tag === "ol" || tag === "ul") {
          walk(child, depth);
        }
      }
    };
    walk(chosen, 0);
    return entries;
  };

  const tocFromNcx = (ncxDoc: string): RawEntry[] => {
    let root: XmlEl;
    try {
      root = readXml(ncxDoc);
    } catch {
      return [];
    }
    const entries: RawEntry[] = [];
    const walk = (node: XmlEl, depth: number): void => {
      for (const child of node.children) {
        if (child.tag !== "navPoint") continue;
        const labelEl = [...iter(child)].find((e) => e.tag === "text");
        const contentEl = [...iter(child)].find((e) => e.tag === "content");
        const label = labelEl ? textOf(labelEl) : "";
        const content = contentEl ? attr(contentEl, "src") : "";
        if (content) entries.push({ level: depth, title: label, key: epubKey(ncxDoc, content) });
        walk(child, depth + 1);
      }
    };
    const navMap = [...iter(root)].find((el) => el.tag === "navMap") ?? root;
    walk(navMap, 0);
    return entries;
  };

  let raw: RawEntry[] = [];
  const navHref = Object.values(manifest).find((i) => i.props.includes("nav"))?.href;
  if (navHref) raw = tocFromNav(navHref);
  if (!raw.length) {
    const ncxHref = Object.values(manifest).find((i) => i.type === "application/x-dtbncx+xml")?.href;
    if (ncxHref) raw = tocFromNcx(ncxHref);
  }

  const resolved: TocEntry[] = [];
  for (const entry of raw) {
    let index = anchors[entry.key];
    if (index === undefined && entry.key.includes("#")) index = anchors[entry.key.split("#")[0]!];
    if (index !== undefined && entry.title) {
      resolved.push({ level: entry.level, title: entry.title, block: index });
    }
  }
  const finalToc = resolved.length >= 2 ? resolved.sort((a, b) => a.block - b.block) : toc;

  return { blocks, toc: finalToc, anchors, repairs, title, author, series };
}
