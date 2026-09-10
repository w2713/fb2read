/**
 * Синхронизация браузерной читалки с сервером.
 *
 * Ради этого затевалось всё остальное: место в книге хранится номером абзаца,
 * ключ книги — отпечатком содержимого, а закладки умеют надгробия. Здесь эти
 * решения наконец сходятся: книга, брошенная на ноутбуке, открывается на
 * телефоне там же, где её оставили.
 *
 * Клиент берётся из ядра — тот же самый, что в терминале. Он с самого начала
 * писался без привязки к платформе и берёт `fetch` у среды, так что менять в
 * нём ничего не пришлось.
 *
 * DOM сюда не заходит: обмен возвращает отчёт, а показывает его тот, кто
 * вызвал.
 */

import {
  SyncClient,
  SyncError,
  mergeState,
  type Settings,
  type SyncState,
} from "@fb2read/core";
import type { IdbStore } from "./db.js";

export interface SyncSettings {
  url: string;
  token: string;
  /** Имя устройства: по нему видно, откуда приехало место. */
  device: string;
  /** Обмениваться ли самому при закрытии книги. */
  auto: boolean;
}

/** Что вышло из обмена — словами, которые можно показать читателю. */
export interface SyncReport {
  ok: boolean;
  text: string;
  /** Книги, приехавшие с сервера: полку надо перерисовать. */
  arrived: number;
}

/**
 * Настройки обмена из общего хранилища настроек.
 *
 * Пока нет адреса, синхронизации нет вовсе: пустой адрес — это не ошибка, а
 * обычное состояние читалки, которой сервер не нужен.
 */
export function syncSettings(settings: Settings): SyncSettings | null {
  const url = typeof settings["syncUrl"] === "string" ? settings["syncUrl"].trim() : "";
  if (!url) return null;
  const token = typeof settings["syncToken"] === "string" ? settings["syncToken"] : "";
  const device = typeof settings["device"] === "string" && settings["device"] ? settings["device"] : "браузер";
  return { url, token, device, auto: settings["syncAuto"] !== false };
}

/** Имя устройства по умолчанию — по тому, откуда читают. */
export function guessDevice(agent: string): string {
  if (/iPhone|iPad|iPod/i.test(agent)) return "iPhone";
  if (/Android/i.test(agent)) return "Android";
  if (/Mac OS X/i.test(agent)) return "Mac";
  if (/Windows/i.test(agent)) return "Windows";
  return "браузер";
}

/**
 * Изменилось ли состояние после обмена.
 *
 * Сравнивается содержимое, а не длина списка: снятая и поставленная закладка
 * дают ту же длину, и по ней обмен выглядел бы пустым. На эту же удочку
 * читалка в терминале однажды и попалась.
 */
export function changed(sent: SyncState, got: SyncState): boolean {
  if (sent.block !== got.block) return true;
  const mark = (m: { block: number; at?: number; deleted?: boolean }): string =>
    `${m.block}:${m.at ?? 0}:${m.deleted ? 1 : 0}`;
  const before = new Set(sent.bookmarks.map(mark));
  return got.bookmarks.some((m) => !before.has(mark(m)));
}

/** Итог обмена словами. */
export function tell(sent: number, taken: number, updated: number): string {
  if (!sent && !taken && !updated) return "всё и так совпадало";
  const parts: string[] = [];
  if (sent) parts.push(`отправлено книг: ${sent}`);
  if (taken) parts.push(`получено книг: ${taken}`);
  if (updated) parts.push(`обновилось мест: ${updated}`);
  return parts.join(", ");
}

export function client(settings: SyncSettings, timeoutMs: number): SyncClient {
  return new SyncClient({
    url: settings.url,
    token: settings.token,
    device: settings.device,
    timeoutMs,
  });
}

/**
 * Забирает с сервера одну книгу и возвращает её на полку.
 *
 * Нужна тому, кто убрал книгу с устройства, а потом передумал: снятая книга
 * остаётся видна облаком, и это единственный способ вернуть её обратно.
 */
export async function fetchBook(
  store: IdbStore,
  settings: SyncSettings,
  hash: string,
): Promise<string> {
  try {
    const api = client(settings, 120_000);
    const there = (await api.list()).find((book) => book.hash === hash);
    if (!there) {
      // Книгу могли удалить с сервера с другого устройства. Держать облако,
      // за которым ничего нет, — обманывать читателя.
      await store.undrop(hash);
      return "книги на сервере больше нет";
    }
    const bytes = await api.download(hash);
    await store.putBook(
      {
        hash,
        name: there.name,
        title: there.title,
        author: there.author,
        size: bytes.length,
        addedAt: Date.now() / 1000,
      },
      new Blob([bytes as unknown as BlobPart]),
    );
    await store.undrop(hash);
    return `вернулась: ${there.title || there.name}`;
  } catch (e) {
    return `не вышло: ${e instanceof SyncError ? e.message : (e as Error).message}`;
  }
}

/**
 * Удаляет книгу с сервера — вместе с местом и закладками.
 *
 * Отдельно от «убрать с устройства» намеренно: одно освобождает место на
 * телефоне, другое отбирает книгу у всех устройств сразу.
 */
export async function forgetBook(
  store: IdbStore,
  settings: SyncSettings,
  hash: string,
): Promise<string> {
  try {
    await client(settings, 60_000).remove(hash);
    await store.undrop(hash);
    return "удалена с сервера";
  } catch (e) {
    return `не вышло: ${e instanceof SyncError ? e.message : (e as Error).message}`;
  }
}

/**
 * Полный обмен: книги в обе стороны и места по всем книгам.
 *
 * Книги отправляются и забираются раньше мест: место без книги читателю
 * бесполезно, а книга без места открывается с начала — потеря куда обиднее.
 */
export async function exchange(store: IdbStore, settings: SyncSettings): Promise<SyncReport> {
  try {
    const api = client(settings, 120_000);
    const remote = await api.list();
    const { books, states } = await store.shelf();

    const there = new Set(remote.map((book) => book.hash));
    const here = new Set(books.map((book) => book.hash));

    let sent = 0;
    for (const book of books) {
      if (there.has(book.hash)) continue;
      const data = await store.bookFile(book.hash);
      if (!data) continue;
      await api.upload(book.hash, book.name, new Uint8Array(await data.arrayBuffer()), {
        title: book.title,
        author: book.author,
      });
      sent += 1;
    }

    // Снятые с полки книги не скачиваются заново. Иначе «убрать» не работает
    // вовсе: обмен видит, что книги нет, и добросовестно возвращает её.
    const dropped = await store.dropped();

    let taken = 0;
    for (const book of remote) {
      if (here.has(book.hash) || dropped.has(book.hash)) continue;
      const bytes = await api.download(book.hash);
      await store.putBook(
        {
          hash: book.hash,
          name: book.name,
          title: book.title,
          author: book.author,
          size: bytes.length,
          addedAt: Date.now() / 1000,
        },
        new Blob([bytes as unknown as BlobPart]),
      );
      taken += 1;
    }

    // Места отправляются по всем книгам, что лежат на полке, — включая
    // только что приехавшие: у них место уже может быть на сервере.
    let updated = 0;
    const known = new Map(states.map((state) => [state.hash ?? "", state]));
    for (const hash of new Set([...here, ...there])) {
      const state = known.get(hash);
      const meta = books.find((book) => book.hash === hash);
      const mine: SyncState = {
        hash,
        block: state?.block ?? 0,
        total: state?.total ?? 0,
        title: state?.title || meta?.title || "",
        author: state?.author || meta?.author || "",
        at: state?.at ?? 0,
        device: settings.device,
        bookmarks: state?.bookmarks ?? [],
      };
      const { state: merged } = await api.pushState(mine);
      await store.applyState(hash, mergeState(mine, merged));
      if (changed(mine, merged)) updated += 1;
    }

    return { ok: true, text: tell(sent, taken, updated), arrived: taken };
  } catch (e) {
    // Читатель нажал кнопку и ждёт ответа: молчать нельзя, но и мешать
    // чтению эта неудача не должна.
    const why = e instanceof SyncError ? e.message : (e as Error).message;
    return { ok: false, text: `не вышло: ${why}`, arrived: 0 };
  }
}
