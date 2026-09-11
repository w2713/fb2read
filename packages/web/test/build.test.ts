/**
 * Что получилось из сборки.
 *
 * Браузер здесь не нужен: проверяется то, что лежит в `dist` после `vite
 * build`. Отдельным файлом — именно потому, что не нужен: там, где Chromium
 * не поставлен, браузерные наборы пропускаются целиком, а эти проверки
 * работать обязаны.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dist = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "dist");

/** Все файлы каталога с относительными именами. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (path: string): void => {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full).split(/[\\/]/).join("/"));
    }
  };
  walk(dir);
  return out;
}

describe("список для кэша", () => {
  it("перечисляет ровно то, что выдала сборка", async () => {
    // Забытый в списке файл — это офлайн, который сломается молча: addAll
    // атомарен, и работник просто не установится.
    const sw = readFileSync(join(dist, "sw.js"), "utf-8");
    const listed = JSON.parse(/const ASSETS = (\[[\s\S]*?\]);/.exec(sw)![1]!) as string[];
    const built = listFiles(dist)
      .filter((name) => name !== "sw.js" && !name.endsWith(".map"))
      .map((name) => `/fb2read/app/${name}`)
      .sort();
    expect(listed).toEqual(built);
  });

  it("имя кэша меняется вместе со сборкой", () => {
    const sw = readFileSync(join(dist, "sw.js"), "utf-8");
    expect(/const CACHE = "(fb2read-[0-9a-f]{12})"/.test(sw)).toBe(true);
  });
});

describe("иконки", () => {
  const icons = join(dist, "icons");
  const WANTED = [
    ["icon-192.png", 192],
    ["icon-512.png", 512],
    ["icon-maskable-512.png", 512],
    ["apple-touch-icon-180.png", 180],
  ] as const;

  it.each(WANTED)("%s — настоящая PNG заявленного размера", (file, size) => {
    // Значок неверного размера система молча не покажет, и узнать об этом
    // можно было бы только с телефона.
    const bytes = readFileSync(join(icons, file));
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(bytes.readUInt32BE(16)).toBe(size);
    expect(bytes.readUInt32BE(20)).toBe(size);
  });
});

describe("версия в сборке", () => {
  it("совпадает с версией пакета", () => {
    // Второго места, где версию можно забыть обновить, быть не должно: число
    // подставляется из того же package.json, который поднимается при выпуске.
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as {
      version: string;
    };
    const собрано = listFiles(dist)
      .filter((name) => name.endsWith(".js"))
      .map((name) => readFileSync(join(dist, name), "utf-8"))
      .join("\n");
    expect(собрано).toContain(`fb2read ${version}`);
  });
});
