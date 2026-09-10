/*
 * Рисует иконки читалки из SVG.
 *
 * Рисовальных программ здесь нет, а Chromium уже стоит — тот самый, которым
 * проверяется читалка. Он раскладывает SVG в пиксели ровно и повторяемо,
 * а PNG кладутся в репозиторий готовыми: ни сборка, ни выкладка не должны
 * требовать браузера.
 *
 * Запуск: node scripts/make-icons.mjs
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const icons = resolve(here, "..", "packages", "web", "public", "icons");

const WANTED = [
  { file: "icon-192.png", size: 192, art: "icon.svg" },
  { file: "icon-512.png", size: 512, art: "icon.svg" },
  { file: "icon-maskable-512.png", size: 512, art: "icon-maskable.svg" },
  { file: "apple-touch-icon-180.png", size: 180, art: "icon.svg" },
];

/** Где взять Chromium: в образе он не той сборки, которую ждёт Playwright. */
function findChrome() {
  const inImage = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (existsSync(inImage)) return inImage;
  return chromium.executablePath();
}

const browser = await chromium.launch({ executablePath: findChrome() });
for (const { file, size, art } of WANTED) {
  const svg = readFileSync(join(icons, art), "utf-8");
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<style>html,body{margin:0;padding:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
  );
  await page.screenshot({ path: join(icons, file), type: "png" });
  await page.close();
  console.log(`${file}: ${size}×${size}`);
}
await browser.close();
