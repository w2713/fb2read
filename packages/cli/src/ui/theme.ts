/**
 * Цветовые темы.
 *
 * Числа те же, что в эталонной реализации: это номера в 256-цветной палитре
 * терминала, а -1 означает цвет по умолчанию. На бедной палитре они
 * подменяются базовыми восемью, этим занимается слой ANSI.
 */

import type { Attr } from "../term/ansi.js";

/** Роль на экране: текст, заголовок, приглушённое, полоса, сноска. */
export type Role = "text" | "title" | "dim" | "header" | "note";

type Palette = Record<Role, [number, number]>;

export const THEMES: Readonly<Record<string, Palette>> = {
  auto: {
    text: [-1, -1],
    title: [3, -1], // жёлтый
    dim: [-1, -1],
    header: [0, 6], // чёрный на голубом
    note: [6, -1],
  },
  night: {
    text: [250, 233],
    title: [179, 233],
    dim: [243, 233],
    header: [250, 236],
    note: [109, 233],
  },
  sepia: {
    text: [94, 223],
    title: [52, 223],
    dim: [138, 223],
    header: [223, 94],
    note: [24, 223],
  },
  day: {
    text: [235, 255],
    title: [24, 255],
    dim: [245, 255],
    header: [255, 24],
    note: [26, 255],
  },
};

/** Набор готовых начертаний для выбранной темы. */
export class Theme {
  constructor(public name: string) {}

  private get palette(): Palette {
    return THEMES[this.name] ?? THEMES["auto"]!;
  }

  /** Начертание роли, с возможными добавками. */
  attr(role: Role, extra: Partial<Attr> = {}): Attr {
    const [fg, bg] = this.palette[role];
    return { fg, bg, ...extra };
  }

  /** Фон всего экрана. */
  get background(): Attr {
    return this.attr("text");
  }

  /** Начертание строки по её роли в вёрстке. */
  lineAttr(attr: "title" | "sub" | "text" | "dim"): Attr {
    if (attr === "title") return this.attr("title", { bold: true });
    if (attr === "sub") return this.attr("text", { bold: true });
    if (attr === "dim") return this.attr("dim", { dim: true });
    return this.attr("text");
  }

  /** Полоса заголовка книги. */
  get header(): Attr {
    return this.attr("header", { bold: true });
  }

  /** Маркер сноски: его видно и без цвета, по подчёркиванию. */
  get note(): Attr {
    return this.attr("note", { underline: true, bold: true });
  }

  /**
   * Начертание найденного текста.
   *
   * Обращение цветов заметно в любой теме и на любой палитре, поэтому
   * подсветка поиска не теряется даже в чёрно-белом терминале.
   */
  get match(): Attr {
    return this.attr("text", { reverse: true });
  }
}

/** Курсив умеют не все терминалы, там он превращается в подчёркивание. */
export function emphasisAttr(base: Attr, kind: "em" | "strong"): Attr {
  return kind === "em" ? { ...base, italic: true } : { ...base, bold: true };
}
