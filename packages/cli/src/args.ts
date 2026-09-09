/**
 * Разбор ключей командной строки.
 *
 * util.parseArgs умеет цифровые короткие ключи, так что `-2` и `-1` берутся
 * им же. Проверка значений и текст справки свои: сообщения должны совпадать
 * с эталонной реализацией.
 */

import { parseArgs } from "node:util";
import { IMAGE_BACKENDS, THEME_ORDER, type ImageBackend, type Theme } from "@fb2read/core";

export const APP = "fb2read";
export const VERSION = "0.12.0";

/** Что разобрали из командной строки. */
export interface Args {
  file?: string;
  width?: number;
  spacing?: number;
  columns?: number;
  theme?: Theme;
  images?: ImageBackend;
  mouse?: boolean;
  config?: string;
  dump: boolean;
  toc: boolean;
  info: boolean;
  writeConfig: boolean;
  fromStart: boolean;
  help: boolean;
  version: boolean;
}

/** Ошибка в командной строке: сообщение готово к печати. */
export class ArgsError extends Error {}

export const HELP = `Использование: ${APP} [КЛЮЧИ] [ФАЙЛ]

Читалка книг FB2 и EPUB для терминала.

Позиционный аргумент:
  ФАЙЛ                  книга .fb2 / .fb2.zip / .epub либо каталог с книгами;
                        без аргумента открывается список недавних

Ключи:
  -w, --width N         ширина текстовой колонки (по умолчанию 80)
  -s, --spacing N       межстрочный интервал: 1, 2 или 3
  -2, --spread          книжный разворот: две страницы рядом
  -1, --single          одна колонка
      --theme ТЕМА      ${THEME_ORDER.join(", ")}
      --images СПОСОБ   ${IMAGE_BACKENDS.join(", ")}
      --no-mouse        не захватывать мышь
      --from-start      не восстанавливать сохранённую позицию
      --config ФАЙЛ     файл настроек
      --write-config    записать образец файла настроек и выйти
      --dump            вывести текст в stdout (например, | less -R)
      --toc             вывести оглавление
      --info            вывести сведения о книге
  -h, --help            эта справка
  -V, --version         версия`;

function integer(name: string, raw: string | undefined, allowed?: number[]): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!/^[+-]?\d+$/.test(raw.trim()) || Number.isNaN(value)) {
    throw new ArgsError(`неверное значение ${name}: ${raw}`);
  }
  if (allowed && !allowed.includes(value)) {
    throw new ArgsError(`${name} должно быть одним из: ${allowed.join(", ")}`);
  }
  return value;
}

function oneOf<T extends string>(
  name: string,
  raw: string | undefined,
  allowed: readonly T[],
): T | undefined {
  if (raw === undefined) return undefined;
  if (!allowed.includes(raw as T)) {
    throw new ArgsError(`${name} должно быть одним из: ${allowed.join(", ")}`);
  }
  return raw as T;
}

/** Разбирает аргументы; бросает ArgsError с готовым сообщением. */
export function parseCliArgs(argv: string[]): Args {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        width: { type: "string", short: "w" },
        spacing: { type: "string", short: "s" },
        spread: { type: "boolean", short: "2" },
        single: { type: "boolean", short: "1" },
        theme: { type: "string" },
        images: { type: "string" },
        "no-mouse": { type: "boolean" },
        "from-start": { type: "boolean" },
        config: { type: "string" },
        "write-config": { type: "boolean" },
        dump: { type: "boolean" },
        toc: { type: "boolean" },
        info: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "V" },
      },
    });
  } catch (e) {
    throw new ArgsError(e instanceof Error ? e.message : String(e));
  }

  const v = parsed.values;
  if (parsed.positionals.length > 1) {
    throw new ArgsError(`лишний аргумент: ${parsed.positionals[1]}`);
  }

  // Последний из -1 и -2 не выигрывает: как и в эталоне, разворот сильнее.
  const columns = v.spread ? 2 : v.single ? 1 : undefined;

  return {
    file: parsed.positionals[0],
    width: integer("--width", v.width),
    spacing: integer("--spacing", v.spacing, [1, 2, 3]),
    columns,
    theme: oneOf("--theme", v.theme, THEME_ORDER),
    images: oneOf("--images", v.images, IMAGE_BACKENDS),
    mouse: v["no-mouse"] ? false : undefined,
    config: v.config,
    dump: !!v.dump,
    toc: !!v.toc,
    info: !!v.info,
    writeConfig: !!v["write-config"],
    fromStart: !!v["from-start"],
    help: !!v.help,
    version: !!v.version,
  };
}
