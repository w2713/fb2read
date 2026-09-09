/**
 * Хранилище сервера: книги и состояние в каталоге на диске.
 *
 * База данных не нужна: книг у человека сотни, а не миллионы, и каталог с
 * файлами можно скопировать, положить в архив и посмотреть глазами. Внутри
 * у каждого пользователя своя папка, чтобы токены не видели чужого:
 *
 *   <корень>/<пользователь>/books/<отпечаток><расширение>
 *   <корень>/<пользователь>/state/<отпечаток>.json
 *   <корень>/<пользователь>/index.json
 *
 * Отпечаток — sha256 содержимого книги, тот же, по которому книга узнаётся
 * на другом устройстве.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { mergeState, type SyncState } from "@fb2read/core";

/** Что известно о книге, лежащей на сервере. */
export interface BookEntry {
  hash: string;
  name: string;
  size: number;
  title: string;
  author: string;
  updatedAt: number;
  /** Расширение с точкой: по нему собирается имя файла. */
  ext: string;
}

/**
 * Состояние с отметкой сервера.
 *
 * Своя отметка нужна для выборки «что изменилось с такого-то времени»: у
 * `state.at` часы клиента, а они у устройств расходятся. Отбирать по чужим
 * часам значит терять записи или слать одно и то же по кругу.
 */
interface StoredState {
  state: SyncState;
  updatedAt: number;
}

const HASH = /^[0-9a-f]{64}$/;

/** Отпечаток должен быть отпечатком, а не путём: файл кладётся по этому имени. */
export function isHash(value: string): boolean {
  return HASH.test(value);
}

/** Расширение книги; всё незнакомое приводится к .fb2. */
export function safeExt(name: string): string {
  const match = /\.(fb2\.zip|fb2|fbz|epub|zip)$/i.exec(name);
  return match ? `.${match[1]!.toLowerCase()}` : ".fb2";
}

/** Читает JSON или отдаёт запасное значение, если файла нет или он испорчен. */
async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

/**
 * Запись через временное имя.
 *
 * Обрыв на середине оставит целым прежний файл, а не половину нового:
 * потерять позицию чтения обидно, но испорченный index.json хуже — он
 * прячет сразу все книги.
 */
async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, data);
  await rename(temp, path);
}

export class Storage {
  /**
   * Очередь операций на каждую книгу.
   *
   * Слияние состояния — это «прочитать, слить, записать» с ожиданием между
   * шагами. Два запроса по одной книге, пришедшие разом, успели бы прочитать
   * одно и то же и один затёр бы другого. Очередь выстраивает их в цепочку.
   */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly root: string) {}

  private dir(user: string): string {
    return join(this.root, user);
  }

  private async serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    // В карте хранится только «когда освободится», без результата и без
    // отказа: иначе одна ошибка отравляла бы всю очередь по этой книге.
    this.queues.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  // --- книги ---------------------------------------------------------------

  private indexPath(user: string): string {
    return join(this.dir(user), "index.json");
  }

  async index(user: string): Promise<Record<string, BookEntry>> {
    return readJson<Record<string, BookEntry>>(this.indexPath(user), {});
  }

  /** Все книги пользователя, новые сверху. */
  async books(user: string): Promise<BookEntry[]> {
    const index = await this.index(user);
    return Object.values(index).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async book(user: string, hash: string): Promise<BookEntry | null> {
    return (await this.index(user))[hash] ?? null;
  }

  /** Кладёт книгу и запоминает её в указателе. */
  async putBook(user: string, entry: BookEntry, data: Uint8Array): Promise<void> {
    await this.serial(`${user}/${entry.hash}`, async () => {
      await writeAtomic(join(this.dir(user), "books", `${entry.hash}${entry.ext}`), data);
      const index = await this.index(user);
      index[entry.hash] = entry;
      await writeAtomic(this.indexPath(user), JSON.stringify(index, null, 1));
    });
  }

  async readBook(user: string, hash: string): Promise<Uint8Array | null> {
    const entry = await this.book(user, hash);
    if (!entry) return null;
    try {
      return new Uint8Array(await readFile(join(this.dir(user), "books", `${hash}${entry.ext}`)));
    } catch {
      // Указатель помнит книгу, а файла нет: скажем «нет», а не упадём.
      return null;
    }
  }

  /** Удаляет книгу вместе с её состоянием. */
  async deleteBook(user: string, hash: string): Promise<boolean> {
    return this.serial(`${user}/${hash}`, async () => {
      const index = await this.index(user);
      const entry = index[hash];
      if (!entry) return false;
      delete index[hash];
      await writeAtomic(this.indexPath(user), JSON.stringify(index, null, 1));
      await rm(join(this.dir(user), "books", `${hash}${entry.ext}`), { force: true });
      await rm(join(this.dir(user), "state", `${hash}.json`), { force: true });
      return true;
    });
  }

  // --- состояние -----------------------------------------------------------

  private statePath(user: string, hash: string): string {
    return join(this.dir(user), "state", `${hash}.json`);
  }

  async state(user: string, hash: string): Promise<SyncState | null> {
    const stored = await readJson<StoredState | null>(this.statePath(user, hash), null);
    return stored?.state ?? null;
  }

  /**
   * Сливает присланное состояние с тем, что лежит, и возвращает результат.
   *
   * Присланное идёт вторым аргументом слияния: при совпадении времени до
   * секунды побеждает то, что пришло сейчас.
   */
  async mergeIn(user: string, incoming: SyncState, now: number): Promise<SyncState> {
    return this.serial(`${user}/${incoming.hash}`, async () => {
      const current = await this.state(user, incoming.hash);
      const merged = current ? mergeState(current, incoming) : incoming;
      await writeAtomic(
        this.statePath(user, incoming.hash),
        JSON.stringify({ state: merged, updatedAt: now } satisfies StoredState, null, 1),
      );
      return merged;
    });
  }

  /**
   * Состояния, записанные сервером после указанного времени.
   *
   * Отбор идёт по отметке сервера, а не по `state.at`: часы устройств
   * расходятся, и по чужим часам выборка либо теряла бы записи, либо гоняла
   * бы одни и те же.
   */
  async statesSince(user: string, since: number): Promise<SyncState[]> {
    const out: SyncState[] = [];
    for (const hash of Object.keys(await this.index(user))) {
      const stored = await readJson<StoredState | null>(this.statePath(user, hash), null);
      if (stored && stored.updatedAt > since) out.push(stored.state);
    }
    // Состояние может быть и у книги, которой на сервере нет: позицию
    // синхронизируют и для книг, лежащих только на устройствах.
    for (const stored of await this.orphanStates(user)) {
      if (stored.updatedAt > since) out.push(stored.state);
    }
    return out.sort((a, b) => a.hash.localeCompare(b.hash));
  }

  private async orphanStates(user: string): Promise<StoredState[]> {
    const known = new Set(Object.keys(await this.index(user)));
    const dir = join(this.dir(user), "state");
    let names: string[];
    try {
      const { readdir } = await import("node:fs/promises");
      names = await readdir(dir);
    } catch {
      return [];
    }
    const out: StoredState[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const hash = name.slice(0, -5);
      if (known.has(hash) || !isHash(hash)) continue;
      const stored = await readJson<StoredState | null>(join(dir, name), null);
      if (stored) out.push(stored);
    }
    return out;
  }
}
