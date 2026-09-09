/** Разбор командной строки. */

import { describe, expect, it } from "vitest";
import { ArgsError, parseCliArgs } from "../src/args.js";

describe("аргументы", () => {
  it("без аргументов ничего не просит", () => {
    const args = parseCliArgs([]);
    expect(args.file).toBeUndefined();
    expect(args.dump).toBe(false);
  });

  it("берёт файл и ширину", () => {
    const args = parseCliArgs(["книга.fb2", "-w", "72"]);
    expect(args.file).toBe("книга.fb2");
    expect(args.width).toBe(72);
  });

  it("понимает цифровые ключи разворота", () => {
    expect(parseCliArgs(["-2"]).columns).toBe(2);
    expect(parseCliArgs(["--spread"]).columns).toBe(2);
    expect(parseCliArgs(["-1"]).columns).toBe(1);
    expect(parseCliArgs([]).columns).toBeUndefined();
  });

  it("собирает длинные ключи", () => {
    const args = parseCliArgs([
      "книга.epub",
      "--theme",
      "night",
      "--images",
      "kitty",
      "--no-mouse",
      "--from-start",
      "--toc",
    ]);
    expect(args.theme).toBe("night");
    expect(args.images).toBe("kitty");
    expect(args.mouse).toBe(false);
    expect(args.fromStart).toBe(true);
    expect(args.toc).toBe(true);
  });

  it("отвергает неверный интервал", () => {
    expect(() => parseCliArgs(["-s", "9"])).toThrow(ArgsError);
    expect(() => parseCliArgs(["-s", "два"])).toThrow(ArgsError);
    expect(parseCliArgs(["-s", "2"]).spacing).toBe(2);
  });

  it("отвергает неизвестную тему и способ показа картинок", () => {
    expect(() => parseCliArgs(["--theme", "радуга"])).toThrow(ArgsError);
    expect(() => parseCliArgs(["--images", "магия"])).toThrow(ArgsError);
  });

  it("отвергает неизвестный ключ и лишний аргумент", () => {
    expect(() => parseCliArgs(["--летать"])).toThrow(ArgsError);
    expect(() => parseCliArgs(["одна.fb2", "вторая.fb2"])).toThrow(ArgsError);
  });
});
