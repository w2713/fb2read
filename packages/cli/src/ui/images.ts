/**
 * Показ иллюстраций в терминале.
 *
 * Протоколы kitty и iTerm2 — это просто escape-последовательности, поэтому
 * работают без сторонних библиотек. Остальным терминалам помогают внешние
 * chafa или img2sixel, если они есть; когда нет ничего, читатель получает
 * понятную подсказку, а не пустой экран.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guessExtension, type ImageData } from "@fb2read/core";
import type { ImageBackend } from "@fb2read/core";

/** Есть ли программа в PATH. */
function hasCommand(name: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  return spawnSync(probe, [name], { stdio: "ignore" }).status === 0;
}

/** Чем этот терминал умеет показывать картинки. */
export function detectBackend(env = process.env): Exclude<ImageBackend, "auto"> | "" {
  const term = env["TERM"] ?? "";
  if (env["KITTY_WINDOW_ID"] || term.includes("kitty")) return "kitty";
  if (
    env["TERM_PROGRAM"] === "iTerm.app" ||
    env["TERM_PROGRAM"] === "WezTerm" ||
    env["WEZTERM_PANE"]
  ) {
    return "iterm";
  }
  if (hasCommand("chafa")) return "chafa";
  if (hasCommand("img2sixel")) return "sixel";
  return "";
}

function toBase64(data: Uint8Array): string {
  return Buffer.from(data).toString("base64");
}

/** Графический протокол kitty: сами байты PNG, порциями по 4 КБ. */
function kittyImage(write: (s: string) => void, data: Uint8Array, cols: number, rows: number): boolean {
  const png = [0x89, 0x50, 0x4e, 0x47];
  if (!png.every((byte, i) => data[i] === byte)) return false; // kitty ждёт PNG
  const payload = toBase64(data);
  const chunks: string[] = [];
  for (let i = 0; i < payload.length; i += 4096) chunks.push(payload.slice(i, i + 4096));
  if (!chunks.length) chunks.push("");
  chunks.forEach((chunk, number) => {
    const more = number < chunks.length - 1 ? 1 : 0;
    const head =
      number === 0 ? `a=T,f=100,c=${cols},r=${rows},m=${more}` : `m=${more}`;
    write(`\x1b_G${head};${chunk}\x1b\\`);
  });
  return true;
}

/** Протокол iTerm2 и WezTerm: файл целиком в OSC 1337. */
function itermImage(write: (s: string) => void, data: Uint8Array, cols: number, rows: number): boolean {
  const head =
    `1337;File=inline=1;width=${cols};height=${rows};` +
    `preserveAspectRatio=1;size=${data.length}:`;
  write(`\x1b]${head}${toBase64(data)}\x07`);
  return true;
}

/** Показ через внешнюю программу: chafa или img2sixel. */
function externalImage(
  write: (s: string) => void,
  command: string[],
  data: Uint8Array,
  suffix: string,
): boolean {
  const dir = mkdtempSync(join(tmpdir(), "fb2read-img-"));
  const file = join(dir, `image${suffix || ".img"}`);
  try {
    writeFileSync(file, data);
    const result = spawnSync(command[0]!, [...command.slice(1), file], {
      encoding: "buffer",
      timeout: 20_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0 || !result.stdout) return false;
    write(result.stdout.toString("binary"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Рисует картинку в текущем терминале. Возвращает, получилось ли. */
export function renderImage(
  write: (s: string) => void,
  image: ImageData,
  backend: string,
  cols: number,
  rows: number,
): boolean {
  const suffix = guessExtension(image.mime) || ".jpg";
  if (backend === "kitty" && kittyImage(write, image.data, cols, rows)) return true;
  if (backend === "iterm") return itermImage(write, image.data, cols, rows);
  if (backend === "sixel") {
    return externalImage(write, ["img2sixel", "-w", String(cols * 8)], image.data, suffix);
  }
  if (["chafa", "kitty", "iterm"].includes(backend) && hasCommand("chafa")) {
    return externalImage(
      write,
      ["chafa", "--clear", "--size", `${cols}x${rows}`],
      image.data,
      suffix,
    );
  }
  return false;
}
