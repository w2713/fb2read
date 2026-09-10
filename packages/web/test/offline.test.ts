/**
 * Читалка без сети.
 *
 * Это условие приёмки всего милестоуна: книга должна открываться в самолёте, с
 * домашнего экрана, без единого запроса наружу. Подделать здесь нечего —
 * проверяется настоящий service worker в настоящем Chromium, которому сеть
 * отключают по-настоящему.
 *
 * Набор отдельный: ему нужен свой браузерный контекст, который не жалко
 * оставить без сети.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
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
const SLOW = 40_000;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

let browser: Browser;
let server: Server;
let base: string;

const BOOK =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">' +
  "<description><title-info><book-title>Книга для самолёта</book-title>" +
  "</title-info></description><body><section><title><p>Глава</p></title>" +
  "<p>Этот абзац читается без сети.</p></section></body></FictionBook>";

beforeAll(async () => {
  if (!existsSync(dist)) throw new Error("нет сборки — запустите pnpm --filter @fb2read/web build");
  server = createServer((request, response) => {
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
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  // Именно 127.0.0.1: только он считается надёжным адресом, а без этого
  // браузер не даст завести service worker вовсе.
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/fb2read/app/`;
  browser = await chromium.launch({ executablePath: CHROME! });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => server.close(() => r()));
});

describe.skipIf(!CHROME)("читалка без сети", () => {
  it("в авиарежиме и приложение открывается, и книга читается", async () => {
    const page = await browser.newPage();
    const crashes: string[] = [];
    page.on("pageerror", (e) => crashes.push(e.message));

    await page.goto(base);
    // Ждём, пока работник заберёт страницу себе: до этого кэш пуст.
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
      timeout: 20_000,
    });

    await page.evaluate((text) => {
      const file = new File([new TextEncoder().encode(text)], "Самолёт.fb2");
      const carrier = new DataTransfer();
      carrier.items.add(file);
      const input = document.querySelector<HTMLInputElement>("#file")!;
      input.files = carrier.files;
      input.dispatchEvent(new Event("change"));
    }, BOOK);
    await page.waitForSelector("#book:not([hidden])", { timeout: 20_000 });
    await page.click("#close");
    await page.waitForSelector("#shelf li", { timeout: 10_000 });

    // Сеть выключается по-настоящему, а не понарошку.
    await page.context().setOffline(true);
    await page.reload();
    await page.waitForSelector("#start:not([hidden])", { timeout: 20_000 });

    // Книга на полке и открывается — вот ради чего всё это.
    await page.waitForSelector("#shelf li", { timeout: 10_000 });
    await page.click("#shelf .shelf-open");
    await page.waitForSelector("#book:not([hidden])", { timeout: 20_000 });
    expect(await page.textContent("#book")).toContain("Этот абзац читается без сети");

    // Разбор идёт в отдельном потоке — значит, и его файл достался из кэша.
    expect(crashes).toEqual([]);
    await page.context().setOffline(false);
    await page.close();
  }, SLOW);

  it("старые кэши убираются, а не копятся", async () => {
    const page = await browser.newPage();
    await page.goto(base);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
      timeout: 20_000,
    });

    // Кэш от прошлой сборки: он должен уйти при первом же запуске нового
    // работника, иначе на телефоне копились бы сборки за все месяцы.
    await page.evaluate(async () => {
      const old = await caches.open("fb2read-древний");
      await old.put("/fb2read/app/старое", new Response("старьё"));
      const reg = await navigator.serviceWorker.getRegistration();
      await reg?.unregister();
    });
    await page.reload();
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
      timeout: 20_000,
    });

    const names = await page.evaluate(() => caches.keys());
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^fb2read-[0-9a-f]{12}$/);
    await page.close();
  }, SLOW);

  it("манифест отдаётся и обещает отдельное приложение", async () => {
    const page = await browser.newPage();
    await page.goto(base);
    const manifest = await page.evaluate(async () => {
      const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')!;
      const answer = await fetch(link.href);
      return { ok: answer.ok, body: (await answer.json()) as Record<string, unknown> };
    });
    expect(manifest.ok).toBe(true);
    // Без standalone iOS открывает читалку вкладкой с адресной строкой.
    expect(manifest.body["display"]).toBe("standalone");
    expect(manifest.body["start_url"]).toBe("./");

    // Иконки не просто перечислены, а лежат на месте.
    const icons = await page.evaluate(async () => {
      const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')!;
      const body = (await (await fetch(link.href)).json()) as { icons: { src: string }[] };
      const out: number[] = [];
      for (const icon of body.icons) {
        out.push((await fetch(new URL(icon.src, link.href))).status);
      }
      return out;
    });
    expect(icons).toEqual([200, 200, 200]);
    await page.close();
  }, SLOW);
});

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
