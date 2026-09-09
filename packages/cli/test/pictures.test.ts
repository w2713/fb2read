/**
 * Показ иллюстраций.
 *
 * Протоколы kitty и iTerm2 — это байты в потоке, поэтому проверяются они по
 * сырому журналу вывода: эмулятор такие последовательности проглатывает, как
 * и настоящий терминал, который их не понимает.
 */

import { describe, expect, it } from "vitest";
import { Book, MemorySource } from "@fb2read/core";
import { harness } from "./harness.js";
import { PICTURE, sampleBook } from "./books.js";

const OPTIONS = {
  width: 60,
  startBlock: 0,
  theme: "night",
  spacing: 1,
  columns: 1,
  mouse: true,
};

const pictureBook = () =>
  Book.open(new MemorySource("picture.fb2", new TextEncoder().encode(PICTURE)));

async function open(images: "kitty" | "iterm" | "off" | "" | "chafa" = "kitty") {
  return harness({
    book: await pictureBook(),
    ...OPTIONS,
    images: images as never,
    imagesOff: images === "off",
  });
}

describe("протоколы", () => {
  it("в kitty картинка уходит графическим протоколом", async () => {
    const ui = await open("kitty");
    await ui.press("p");
    expect(ui.terminal.raw).toContain("\x1b_G");
    expect(ui.terminal.raw).toContain("a=T,f=100");
  });

  it("под картинкой подпись и приглашение нажать клавишу", async () => {
    const ui = await open("kitty");
    await ui.press("p");
    expect(ui.terminal.raw).toContain("любая клавиша");
  });

  it("любая клавиша возвращает к тексту", async () => {
    const ui = await open("kitty");
    await ui.press("p");
    await ui.press("x");
    expect(ui.terminal.text()).toContain("Текст перед картинкой");
  });

  it("в iTerm2 картинка уходит своим протоколом", async () => {
    const ui = await open("iterm");
    await ui.press("p");
    expect(ui.terminal.raw).toContain("\x1b]1337;File=inline=1");
  });
});

describe("когда показать нельзя", () => {
  it("с --images off говорит об этом и ничего не рисует", async () => {
    const ui = await open("off");
    await ui.press("p");
    expect(ui.terminal.line(ui.terminal.rows - 1)).toContain("выключен");
    expect(ui.terminal.raw).not.toContain("\x1b_G");
  });

  it("терминал без графики честно предупреждает", async () => {
    const ui = await open("");
    await ui.press("p");
    expect(ui.terminal.line(ui.terminal.rows - 1)).toContain("не умеет показывать картинки");
  });

  it("когда иллюстраций на экране нет, говорит об этом", async () => {
    const ui = await harness({ book: await sampleBook(), ...OPTIONS });
    await ui.press("G", "p");
    expect(ui.terminal.line(ui.terminal.rows - 1)).toContain("нет иллюстраций");
  });
});

describe("мышь", () => {
  it("щелчок по иллюстрации показывает её", async () => {
    const ui = await open("kitty");
    const row = ui.terminal.findRow("иллюстрация");
    expect(row).toBeGreaterThan(0);
    ui.terminal.click(ui.terminal.line(row).indexOf("["), row);
    await ui.settle();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ui.terminal.raw).toContain("\x1b_G");
  });

  it("щелчок по обычному тексту ничего не делает", async () => {
    const ui = await open("kitty");
    const before = ui.terminal.text();
    const row = ui.terminal.findRow("Текст перед картинкой");
    ui.terminal.click(20, row);
    await ui.settle();
    expect(ui.terminal.text()).toBe(before);
    expect(ui.terminal.raw).not.toContain("\x1b_G");
  });
});
