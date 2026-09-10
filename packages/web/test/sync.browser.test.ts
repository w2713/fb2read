/**
 * Обмен браузерной читалки с настоящим сервером.
 *
 * Ради этого затевалась вся синхронизация: книга, брошенная на ноутбуке,
 * должна открываться на телефоне там же, где её оставили. Проверять это на
 * подделках бессмысленно — половина сложности здесь в том, что браузер ходит
 * на чужой адрес и сам решает, пускать ли его. Поэтому: настоящий сервер
 * синхронизации, настоящий Chromium и настоящий обмен между ними.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createFileServer, type Server } from "node:http";
import { createServer as createSocket, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(resolve(here, ".."), "dist");

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
const SLOW = 60_000;
const TOKEN = "проба-токен-latin1-only".replace(/[^\x21-\x7e]/g, "") || "token";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

let browser: Browser;
let pages: Server;
let sync: ChildProcess;
let base: string;
let api: string;
let data: string;

/** Свободный порт: сервер запускается отдельным процессом и порт ему нужен. */
function freePort(): Promise<number> {
  return new Promise((done) => {
    const probe = createSocket();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => done(port));
    });
  });
}

const BOOK =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">' +
  "<description><title-info><book-title>Книга с ноутбука</book-title>" +
  "<author><first-name>Лев</first-name><last-name>Толстой</last-name></author>" +
  "</title-info></description><body><section><title><p>Глава</p></title>" +
  Array.from({ length: 40 }, (_, i) => `<p>Абзац номер ${i + 1}.</p>`).join("") +
  "</section></body></FictionBook>";

beforeAll(async () => {
  if (!existsSync(dist)) throw new Error("нет сборки — запустите pnpm --filter @fb2read/web build");

  pages = createFileServer((request, response) => {
    const name = (request.url ?? "/").split("?")[0]!.replace("/fb2read/app/", "/");
    const file = join(dist, name === "/" ? "index.html" : name);
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
  await new Promise<void>((r) => pages.listen(0, "127.0.0.1", r));
  const port = (pages.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}/fb2read/app/`;

  // Сервер синхронизации — настоящий и отдельным процессом: запускается ровно
  // тот файл, который человек ставит у себя. Адрес читалки для него чужой,
  // поэтому без разрешения браузер к нему и не постучится.
  const built = join(resolve(here, "..", "..", "server"), "dist", "fb2read-server.mjs");
  if (!existsSync(built)) throw new Error("нет сборки сервера — запустите pnpm build");
  data = mkdtempSync(join(tmpdir(), "fb2read-обмен-"));
  const apiPort = await freePort();
  api = `http://127.0.0.1:${apiPort}`;
  sync = spawn(process.execPath, [built], {
    env: {
      ...process.env,
      FB2READ_SERVER_TOKENS: `я:${TOKEN}`,
      FB2READ_SERVER_DIR: data,
      FB2READ_SERVER_PORT: String(apiPort),
      FB2READ_SERVER_ORIGIN: `http://127.0.0.1:${port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error("сервер не поднялся")), 20_000);
    sync.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("слушаю")) {
        clearTimeout(timer);
        done();
      }
    });
    sync.on("exit", (code) => fail(new Error(`сервер вышел с кодом ${code}`)));
  });

  browser = await chromium.launch({ executablePath: CHROME! });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => pages.close(() => r()));
  sync?.kill();
  rmSync(data, { recursive: true, force: true });
});

/** Настраивает обмен так, как это сделал бы читатель руками. */
async function setUp(page: Page): Promise<void> {
  await page.click("#sync-setup");
  await page.fill("#sync-url", api);
  await page.fill("#sync-token", TOKEN);
  await page.fill("#sync-device", "телефон");
  await page.click("#sync-form button[type=submit]");
  await page.waitForSelector("#sync-now:not([hidden])", { timeout: 10_000 });
}

/** Отдаёт книгу странице так, как это сделал бы проводник. */
async function give(page: Page, name: string, text: string): Promise<void> {
  await page.evaluate(
    ({ name, text }) => {
      const file = new File([new TextEncoder().encode(text)], name);
      const carrier = new DataTransfer();
      carrier.items.add(file);
      const input = document.querySelector<HTMLInputElement>("#file")!;
      input.files = carrier.files;
      input.dispatchEvent(new Event("change"));
    },
    { name, text },
  );
}

describe.skipIf(!CHROME)("обмен с сервером", () => {
  it("книга и место уезжают на сервер и приезжают на другое устройство", async () => {
    // Первое устройство: открыло книгу, почитало, синхронизировалось.
    const первое = await browser.newPage();
    await первое.goto(base);
    await setUp(первое);
    await give(первое, "Книга с ноутбука.fb2", BOOK);
    await первое.waitForSelector("#book:not([hidden])", { timeout: 20_000 });

    await первое.evaluate(() => {
      const node = document.querySelector('[data-block="20"]')!;
      const panel = document.querySelector("#top")!.getBoundingClientRect().bottom;
      window.scrollBy(0, node.getBoundingClientRect().top - Math.max(panel, 0));
    });
    await первое.waitForFunction(() => document.querySelector("#progress")!.textContent !== "0%", undefined, { timeout: 10_000 });
    await первое.click("#close");
    await первое.waitForSelector("#shelf li", { timeout: 10_000 });
    // Обмен мог случиться уже при закрытии книги — он на то и заведён; важно
    // не то, кто отправил книгу, а то, что она на сервере.
    await первое.click("#sync-now");
    await expect
      .poll(() => первое.textContent("#sync-note"), { timeout: 30_000 })
      .not.toContain("не вышло");

    // Второе устройство — другой браузерный профиль, ничего своего у него нет.
    const второе = await browser.newPage();
    await второе.goto(base);
    await setUp(второе);
    expect(await второе.$$eval("#shelf li", (n) => n.length)).toBe(0);

    await второе.click("#sync-now");
    await expect
      .poll(() => второе.textContent("#sync-note"), { timeout: 30_000 })
      .toContain("получено книг: 1");

    // Книга приехала целиком и открывается.
    await второе.waitForSelector("#shelf li", { timeout: 10_000 });
    expect(await второе.textContent("#shelf .shelf-open")).toContain("Книга с ноутбука");
    await второе.click("#shelf .shelf-open");
    await второе.waitForSelector("#book:not([hidden])", { timeout: 20_000 });
    expect(await второе.textContent("#book")).toContain("Абзац номер 20.");

    // И открылась там, где её бросили на первом устройстве.
    const где = await второе.evaluate(() => {
      const node = document.querySelector('[data-block="20"]')!;
      const panel = document.querySelector("#top")!.getBoundingClientRect().bottom;
      return node.getBoundingClientRect().top - Math.max(panel, 0);
    });
    expect(Math.abs(где)).toBeLessThan(40);

    await первое.close();
    await второе.close();
  }, SLOW);

  it("закладка, снятая на одном устройстве, не возвращается с другого", async () => {
    // Надгробия ради этого и заводились: без них закладка воскресала бы при
    // каждом обмене с устройством, которое о снятии не знает.
    const первое = await browser.newPage();
    await первое.goto(base);
    await setUp(первое);
    await give(первое, "Закладки.fb2", BOOK.replace("Книга с ноутбука", "Книга закладок"));
    await первое.waitForSelector("#book:not([hidden])", { timeout: 20_000 });
    await первое.click("#mark");
    await первое.click("#close");
    await первое.waitForSelector("#shelf li", { timeout: 10_000 });
    await первое.click("#sync-now");
    await expect.poll(() => первое.textContent("#sync-note"), { timeout: 30_000 }).not.toContain("не вышло");

    // Второе устройство забирает книгу вместе с закладкой.
    const второе = await browser.newPage();
    await второе.goto(base);
    await setUp(второе);
    await второе.click("#sync-now");
    await expect.poll(() => второе.textContent("#sync-note"), { timeout: 30_000 }).toContain("получено книг");
    await второе.waitForSelector("#shelf li", { timeout: 10_000 });
    // Выбирается именно эта книга: на полке уже лежит и та, что приехала
    // раньше, и «последняя строка» оказалась бы не той.
    await второе.click("#shelf .shelf-open:has-text('Книга закладок')");
    await второе.waitForSelector("#book:not([hidden])", { timeout: 20_000 });
    await второе.click("#marks-toggle");
    expect(await второе.$$eval("#mark-list .mark-go", (n) => n.length)).toBe(1);

    // Снимаем её здесь и обмениваемся.
    await второе.click("#mark-list .mark-drop");
    await второе.click("#close");
    await второе.waitForSelector("#shelf li", { timeout: 10_000 });
    await второе.click("#sync-now");
    await expect.poll(() => второе.textContent("#sync-note"), { timeout: 30_000 }).not.toContain("не вышло");

    // Первое устройство обменивается снова — закладка должна уйти и у него.
    await первое.click("#sync-now");
    await expect.poll(() => первое.textContent("#sync-note"), { timeout: 30_000 }).not.toContain("не вышло");
    await первое.click("#shelf .shelf-open:has-text('Книга закладок')");
    await первое.waitForSelector("#book:not([hidden])", { timeout: 20_000 });
    await первое.click("#marks-toggle");
    expect(await первое.$$eval("#mark-list .mark-go", (n) => n.length)).toBe(0);

    await первое.close();
    await второе.close();
  }, SLOW);

  it("неверный токен объясняется, а не молчит", async () => {
    const page = await browser.newPage();
    await page.goto(base);
    await page.click("#sync-setup");
    await page.fill("#sync-url", api);
    await page.fill("#sync-token", "не-тот-токен");
    await page.click("#sync-form button[type=submit]");
    await page.waitForSelector("#sync-now:not([hidden])", { timeout: 10_000 });

    await page.click("#sync-now");
    // Сказано должно быть именно про токен: «не вышло» бывает и когда сети
    // нет вовсе, и такой ответ читателю ничего не объясняет.
    await expect.poll(() => page.textContent("#sync-note"), { timeout: 30_000 }).toContain("токен");
    await page.close();
  }, SLOW);
});
