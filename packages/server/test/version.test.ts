/** Версия сервера. */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/main.js";

describe("версия", () => {
  it("совпадает с той, что в пакете", () => {
    // Ровно та же проверка, что у читалки, и по той же причине: версия
    // названа и в коде, и в манифесте, выпуск сверяет с тегом только
    // манифест — разъедутся, и `--version` покажет чужое число. У читалки
    // это уже случалось.
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(readFileSync(resolve(here, "..", "package.json"), "utf-8")) as {
      version: string;
    };
    expect(VERSION).toBe(manifest.version);
  });

  it("совпадает с версией читалки", () => {
    // Читалка и сервер выпускаются одним тегом, поэтому расходиться им
    // незачем: разные числа под одним тегом сбивают с толку.
    const here = dirname(fileURLToPath(import.meta.url));
    const cli = JSON.parse(
      readFileSync(resolve(here, "..", "..", "cli", "package.json"), "utf-8"),
    ) as { version: string };
    expect(VERSION).toBe(cli.version);
  });
});
