/**
 * Разбор FB2 в блоки.
 *
 * Сюда приходит уже разобранное и, если надо, починенное дерево: обход
 * занимается только смыслом разметки — где заголовок, где стих, где сноска.
 */

import { makeBlock, type Block, type TocEntry } from "./block.js";
import { inlineRuns } from "./inline.js";
import { attr, iter, textOf, type XmlEl } from "./xml.js";

/** Метаданные книги из `<title-info>`. */
export interface Fb2Meta {
  title: string;
  author: string;
  series: string;
}

/** Результат обхода тела книги. */
export interface Fb2Body {
  blocks: Block[];
  toc: TocEntry[];
  /** Идентификатор якоря в номер блока: цели сносок. */
  anchors: Record<string, number>;
}

/** Название, автор и серия из описания книги. */
export function fb2Meta(root: XmlEl): Fb2Meta {
  let title = "";
  let author = "";
  let series = "";
  for (const desc of iter(root)) {
    if (desc.tag !== "title-info") continue;
    for (const el of desc.children) {
      const tag = el.tag;
      if (tag === "book-title" && !title) {
        title = textOf(el);
      } else if (tag === "author" && !author) {
        const names = el.children
          .filter((p) => ["first-name", "middle-name", "last-name", "nickname"].includes(p.tag))
          .map((p) => textOf(p))
          .filter(Boolean);
        author = names.join(" ");
      } else if (tag === "sequence" && !series) {
        const name = attr(el, "name");
        const num = attr(el, "number");
        series = name ? `${name} #${num}`.trim() : "";
      }
    }
    break;
  }
  return { title, author, series };
}

const BODY_NAMES: Readonly<Record<string, string>> = {
  notes: "Примечания",
  comments: "Комментарии",
};

/** Обходит тела книги и собирает блоки, оглавление и якоря. */
export function parseFb2Bodies(root: XmlEl): Fb2Body {
  const blocks: Block[] = [];
  const toc: TocEntry[] = [];
  const anchors: Record<string, number> = {};
  let level = 0;
  const style: Array<"cite"> = [];

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

  const walk = (el: XmlEl): void => {
    const tag = el.tag;
    const eid = attr(el, "id");
    if (eid && !(eid in anchors)) anchors[eid] = blocks.length;

    if (tag === "body" || tag === "section") {
      if (tag === "section") level += 1;
      for (const child of el.children) walk(child);
      if (tag === "section") {
        level -= 1;
        add("empty");
      }
    } else if (tag === "title") {
      const lines = el.children.map((p) => textOf(p)).filter(Boolean);
      if (lines.length) {
        const idx = add("title", lines.join("\n"));
        toc.push({ level: Math.max(level - 1, 0), title: lines.join(" "), block: idx });
      }
    } else if (tag === "subtitle") {
      const { text, refs, spans } = inlineRuns(el);
      add("subtitle", text, refs, spans);
    } else if (tag === "p") {
      const { text, refs, spans } = inlineRuns(el);
      add("p", text, refs, spans);
    } else if (tag === "empty-line") {
      add("empty");
    } else if (tag === "cite" || tag === "epigraph" || tag === "annotation") {
      style.push("cite");
      add("empty");
      for (const child of el.children) walk(child);
      style.pop();
      add("empty");
    } else if (tag === "poem") {
      add("empty");
      for (const child of el.children) walk(child);
      add("empty");
    } else if (tag === "stanza") {
      for (const child of el.children) walk(child);
      add("empty");
    } else if (tag === "v") {
      const { text, refs, spans } = inlineRuns(el);
      add("v", text, refs, spans);
    } else if (tag === "text-author") {
      add("author", textOf(el));
    } else if (tag === "image") {
      const href = attr(el, "href");
      add("image", "[ иллюстрация ]", [], [], href.replace(/^#+/, ""));
    } else if (tag === "table") {
      for (const row of el.children) {
        add("p", row.children.map((c) => textOf(c)).join("  |  "));
      }
    } else if (tag === "binary" || tag === "description") {
      return;
    } else {
      for (const child of el.children) walk(child);
    }
  };

  let bodies = root.children.filter((el) => el.tag === "body");
  if (!bodies.length) bodies = [...iter(root)].filter((el) => el.tag === "body");

  bodies.forEach((body, i) => {
    if (i && !body.children.some((c) => c.tag === "title")) {
      const raw = (attr(body, "name") || "notes").toLowerCase();
      const name = BODY_NAMES[raw] ?? raw.charAt(0).toUpperCase() + raw.slice(1);
      const idx = add("title", name);
      toc.push({ level: 0, title: name, block: idx });
    }
    walk(body);
  });

  return { blocks, toc, anchors };
}
