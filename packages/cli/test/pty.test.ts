/**
 * Запуск в настоящем псевдотерминале.
 *
 * Основные проверки интерфейса идут внутри процесса и потому быстры и
 * устойчивы. Но сырой режим, сигналы и настоящий tty так не проверить:
 * здесь программа запускается по-настоящему и получает ровно то, что
 * получила бы от терминала пользователя.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SAMPLE } from "./books.js";
import { encodeLegacy } from "@fb2read/core";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "..", "dist", "fb2read.mjs");

type Pty = typeof import("node-pty");
let pty: Pty | null = null;
try {
  // Собственный модуль: если он не собрался, эти проверки просто пропускаются,
  // а вся остальная проверка интерфейса от него не зависит.
  pty = require("node-pty") as Pty;
} catch {
  pty = null;
}

const runnable = pty !== null && existsSync(CLI) && process.platform !== "win32";

let dir: string;
let book: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "fb2read-pty-"));
  book = join(dir, "книга.fb2");
  writeFileSync(book, encodeLegacy(SAMPLE, "cp1251"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Ведёт сеанс: посылает клавиши с паузами и возвращает всё, что вышло. */
async function session(
  steps: Array<string | number>,
  size: { rows: number; cols: number } = { rows: 24, cols: 100 },
  extraEnv: Record<string, string> = {},
): Promise<{ output: string; code: number }> {
  const term = pty!.spawn(process.execPath, [CLI, book], {
    name: "xterm-256color",
    cols: size.cols,
    rows: size.rows,
    cwd: dir,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      XDG_DATA_HOME: join(dir, "data"),
      XDG_CONFIG_HOME: join(dir, "config"),
      ...extraEnv,
    },
  });

  let output = "";
  term.onData((data) => {
    output += data;
  });

  const exited = new Promise<number>((done) => {
    term.onExit(({ exitCode }) => done(exitCode));
  });

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await wait(400);
  for (const step of steps) {
    if (typeof step === "number") await wait(step);
    else term.write(step);
    await wait(120);
  }
  const code = await Promise.race([
    exited,
    wait(3000).then(() => {
      term.kill();
      return -1;
    }),
  ]);
  return { output, code };
}

describe.skipIf(!runnable)("настоящий терминал", () => {
  it("открывает книгу, читает и выходит с нулевым кодом", async () => {
    const { output, code } = await session(["j", "j", "q"]);
    expect(code).toBe(0);
    expect(output).toContain("Проверка читалки");
  });

  it("занимает альтернативный экран и возвращает его при выходе", async () => {
    const { output } = await session(["q"]);
    expect(output).toContain("\x1b[?1049h");
    expect(output).toContain("\x1b[?1049l");
    expect(output).toContain("\x1b[?25h"); // курсор вернули
  });

  it("переживает изменение размера окна", async () => {
    const term = pty!.spawn(process.execPath, [CLI, book], {
      name: "xterm-256color",
      cols: 100,
      rows: 24,
      cwd: dir,
      env: { ...process.env, XDG_DATA_HOME: join(dir, "data2") },
    });
    let output = "";
    term.onData((d) => {
      output += d;
    });
    const exited = new Promise<number>((done) => term.onExit(({ exitCode }) => done(exitCode)));
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await wait(400);
    const before = output.length;
    term.resize(60, 30);
    await wait(400);
    expect(output.length).toBeGreaterThan(before); // перерисовался
    term.write("q");
    expect(await exited).toBe(0);
  });

  it("запоминает позицию чтения между запусками", async () => {
    await session(["j", "j", "j", "j", "j", "q"]);
    const state = join(dir, "data", "fb2read", "positions.json");
    const data = JSON.parse(readFileSync(state, "utf-8")) as Record<
      string,
      { block?: number; hash?: string }
    >;
    const entry = Object.entries(data).find(([key]) => key !== "__settings__")?.[1];
    expect(entry?.block).toBeGreaterThan(0);
    expect(entry?.hash).toMatch(/^[0-9a-f]{64}$/); // отпечаток для синхронизации
  });

  it("показывает оглавление и уходит по нему в главу", async () => {
    const { output } = await session(["t", "j", "\r", "q"]);
    expect(output).toContain("Оглавление");
  });

  it("кириллица доходит до экрана и без UTF-8 локали", async () => {
    // LC_ALL=C — обычное дело в ssh, docker и cron; текст не должен
    // превращаться в вопросительные знаки.
    const { output } = await session(["q"], { rows: 24, cols: 100 }, { LC_ALL: "C", LANG: "C" });
    expect(output).toContain("Проверка читалки");
  });

  it("тема и интервал переживают выход и следующий запуск", async () => {
    await session(["c", "s", "q"]);
    const state = join(dir, "data", "fb2read", "positions.json");
    const settings = (
      JSON.parse(readFileSync(state, "utf-8")) as Record<string, Record<string, unknown>>
    )["__settings__"];
    expect(settings).toMatchObject({ spacing: 2 });
    expect(typeof settings!["theme"]).toBe("string");

    // Следующий запуск открывает книгу уже с этими настройками.
    const again = await session(["q"]);
    expect(again.code).toBe(0);
  });

  it("книга открывается на сохранённом месте", async () => {
    await session([" ", " ", " ", "q"]);
    const state = join(dir, "data", "fb2read", "positions.json");
    const data = JSON.parse(readFileSync(state, "utf-8")) as Record<string, { block?: number }>;
    const saved = Object.entries(data).find(([key]) => key !== "__settings__")?.[1];
    expect(saved?.block).toBeGreaterThan(0);

    // Второй запуск должен показать тот же кусок книги, а не начало.
    const { output } = await session(["q"]);
    expect(output).not.toContain("  0% ");
  });
});

describe.skipIf(!runnable)("библиотека в настоящем терминале", () => {
  it("открывает список каталога, читает книгу и возвращается", async () => {
    const shelf = join(dir, "полка");
    mkdirSync(shelf, { recursive: true });
    writeFileSync(join(shelf, "книга.fb2"), encodeLegacy(SAMPLE, "cp1251"));

    const term = pty!.spawn(process.execPath, [CLI, shelf], {
      name: "xterm-256color",
      cols: 90,
      rows: 20,
      cwd: dir,
      env: { ...process.env, XDG_DATA_HOME: join(dir, "libdata") },
    });
    let output = "";
    term.onData((d) => {
      output += d;
    });
    const exited = new Promise<number>((done) => term.onExit(({ exitCode }) => done(exitCode)));
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

    await wait(500);
    expect(output).toContain("Библиотека");
    term.write("\r"); // открыть книгу
    await wait(500);
    expect(output).toContain("Проверка читалки");
    term.write("q"); // назад к списку
    await wait(500);
    expect(output.lastIndexOf("Библиотека")).toBeGreaterThan(output.indexOf("Проверка читалки"));
    term.write("q"); // выйти совсем
    expect(await exited).toBe(0);
  });
});
