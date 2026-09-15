/**
 * Поиск по всей библиотеке в терминале.
 *
 * В браузере он появился раньше, и правила у них общие — они лежат в ядре.
 * Здесь проверяется терминальная половина: экран находок и то, что выбор на
 * нём открывает ту самую книгу на том самом месте.
 *
 * Книги настоящие и лежат на диске: перебор — это разбор каждой из них, и
 * подделать тут нечего.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonFileStore } from "../src/store.js";
import { runLibrary, searchQueue } from "../src/ui/library.js";
import type { ChooserEntry } from "../src/ui/chooser.js";
import { FakeTerminal } from "./harness.js";

let dir: string;
let store: JsonFileStore;

/** Книга, в которой искомое встречается через каждые `every` абзацев. */
function книга(title: string, author: string, every: number, count = 200): string {
  let body = "";
  for (let i = 1; i <= count; i += 1) {
    const нашлось = every && i % every === 0 ? " старая мельница" : "";
    body += `<p>Абзац номер ${i}. слово слово слово${нашлось}.</p>`;
  }
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">' +
    `<description><title-info><book-title>${title}</book-title>` +
    `<author><last-name>${author}</last-name></author></title-info></description>` +
    `<body><section>${body}</section></body></FictionBook>`
  );
}

function положить(имя: string, title: string, author: string, every: number, count = 200): string {
  const path = join(dir, имя);
  writeFileSync(path, книга(title, author, every, count));
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fb2read-find-"));
  store = new JsonFileStore(join(dir, "positions.json"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Библиотека на поддельном терминале: список книг уже на экране. */
async function библиотека(entries: ChooserEntry[], rows = 24, columns = 80) {
  const terminal = new FakeTerminal(rows, columns);
  const running = runLibrary(terminal, {
    entries,
    prefs: {
      theme: "night",
      spacing: 1,
      columns: 1,
      images: "off",
      mouse: false,
      justify: false,
      hyphens: false,
      width: 80,
      keys: {},
    },
    store,
    fromStart: false,
    exportBookmarks: () => "",
  });
  await terminal.drain();
  const press = async (...sequences: string[]): Promise<void> => {
    terminal.send(...sequences);
    await new Promise((resolve) => setImmediate(resolve));
    await terminal.drain();
  };
  /** Ждёт, пока на экране появится нужное: перебор идёт своим ходом. */
  const ждать = async (text: string): Promise<void> => {
    for (let i = 0; i < 400; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      await terminal.drain();
      if (terminal.lines().some((line) => line.includes(text))) return;
    }
    throw new Error(`не дождались «${text}»; на экране:\n${terminal.lines().join("\n")}`);
  };
  return { terminal, running, press, ждать };
}

const ENTER = "\r";

describe("поиск по всей библиотеке", () => {
  it("находит в нескольких книгах и раскладывает находки по книгам", async () => {
    const полка: ChooserEntry[] = [
      { path: положить("a.fb2", "Обломов", "Гончаров", 0), title: "Обломов", author: "Гончаров", percent: null },
      { path: положить("b.fb2", "Ревизор", "Гоголь", 50), title: "Ревизор", author: "Гоголь", percent: null },
      { path: положить("c.fb2", "Бесы", "Достоевский", 80), title: "Бесы", author: "Достоевский", percent: null },
    ];
    const ui = await библиотека(полка);
    await ui.press("/");
    await ui.press("старая мельница", ENTER);
    await ui.ждать("q — назад");

    const экран = ui.terminal.lines().join("\n");
    // Заголовок — с запросом, и только те книги, где искомое и правда есть.
    expect(ui.terminal.line(0)).toContain("Поиск: старая мельница");
    expect(экран).toContain("Гоголь — Ревизор");
    expect(экран).toContain("Достоевский — Бесы");
    expect(экран).not.toContain("Гончаров — Обломов");
    // Четыре находки в «Ревизоре» и две в «Бесах».
    expect(экран).toContain("нашлось 6");
    // Выдержка — с процентом по книге и текстом вокруг совпадения. Проценты
    // настоящие: в «Ревизоре» двести абзацев, а искомое в каждом пятидесятом,
    // то есть на четверти, половине, трёх четвертях и в самом конце.
    expect(экран).toMatch(/\d+%\s+.*старая мельница/);
    const проценты = экран
      .split("\n")
      .map((line) => /^\s+(\d+)%/.exec(line)?.[1])
      .filter(Boolean);
    expect(проценты).toContain("25");
    expect(проценты).toContain("50");
    expect(проценты).toContain("100");

    await ui.press("q");
    await ui.press("q");
    await ui.running;
  }, 30_000);

  it("находка открывает книгу на своём месте", async () => {
    const полка: ChooserEntry[] = [
      { path: положить("b.fb2", "Ревизор", "Гоголь", 50), title: "Ревизор", author: "Гоголь", percent: null },
    ];
    // Одна книга поиска по библиотеке не знает — кладём вторую, пустую.
    полка.push({
      path: положить("a.fb2", "Обломов", "Гончаров", 0),
      title: "Обломов",
      author: "Гончаров",
      percent: null,
    });

    const ui = await библиотека(полка);
    await ui.press("/");
    await ui.press("мельница", ENTER);
    // Ждём конца перебора: пока он идёт, внизу «esc — прекратить».
    await ui.ждать("q — назад");
    await ui.press(ENTER);
    await ui.ждать("Абзац номер 50.");

    // Первая находка в «Ревизоре» — пятидесятый абзац, и книга открылась
    // именно на нём, а не на запомненном месте.
    const экран = ui.terminal.lines();
    expect(экран.findIndex((line) => line.includes("Абзац номер 50."))).toBeLessThan(4);

    await ui.press("q");
    await ui.press("q");
    await ui.running;
  }, 30_000);

  it("чего нет ни в одной книге — так и сказано", async () => {
    const полка: ChooserEntry[] = [
      { path: положить("a.fb2", "Обломов", "Гончаров", 0), title: "Обломов", author: "Гончаров", percent: null },
      { path: положить("b.fb2", "Бесы", "Достоевский", 0), title: "Бесы", author: "Достоевский", percent: null },
    ];
    const ui = await библиотека(полка);
    await ui.press("/");
    await ui.press("мельница", ENTER);
    await ui.ждать("ничего не нашлось");

    expect(ui.terminal.lines().join("\n")).not.toContain("%");
    await ui.press("q");
    await ui.press("q");
    await ui.running;
  }, 30_000);

  it("битая книга не обрывает перебор по остальным", async () => {
    const битая = join(dir, "битая.fb2");
    writeFileSync(битая, "это вообще не книга");
    const полка: ChooserEntry[] = [
      { path: битая, title: "Битая", author: "", percent: null },
      { path: положить("b.fb2", "Ревизор", "Гоголь", 50), title: "Ревизор", author: "Гоголь", percent: null },
    ];
    const ui = await библиотека(полка);
    await ui.press("/");
    await ui.press("мельница", ENTER);
    await ui.ждать("q — назад");

    expect(ui.terminal.lines().join("\n")).toContain("Гоголь — Ревизор");
    await ui.press("q");
    await ui.press("q");
    await ui.running;
  }, 30_000);

  it("курсор ходит по находкам, а не по заголовкам книг", async () => {
    const полка: ChooserEntry[] = [
      { path: положить("b.fb2", "Ревизор", "Гоголь", 50), title: "Ревизор", author: "Гоголь", percent: null },
      { path: положить("c.fb2", "Бесы", "Достоевский", 80), title: "Бесы", author: "Достоевский", percent: null },
    ];
    const ui = await библиотека(полка);
    await ui.press("/");
    await ui.press("мельница", ENTER);
    await ui.ждать("q — назад");

    /** Какая строка выделена обращением цветов. */
    const выделена = (): string => {
      for (let row = 1; row < 23; row += 1) {
        if (ui.terminal.style(row, 3).inverse) return ui.terminal.line(row);
      }
      return "";
    };

    // Под курсором сразу первая находка, а не заголовок книги: за ней и шли.
    expect(выделена()).toMatch(/\d+%/);
    // Шесть нажатий вниз проходят четыре находки «Ревизора» и упираются во
    // вторую книгу — и ни разу не останавливаются на её заголовке.
    for (let i = 0; i < 6; i += 1) {
      await ui.press("j");
      expect(выделена()).toMatch(/\d+%/);
    }

    await ui.press("q");
    await ui.press("q");
    await ui.running;
  }, 30_000);

  it("перебор можно прекратить, не дожидаясь конца", async () => {
    const полка: ChooserEntry[] = [
      { path: положить("b.fb2", "Ревизор", "Гоголь", 50), title: "Ревизор", author: "Гоголь", percent: null },
      // Книга нарочно огромная: пока она разбирается, «прекратить» и нажимают.
      // Шестьдесят тысяч абзацев — это около семисот миллисекунд разбора
      // (измерено), и на двенадцати тысячах окна не хватало: в CI на macOS
      // нажатие успевало прийти уже после третьей книги, и проверка краснела
      // на ровном месте.
      {
        path: положить("big.fb2", "Долгая", "Автор", 0, 60_000),
        title: "Долгая",
        author: "Автор",
        percent: null,
      },
      { path: положить("c.fb2", "Бесы", "Достоевский", 80), title: "Бесы", author: "Достоевский", percent: null },
    ];
    const ui = await библиотека(полка);
    await ui.press("/");
    await ui.press("мельница", ENTER);
    // Первая книга просмотрена — значит, перебор идёт и добрался до долгой.
    await ui.ждать("просмотрено 1 из 3");
    await ui.press("\x1b");
    await ui.ждать("остановлено");

    const экран = ui.terminal.lines().join("\n");
    // Найденное до остановки осталось на экране: за ним и шли.
    expect(экран).toContain("Гоголь — Ревизор");
    // А до третьей книги перебор не дошёл.
    expect(экран).not.toContain("Достоевский — Бесы");

    // Первое «q» уходит с находок, второе закрывает список книг.
    await ui.press("q");
    await ui.press("q");
    await ui.running;
  }, 30_000);

  it("книги с сервера в перебор не берутся: их тут нет", async () => {
    // Правило проверяется отдельно от экрана: на экране разница видна только
    // в счёте просмотренных, а он мелькает и пропадает — книга разбирается
    // быстрее, чем проверка успевает посмотреть.
    const полка: ChooserEntry[] = [
      { path: "/книги/есть.fb2", title: "Есть", author: "", percent: null },
      { path: "", title: "Только на сервере", author: "", percent: null, remote: "a".repeat(64) },
      // Запись без пути и без облака: такой в списке взяться неоткуда, но
      // открывать её всё равно нечем.
      { path: "", title: "Ниоткуда", author: "", percent: null },
    ];
    expect(searchQueue(полка).map((entry) => entry.title)).toEqual(["Есть"]);
  });

  it("из книги, где искомое на каждой странице, показывают начало и остаток", async () => {
    // Иначе одна такая книга завалила бы экран тысячей строк, и остальные
    // книги читатель просто не увидел бы.
    const полка: ChooserEntry[] = [
      {
        path: положить("big.fb2", "Долгая", "Автор", 100, 12_000),
        title: "Долгая",
        author: "Автор",
        percent: null,
      },
      { path: положить("c.fb2", "Бесы", "Достоевский", 80), title: "Бесы", author: "Достоевский", percent: null },
    ];
    const ui = await библиотека(полка, 40);
    await ui.press("/");
    await ui.press("мельница", ENTER);
    await ui.ждать("q — назад");

    const экран = ui.terminal.lines();
    // Двадцать выдержек из ста двадцати, и честный хвост под ними.
    expect(экран.filter((line) => /^\s+\d+%/.test(line))).toHaveLength(22);
    expect(экран.join("\n")).toContain("…и ещё 100");
    // А вторая книга при этом не потерялась: остаток её не вытеснил.
    expect(экран.join("\n")).toContain("Достоевский — Бесы");

    await ui.press("q");
    await ui.press("q");
    await ui.running;
  }, 30_000);

  it("облачная книга не появляется среди находок", async () => {
    const полка: ChooserEntry[] = [
      { path: положить("b.fb2", "Ревизор", "Гоголь", 50), title: "Ревизор", author: "Гоголь", percent: null },
      { path: "", title: "Только на сервере", author: "Автор", percent: null, remote: "a".repeat(64) },
    ];
    const ui = await библиотека(полка);
    await ui.press("/");
    await ui.press("мельница", ENTER);
    await ui.ждать("q — назад");

    expect(ui.terminal.lines().join("\n")).not.toContain("Только на сервере");
    expect(ui.terminal.lines().join("\n")).toContain("нашлось 4");

    await ui.press("q");
    await ui.press("q");
    await ui.running;
  }, 30_000);
});
