/**
 * Точка входа: разбор аргументов, режимы вывода и запуск чтения.
 */

import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  Book,
  bookKey,
  bookmarksFileName,
  bookmarksMarkdown,
  configSample,
  layout,
  readConfig,
  type Bookmark,
  type ConfigResult,
  type ImageBackend,
  type Theme,
} from "@fb2read/core";
import { APP, ArgsError, HELP, VERSION, parseCliArgs, type Args } from "./args.js";
import { FileSource } from "./fsSource.js";
import { addToLibrary, libraryLines, scanDir } from "./library.js";
import { configFile } from "./paths.js";
import { JsonFileStore } from "./store.js";
import {
  cmdPull,
  cmdForget,
  cmdPush,
  cmdRemote,
  cmdSync,
  downloadBook,
  keepOnServer,
  libraryDir,
  remoteOnly,
  syncAllQuiet,
  syncOnDemand,
  syncOne,
  syncSettings,
} from "./sync.js";
import type { ChooserEntry } from "./ui/chooser.js";
import { NodeTerminal } from "./term/terminal.js";
import { runLibrary } from "./ui/library.js";
import { readBook } from "./ui/read.js";
import { Session } from "./ui/session.js";

/** Настройки чтения после слияния всех источников. */
interface Prefs {
  theme: Theme;
  spacing: number;
  columns: number;
  images: ImageBackend;
  mouse: boolean;
  justify: boolean;
  hyphens: boolean;
  width: number;
  keys: Record<string, string>;
}

/**
 * Печатает строки, переживая закрытый конвейер.
 *
 * `fb2read book.fb2 --dump | head` закрывает трубу на первой странице: это
 * не ошибка, а обычный конец работы. Запись в поток идёт своим чередом,
 * поэтому обрыв приходит событием, а не исключением, — ловить надо оба.
 */
function printLines(lines: Iterable<string>): number {
  process.stdout.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code !== "EPIPE") throw e;
  });
  try {
    process.stdout.write([...lines].join("\n") + "\n");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EPIPE") throw e;
  }
  return 0;
}

function fail(message: string): void {
  process.stderr.write(`${APP}: ${message}\n`);
}

/** Ключ командной строки, затем конфиг, затем прошлый запуск. */
function choose<T>(fromArgs: T | undefined, fromConfig: T | undefined, saved: T | undefined, fallback: T): T {
  if (fromArgs !== undefined) return fromArgs;
  if (fromConfig !== undefined) return fromConfig;
  return saved ?? fallback;
}

/**
 * Пишет закладки в файл рядом с тем, откуда запущена читалка.
 *
 * Текст и имя файла готовит ядро; здесь только запись и сообщение, которое
 * читатель увидит в строке состояния.
 */
function exportBookmarks(book: Book, marks: Bookmark[]): string {
  const target = join(process.cwd(), bookmarksFileName(book.title));
  try {
    writeFileSync(target, bookmarksMarkdown(book, marks), "utf-8");
  } catch (e) {
    return `не удалось записать файл: ${(e as Error).message}`;
  }
  return `закладки сохранены: ${target}`;
}

async function writeConfigSample(path: string): Promise<number> {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, configSample(), "utf-8");
  } catch (e) {
    return printLines([`не удалось записать ${path}: ${(e as Error).message}`]);
  }
  return printLines([`образец настроек записан: ${path}`]);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: Args;
  try {
    args = parseCliArgs(argv);
  } catch (e) {
    fail(e instanceof ArgsError ? e.message : String(e));
    return 2;
  }

  if (args.help) return printLines([HELP]);
  if (args.version) return printLines([`${APP} ${VERSION}`]);
  if (args.writeConfig) return writeConfigSample(args.config ?? configFile());

  const configPath = args.config ?? configFile();
  let config: ConfigResult = { prefs: {}, sync: {}, keys: {}, notes: [] };
  try {
    config = readConfig(await readFile(configPath, "utf-8"));
  } catch (e) {
    // Файла может не быть — это обычное дело и не повод для сообщения.
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") fail(`конфиг не прочитан: ${(e as Error).message}`);
  }
  for (const note of config.notes) fail(note);

  const store = new JsonFileStore();

  // Команды синхронизации. Книгу с именем «sync» это не заслоняет: если
  // такой файл есть, он и открывается — команду тогда пишут как ./sync.
  if (args.command && !safeExists(args.command)) {
    switch (args.command) {
      case "sync":
        return cmdSync(config.sync, store);
      case "remote":
        return cmdRemote(config.sync);
      case "push":
        return cmdPush(config.sync, args.file, args.all, store);
      case "pull":
        return cmdPull(config.sync, args.file, args.all, store);
      case "forget":
        return cmdForget(config.sync, args.file);
    }
  }

  const settings = await store.loadSettings();
  const prefs: Prefs = {
    theme: choose(args.theme, config.prefs.theme, settings.theme as Theme, "auto"),
    spacing: choose(args.spacing, config.prefs.spacing, settings.spacing, 1),
    columns: choose(args.columns, config.prefs.columns, settings.columns, 1),
    images: choose(args.images, config.prefs.images, undefined, "auto"),
    mouse: choose(args.mouse, config.prefs.mouse, settings.mouse, true),
    justify: choose(args.justify, config.prefs.justify, settings.justify as boolean, false),
    hyphens: choose(args.hyphens, config.prefs.hyphens, settings.hyphens as boolean, false),
    width: choose(args.width, config.prefs.width, undefined, 80),
    keys: config.keys,
  };

  // Режим библиотеки: без аргумента или с каталогом.
  const isDirectory = args.file ? safeIsDirectory(args.file) : true;
  if (isDirectory) {
    if (args.dump || args.toc || args.info) {
      fail("для --dump/--toc/--info нужен файл книги");
      return 2;
    }
    const found: ChooserEntry[] = args.file
      ? await scanDir(args.file, store)
      : (await store.recent()).map((e) => ({ ...e }));

    // Книги, лежащие только на сервере, показываются облаком и скачиваются
    // по Enter. Сервер спрашивается недолго и без шума: если он недоступен,
    // список появляется сразу и просто без облаков.
    const librarySync = syncSettings(config.sync);

    /**
     * Дописывает к списку книги, которые есть только на сервере.
     *
     * Всегда возвращает новый массив: тот, что пришёл, может лежать у
     * вызывающего, и менять его на месте — верный способ обнулить список.
     */
    const addRemote = async (list: ChooserEntry[]): Promise<ChooserEntry[]> => {
      const out = list.filter((e) => !e.remote);
      if (!librarySync) return out;
      const have = new Set((await store.syncableStates(librarySync.device)).map((s) => s.hash));
      for (const book of await remoteOnly(librarySync, have)) {
        out.push({
          path: "",
          title: book.title,
          author: book.author,
          percent: null,
          remote: book.hash,
        });
      }
      return out;
    };

    const entries = await addRemote(found);

    if (!entries.length) {
      fail(`в ${args.file ?? "истории чтения"} книг не нашлось`);
      return 1;
    }
    // Вывод не в терминал — печатаем список текстом: так работает
    // `fb2read ~/books | grep`, и экран при этом не занимается.
    if (!process.stdout.isTTY) return printLines(libraryLines(entries));

    // Список пересобирается целиком: и прогресс, и книги с сервера могли
    // измениться, а подправлять их на месте — искать ошибок на ровном месте.
    const rebuild = async (): Promise<ChooserEntry[]> => {
      const fresh = args.file
        ? await scanDir(args.file, store)
        : (await store.recent()).map((e) => ({ ...e }));
      return addRemote(fresh);
    };

    const after = await runLibrary(new NodeTerminal(), {
      entries,
      prefs,
      store,
      fromStart: args.fromStart,
      exportBookmarks,
      version: VERSION,
      add: async (where: string) => {
        const got = await addToLibrary(where, libraryDir(), store);
        return got.count ? { text: got.text, entries: await rebuild() } : { text: got.text };
      },
      ...(librarySync
        ? {
            download: (hash: string, name: string) => downloadBook(librarySync, store, hash, name),
            ...(librarySync.upload
              ? {
                  keep: (path: string, meta: { hash: string; title: string; author: string }) =>
                    keepOnServer(librarySync, path, meta),
                }
              : {}),
            syncNow:
              (
                key: string,
                meta: { hash: string; title: string; author: string; total: number },
                path: string,
              ) =>
              (block: number, marks: Bookmark[]) =>
                syncOnDemand(librarySync, store, key, meta, path, block, marks),
            syncAll: async () => {
              try {
                const text = await syncAllQuiet(librarySync, store);
                return { text, entries: await rebuild() };
              } catch (e) {
                return { text: `не вышло: ${(e as Error).message}` };
              }
            },
          }
        : {}),
    });
    await store.saveSettings({
      theme: after.theme,
      spacing: after.spacing,
      columns: after.columns,
      mouse: after.mouse,
      justify: after.justify,
      hyphens: after.hyphens,
    });
    return 0;
  }

  let book: Book;
  let source: FileSource;
  try {
    source = new FileSource(args.file!);
    book = await Book.open(source);
  } catch (e) {
    fail(`${args.file}: ${(e as Error).message}`);
    return 1;
  }

  if (args.info) {
    return printLines([
      `Формат:   ${book.format}`,
      ...book.repairs.map((n) => `Правки:   ${n}`),
      `Название: ${book.title}`,
      `Автор:    ${book.author || "—"}`,
      `Серия:    ${book.series || "—"}`,
      `Абзацев:  ${book.blocks.length}`,
      `Глав:     ${book.toc.length}`,
    ]);
  }

  if (args.toc) {
    return printLines(book.toc.map((t) => "  ".repeat(Math.min(t.level, 4)) + t.title));
  }

  if (args.dump) {
    return printLines(
      layout(book.blocks, prefs.width, prefs.spacing, {
        justify: prefs.justify,
        hyphens: prefs.hyphens,
      }).map((l) => l.text),
    );
  }

  if (!process.stdout.isTTY) {
    fail("вывод не в терминал, используйте --dump");
    return 2;
  }

  const path = resolve(args.file!);
  const key = await bookKey(path, source.size);

  // Слияние до чтения, а не после: смысл в том, чтобы книга открылась там,
  // где её оставили на другом устройстве. Ждём не дольше трёх секунд —
  // читатель пришёл читать, а не смотреть на сеть.
  const sync = syncSettings(config.sync);
  let syncNote = "";
  if (sync?.auto) {
    const before = await store.record(key);
    const outcome = await syncOne(
      sync,
      store,
      key,
      {
        hash: book.hash,
        block: before?.block ?? 0,
        total: book.blocks.length,
        title: book.title,
        author: book.author,
        at: before?.at ?? 0,
        device: sync.device,
        bookmarks: before?.bookmarks ?? [],
      },
      path,
    );
    syncNote = outcome.note;
  }

  // Книга уезжает на сервер целиком, пока её читают: сорок мегабайт по узкому
  // каналу идут долго, и ждать этого читателю ни на входе, ни на выходе
  // незачем. Обещание не отвергается никогда — внутри всё поймано.
  let uploaded: string | null = null;
  const uploading = sync?.upload
    ? keepOnServer(sync, path, { hash: book.hash, title: book.title, author: book.author }).then(
        (note) => (uploaded = note),
      )
    : null;

  const start = args.fromStart ? 0 : await store.loadPosition(key);
  const bookmarks = await store.loadBookmarks(key);

  const session = new Session(new NodeTerminal());
  session.begin(prefs.mouse);
  let result;
  try {
    result = await readBook(session, {
      book,
      path,
      width: prefs.width,
      startBlock: start,
      theme: prefs.theme,
      spacing: prefs.spacing,
      columns: prefs.columns,
      images: prefs.images,
      imagesOff: prefs.images === "off",
      mouse: prefs.mouse,
      justify: prefs.justify,
      hyphens: prefs.hyphens,
      keys: prefs.keys,
      bookmarks,
      notice: syncNote,
      version: VERSION,
      syncNow: sync
        ? (block, marks) =>
            syncOnDemand(
              sync,
              store,
              key,
              {
                hash: book.hash,
                title: book.title,
                author: book.author,
                total: book.blocks.length,
              },
              path,
              block,
              marks,
            )
        : undefined,
      saveBookmarks: (marks) => {
        void store.saveBookmarks(key, marks, {
          title: book.title,
          author: book.author,
          total: book.blocks.length,
          path,
        });
      },
      exportBookmarks: (marks) => exportBookmarks(book, marks),
    });
  } finally {
    session.end();
  }
  await store.savePosition(key, {
    block: result.block,
    title: book.title,
    author: book.author,
    total: book.blocks.length,
    path,
    at: Date.now() / 1000,
    hash: book.hash,
  });
  // Способ показа картинок не запоминаем: он зависит от того, в каком
  // терминале книгу открыли сейчас.
  await store.saveSettings({
    theme: result.reader.theme.name,
    spacing: result.reader.spacing,
    columns: result.reader.columns,
    mouse: result.reader.mouse,
  });

  // Отправляем, где остановились. Экран уже отпущен, поэтому сообщение
  // печатается обычной строкой и никуда не пропадает.
  if (sync?.auto) {
    const outcome = await syncOne(
      sync,
      store,
      key,
      {
        hash: book.hash,
        block: result.block,
        total: book.blocks.length,
        title: book.title,
        author: book.author,
        at: Date.now() / 1000,
        device: sync.device,
        bookmarks: result.bookmarks,
      },
      path,
    );
    if (!outcome.state) fail(`синхронизация не удалась: ${outcome.note}`);
  }

  // Выгрузка книги почти всегда закончилась, пока читали. Если нет — ждём,
  // предупредив: иначе выход выглядел бы зависанием.
  if (uploading) {
    if (uploaded === null) printLines(["дожидаюсь выгрузки книги на сервер…"]);
    await uploading;
    if (uploaded) printLines([uploaded]);
  }
  return 0;
}

function safeIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false; // нет такого файла — пусть об этом скажет открытие книги
  }
}

/** Есть ли такой файл или каталог: команда не должна заслонять книгу. */
function safeExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

const invoked = process.argv[1] ?? "";
if (invoked.includes("fb2read") || invoked.endsWith("main.ts")) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      fail((e as Error).message);
      process.exitCode = 1;
    },
  );
}
