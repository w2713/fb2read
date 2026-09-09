/** Разбор клавиш и мыши: то, что раньше делал curses.getch. */

import { describe, expect, it } from "vitest";
import { InputParser, type InputEvent } from "../src/term/input.js";

const encoder = new TextEncoder();
const feed = (...chunks: Array<string | Uint8Array>): InputEvent[] => {
  const parser = new InputParser();
  const events: InputEvent[] = [];
  for (const chunk of chunks) {
    events.push(...parser.feed(typeof chunk === "string" ? encoder.encode(chunk) : chunk));
  }
  events.push(...parser.flush());
  return events;
};
const names = (...chunks: Array<string | Uint8Array>): string[] =>
  feed(...chunks).map((e) => (e.kind === "key" ? e.name : `mouse:${e.button}`));

describe("клавиши", () => {
  it("обычные буквы приходят как есть", () => {
    expect(names("jkq")).toEqual(["j", "k", "q"]);
  });

  it("кириллица собирается из нескольких байтов", () => {
    expect(names("щ")).toEqual(["щ"]);
  });

  it("символ, разорванный между чтениями, не теряется", () => {
    const bytes = encoder.encode("щ");
    expect(names(bytes.subarray(0, 1), bytes.subarray(1))).toEqual(["щ"]);
  });

  it.each([
    ["\r", "enter"],
    ["\n", "enter"],
    ["\x7f", "backspace"],
    ["\x08", "backspace"],
    ["\t", "tab"],
    ["\x0c", "ctrl-l"],
    ["\x01", "ctrl-a"],
  ])("сводит %j к %j", (input, expected) => {
    expect(names(input)).toEqual([expected]);
  });

  it.each([
    ["\x1b[A", "up"],
    ["\x1b[B", "down"],
    ["\x1b[C", "right"],
    ["\x1b[D", "left"],
    ["\x1b[H", "home"],
    ["\x1b[F", "end"],
    ["\x1b[5~", "pgup"],
    ["\x1b[6~", "pgdn"],
    ["\x1b[3~", "delete"],
    ["\x1b[1~", "home"],
    ["\x1b[4~", "end"],
    ["\x1bOA", "up"],
    ["\x1bOH", "home"],
  ])("разбирает %j как %j", (input, expected) => {
    expect(names(input)).toEqual([expected]);
  });

  it("одинокий Esc отдаётся только после паузы", () => {
    const parser = new InputParser();
    expect(parser.feed(encoder.encode("\x1b"))).toEqual([]);
    expect(parser.flush()).toEqual([{ kind: "key", name: "esc" }]);
  });

  it("последовательность, разорванная между чтениями, собирается", () => {
    expect(names("\x1b[", "5~")).toEqual(["pgup"]);
  });

  it("проглатывает неизвестные последовательности, не сыпля мусором", () => {
    expect(names("\x1b[999;999R" + "j")).toEqual(["j"]);
    expect(names("\x1b]0;заголовок окна\x07" + "k")).toEqual(["k"]);
    expect(names("\x1b_Gответ графики\x1b\\" + "q")).toEqual(["q"]);
  });
});

describe("мышь", () => {
  it("разбирает нажатие левой кнопки", () => {
    expect(feed("\x1b[<0;10;5M")).toEqual([
      { kind: "mouse", button: "left", column: 9, row: 4, press: true, motion: false },
    ]);
  });

  it("отличает отпускание от нажатия", () => {
    const [event] = feed("\x1b[<0;10;5m");
    expect(event).toMatchObject({ kind: "mouse", press: false });
  });

  it("разбирает колесо в обе стороны", () => {
    expect(names("\x1b[<64;1;1M", "\x1b[<65;1;1M")).toEqual([
      "mouse:wheel-up",
      "mouse:wheel-down",
    ]);
  });

  it("разбирает правую кнопку", () => {
    expect(names("\x1b[<2;3;4M")).toEqual(["mouse:right"]);
  });

  it("работает за 223-й колонкой, где старый формат бессилен", () => {
    const [event] = feed("\x1b[<0;300;40M");
    expect(event).toMatchObject({ column: 299, row: 39 });
  });

  it("понимает и старый формат отчётов", () => {
    const bytes = new Uint8Array([0x1b, 0x5b, 0x4d, 32, 33 + 9, 33 + 4]);
    expect(feed(bytes)).toEqual([
      { kind: "mouse", button: "left", column: 9, row: 4, press: true, motion: false },
    ]);
  });

  it("отчёт, разорванный между чтениями, собирается", () => {
    expect(names("\x1b[<0;10", ";5M")).toEqual(["mouse:left"]);
  });
});
