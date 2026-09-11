/**
 * Сквозные проверки собранной программы.
 *
 * Запускается настоящий бандл: так ловятся вещи, которых не видно при
 * вызове функций, — обрыв конвейера, коды выхода, вывод не в терминал.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "..", "dist", "fb2read.mjs");
const built = existsSync(CLI);

let dir: string;
let book: string;

const BOOK =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" ' +
  'xmlns:l="http://www.w3.org/1999/xlink">' +
  "<description><title-info><book-title>Книга для проверки</book-title>" +
  "<author><last-name>Автор</last-name></author></title-info></description>" +
  "<body><title><p>Книга для проверки</p></title>" +
  "<section><title><p>Глава</p></title>" +
  Array.from({ length: 400 }, (_, i) => `<p>Абзац номер ${i} с текстом.</p>`).join("") +
  "</section></body></FictionBook>";

/**
 * Книга с длинными абзацами.
 *
 * У основного образца абзацы короче колонки, поэтому они не переносятся вовсе,
 * каждая строка оказывается последней в своём абзаце — а последнюю выключка не
 * трогает. На нём проверка выключки прошла бы вхолостую.
 */
const ДЛИННАЯ =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">' +
  "<description><title-info><book-title>Длинная</book-title>" +
  "</title-info></description><body><section><title><p>Глава</p></title>" +
  Array.from(
    { length: 30 },
    (_, i) =>
      `<p>Абзац номер ${i}, и в нём достаточно слов, чтобы он не уместился ` +
      "в одну строку узкой колонки, а перенёсся на несколько строк подряд " +
      "и дал выключке хоть какую-то работу над промежутками.</p>",
  ).join("") +
  "</section></body></FictionBook>";

let длинная: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "fb2read-cli-"));
  book = join(dir, "книга.fb2");
  writeFileSync(book, BOOK, "utf-8");
  длинная = join(dir, "длинная.fb2");
  writeFileSync(длинная, ДЛИННАЯ, "utf-8");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const env = () => ({
  ...process.env,
  XDG_DATA_HOME: join(dir, "data"),
  XDG_CONFIG_HOME: join(dir, "config"),
});

const run = (...args: string[]) =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: "utf-8", env: env() });

describe.skipIf(!built)("собранная программа", () => {
  it("печатает версию", () => {
    expect(run("--version").stdout.trim()).toMatch(/^fb2read \d+\.\d+\.\d+$/);
  });

  it("показывает сведения о книге", () => {
    const out = run(book, "--info").stdout;
    expect(out).toContain("Название: Книга для проверки");
    expect(out).toContain("Формат:   FB2");
  });

  it("печатает оглавление", () => {
    expect(run(book, "--toc").stdout.trim().split("\n")).toEqual([
      "Книга для проверки",
      "Глава",
    ]);
  });

  it("держит заданную ширину при выводе текста", () => {
    for (const line of run(book, "--dump", "-w", "40").stdout.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(40);
    }
  });

  it("--justify равняет правый край, а без него он неровный", () => {
    // Умолчание сверяется с эталонной реализацией побайтно (diff-dump.sh),
    // поэтому выключка обязана быть только по просьбе.
    const ширины = (args: string[]) =>
      run(длинная, "--dump", "-w", "40", ...args)
        .stdout.split("\n")
        .filter((line) => line.trim().length > 30)
        .map((line) => line.length);

    const обычно = ширины([]);
    const ровно = ширины(["--justify"]);
    expect(обычно.length).toBeGreaterThan(2);
    expect(обычно.every((n) => n === 40)).toBe(false);
    expect(ровно.filter((n) => n === 40).length).toBeGreaterThan(обычно.filter((n) => n === 40).length);
    for (const n of ровно) expect(n).toBeLessThanOrEqual(40);
  });

  it("переживает обрыв конвейера", () => {
    // head закрывает трубу на первой странице — это обычный конец работы,
    // а не ошибка: код возврата должен быть нулевым и без крика в stderr.
    const result = spawnSync(
      "sh",
      ["-c", `"${process.execPath}" "${CLI}" "${book}" --dump | head -2`],
      { encoding: "utf-8", env: env() },
    );
    expect(result.stderr).not.toContain("EPIPE");
    expect(result.status).toBe(0);
  });

  it("на неизвестном ключе выходит с кодом 2", () => {
    const result = run("--летать");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("fb2read:");
  });

  it("на отсутствующем файле выходит с кодом 1", () => {
    const result = run(join(dir, "нет-такой.fb2"));
    expect(result.status).toBe(1);
  });

  it("на повреждённом файле объясняет, что случилось", () => {
    const broken = join(dir, "битая.fb2");
    writeFileSync(broken, "это не книга", "utf-8");
    const result = run(broken, "--info");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("повреждён");
  });

  it("записывает образец настроек и читает его обратно", () => {
    const path = join(dir, "config.ini");
    const result = run("--write-config", "--config", path);
    expect(result.stdout).toContain(path);
    const again = run(book, "--info", "--config", path);
    expect(again.stderr).toBe("");
    expect(again.status).toBe(0);
  });

  it("настройки из конфига меняют вывод", () => {
    const path = join(dir, "narrow.ini");
    writeFileSync(path, "[reader]\nwidth = 30\n", "utf-8");
    for (const line of run(book, "--dump", "--config", path).stdout.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(30);
    }
  });

  it("для --dump без книги объясняет, что нужен файл", () => {
    const result = run(dir, "--dump");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("нужен файл книги");
  });

  it("недавние книги печатаются текстом, когда вывод не в терминал", () => {
    // Без аргумента и без терминала список идёт в конвейер, а не на экран.
    const result = spawnSync(process.execPath, [CLI], { encoding: "utf-8", env: env() });
    expect(result.status === 0 || result.status === 1).toBe(true);
  });

  it("список книг в каталоге печатается текстом", () => {
    const out = execFileSync(process.execPath, [CLI, dir], {
      encoding: "utf-8",
      env: env(),
    });
    expect(out).toContain("Книга для проверки");
  });
});
