import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { defineConfig, type Plugin } from "vite";

// Читалка живёт по отдельному адресу, а установщики остаются в корне сайта:
// ссылки на install.sh и install.ps1 зашиты в README и в уже выпущенные
// установщики, ломать их нельзя.
const BASE = "/fb2read/app/";

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
  try {
    walk(dir);
  } catch {
    // Каталога может не быть вовсе — тогда и класть в кэш нечего.
  }
  return out;
}

/**
 * Пишет service worker со списком файлов этой сборки.
 *
 * Vite даёт файлам имена с отпечатками, поэтому список для кэша неоткуда взять,
 * кроме как из самой сборки. Готовый плагин (workbox) делал бы то же самое, но
 * весил бы больше всего остального приложения — а здесь своими руками написаны
 * и распаковщик zip, и base64, и sha256.
 *
 * Штамп кэша — отпечаток списка и содержимого `public`: меняется сборка,
 * меняется имя кэша, и старый уходит при первом запуске нового работника.
 */
function serviceWorker(root: string): Plugin {
  let publicDir = "";
  return {
    name: "fb2read-sw",
    apply: "build",
    // Строго после всех: index.html попадает в набор только в generateBundle
    // сборщика разметки, и без этого его в списке для кэша не оказалось бы —
    // а офлайн без страницы открывается пустотой.
    enforce: "post",
    configResolved(config) {
      publicDir = config.publicDir;
    },
    generateBundle(_options, bundle) {
      // Карты кода в кэш не нужны: их читает отладчик, а не читалка.
      const built = Object.keys(bundle).filter((name) => !name.endsWith(".map"));
      // Файлы из public в набор не попадают вовсе — их надо обойти по диску.
      const fromPublic = listFiles(publicDir);
      const assets = [...built, ...fromPublic].map((name) => BASE + name).sort();

      const stamp = createHash("sha256")
        .update(assets.join("\n"))
        // Содержимое public — тоже часть штампа: иконку правят, не переименовывая.
        .update(
          fromPublic
            .map((name) => createHash("sha256").update(readFileSync(join(publicDir, name))).digest("hex"))
            .join("\n"),
        )
        .digest("hex")
        .slice(0, 12);

      const head =
        `/* Шапку дописывает сборка: список файлов и штамп берутся из неё. */\n` +
        `const CACHE = ${JSON.stringify(`fb2read-${stamp}`)};\n` +
        `const BASE = ${JSON.stringify(BASE)};\n` +
        `const ASSETS = ${JSON.stringify(assets, null, 2)};\n\n`;

      // Имя строго `sw.js`, без отпечатка: работник с новым именем — это новый
      // работник, а не обновление прежнего.
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: head + readFileSync(join(root, "src/sw.js"), "utf-8"),
      });
    },
  };
}

export default defineConfig({
  base: BASE,
  build: { target: "es2022", outDir: "dist" },
  plugins: [serviceWorker(process.cwd())],
});
