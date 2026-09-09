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
});
