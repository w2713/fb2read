/**
 * Последовательности терминала — то, что раньше делал curses.
 *
 * Никакого terminfo: берётся подмножество xterm, которое понимают все
 * живые эмуляторы, включая Windows Terminal и conhost начиная с Windows 10
 * версии 1809. Это позволяет обойтись без сторонней библиотеки и оставить
 * вывод предсказуемым до байта — на нём держатся тесты.
 */

export const ESC = "\x1b";
export const CSI = `${ESC}[`;

/** Управление экраном. */
export const ALT_SCREEN_ON = `${CSI}?1049h`;
export const ALT_SCREEN_OFF = `${CSI}?1049l`;
export const CURSOR_HIDE = `${CSI}?25l`;
export const CURSOR_SHOW = `${CSI}?25h`;
export const CLEAR = `${CSI}2J`;
export const RESET = `${CSI}0m`;

/**
 * Синхронный вывод: терминал показывает кадр целиком, а не по мере прихода
 * байтов. Кто не умеет — молча пропустит.
 */
export const SYNC_ON = `${CSI}?2026h`;
export const SYNC_OFF = `${CSI}?2026l`;

/** Мышь: обычные события плюс SGR-отчёты, чтобы клики шли и за 223-й колонкой. */
export const MOUSE_ON = `${CSI}?1000h${CSI}?1002h${CSI}?1006h`;
export const MOUSE_OFF = `${CSI}?1006l${CSI}?1002l${CSI}?1000l`;

/**
 * Прокрутка колесом там, где мышь не захвачена: терминал сам превращает
 * колесо в стрелки. На Windows это единственный способ листать колесом.
 */
export const ALT_SCROLL_ON = `${CSI}?1007h`;
export const ALT_SCROLL_OFF = `${CSI}?1007l`;

/** Ставит курсор: строка и колонка считаются от нуля. */
export function moveTo(row: number, column: number): string {
  return `${CSI}${row + 1};${column + 1}H`;
}

/** Начертание ячейки. */
export interface Attr {
  /** Цвет текста: -1 — цвет терминала по умолчанию. */
  fg: number;
  /** Цвет фона: -1 — цвет терминала по умолчанию. */
  bg: number;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  reverse?: boolean;
}

export const DEFAULT_ATTR: Attr = { fg: -1, bg: -1 };

/** Одинаковы ли начертания — сравнение по значению, а не по ссылке. */
export function sameAttr(a: Attr, b: Attr): boolean {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    !!a.bold === !!b.bold &&
    !!a.dim === !!b.dim &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline &&
    !!a.reverse === !!b.reverse
  );
}

/** Чем заменить 256-цветные оттенки на бедной палитре. */
const FALLBACK: Readonly<Record<number, number>> = {
  233: 0,
  235: 0,
  236: 0, // чёрный
  52: 1, // красный
  94: 3,
  138: 3,
  179: 3, // жёлтый
  223: 7,
  243: 7,
  245: 7,
  250: 7,
  255: 7, // белый
  24: 4,
  26: 4, // синий
  109: 6, // голубой
};

/** Приводит цвет к тому, что терминал действительно умеет. */
export function fitColor(value: number, colors: number): number {
  if (value < 8) return value; // -1 и базовые восемь есть везде
  if (colors >= 256) return value;
  return FALLBACK[value] ?? 7;
}

/**
 * Сколько цветов у терминала.
 *
 * TERM на Windows обычно пуст, но и conhost, и Windows Terminal умеют 256
 * цветов, поэтому там отвечаем утвердительно, не заглядывая в переменные.
 */
export function colorDepth(env: Record<string, string | undefined>, platform: string): number {
  if (env["NO_COLOR"] !== undefined) return 0;
  if (platform === "win32") return 256;
  const term = env["TERM"] ?? "";
  if (!term || term === "dumb") return 0;
  if (env["COLORTERM"] === "truecolor" || env["COLORTERM"] === "24bit") return 256;
  if (term.includes("256")) return 256;
  if (term === "linux") return 8;
  return 8;
}

/** Собирает SGR-команду для перехода к нужному начертанию. */
export function sgr(attr: Attr, colors: number): string {
  if (colors === 0) {
    // Без цвета остаются только начертания: жирный, курсив и прочее.
    const plain = [
      attr.bold ? "1" : "",
      attr.dim ? "2" : "",
      attr.italic ? "3" : "",
      attr.underline ? "4" : "",
      attr.reverse ? "7" : "",
    ].filter(Boolean);
    return `${CSI}0${plain.length ? ";" + plain.join(";") : ""}m`;
  }

  const parts = ["0"];
  if (attr.bold) parts.push("1");
  if (attr.dim) parts.push("2");
  if (attr.italic) parts.push("3");
  if (attr.underline) parts.push("4");
  if (attr.reverse) parts.push("7");

  const fg = fitColor(attr.fg, colors);
  const bg = fitColor(attr.bg, colors);
  if (fg >= 0) parts.push(fg < 8 ? String(30 + fg) : `38;5;${fg}`);
  if (bg >= 0) parts.push(bg < 8 ? String(40 + bg) : `48;5;${bg}`);
  return `${CSI}${parts.join(";")}m`;
}

/**
 * Последовательности входа в полноэкранный режим и выхода из него.
 *
 * Вынесены сюда, чтобы настоящий терминал и его подмена в тестах посылали
 * ровно одно и то же: иначе тесты проверяли бы не то, что видит терминал.
 */
export function enterSequence(mouse: boolean): string {
  return ALT_SCREEN_ON + CURSOR_HIDE + ALT_SCROLL_ON + (mouse ? MOUSE_ON : "");
}

export function leaveSequence(mouse: boolean): string {
  return (mouse ? MOUSE_OFF : "") + ALT_SCROLL_OFF + CURSOR_SHOW + ALT_SCREEN_OFF + RESET;
}
