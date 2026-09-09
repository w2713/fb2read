/**
 * Сбор абзаца: текст, начертание и ссылки на сноски.
 *
 * Смещения везде считаются в единицах UTF-16, то есть в индексах строки JS.
 * Одно соглашение на всё ядро: вёрстка, поиск и подсветка режут ту же строку
 * теми же числами, иначе разметка съезжала бы на суррогатных парах.
 */

import { attr, local, textOf, type XmlEl } from "./xml.js";

/** Вид начертания: слева тег FB2 или XHTML, справа — что рисовать. */
const INLINE_STYLE: Readonly<Record<string, "em" | "strong">> = {
  emphasis: "em",
  strong: "strong",
  code: "strong",
  em: "em",
  i: "em",
  cite: "em",
  var: "em",
  b: "strong",
  mark: "strong",
};

/** Начертание куска абзаца: начало, конец, вид. */
export type Span = readonly [number, number, "em" | "strong"];

/** Сноска абзаца: видимый маркер и идентификатор цели. */
export type Ref = readonly [string, string];

/** Собирает текст абзаца вместе с разметкой и ссылками. */
class Runs {
  private parts: string[] = [];
  length = 0;
  spans: Array<[number, number, "em" | "strong"]> = [];
  marks: Array<[number, number, string]> = [];

  add(raw: string): void {
    if (!raw) return;
    let chunk = raw.replace(/\s+/g, " ");
    const tailSpace = this.length === 0 || this.parts[this.parts.length - 1]!.endsWith(" ");
    if (chunk.startsWith(" ") && tailSpace) chunk = chunk.slice(1);
    if (!chunk) return;
    this.parts.push(chunk);
    this.length += chunk.length;
  }

  result(): { text: string; refs: Ref[]; spans: Span[] } {
    const text = this.parts.join("").replace(/\s+$/, "");
    const limit = text.length;
    const spans: Span[] = this.spans
      .filter(([a]) => a < limit)
      .map(([a, b, k]) => [a, Math.min(b, limit), k] as const);
    const refs: Ref[] = this.marks
      .filter(([a, b]) => a < limit && text.slice(a, b).trim())
      .map(([a, b, target]) => [text.slice(a, Math.min(b, limit)), target] as const);
    return { text, refs, spans };
  }
}

/**
 * Текст элемента, ссылки на сноски и разметка курсива и полужирного.
 *
 * `resolve` превращает href в ключ якоря: для FB2 достаточно отбросить
 * решётку, в EPUB ссылка может вести в соседний файл книги.
 */
export function inlineRuns(
  el: XmlEl,
  resolve?: (href: string) => string | null,
): { text: string; refs: Ref[]; spans: Span[] } {
  const runs = new Runs();

  const rec = (node: XmlEl): void => {
    if (node.text) runs.add(node.text);
    for (const child of node.children) {
      const tag = child.tag;
      const start = runs.length;
      if (tag === "image") {
        // Картинка внутри абзаца текста не даёт.
      } else if (tag === "a") {
        const href = attr(child, "href");
        rec(child);
        const target = resolve ? resolve(href) : href.startsWith("#") ? href.slice(1) : null;
        if (target && runs.length > start) runs.marks.push([start, runs.length, target]);
      } else {
        rec(child);
        const kind = INLINE_STYLE[tag];
        if (kind && runs.length > start) runs.spans.push([start, runs.length, kind]);
      }
      if (child.tail) runs.add(child.tail);
    }
  };

  rec(el);
  return runs.result();
}

/** Текст элемента и найденные в нём ссылки. */
export function textAndRefs(el: XmlEl): { text: string; refs: Ref[] } {
  const refs: Ref[] = [];

  const rec = (node: XmlEl): string => {
    const parts: string[] = [];
    if (node.text) parts.push(node.text);
    for (const child of node.children) {
      const tag = child.tag;
      if (tag === "image") {
        // Картинка текста не даёт.
      } else if (tag === "a") {
        const inner = textOf(child);
        const href = attr(child, "href");
        if (href.startsWith("#") && inner) refs.push([inner, href.slice(1)]);
        parts.push(inner);
      } else {
        parts.push(rec(child));
      }
      if (child.tail) parts.push(child.tail);
    }
    return parts.join("");
  };

  return { text: rec(el).replace(/\s+/g, " ").trim(), refs };
}

export { local };
