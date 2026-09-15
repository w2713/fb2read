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
 *   <корень>/<пользователь>/graveyard.json
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

/** Счётчик временных файлов: имя должно быть своим у каждой записи. */
let temporaries = 0;

/**
 * Запись через временное имя.
 *
 * Обрыв на середине оставит целым прежний файл, а не половину нового:
 * потерять позицию чтения обидно, но испорченный index.json хуже — он
 * прячет сразу все книги.
 *
 * Временное имя своё у каждой записи. Общее имя на всех значило бы, что две
 * записи разом переименуют одно и то же: первая уносит временный файл себе,
 * вторая падает на `rename` с ENOENT. Так и случалось при выгрузке двух книг
 * одновременно, пока указатель правился без общей очереди.
 *
 * Очередь это и закрывает, а имя остаётся второй линией: на будущие пути,
 * которые кто-нибудь однажды запишет из двух мест разом. Двух серверов над
 * одним каталогом оно, впрочем, не спасает — там разъедется и слияние
 * состояния, у которого очередь тоже своя на процесс.
 */
async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  temporaries += 1;
  const temp = `${path}.${process.pid}.${temporaries}.tmp`;
  try {
    await writeFile(temp, data);
    await rename(temp, path);
  } catch (e) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw e;
  }
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

  /**
   * Правит указатель книг под общей очередью.
   *
   * Очередь на книгу тут не спасает: указатель один на всех, и две книги,
   * выгруженные разом, читали его одинаковым, а писали по очереди — вторая
   * запись теряла первую книгу. Поэтому правка указателя выстраивается в свою
   * цепочку, общую для пользователя.
   */
  private editIndex<T>(user: string, edit: (index: Record<string, BookEntry>) => T): Promise<T> {
    return this.serial(`${user}/index`, async () => {
      const index = await this.index(user);
      const got = edit(index);
      await writeAtomic(this.indexPath(user), JSON.stringify(index, null, 1));
      return got;
    });
  }

  // --- надгробия -----------------------------------------------------------

  private graveyardPath(user: string): string {
    return join(this.dir(user), "graveyard.json");
  }

  /**
   * Отпечатки книг, удалённых с сервера.
   *
   * Без этой памяти удаление отменяется само: любое устройство, где книга
   * осталась, выгружает её при первом же обмене — а обмен затевается сам, без
   * спроса. Надгробие стоит недорого: отпечаток и время, около восьмидесяти
   * байт, то есть тысяча удалённых книг — восемьдесят килобайт.
   *
   * Лежит в каталоге пользователя: сосед про мои удаления знать не должен.
   */
  async buried(user: string): Promise<Set<string>> {
    return new Set(Object.keys(await readJson<Record<string, number>>(this.graveyardPath(user), {})));
  }

  private editGraveyard(user: string, edit: (graveyard: Record<string, number>) => void): Promise<void> {
    return this.serial(`${user}/graveyard`, async () => {
      const graveyard = await readJson<Record<string, number>>(this.graveyardPath(user), {});
      edit(graveyard);
      await writeAtomic(this.graveyardPath(user), JSON.stringify(graveyard, null, 1));
    });
  }

  /** Снимает надгробие: книгу снова принимают как обычную. */
  async unbury(user: string, hash: string): Promise<void> {
    await this.editGraveyard(user, (graveyard) => {
      delete graveyard[hash];
    });
  }

  /** Кладёт книгу и запоминает её в указателе. */
  async putBook(user: string, entry: BookEntry, data: Uint8Array): Promise<void> {
    await this.serial(`${user}/${entry.hash}`, async () => {
      // Сначала байты, потом запись о них: книга без записи просто не видна, а
      // запись без книги обещает то, чего скачать нельзя.
      await writeAtomic(join(this.dir(user), "books", `${entry.hash}${entry.ext}`), data);
      await this.editIndex(user, (index) => {
        index[entry.hash] = entry;
      });
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

  /**
   * Удаляет книгу вместе с её состоянием и ставит надгробие.
   *
   * Надгробие ставится и тогда, когда удалять было нечего: удаляют обычно с
   * того устройства, где книгу видно, а вернуть её может любое другое — и
   * порядок, в котором они доберутся до сервера, никому не известен.
   *
   * Состояние уносится и без записи в указателе: позицию синхронизируют и для
   * книг, лежащих только на устройствах, а «удалить с сервера» — это и про
   * неё. Поэтому удалённым считается и такой случай: что-то на сервере было.
   */
  async deleteBook(user: string, hash: string): Promise<boolean> {
    return this.serial(`${user}/${hash}`, async () => {
      await this.editGraveyard(user, (graveyard) => {
        graveyard[hash] = Date.now() / 1000;
      });
      const entry = await this.editIndex(user, (index) => {
        const found = index[hash] ?? null;
        delete index[hash];
        return found;
      });
      const hadState = (await this.state(user, hash)) !== null;
      if (entry) await rm(join(this.dir(user), "books", `${hash}${entry.ext}`), { force: true });
      if (entry || hadState) await rm(this.statePath(user, hash), { force: true });
      return Boolean(entry) || hadState;
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
