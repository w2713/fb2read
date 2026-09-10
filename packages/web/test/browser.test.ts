/**
 * Читалка в настоящем браузере.
 *
 * Разметка проверяется чистыми тестами, но собранная страница — это ещё и
 * модули, отдельный поток разбора и вёрстка. Подделывать тут нечего: если
 * Worker не соберётся или кодировка развалится, узнать об этом надо здесь, а
 * не с телефона.
 *
 * Берётся Chromium, установленный в среде. На iOS Safari свои правила, и его
 * этим не заменить — про это сказано в README отдельно.
 */

import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeLegacy } from "@fb2read/core";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(resolve(here, ".."), "dist");

/**
 * Где взять Chromium.
 *
 * В образе для разработки он уже стоит, но не той сборки, которую попросил бы
 * Playwright, — путь тогда указывается прямо. В CI браузер ставится обычным
 * способом, и подходит то, что Playwright нашёл сам.
 *
 * Если браузера нет вовсе, набор пропускается целиком, а не падает: сборку и
 * остальные тесты это не должно останавливать.
 */
function findChrome(): string | null {
  const inImage = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (existsSync(inImage)) return inImage;
  try {
    const own = chromium.executablePath();
    if (own && existsSync(own)) return own;
  } catch {
    // Playwright не знает, где браузер, — значит, его и нет.
  }
  return null;
}

const CHROME = findChrome();

/** Браузерным проверкам пяти секунд по умолчанию мало. */
const SLOW = 30_000;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

let browser: Browser;
let server: Server;
let base: string;

const BOOK_XML =
  '<?xml version="1.0" encoding="windows-1251"?>' +
  '<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">' +
  "<description><title-info>" +
  "<book-title>Анна Каренина</book-title>" +
  "<author><first-name>Лев</first-name><last-name>Толстой</last-name></author>" +
  "</title-info></description><body><section>" +
  "<title><p>Часть первая</p></title>" +
  "<p>Все счастливые семьи похожи друг на друга, каждая несчастливая " +
  "семья несчастлива <emphasis>по-своему</emphasis>.</p>" +
  "<p>Всё смешалось в доме Облонских.</p>" +
  "</section></body></FictionBook>";

/** Книга в cp1251: главная проверка на то, что кодировки не потерялись. */
function bookBytes(): Uint8Array {
  return encodeLegacy(BOOK_XML, "cp1251");
}

beforeAll(async () => {
  if (!existsSync(dist)) throw new Error("нет сборки — запустите pnpm --filter @fb2read/web build");

  server = createServer((request, response) => {
    const name = (request.url ?? "/").split("?")[0]!.replace("/fb2read/app/", "/");
    const file = join(dist, name === "/" ? "index.html" : name);
    // Сначала читаем, потом отвечаем: заголовки, ушедшие до неудачного
    // чтения, второй раз уже не переписать.
    let body: Buffer;
    try {
      body = readFileSync(file);
    } catch {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
    response.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/fb2read/app/`;

  browser = await chromium.launch({ executablePath: CHROME! });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => server.close(() => r()));
});

/**
 * Отдаёт книгу странице так, как это сделал бы проводник.
 *
 * File собирается прямо в странице, а не через setInputFiles: тот не умеет
 * передавать файлы с русскими именами — они просто не доезжают до страницы.
 * Заодно это ближе к жизни, где книги как раз называются по-русски.
 */
async function give(page: Page, name: string, bytes: Uint8Array): Promise<void> {
  await page.evaluate(
    ({ name, data }) => {
      const file = new File([new Uint8Array(data)], name);
      const carrier = new DataTransfer();
      carrier.items.add(file);
      const input = document.querySelector<HTMLInputElement>("#file")!;
      input.files = carrier.files;
      input.dispatchEvent(new Event("change"));
    },
    { name, data: [...bytes] },
  );
}

/** Открывает страницу и книгу, дожидаясь, пока её покажут. */
async function openBook(page: Page, name = "Анна Каренина.fb2", bytes = bookBytes()): Promise<void> {
  await page.goto(base);
  await give(page, name, bytes);
  await page.waitForSelector("#book:not([hidden])", { timeout: 20_000 });
}


/** Однопиксельная PNG: для проверки картинок важно не изображение, а байты. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/**
 * Длинная книга из двух частей.
 *
 * Короткая для проверки места не годится: она вся помещается на экран, и
 * прокручивать в ней нечего. Здесь же абзацев столько, что сороковой лежит
 * далеко за краем окна — как в настоящей книге.
 */
function longBook(withImage = false): Uint8Array {
  const part = (title: string, from: number) =>
    `<section><title><p>${title}</p></title>` +
    Array.from({ length: 60 }, (_, i) => `<p>Абзац номер ${from + i}.</p>`).join("") +
    "</section>";
  const xml =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" ' +
    'xmlns:l="http://www.w3.org/1999/xlink">' +
    "<description><title-info><book-title>Долгая книга</book-title>" +
    "</title-info></description><body>" +
    part("Часть первая", 1) +
    part("Часть вторая", 61) +
    (withImage ? '<section><p>Перед картинкой.</p><image l:href="#pic1"/></section>' : "") +
    "</body>" +
    (withImage ? `<binary id="pic1" content-type="image/png">${PNG_BASE64}</binary>` : "") +
    "</FictionBook>";
  return new TextEncoder().encode(xml);
}

/**
 * Книга со сноской.
 *
 * Примечания в FB2 лежат отдельным телом и попадают в конец книги — оттого
 * переход к сноске и есть настоящий переход, через всю книгу, а не на соседний
 * абзац.
 */
function noteBook(): Uint8Array {
  const xml =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" ' +
    'xmlns:l="http://www.w3.org/1999/xlink">' +
    "<description><title-info><book-title>Со сноской</book-title>" +
    "</title-info></description><body><section><title><p>Глава</p></title>" +
    '<p>Дуэль<a l:href="#n1" type="note">[1]</a> случилась в среду.</p>' +
    Array.from({ length: 60 }, (_, i) => `<p>Абзац номер ${i + 1}.</p>`).join("") +
    "</section></body>" +
    '<body name="notes"><section id="n1"><title><p>1</p></title>' +
    "<p>Примечание о дуэли.</p></section></body></FictionBook>";
  return new TextEncoder().encode(xml);
}

/** Записи о книгах из IndexedDB — целиком, вместе с закладками. */
async function savedRecords(page: Page): Promise<Array<{ block: number; bookmarks?: unknown[] }>> {
  return page.evaluate(
    () =>
      new Promise<Array<{ block: number; bookmarks?: unknown[] }>>((resolve) => {
        const request = indexedDB.open("fb2read");
        request.onerror = () => resolve([]);
        request.onsuccess = () => {
          try {
            const all = request.result.transaction("state", "readonly").objectStore("state").getAll();
            all.onerror = () => resolve([]);
            all.onsuccess = () => resolve(all.result as Array<{ block: number }>);
          } catch {
            // Хранилища ещё нет — значит, ничего и не записано.
            resolve([]);
          }
        };
      }),
  );
}

/**
 * Записанное место — тот ли это абзац.
 *
 * С точностью до соседнего: прокрутка ложится на целые пиксели, и абзац
 * оказывается то ровно у края, то на треть пикселя ниже. Который из двух
 * соседних записан — читателю всё равно, это одна и та же строка на экране.
 */
async function savedNear(page: Page, want: number): Promise<boolean> {
  const [block] = await savedBlocks(page);
  return block !== undefined && Math.abs(block - want) <= 1;
}

/** Что записано в IndexedDB о месте в книге. */
async function savedBlocks(page: Page): Promise<number[]> {
  return (await savedRecords(page)).map((record) => record.block);
}

/** Прокручивает к блоку так же, как это сделал бы читатель пальцем. */
async function scrollToBlock(page: Page, block: number): Promise<void> {
  await page.evaluate((n) => {
    const node = document.querySelector(`[data-block="${n}"]`)!;
    const panel = document.querySelector("#top")!.getBoundingClientRect().bottom;
    window.scrollBy(0, node.getBoundingClientRect().top - Math.max(panel, 0));
  }, block);
}

/**
 * Прокручивает к блоку и ждёт, пока читалка это заметит.
 *
 * Слежение за экраном идёт кадрами: сразу после прокрутки читалка ещё думает,
 * что читают прежнее место, и закладка встала бы не туда.
 */
async function readAt(page: Page, block: number): Promise<void> {
  const before = await page.textContent("#progress");
  await scrollToBlock(page, block);
  await page.waitForFunction(
    (was) => document.querySelector("#progress")!.textContent !== was,
    before,
    { timeout: 5000 },
  );
}

/**
 * Где сейчас верх блока относительно места для чтения.
 *
 * Не относительно окна: сверху висит панель, и абзац, оказавшийся под ней,
 * читателю не виден, сколько бы ни было ноль его координата.
 */
function blockTop(page: Page, block: number): Promise<number> {
  return page.evaluate((n) => {
    const node = document.querySelector(`[data-block="${n}"]`)!;
    const panel = document.querySelector("#top")!.getBoundingClientRect().bottom;
    return node.getBoundingClientRect().top - Math.max(panel, 0);
  }, block);
}

// Без браузера проверять нечего; молча делать вид, что всё хорошо, — нельзя,
// поэтому набор именно пропускается и это видно в отчёте.
describe.skipIf(!CHROME)("читалка в браузере", () => {
  it("открывает книгу в cp1251 под русским именем", async () => {
    const page = await browser.newPage();
    await openBook(page);

    const text = await page.textContent("#book");
    expect(text).toContain("Все счастливые семьи похожи");
    expect(text).toContain("Всё смешалось в доме Облонских");
    await page.close();
  }, SLOW);

  it("заголовок книги попадает в заголовок вкладки", async () => {
    const page = await browser.newPage();
    await openBook(page);
    expect(await page.title()).toContain("Анна Каренина");
    await page.close();
  }, SLOW);

  it("на каждом абзаце стоит его номер: по нему хранится позиция", async () => {
    const page = await browser.newPage();
    await openBook(page);
    const blocks = await page.$$eval("#book [data-block]", (nodes) =>
      nodes.map((n) => Number(n.getAttribute("data-block"))),
    );
    expect(blocks.length).toBeGreaterThan(2);
    // Номера идут подряд с нуля — иначе позиция из терминала указала бы не туда.
    expect(blocks).toEqual(blocks.map((_, i) => i));
    await page.close();
  }, SLOW);

  it("начертание становится настоящей разметкой", async () => {
    const page = await browser.newPage();
    await openBook(page);
    expect(await page.textContent("#book em")).toBe("по-своему");
    await page.close();
  }, SLOW);

  it("заголовок раздела — настоящий заголовок, а не абзац", async () => {
    const page = await browser.newPage();
    await openBook(page);
    const headings = await page.$$eval("#book h1, #book h2, #book h3", (n) =>
      n.map((h) => h.textContent),
    );
    expect(headings.join(" ")).toContain("Часть первая");
    await page.close();
  }, SLOW);

  it("разбор идёт в отдельном потоке, а не в основном", async () => {
    // Иначе большая книга морозила бы страницу, и на телефоне это выглядит
    // как зависшее приложение.
    const page = await browser.newPage();
    const workers: string[] = [];
    page.on("worker", (w) => workers.push(w.url()));
    await openBook(page);
    expect(workers.length).toBeGreaterThan(0);
    await page.close();
  }, SLOW);

  it("битый файл не роняет страницу, а объясняется", async () => {
    const page = await browser.newPage();
    const crashes: string[] = [];
    page.on("pageerror", (e) => crashes.push(e.message));

    await page.goto(base);
    await give(page, "битая.fb2", new TextEncoder().encode("это вообще не книга"));
    await page.waitForSelector(".failure", { timeout: 20_000 });

    expect(await page.textContent(".failure")).toContain("битая.fb2");
    expect(crashes).toEqual([]);
    await page.close();
  }, SLOW);

  it("текст книги не выполняется как разметка", async () => {
    // Книга — чужой файл. Без экранирования она бы распоряжалась страницей.
    const nasty = new TextEncoder().encode(
      '<?xml version="1.0" encoding="utf-8"?>' +
        '<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">' +
        "<description><title-info><book-title>Проба</book-title></title-info></description>" +
        "<body><section><p>&lt;img src=x onerror=&quot;window.__beda=1&quot;&gt;</p>" +
        "</section></body></FictionBook>",
    );
    const page = await browser.newPage();
    await openBook(page, "вредная.fb2", nasty);

    expect(
      await page.evaluate(() => (window as unknown as { __beda?: number }).__beda),
    ).toBeUndefined();
    expect(await page.$("#book img")).toBeNull();
    expect(await page.textContent("#book")).toContain("<img src=x");
    await page.close();
  }, SLOW);

  it("книга открывается там, где её бросили", async () => {
    // Ради этого всё и затевалось: читалка, забывающая место, — не читалка.
    const page = await browser.newPage();
    await openBook(page, "Долгая книга.fb2", longBook());
    await scrollToBlock(page, 40);
    await page.waitForFunction(
      () => document.querySelector("#progress")!.textContent !== "",
      undefined,
      { timeout: 20_000 },
    );
    await expect.poll(() => savedNear(page, 40), { timeout: 10_000 }).toBe(true);
    const saved = (await savedBlocks(page))[0]!;

    await page.reload();
    await give(page, "Долгая книга.fb2", longBook());
    await page.waitForSelector("#book:not([hidden])", { timeout: 20_000 });

    // Не «примерно туда»: записанный абзац стоит ровно у края места для чтения,
    // а не под панелью и не экраном ниже.
    expect(Math.abs(await blockTop(page, saved))).toBeLessThan(5);
    await page.close();
  }, SLOW);

  it("уход со страницы записывает место немедленно", async () => {
    // На iOS вкладку закрывают, не спрашивая, и ждать придержки нельзя.
    const page = await browser.newPage();
    await openBook(page, "Долгая книга.fb2", longBook());
    await readAt(page, 20);
    await expect.poll(() => savedNear(page, 20), { timeout: 10_000 }).toBe(true);
    const first = (await savedBlocks(page))[0]!;

    // Второе движение придержка откладывает почти на секунду.
    await readAt(page, 90);

    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    // Срок нарочно короче придержки, и весь отрезок от записи двадцатого блока
    // укладывается в неё же: дождаться таймера — не то же самое, что записать
    // при уходе, и такую подмену эта проверка должна замечать.
    await expect
      .poll(async () => (await savedBlocks(page))[0] !== first, { timeout: 400, interval: 25 })
      .toBe(true);
    expect(await savedNear(page, 90)).toBe(true);
    await page.close();
  }, SLOW);

  it("выбранная тема переживает перезагрузку", async () => {
    const page = await browser.newPage();
    await openBook(page, "Долгая книга.fb2", longBook());
    await page.click("#theme");
    const chosen = await page.getAttribute("html", "data-theme");
    expect(chosen).toBe("night");

    await page.reload();
    await page.waitForFunction(
      () => document.documentElement.getAttribute("data-theme") === "night",
      undefined,
      { timeout: 20_000 },
    );
    await page.close();
  }, SLOW);

  it("оглавление уносит в нужную главу", async () => {
    const page = await browser.newPage();
    await openBook(page, "Долгая книга.fb2", longBook());
    await page.click("#toc-toggle");
    const titles = await page.$$eval("#toc button", (nodes) => nodes.map((n) => n.textContent));
    expect(titles).toEqual(["Часть первая", "Часть вторая"]);

    await page.$$eval("#toc button", (nodes) => (nodes[1] as HTMLElement).click());
    // Уйдя по строке, оглавление закрывается: читать сквозь него нельзя.
    await page.waitForFunction(() => document.querySelector("#toc")!.hasAttribute("hidden"));
    const where = await page.evaluate(() => {
      const heads = [...document.querySelectorAll("#book h1, #book h2, #book h3")];
      const second = heads.find((h) => h.textContent === "Часть вторая")!;
      const panel = document.querySelector("#top")!.getBoundingClientRect().bottom;
      return second.getBoundingClientRect().top - Math.max(panel, 0);
    });
    expect(Math.abs(where)).toBeLessThan(5);
    await page.close();
  }, SLOW);

  it("картинка разворачивается только когда до неё дошли", async () => {
    // Иначе книга с иллюстрациями съедала бы десятки мегабайт памяти ещё до
    // того, как читатель увидел первую из них.
    const page = await browser.newPage();
    await openBook(page, "С картинкой.fb2", longBook(true));

    const src = () => page.getAttribute("#book img", "src");
    expect(await src()).toBeNull();

    await page.evaluate(() => document.querySelector("#book img")!.scrollIntoView());
    await expect.poll(src, { timeout: 10_000 }).toMatch(/^blob:/);
    await page.close();
  }, SLOW);

  it("поиск находит и показывает найденное", async () => {
    const page = await browser.newPage();
    await openBook(page, "Долгая книга.fb2", longBook());

    await page.click("#find-toggle");
    await page.fill("#q", "номер 90.");
    await page.press("#q", "Enter");

    await page.waitForSelector("#book mark.found", { timeout: 10_000 });
    expect(await page.textContent("#book mark.found")).toBe("номер 90.");
    expect(await page.textContent("#find-count")).toContain("1 из 1");

    // Найденное не просто помечено, а показано: искали, чтобы прочитать.
    const where = await page.evaluate(() => {
      const panel = document.querySelector("#top")!.getBoundingClientRect().bottom;
      return document.querySelector("#book mark.found")!.getBoundingClientRect().top -
        Math.max(panel, 0);
    });
    // Найденное не должно оказаться под панелью поиска: его для того и искали.
    expect(where).toBeGreaterThan(-1);
    expect(where).toBeLessThan(await page.evaluate(() => window.innerHeight));
    await page.close();
  }, SLOW);

  it("«дальше» обходит совпадения по кругу", async () => {
    const page = await browser.newPage();
    await openBook(page, "Долгая книга.fb2", longBook());

    await page.click("#find-toggle");
    await page.fill("#q", "Часть");
    await page.press("#q", "Enter");
    expect(await page.textContent("#find-count")).toContain("совпадение 1 из 2");

    await page.click("#find-next");
    expect(await page.textContent("#find-count")).toContain("совпадение 2 из 2");
    expect(await page.textContent("#book mark.found")).toBe("Часть");

    // С последнего — снова первое, и об этом сказано вслух: молча показать то
    // же самое значит убедить читателя, что поиск сломался.
    await page.click("#find-next");
    expect(await page.textContent("#find-count")).toContain("поиск с начала");

    // Подсветка одна на всю книгу, а не по одной от каждого перехода.
    expect(await page.$$eval("#book mark.found", (n) => n.length)).toBe(1);
    await page.close();
  }, SLOW);

  it("ничего не найдено — так и сказано, книга на месте", async () => {
    const page = await browser.newPage();
    await openBook(page, "Долгая книга.fb2", longBook());
    await page.click("#find-toggle");
    await page.fill("#q", "тарабарщина");
    await page.press("#q", "Enter");
    expect(await page.textContent("#find-count")).toContain("не найдено");
    expect(await page.$("#book mark.found")).toBeNull();
    await page.close();
  }, SLOW);

  it("закладка переживает перезагрузку", async () => {
    const page = await browser.newPage();
    await openBook(page, "Долгая книга.fb2", longBook());
    await readAt(page, 40);
    await page.click("#mark");

    const at = await page.$eval("#book .marked", (n) => Number(n.getAttribute("data-block")));
    expect(Math.abs(at - 40)).toBeLessThanOrEqual(1);
    expect(await page.textContent("#mark")).toBe("★");

    await page.reload();
    await give(page, "Долгая книга.fb2", longBook());
    await page.waitForSelector("#book:not([hidden])", { timeout: 20_000 });

    await page.waitForSelector(`[data-block="${at}"].marked`, { timeout: 10_000 });
    await page.click("#marks-toggle");
    const items = await page.$$eval("#mark-list .mark-go", (n) => n.map((b) => b.textContent));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatch(/Абзац номер \d+\./);
    await page.close();
  }, SLOW);

  it("снятая закладка оставляет надгробие, а не исчезает", async () => {
    // Исчезни она — при следующей синхронизации её вернуло бы устройство,
    // которое о снятии не знает, и снять её стало бы нельзя вовсе.
    const page = await browser.newPage();
    await openBook(page, "Долгая книга.fb2", longBook());
    await readAt(page, 12);
    await page.click("#mark");
    const at = await page.$eval("#book .marked", (n) => Number(n.getAttribute("data-block")));
    await page.click("#marks-toggle");
    await page.click("#mark-list .mark-drop");

    expect(await page.$("#book .marked")).toBeNull();
    expect(await page.$("#mark-list .mark-go")).toBeNull();

    await expect
      .poll(async () => (await savedRecords(page))[0]?.bookmarks, { timeout: 10_000 })
      .toEqual([expect.objectContaining({ block: at, deleted: true })]);
    await page.close();
  }, SLOW);

  it("сноска уносит к примечанию и возвращает обратно", async () => {
    const page = await browser.newPage();
    await openBook(page, "Со сноской.fb2", noteBook());

    const marker = await page.textContent("#book a.note");
    expect(marker).toBe("[1]");
    // Абзац со сноской — второй блок книги; к нему и надо вернуться.
    await page.click("#book a.note");

    // Примечание — последний блок книги, и к верхнему краю его не подтянуть:
    // ниже просто ничего нет. Спрашивается поэтому то, что и нужно читателю, —
    // видно ли его на экране.
    const seen = await page.evaluate(() => {
      const all = [...document.querySelectorAll("#book [data-block]")];
      const note = all.find((n) => n.textContent === "Примечание о дуэли.")!;
      const panel = document.querySelector("#top")!.getBoundingClientRect().bottom;
      return {
        top: note.getBoundingClientRect().top - Math.max(panel, 0),
        screen: window.innerHeight,
        gone: window.scrollY,
      };
    });
    expect(seen.top).toBeGreaterThanOrEqual(0);
    expect(seen.top).toBeLessThan(seen.screen);
    // И что это был переход через книгу, а не пара абзацев вниз.
    expect(seen.gone).toBeGreaterThan(100);

    await page.click("#back");
    // Читали в самом начале книги, и вернуться надо туда же: абзац со сноской
    // снова на экране, а книга — снова у начала.
    const home = await page.evaluate(() => {
      const panel = document.querySelector("#top")!.getBoundingClientRect().bottom;
      return {
        top: document.querySelector('[data-block="1"]')!.getBoundingClientRect().top -
          Math.max(panel, 0),
        screen: window.innerHeight,
        gone: window.scrollY,
      };
    });
    expect(home.top).toBeGreaterThanOrEqual(0);
    expect(home.top).toBeLessThan(home.screen);
    expect(home.gone).toBeLessThan(seen.gone / 2);
    // Возвращаться больше некуда — кнопка уходит.
    expect(await page.getAttribute("#back", "hidden")).not.toBeNull();
    await page.close();
  }, SLOW);

  it("после прокрутки на страницу место то самое, что наверху экрана", async () => {
    // Обычное чтение — это прокрутка на экран, при которой половина абзацев с
    // экрана не уходит. Наблюдатель о них молчит, и читалка, верившая
    // запомненным числам, считала текущим абзац на экран ниже настоящего:
    // книга открывалась не там, где её бросили, и закладка вставала не туда.
    const page = await browser.newPage();
    await openBook(page, "Долгая книга.fb2", longBook());
    await readAt(page, 12);

    const saved = (await savedBlocks(page))[0];
    expect(saved).toBeDefined();

    // Спрашивается не номер, а место: записанный абзац должен стоять у верхнего
    // края экрана. Который именно из двух соседних — дело вкуса и округления;
    // абзац на экран ниже — уже потерянное место. С прежней ошибкой сюда
    // попадал двадцатый, в двухстах пикселях ниже края.
    const where = await blockTop(page, saved!);
    expect(where).toBeLessThan(40);
    expect(where).toBeGreaterThan(-100);
    await page.close();
  }, SLOW);

  it("клавиши те же, что в терминале", async () => {
    const page = await browser.newPage();
    await openBook(page, "Долгая книга.fb2", longBook());

    await page.keyboard.press("/");
    await page.waitForSelector("#find:not([hidden])", { timeout: 5000 });
    // Свой поиск, а не браузерный: тот ищет лишь в показанном куске книги.
    expect(await page.inputValue("#q")).toBe("");

    await page.keyboard.press("Escape");
    await page.waitForSelector("#panel", { state: "hidden", timeout: 5000 });

    await readAt(page, 30);
    await page.keyboard.press("M");
    await page.waitForSelector('[data-block="30"].marked, [data-block="29"].marked', {
      timeout: 5000,
    });
    await page.close();
  }, SLOW);

  it("набор в поле поиска не считается командами", async () => {
    // В запросе есть «t», «o» и «n» — каждая из них по книге что-нибудь делает.
    // Срабатывай они при наборе, искать было бы нельзя вовсе.
    const page = await browser.newPage();
    await openBook(page, "Долгая книга.fb2", longBook());
    await page.click("#find-toggle");
    await page.type("#q", "тонна");

    expect(await page.inputValue("#q")).toBe("тонна");
    expect(await page.$("#find:not([hidden])")).not.toBeNull();
    expect(await page.$("#toc:not([hidden])")).toBeNull();
    expect(await page.$("#book .marked")).toBeNull();
    await page.close();
  }, SLOW);
});
