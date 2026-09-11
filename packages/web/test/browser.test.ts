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
  ".png": "image/png",
  ".svg": "image/svg+xml",
  // Без этого типа Chromium отказывается считать манифест манифестом, и
  // установка на домашний экран не предлагается вовсе.
  ".webmanifest": "application/manifest+json",
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

  if (CHROME) browser = await chromium.launch({ executablePath: CHROME });
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
  await settled(page);
}


/**
 * Высокая PNG: 600×3000, впятеро выше своей ширины.
 *
 * Размер настоящий, а не условный, и это выяснилось поломкой: сперва здесь
 * лежала картинка 2×12, и проверка проходила впустую при любом коде. `max-width`
 * ширину только ограничивает, а не растягивает — крошечная картинка рисовалась
 * в свои двенадцать пикселей и влезала в колонку сама собой. Чтобы проверять
 * предел по высоте, картинка должна быть шире колонки.
 */
const TALL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAlgAAAu4CAIAAACy2FHaAAAjTUlEQVR42uzVMQEAAACCMOMb2yBuEXhIAeBYJADACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAEwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgCMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBMAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIATBCCQAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgAwQgCMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBMAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIATBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCAIxQAgCMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBMAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIATBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQACOUAAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBMAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIATBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEwAglAMAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIAcAIATBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBMEIJADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCADBCAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAjFACAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAI5QAACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEACMEwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwTACCUAwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBwAgBMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAjBAAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwQAIwTACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAHACAEwQgkAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEIAMEJg7dUxDQAAAICg/q3t4SCCj4ARAoARAoARAoARAoARAoARAoARAoARAoARAoARAoARAoARAoARAoARAoARAoARAoARAoARAoARAoARAoARAoARAoARAoARAoARAoARAoARAoARAmCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECYIQSAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEAGCEABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAYIQAGKEEABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghABghAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIAEYIgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECgBECYIQAYIQAYIQAYIQAYIQAYIQA8Be3gp65FBVj7AAAAABJRU5ErkJggg==";

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
 * Книга настоящего размера.
 *
 * «Долгая книга» в сто двадцать абзацев для ленивой вёрстки мала: она почти
 * целиком помещается в те несколько экранов, которые браузер верстает и так, и
 * разницы между ленивой вёрсткой и полной на ней не видно. Настоящая книга —
 * это тысячи абзацев, и вся затея ради них.
 *
 * Абзацы разной длины и называют сами себя: по тексту видно, тот ли это абзац,
 * за номер которого он себя выдаёт.
 */
function bigBook(count: number): Uint8Array {
  const слова =
    "Все счастливые семьи похожи друг на друга каждая несчастливая семья несчастлива по своему".split(
      " ",
    );
  const абзацы: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const длина = 25 + (i % 40);
    const текст: string[] = [];
    for (let k = 0; k < длина; k += 1) текст.push(слова[(i + k) % слова.length]!);
    абзацы.push(`<p>Абзац номер ${i}. ${текст.join(" ")}</p>`);
  }
  return new TextEncoder().encode(
    '<?xml version="1.0" encoding="utf-8"?>' +
      '<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">' +
      "<description><title-info><book-title>Большая книга</book-title>" +
      "</title-info></description><body>" +
      `<section><title><p>Часть первая</p></title>${абзацы.slice(0, count / 2).join("")}</section>` +
      `<section><title><p>Часть вторая</p></title>${абзацы.slice(count / 2).join("")}</section>` +
      "</body></FictionBook>",
  );
}

/** Долгая книга, в конце которой высокая картинка. */
function tallImageBook(): Uint8Array {
  const xml =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" ' +
    'xmlns:l="http://www.w3.org/1999/xlink">' +
    "<description><title-info><book-title>С картинкой</book-title>" +
    "</title-info></description><body>" +
    '<section><title><p>Часть первая</p></title>' +
    Array.from({ length: 40 }, (_, i) => `<p>Абзац номер ${i + 1}.</p>`).join("") +
    '<p>Перед картинкой.</p><image l:href="#pic1"/>' +
    "</section></body>" +
    `<binary id="pic1" content-type="image/png">${TALL_PNG_BASE64}</binary></FictionBook>`;
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

/** Блоки закладок, действительно записанных в хранилище. */
async function savedMarks(page: Page): Promise<number[]> {
  const [record] = await savedRecords(page);
  const marks = (record?.bookmarks ?? []) as { block: number; deleted?: boolean }[];
  return marks.filter((mark) => !mark.deleted).map((mark) => mark.block);
}

/**
 * Что записано в IndexedDB о настройках читалки.
 *
 * Нужно, чтобы отличить «настройка не сохраняется» от «не успела сохраниться»:
 * запись идёт своим чередом после нажатия, и перезагрузка, случившаяся раньше
 * неё, потеряет настройку, сколько бы та ни была верна.
 */
async function savedSettings(page: Page): Promise<{ text?: number; columns?: number }> {
  return page.evaluate(
    () =>
      new Promise<{ text?: number; columns?: number }>((resolve) => {
        const request = indexedDB.open("fb2read");
        request.onerror = () => resolve({});
        request.onsuccess = () => {
          try {
            const one = request.result
              .transaction("settings", "readonly")
              .objectStore("settings")
              .get("reader");
            one.onerror = () => resolve({});
            one.onsuccess = () => resolve((one.result as { text?: number; columns?: number }) ?? {});
          } catch {
            // Хранилища ещё нет — значит, ничего и не записано.
            resolve({});
          }
        };
      }),
  );
}

/** Что записано в IndexedDB о месте в книге. */
async function savedBlocks(page: Page): Promise<number[]> {
  return (await savedRecords(page)).map((record) => record.block);
}

/**
 * Ждёт, пока страница устоится.
 *
 * Вёрстка ленивая: высоты абзацев, до которых читатель не дошёл, сперва
 * угаданы, а потом уточняются, и высота страницы несколько кадров гуляет.
 * Пока она гуляет, читалка придерживает место — и мерить в этот миг значит
 * мерить то, чего читатель никогда не видел: снятый с экрана снимок в этот
 * момент ещё вовсе пуст.
 *
 * Потолок больше, чем у самой придержки: иначе проверка отвернулась бы раньше,
 * чем читалка перестала поправлять.
 */
async function settled(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        let было = -1;
        let тихих = 0;
        const начало = performance.now();
        const кадр = (): void => {
          const высота = document.documentElement.scrollHeight;
          тихих = высота === было ? тихих + 1 : 0;
          было = высота;
          if (тихих >= 3 || performance.now() - начало > 2500) done();
          else requestAnimationFrame(кадр);
        };
        requestAnimationFrame(кадр);
      }),
  );
}

/**
 * Ставит читателя на блок и оставляет его там.
 *
 * Одной прокрутки мало: вёрстка ленивая, и высоты абзацев над местом чтения
 * уточняются уже после прыжка — блок уезжает из-под читателя. В самой читалке
 * за этим следит придержка (`hold.ts`), но она включается на её собственных
 * переходах, а не на прокрутке из проверки. Поэтому здесь то же самое делается
 * руками: прокрутить, дать устояться, поправить — пока не встанет.
 */
async function scrollToBlock(page: Page, block: number): Promise<void> {
  const край = async (): Promise<number> =>
    page.evaluate((n) => {
      const node = document.querySelector(`[data-block="${n}"]`)!;
      const panel = document.querySelector("#top")!.getBoundingClientRect().bottom;
      const top = node.getBoundingClientRect().top - Math.max(panel, 0);
      window.scrollBy(0, top);
      return top;
    }, block);

  for (let попытка = 0; попытка < 8; попытка += 1) {
    await край();
    await settled(page);
    // Ещё раз: устоявшись, страница могла сдвинуться под читателем.
    if (Math.abs(await край()) <= 1) return;
  }
}

/**
 * Прокручивает к блоку и ждёт, пока читалка это заметит.
 *
 * Слежение за экраном идёт кадрами: сразу после прокрутки читалка ещё думает,
 * что читают прежнее место, и закладка встала бы не туда.
 */
async function readAt(page: Page, block: number): Promise<void> {
  await scrollToBlock(page, block);
  await settled(page);
  // Ждём не «процент изменился», а «процент стал тем самым».
  //
  // Изменение — слишком слабый признак: процент дёргается и от схлопывания
  // панели, которая сдвигает текст, а не только от прокрутки. Проверка успевала
  // нажать клавишу до того, как читалка поймёт, где она, и закладка вставала не
  // туда. Соседний абзац засчитывается: который из двух — дело округления.
  await page.waitForFunction(
    (n) => {
      const total = document.querySelectorAll("#book [data-block]").length;
      const percent = (at: number) => Math.round((100 * at) / Math.max(total - 1, 1));
      const now = document.querySelector("#progress")!.textContent;
      return [n - 1, n, n + 1].some((at) => now === `${percent(at)}%`);
    },
    block,
    { timeout: 10_000 },
  );
}

/**
 * Где сейчас верх блока относительно места для чтения.
 *
 * Не относительно окна: сверху висит панель, и абзац, оказавшийся под ней,
 * читателю не виден, сколько бы ни было ноль его координата.
 */
/**
 * Какой абзац у верхнего края — по тому же правилу, что и в читалке.
 *
 * Спрашивать записанное в хранилище нельзя: оно приходит от наблюдателя с
 * задержкой, и сразу после нажатия там ещё вчерашнее число. А обещание читателю
 * ровно такое: тот абзац, на который он смотрел, остался тем, на который он
 * смотрит.
 */
function topBlock(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const edge = Math.max(document.querySelector("#top")!.getBoundingClientRect().bottom, 0);
    let above: { block: number; top: number } | null = null;
    let below: { block: number; top: number } | null = null;
    for (const node of document.querySelectorAll<HTMLElement>("[data-block]")) {
      const entry = {
        block: Number(node.dataset["block"]),
        top: node.getBoundingClientRect().top - edge,
      };
      if (entry.top <= 0) {
        if (!above || entry.top > above.top) above = entry;
      } else if (!below || entry.top < below.top) {
        below = entry;
      }
    }
    return (above ?? below)?.block ?? null;
  });
}

/**
 * На какой своей доле абзац пересекает край чтения.
 *
 * Ноль — абзац только начался у края, -0.5 — прочитана половина, -1 — он весь
 * ушёл вверх. Мерить в долях, а не в пикселях, приходится потому, что при
 * крупном шрифте абзац выше, и то же место в тексте даёт совсем другое число
 * пикселей. Это ровно то, что читалка и обещает сохранить при перевёрстке.
 */
function partOf(page: Page, block: number): Promise<number> {
  return page.evaluate((n) => {
    const node = document.querySelector(`[data-block="${n}"]`)!;
    const panel = document.querySelector("#top")!.getBoundingClientRect().bottom;
    const rect = node.getBoundingClientRect();
    return rect.height ? (rect.top - Math.max(panel, 0)) / rect.height : 0;
  }, block);
}

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
    await settled(page);

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
    // Мерить сразу после перехода нельзя, и причина поучительная.
    //
    // Вёрстка ленивая: высоты абзацев выше места чтения уточняются уже после
    // прыжка, и высота страницы на этой книге падает с 8393 пикселей до 4052.
    // Придержка это выправляет — но в своём кадре, и между перевёрсткой
    // браузера и её поправкой есть промежуток в один кадр. Читатель его не
    // видит: поправка идёт в requestAnimationFrame, то есть до отрисовки. А
    // getBoundingClientRect из проверки читает разметку как раз между кадрами и
    // потому застаёт то, чего на экране не было.
    //
    // Пойман он был в CI, одним и тем же числом раз за разом: снос ровно
    // 331.86 пикселя — в точности та поправка, которую придержка делает
    // следующим кадром. Проверено по её журналу: кадр со сносом −331.86, а
    // следующий уже 0.14.
    await settled(page);
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

    // Ждём саму запись, а не отметку на экране: на экране закладка появляется
    // сразу, а в хранилище ложится следом, и перезагрузка успевала её обогнать.
    await expect.poll(() => savedMarks(page), { timeout: 10_000 }).toEqual([at]);

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

  it("размер текста меняется", async () => {
    const page = await browser.newPage();
    await openBook(page, "Долгая книга.fb2", longBook());
    const размер = () =>
      page.evaluate(() => getComputedStyle(document.querySelector("#book")!).fontSize);
    const было = await размер();
    await page.click("#bigger");
    expect(Number.parseFloat(await размер())).toBeGreaterThan(Number.parseFloat(было));
    await page.close();
  }, SLOW);

  it("смена размера не уносит с места и там, где браузер не придерживает", async () => {
    // Chromium сам придерживает содержимое при перевёрстке (scroll anchoring), и
    // поэтому изъяна не показывает: абзац уезжает на шесть пикселей. В Safari —
    // а телефон читателя как раз на нём — придержки нет, и то же нажатие уносит
    // на тысячи пикселей: измерено, на 110-м абзаце 2467.
    //
    // Поэтому придержка здесь выключается нарочно: проверяется поведение в том
    // браузере, в котором книгу и читают.
    const page = await browser.newPage();
    await openBook(page, "Долгая книга.fb2", longBook());
    await page.addStyleTag({
      content: "html, body, #book, #book * { overflow-anchor: none !important; }",
    });
    await readAt(page, 80);

    const до = await topBlock(page);
    expect(до).not.toBeNull();

    for (let i = 0; i < 3; i += 1) await page.click("#bigger");
    await settled(page);

    // Обещание: читатель не уехал больше, чем на строку. Точного равенства
    // требовать нельзя — на границе абзацев округление честно перекидывает
    // номер на соседний. А с потерянным местом разница была бы в двадцать
    // абзацев: измерено, восемьсот тридцать пикселей.
    const после = await topBlock(page);
    expect(после).not.toBeNull();
    expect(Math.abs(после! - до!)).toBeLessThanOrEqual(1);
    expect(Math.abs(await blockTop(page, до!))).toBeLessThan(60);
    await page.close();
  }, SLOW);

  it("смена размера не уносит с места и в большой книге", async () => {
    // На ста двадцати абзацах возврат к абзацу справляется и без придержки:
    // вёрстка там укладывается в один кадр. Настоящая книга — другое дело:
    // высоты уточняются ещё долго после нажатия, и без придержки читателя
    // уносит уже после того, как его вернули на место.
    const page = await browser.newPage();
    await openBook(page, "Большая книга.fb2", bigBook(3000));
    await page.addStyleTag({
      content: "html, body, #book, #book * { overflow-anchor: none !important; }",
    });
    await readAt(page, 1500);

    const до = await topBlock(page);
    expect(до).not.toBeNull();
    const доля = await partOf(page, до!);

    for (let i = 0; i < 3; i += 1) await page.click("#bigger");
    await settled(page);

    const после = await topBlock(page);
    expect(Math.abs(после! - до!)).toBeLessThanOrEqual(1);
    // И то же место внутри абзаца: читатель смотрит на ту же строку, а не на
    // начало абзаца, который дочитал до середины. Без придержки он уезжает на
    // добрый десяток абзацев, и доля уходит далеко за единицу.
    expect(Math.abs((await partOf(page, до!)) - доля)).toBeLessThan(1);
    await page.close();
  }, SLOW);

  it("большая книга не дороже маленькой при смене размера", async () => {
    // Это и есть ленивая вёрстка, выраженная числом: если книга верстается
    // целиком, то менять размер в книге на три тысячи абзацев втрое дороже,
    // чем в книге на двести — измерено, 200 мс против 67. Если верстается
    // только видимое, цена от размера книги не зависит вовсе.
    //
    // Отношение, а не миллисекунды: машина под проверкой бывает и чужая, и
    // занятая, а отношение переживает и то и другое.
    const цена = async (blocks: number): Promise<number> => {
      const page = await browser.newPage();
      await openBook(page, "Большая книга.fb2", bigBook(blocks));
      const мс = await page.evaluate(async () => {
        const устоялась = (): Promise<void> =>
          new Promise((done) => {
            let было = -1;
            let тихих = 0;
            const начало = performance.now();
            const кадр = (): void => {
              const высота = document.documentElement.scrollHeight;
              тихих = высота === было ? тихих + 1 : 0;
              было = высота;
              if (тихих >= 3 || performance.now() - начало > 2500) done();
              else requestAnimationFrame(кадр);
            };
            requestAnimationFrame(кадр);
          });
        const t0 = performance.now();
        document.querySelector<HTMLButtonElement>("#bigger")!.click();
        await устоялась();
        return performance.now() - t0;
      });
      await page.close();
      return мс;
    };

    const малая = await цена(200);
    const большая = await цена(3000);
    expect(большая / малая).toBeLessThan(2);
  }, 120_000);

  it("переход в конец большой книги не уползает", async () => {
    // Прыжок через всю книгу — худший случай для ленивой вёрстки: высоты всего,
    // что осталось выше, только теперь и уточняются, и читателя сносит уже
    // после того, как он пришёл.
    const page = await browser.newPage();
    await openBook(page, "Большая книга.fb2", bigBook(3000));
    await page.addStyleTag({
      content: "html, body, #book, #book * { overflow-anchor: none !important; }",
    });

    await page.click("#toc-toggle");
    // Последняя глава — «Часть вторая», то есть середина книги и дальше.
    await page.$$eval("#toc button", (nodes) => (nodes.at(-1) as HTMLElement).click());
    await settled(page);

    // Заголовок главы стоит ровно у края места для чтения — не под панелью и не
    // экраном ниже. Без придержки его уносит на сотни пикселей.
    const заголовок = await page.evaluate(() => {
      const узлы = [...document.querySelectorAll<HTMLElement>("#book h1, #book h2, #book h3")];
      const нужный = узлы.find((узел) => узел.textContent === "Часть вторая")!;
      return Number(нужный.dataset["block"]);
    });
    expect(заголовок).toBeGreaterThan(1400);
    // Соседний блок засчитывается: когда заголовок стоит ровно по краю, какой
    // из двух считать верхним — дело округления в доли пикселя.
    expect(Math.abs((await topBlock(page))! - заголовок)).toBeLessThanOrEqual(1);
    expect(Math.abs(await blockTop(page, заголовок))).toBeLessThan(5);
    await page.close();
  }, SLOW);

  it("абзац знает свой номер и в конце большой книги", async () => {
    // Номер блока — это место чтения: по нему книга открывается и на телефоне,
    // и в терминале. Абзацы книги называют себя сами, поэтому сдвиг нумерации
    // виден прямо в тексте.
    //
    // Смещение не задаётся числом, а считается по странице: заголовки частей —
    // тоже блоки, и сколько их прошло, столько и сдвиг. Так проверка стережёт
    // нумерацию, а не мою догадку о разборщике.
    const page = await browser.newPage();
    await openBook(page, "Большая книга.fb2", bigBook(3000));
    await readAt(page, 2900);

    const разошлись = await page.evaluate(() => {
      const плохие: string[] = [];
      let абзацев = 0;
      let индекс = 0;
      for (const узел of document.querySelectorAll<HTMLElement>("#book [data-block]")) {
        if (Number(узел.dataset["block"]) !== индекс) плохие.push(`подряд: ${индекс}`);
        индекс += 1;
        const сказано = /^Абзац номер (\d+)\./.exec(узел.textContent ?? "");
        if (!сказано) continue;
        if (Number(сказано[1]) !== абзацев) плохие.push(`${узел.dataset["block"]}: ${сказано[1]}`);
        абзацев += 1;
      }
      if (абзацев !== 3000) плохие.push(`абзацев ${абзацев}`);
      return плохие.slice(0, 5);
    });
    expect(разошлись).toEqual([]);
    await page.close();
  }, SLOW);

  it("размер текста не трогает панель и полку", async () => {
    // Читатель просил крупнее книгу, а не крупнее весь интерфейс.
    const page = await browser.newPage();
    await openBook(page, "Долгая книга.fb2", longBook());
    const панель = () =>
      page.evaluate(() => getComputedStyle(document.querySelector("#bar")!).fontSize);
    const было = await панель();
    await page.click("#bigger");
    await page.click("#bigger");
    expect(await панель()).toBe(было);
    await page.close();
  }, SLOW);

  it("размер текста переживает перезагрузку", async () => {
    const page = await browser.newPage();
    await openBook(page, "Долгая книга.fb2", longBook());
    await page.click("#bigger");
    const выбранный = await page.evaluate(
      () => getComputedStyle(document.querySelector("#book")!).fontSize,
    );
    // Дожидаемся самой записи, а не просто нажатия: она идёт своим чередом, и
    // перезагрузка, случившаяся раньше неё, потеряла бы настройку. Проверяется
    // здесь другое — что записанное читается обратно.
    await expect.poll(async () => (await savedSettings(page)).text, { timeout: 10_000 }).toBeDefined();

    await page.reload();
    await page.waitForSelector("#shelf li", { timeout: 10_000 });
    await page.click("#shelf .shelf-open");
    await page.waitForSelector("#book:not([hidden])", { timeout: 20_000 });
    await settled(page);
    expect(
      await page.evaluate(() => getComputedStyle(document.querySelector("#book")!).fontSize),
    ).toBe(выбранный);
    await page.close();
  }, SLOW);

  it("на самом крупном размере кнопка гаснет, а не заворачивает список", async () => {
    // Иначе одно лишнее нажатие давало бы самый мелкий шрифт.
    const page = await browser.newPage();
    await openBook(page, "Долгая книга.fb2", longBook());
    for (let i = 0; i < 8; i += 1) {
      if (await page.isEnabled("#bigger")) await page.click("#bigger");
    }
    expect(await page.isDisabled("#bigger")).toBe(true);
    const крупнейший = await page.evaluate(
      () => getComputedStyle(document.querySelector("#book")!).fontSize,
    );
    expect(Number.parseFloat(крупнейший)).toBeGreaterThan(20);
    await page.close();
  }, SLOW);

  it("версия читалки видна на первом экране", async () => {
    // С домашнего экрана адресной строки нет: узнать, доехало ли обновление до
    // телефона, иначе неоткуда — приходится верить на слово.
    const page = await browser.newPage();
    await page.goto(base);
    const { version } = JSON.parse(
      readFileSync(join(resolve(here, ".."), "package.json"), "utf-8"),
    ) as { version: string };
    expect(await page.textContent("#version")).toBe(`fb2read ${version}`);
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
  it("выбор файла ничем не ограничен", async () => {
    // Список расширений в поле выбора ломает iOS: он сопоставляет их со своими
    // типами файлов, а .fb2 и .fbz ему незнакомы — книги показывались в
    // «Файлах» серыми, и открыть их было нельзя вовсе. Проверка на месте,
    // чтобы список не вернулся: здесь, в Chromium, он не мешает ничему, и
    // заметить поломку было бы негде.
    const page = await browser.newPage();
    await page.goto(base);
    expect(await page.getAttribute("#file", "accept")).toBeNull();

    // И чужой файл по-прежнему объясняется, а не открывается.
    await give(page, "не книга.txt", new TextEncoder().encode("это вообще не книга"));
    await page.waitForSelector(".failure", { timeout: 20_000 });
    expect(await page.textContent(".failure")).toContain("не книга.txt");
    await page.close();
  }, SLOW);

  it("панель чтения не висит над библиотекой", async () => {
    // Атрибут hidden сам по себе ничего не прячет, если у элемента задан свой
    // display: браузерное правило слабее любого нашего. Проверяется поэтому не
    // атрибут, а то, видно ли панель на самом деле.
    const page = await browser.newPage();
    await page.goto(base);
    const height = () =>
      page.evaluate(() => document.querySelector("#bar")!.getBoundingClientRect().height);
    expect(await height()).toBe(0);

    await give(page, "Долгая книга.fb2", longBook());
    await page.waitForSelector("#book:not([hidden])", { timeout: 20_000 });
    expect(await height()).toBeGreaterThan(0);

    await page.click("#close");
    await page.waitForSelector("#start:not([hidden])", { timeout: 10_000 });
    expect(await height()).toBe(0);
    await page.close();
  }, SLOW);

  it("книга остаётся на полке после перезагрузки", async () => {
    // Ради этого весь этап: на телефоне книга лежит в «Файлах», и пробираться
    // к ней заново при каждом чтении никто не станет.
    const page = await browser.newPage();
    await openBook(page, "Долгая книга.fb2", longBook());
    await readAt(page, 30);

    await page.reload();
    await page.waitForSelector("#shelf li", { timeout: 20_000 });
    expect(await page.textContent("#shelf .shelf-open")).toContain("Долгая книга");

    // Открывается касанием: файл больше не выбирают.
    await page.click("#shelf .shelf-open");
    await page.waitForSelector("#book:not([hidden])", { timeout: 20_000 });
    await settled(page);
    expect(await page.textContent("#book")).toContain("Абзац номер 30.");

    // И открывается там, где бросили.
    const saved = (await savedBlocks(page))[0]!;
    expect(Math.abs(await blockTop(page, saved))).toBeLessThan(40);
    await page.close();
  }, SLOW);

  it("одна и та же книга не удваивается", async () => {
    const page = await browser.newPage();
    await openBook(page, "Долгая книга.fb2", longBook());
    await page.click("#close");
    // Тот же файл под другим именем — та же книга: отпечаток один.
    await give(page, "Копия.fb2", longBook());
    await page.waitForSelector("#book:not([hidden])", { timeout: 20_000 });
    await page.click("#close");

    await page.waitForSelector("#shelf li", { timeout: 10_000 });
    expect(await page.$$eval("#shelf li", (n) => n.length)).toBe(1);
    await page.close();
  }, SLOW);

  it("убранная книга исчезает, а место остаётся", async () => {
    const page = await browser.newPage();
    await openBook(page, "Долгая книга.fb2", longBook());
    await readAt(page, 25);
    const was = (await savedBlocks(page))[0]!;
    await page.click("#close");

    await page.waitForSelector("#shelf li", { timeout: 10_000 });
    await page.click("#shelf .shelf-drop");
    await expect.poll(() => page.$$eval("#shelf li", (n) => n.length), { timeout: 5000 }).toBe(0);

    await page.reload();
    await page.waitForSelector("#start:not([hidden])", { timeout: 20_000 });
    expect(await page.$$eval("#shelf li", (n) => n.length)).toBe(0);

    // Место пережило удаление: вернув ту же книгу, читатель попадёт туда же.
    await give(page, "Долгая книга.fb2", longBook());
    await page.waitForSelector("#book:not([hidden])", { timeout: 20_000 });
    await settled(page);
    expect(Math.abs(await blockTop(page, was))).toBeLessThan(40);
    await page.close();
  }, SLOW);

  it("на полке видно, сколько прочитано", async () => {
    const page = await browser.newPage();
    await openBook(page, "Долгая книга.fb2", longBook());
    await readAt(page, 60);
    await page.click("#close");
    await page.waitForSelector("#shelf li", { timeout: 10_000 });
    expect(await page.textContent("#shelf .shelf-about")).toMatch(/[1-9]\d?%/);
    await page.close();
  }, SLOW);
});

/**
 * Ждёт, пока разворот уляжется.
 *
 * `settled` тут не годится: он следит за высотой страницы, а в развороте она
 * не меняется вовсе — книга растёт вбок. Следить надо за её длиной.
 */
async function spreadSettled(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        const book = document.getElementById("book")!;
        let было = -1;
        let тихих = 0;
        const начало = performance.now();
        const кадр = (): void => {
          const длина = book.scrollWidth;
          тихих = длина === было ? тихих + 1 : 0;
          было = длина;
          if (тихих >= 3 || performance.now() - начало > 2500) done();
          else requestAnimationFrame(кадр);
        };
        requestAnimationFrame(кадр);
      }),
  );
}

/** Включает разворот кнопкой и дожидается, пока книга в него встанет. */
async function turnOnSpread(page: Page): Promise<void> {
  await page.click("#spread");
  await page.waitForFunction(() => document.body.classList.contains("spread"), null, {
    timeout: 10_000,
  });
  await spreadSettled(page);
}

/**
 * Какой абзац стоит в начале видимой страницы.
 *
 * Перебором, а не тем же двоичным поиском, что в читалке: проверка, повторяющая
 * проверяемое, подтвердила бы только саму себя.
 */
async function blockAtPage(page: Page): Promise<number> {
  return page.evaluate(() => {
    const book = document.getElementById("book")!;
    const left = book.getBoundingClientRect().left;
    let ответ = 0;
    for (const node of book.querySelectorAll<HTMLElement>("[data-block]")) {
      if (node.getBoundingClientRect().left - left <= 0) ответ = Number(node.dataset["block"]!);
      else break;
    }
    return ответ;
  });
}

/** Номера абзацев, которые видно на этой странице. */
async function blocksOnPage(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const book = document.getElementById("book")!;
    const край = book.getBoundingClientRect();
    const out: number[] = [];
    for (const node of book.querySelectorAll<HTMLElement>("[data-block]")) {
      const где = node.getBoundingClientRect();
      if (где.right > край.left + 1 && где.left < край.right - 1) {
        out.push(Number(node.dataset["block"]!));
      }
    }
    return out;
  });
}

/** Насколько абзац в начале страницы разошёлся с её краем. */
async function pageDrift(page: Page): Promise<number> {
  const block = await blockAtPage(page);
  return page.evaluate((n) => {
    const book = document.getElementById("book")!;
    const node = document.querySelector(`[data-block="${n}"]`)!;
    return node.getBoundingClientRect().left - book.getBoundingClientRect().left;
  }, block);
}

describe.skipIf(!CHROME)("разворот в браузере", () => {
  it("на широком окне книга встаёт в две колонки и не прокручивается вниз", async () => {
    const page = await browser.newPage();
    await openBook(page, "Долгая книга.fb2", longBook());
    await turnOnSpread(page);

    const вид = await page.evaluate(() => {
      const book = document.getElementById("book")!;
      return {
        колонок: getComputedStyle(book).columnCount,
        вбок: book.scrollWidth > book.clientWidth,
        вниз: document.documentElement.scrollHeight <= window.innerHeight + 1,
      };
    });
    expect(вид.колонок).toBe("2");
    // Книга длиннее одной страницы — иначе листать было бы нечего.
    expect(вид.вбок).toBe(true);
    // Главное отличие разворота: вниз не прокручивается вовсе.
    expect(вид.вниз).toBe(true);
    await page.close();
  }, SLOW);

  it("листание переставляет ровно на разворот", async () => {
    const page = await browser.newPage();
    await openBook(page, "Большая книга.fb2", bigBook(600));
    await turnOnSpread(page);

    // Пять страниц подряд: ошибка в шаге копится, и после одной её не видно.
    // Шаг в ширину окна разошёлся бы с колонкой на промежуток за страницу.
    for (let i = 0; i < 5; i += 1) {
      await page.keyboard.press("ArrowRight");
      await spreadSettled(page);
    }
    expect(Math.abs(await pageDrift(page))).toBeLessThanOrEqual(2);
    await page.close();
  }, SLOW);

  it("листание не пропускает текста", async () => {
    const page = await browser.newPage();
    await openBook(page, "Большая книга.fb2", bigBook(600));
    await turnOnSpread(page);

    const было = await blocksOnPage(page);
    await page.keyboard.press("ArrowRight");
    await spreadSettled(page);
    const стало = await blocksOnPage(page);

    expect(стало[0]).toBeGreaterThan(было[0]!);
    // Между страницами не должно провалиться ни одного абзаца: следующая
    // начинается с того, на котором прошлая кончилась, или со следующего.
    expect(стало[0]!).toBeLessThanOrEqual(было[было.length - 1]! + 1);
    await page.close();
  }, SLOW);

  it("место переживает включение и выключение разворота", async () => {
    const page = await browser.newPage();
    await openBook(page, "Долгая книга.fb2", longBook());
    await readAt(page, 40);

    await turnOnSpread(page);
    // Абзац, который читали, виден на развороте. Требовать, чтобы он стоял в
    // начале страницы, нельзя: страницы в многоколоннике лежат по своим
    // границам, и абзац попадает в середину или во вторую колонку.
    expect(await blocksOnPage(page)).toContain(40);
    // А записано именно оно, а не начало страницы: иначе переключение режима
    // раз за разом уводило бы читателя назад.
    await expect.poll(() => savedNear(page, 40), { timeout: 5000 }).toBe(true);

    await page.click("#spread");
    await page.waitForFunction(() => !document.body.classList.contains("spread"), null, {
      timeout: 10_000,
    });
    await settled(page);
    expect(Math.abs(await blockTop(page, 40))).toBeLessThan(40);
    await page.close();
  }, SLOW);

  it("переход по оглавлению попадает на страницу с этим абзацем", async () => {
    const page = await browser.newPage();
    await openBook(page, "Долгая книга.fb2", longBook());
    await turnOnSpread(page);

    await page.click("#toc-toggle");
    await page.click("#toc li:nth-child(2) button");
    await spreadSettled(page);

    const видно = await page.evaluate(() => {
      const book = document.getElementById("book")!;
      const край = book.getBoundingClientRect();
      const цель = [...book.querySelectorAll("h1, h2, h3")].find((h) =>
        h.textContent?.includes("Часть вторая"),
      )!;
      const где = цель.getBoundingClientRect();
      return где.left >= край.left - 1 && где.right <= край.right + 1;
    });
    expect(видно).toBe(true);
    await page.close();
  }, SLOW);

  it("найденное поиском видно на текущей странице", async () => {
    const page = await browser.newPage();
    await openBook(page, "Долгая книга.fb2", longBook());
    await turnOnSpread(page);

    await page.click("#find-toggle");
    await page.fill("#q", "номер 90.");
    await page.press("#q", "Enter");
    await page.waitForSelector("#book mark.found", { timeout: 10_000 });
    await spreadSettled(page);

    const видно = await page.evaluate(() => {
      const book = document.getElementById("book")!;
      const край = book.getBoundingClientRect();
      const где = document.querySelector("#book mark.found")!.getBoundingClientRect();
      return где.left >= край.left - 1 && где.right <= край.right + 1;
    });
    expect(видно).toBe(true);
    await page.close();
  }, SLOW);

  it("«крупнее» в развороте не теряет места", async () => {
    // Книга большая, место — далеко от начала, и размер меняется трижды. Всё
    // это нарочно: на короткой книге при одном нажатии сдвиг укладывается в ту
    // же страницу, и проверка проходит впустую даже без возврата на место —
    // поймано поломкой кода.
    const page = await browser.newPage();
    await openBook(page, "Большая книга.fb2", bigBook(600));
    await turnOnSpread(page);
    for (let i = 0; i < 10; i += 1) {
      await page.keyboard.press("ArrowRight");
      await spreadSettled(page);
    }
    const было = await blockAtPage(page);

    for (let i = 0; i < 3; i += 1) {
      await page.click("#bigger");
      await spreadSettled(page);
    }

    // Крупнее шрифт — длиннее книга, и страницы легли по-другому. Место
    // сохранено, если абзац, который читали, всё ещё на виду.
    expect(await blocksOnPage(page)).toContain(было);
    await page.close();
  }, SLOW);

  it("высокая картинка не вылезает за колонку", async () => {
    const page = await browser.newPage();
    await openBook(page, "С картинкой.fb2", tallImageBook());
    await turnOnSpread(page);

    await page.click("#find-toggle");
    await page.fill("#q", "Перед картинкой");
    await page.press("#q", "Enter");
    await page.waitForSelector("#book img[src]", { timeout: 10_000 });
    await spreadSettled(page);

    const мера = await page.evaluate(() => {
      const book = document.getElementById("book")!;
      const img = document.querySelector<HTMLImageElement>("#book img[src]")!;
      return { картинка: img.getBoundingClientRect().height, колонка: book.clientHeight };
    });
    expect(мера.картинка).toBeGreaterThan(0);
    expect(мера.картинка).toBeLessThanOrEqual(мера.колонка);
    await page.close();
  }, SLOW);

  it("на окне iPhone в альбомной разворота нет", async () => {
    // Ширины ему хватает с запасом — 844 пикселя. Не хватает высоты: колонка
    // вышла бы в пять строк. Порог поэтому по двум измерениям, а не по ширине.
    const page = await browser.newPage();
    await openBook(page, "Долгая книга.fb2", longBook());
    await turnOnSpread(page);

    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForFunction(() => !document.body.classList.contains("spread"), null, {
      timeout: 10_000,
    });
    // И кнопки нет: нажимать её там незачем.
    expect(await page.isVisible("#spread")).toBe(false);
    // Книга при этом читается по-прежнему — прокруткой.
    expect(await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight))
      .toBe(true);
    await page.close();
  }, SLOW);

  it("протяжка окна идёт по ленивой вёрстке, а страница встаёт ровно", async () => {
    // Честная вёрстка разворота на книге в шесть тысяч абзацев стоит 426 мс на
    // один размер, а протяжка края мышью выдаёт их десятками: окно тащилось
    // рывками по два с половиной кадра в секунду. С ленивой вёрсткой шаг стоит
    // 21 мс, а честная считается один раз — когда край отпустили.
    const page = await browser.newPage();
    await openBook(page, "Большая книга.fb2", bigBook(600));
    await turnOnSpread(page);
    // Пятнадцать страниц, а не пять: сужение окна растягивает книгу, и на той же
    // прокрутке оказывается текст, читанный раньше. Чем дальше от начала, тем
    // больше этот сдвиг — на пяти страницах он укладывался в ту же страницу, и
    // проверка проходила, даже когда место не возвращали вовсе.
    for (let i = 0; i < 15; i += 1) {
      await page.keyboard.press("ArrowRight");
      await spreadSettled(page);
    }
    const был = await blockAtPage(page);

    // Событие подаётся прямо в странице, а не настоящим изменением окна:
    // настоящее идёт через Playwright дольше самой придержки, и застать
    // протяжку в разгаре им нельзя.
    const лень = async (): Promise<string> =>
      page.evaluate(
        () => getComputedStyle(document.querySelector("#book [data-block]")!).contentVisibility,
      );
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    expect(await page.evaluate(() => document.body.classList.contains("resizing"))).toBe(true);
    expect(await лень()).toBe("auto");

    await page.setViewportSize({ width: 900, height: 720 });
    await page.waitForFunction(() => !document.body.classList.contains("resizing"), null, {
      timeout: 10_000,
    });
    await spreadSettled(page);

    // Край отпустили — вёрстка снова честная, и страница встала ровно.
    //
    // Ровность тут важнее места: книга сужается целиком, и та же прокрутка даёт
    // почти тот же текст — измерено, сдвиг на три абзаца. А вот на границу
    // страницы прокрутка уже не приходится: после сужения она пришлась на 18.9-ю
    // страницу из 110, то есть читатель увидел бы половину одного разворота и
    // половину соседнего.
    expect(await лень()).toBe("visible");
    expect(Math.abs(await pageDrift(page))).toBeLessThanOrEqual(2);
    // И место не потеряно. Допуск в несколько абзацев — не небрежность: колонки
    // стали уже, строк в абзаце больше, и тот же текст лёг иначе.
    expect(Math.abs((await blockAtPage(page)) - был)).toBeLessThanOrEqual(5);
    await page.close();
  }, SLOW);

  it("колесо листает разворот, а не прокручивает страницу", async () => {
    const page = await browser.newPage();
    await openBook(page, "Большая книга.fb2", bigBook(600));
    await turnOnSpread(page);
    const был = await blockAtPage(page);

    await page.mouse.move(400, 400);
    await page.mouse.wheel(0, 200);
    await spreadSettled(page);

    expect(await blockAtPage(page)).toBeGreaterThan(был);
    // Вниз при этом страница не поехала: в развороте низа нет.
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await page.close();
  }, SLOW);

  it("закрытая книга не оставляет разворот на первом экране", async () => {
    // Правила разворота задают ширину всей страницы, а не одной книги: остаться
    // на первом экране они не должны, иначе полка разъезжается во всю ширину
    // разворота.
    const page = await browser.newPage();
    await page.goto(base);
    const ширина = async (): Promise<number> =>
      page.evaluate(() => document.getElementById("app")!.getBoundingClientRect().width);
    const было = await ширина();

    await give(page, "Долгая книга.fb2", longBook());
    await page.waitForSelector("#book:not([hidden])", { timeout: 20_000 });
    await settled(page);
    await turnOnSpread(page);
    expect(await ширина()).toBeGreaterThan(было);

    await page.click("#close");
    await page.waitForSelector("#start:not([hidden])", { timeout: 10_000 });
    expect(await page.evaluate(() => document.body.classList.contains("spread"))).toBe(false);
    expect(await ширина()).toBe(было);
    await page.close();
  }, SLOW);

  it("выбор разворота переживает перезагрузку", async () => {
    const page = await browser.newPage();
    await openBook(page, "Долгая книга.fb2", longBook());
    await turnOnSpread(page);
    // Сперва дожидаемся самой записи: перезагрузка, случившаяся раньше неё,
    // потеряла бы настройку, сколько бы та ни была верна.
    await expect.poll(() => savedSettings(page).then((s) => s.columns), { timeout: 5000 }).toBe(2);

    await page.reload();
    await page.waitForSelector("#shelf li", { timeout: 20_000 });
    await page.click("#shelf .shelf-open");
    await page.waitForSelector("#book:not([hidden])", { timeout: 20_000 });
    await spreadSettled(page);

    expect(await page.evaluate(() => document.body.classList.contains("spread"))).toBe(true);
    await page.close();
  }, SLOW);
});
