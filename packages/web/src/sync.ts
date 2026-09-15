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
  bookTimeout,
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

/** Что случилось за обмен — из этого складывается строка для читателя. */
export interface Tally {
  /** Книги, уехавшие на сервер. */
  sent?: number;
  /** Книги, приехавшие с сервера. */
  taken?: number;
  /** Книги, у которых обновилось место или закладки. */
  updated?: number;
  /** Удалённые с сервера, которые не стали возвращать. */
  refused?: number;
  /** Книги, ждущие на сервере: за один обмен полку целиком не тянут. */
  waiting?: number;
  /** Жалоба сервера — например, о разошедшихся часах. */
  warning?: string;
}

/**
 * Итог обмена словами.
 *
 * Жалоба сервера — про часы — идёт следом за итогом, а не вместо него: обмен
 * всё-таки состоялся, и читателю важно и то, и другое.
 *
 * Счётчиков стало пять, и передаются они по имени: пять чисел подряд в вызове
 * читались бы загадкой, а перепутать их местами — дело одной правки.
 */
export function tell(tally: Tally): string {
  const parts: string[] = [];
  if (tally.sent) parts.push(`отправлено книг: ${tally.sent}`);
  if (tally.taken) parts.push(`получено книг: ${tally.taken}`);
  if (tally.updated) parts.push(`обновилось мест: ${tally.updated}`);
  // Про пропущенные говорим прямо: книга лежит на полке, а на сервер не
  // уезжает — молчание об этом читатель принял бы за поломку обмена.
  if (tally.refused) parts.push(`удалённых с сервера не возвращали: ${tally.refused}`);
  // Ждущие — тоже вслух: иначе непонятно, почему книга видна облаком, а обмен
  // прошёл «успешно».
  if (tally.waiting) parts.push(`ждут на сервере: ${tally.waiting} — коснитесь, чтобы забрать`);
  const итог = parts.length ? parts.join(", ") : "всё и так совпадало";
  return tally.warning ? `${итог}; ${tally.warning}` : итог;
}

/**
 * Сколько ждать разговора с сервером: списка, места, удаления.
 *
 * Это короткие запросы, и ждать их минутами незачем: читатель нажал кнопку и
 * смотрит на строку.
 */
export const TALK_TIMEOUT = 30_000;

/**
 * Сколько мегабайт забирать с сервера за один обмен.
 *
 * Обмен затевается и сам — при закрытии книги, — и читатель на телефоне не
 * ждёт, что нажатие «Синхронизировать» притянет всю полку по мобильной связи.
 * Двадцать мегабайт — это несколько книг: то, за чем обмен и нужен.
 */
export const FETCH_BUDGET = 20 * 1024 * 1024;

/**
 * Что забрать сейчас, а что оставить ждать облаком.
 *
 * Книги приходят от сервера новыми сверху, поэтому берутся самые свежие —
 * именно их обычно и ждут на другом устройстве. Остальные никуда не деваются:
 * они видны облаком и забираются касанием, у которого свой срок и свой отчёт.
 *
 * Не влезшая книга не останавливает очередь, а пропускается: иначе одна
 * толстая книга в начале списка держала бы всю полку вечно — каждый обмен
 * упирался бы в неё, и мелкие книги не приезжали бы никогда.
 *
 * Первая книга берётся всегда, даже если она одна толще предела. Иначе такая
 * книга не приехала бы никогда: в браузере за незнакомой книгой сходить нечем,
 * касание есть только у снятых с полки. А так она приедет следующим обменом,
 * когда окажется первой в очереди, — и обмен, в котором она приехала, других
 * книг уже не потянет.
 */
export function budget<T extends { size: number }>(
  wanted: readonly T[],
): { take: T[]; waiting: number } {
  const take: T[] = [];
  let bytes = 0;
  for (const book of wanted) {
    if (take.length > 0 && bytes + book.size > FETCH_BUDGET) continue;
    take.push(book);
    bytes += book.size;
  }
  return { take, waiting: wanted.length - take.length };
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
 * Что за сервер на том конце — словами для читателя.
 *
 * Спрашивается без токена и коротким сроком: это не обмен, а справка, и
 * ждать её десять секунд читателю незачем. Ошибку не бросает вовсе: не
 * ответивший сервер — тоже ответ, и настройки от этого открываться не
 * перестанут.
 */
export async function serverLine(settings: SyncSettings): Promise<string> {
  try {
    const health = await client(settings, 4000).health();
    if (!health.ok) return "сервер отвечает не так, как ожидалось";
    return health.version
      ? `сервер fb2read-server ${health.version}`
      : "сервер версии не назвал — он старее этой читалки";
  } catch (e) {
    return `сервер не отвечает: ${(e as Error).message}`;
  }
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
    const there = (await client(settings, TALK_TIMEOUT).list()).find((book) => book.hash === hash);
    if (!there) {
      // Книгу могли удалить с сервера с другого устройства. Держать облако,
      // за которым ничего нет, — обманывать читателя.
      await store.undrop(hash);
      return "книги на сервере больше нет";
    }
    // Срок — по размеру книги: касанием забирают и толстые, а ждать их
    // столько же, сколько списка, значит не забрать никогда.
    const bytes = await client(settings, bookTimeout(there.size)).download(hash);
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
    await client(settings, TALK_TIMEOUT).remove(hash);
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
    // Разговор коротким сроком, книги — своим на каждую: один срок на всё
    // означал либо вечность в ответ на список, либо заведомо мало на книгу.
    const api = client(settings, TALK_TIMEOUT);
    const { books: remote, buried } = await api.shelf();
    const { books, states } = await store.shelf();

    const there = new Set(remote.map((book) => book.hash));
    const here = new Set(books.map((book) => book.hash));

    let sent = 0;
    // Удалённое с сервера обратно не отправляем. Иначе «удалить с сервера»
    // не работает вовсе: обмен видит, что книги там нет, и добросовестно
    // возвращает её — сам, при закрытии книги, без всякой просьбы.
    let refused = 0;
    for (const book of books) {
      if (there.has(book.hash)) continue;
      if (buried.has(book.hash)) {
        refused += 1;
        continue;
      }
      const data = await store.bookFile(book.hash);
      if (!data) continue;
      const bytes = new Uint8Array(await data.arrayBuffer());
      await client(settings, bookTimeout(bytes.length)).upload(book.hash, book.name, bytes, {
        title: book.title,
        author: book.author,
      });
      sent += 1;
    }

    // Снятые с полки книги не скачиваются заново. Иначе «убрать» не работает
    // вовсе: обмен видит, что книги нет, и добросовестно возвращает её.
    const dropped = await store.dropped();

    // За один обмен берём горстку книг, а не полку целиком: обмен затевается и
    // сам, при закрытии книги, и читатель на телефоне не ждёт, что от этого по
    // мобильной связи приедут все книги сразу. Остальные видны облаком и
    // забираются касанием.
    const { take, waiting } = budget(
      remote.filter((book) => !here.has(book.hash) && !dropped.has(book.hash)),
    );

    let taken = 0;
    for (const book of take) {
      const bytes = await client(settings, bookTimeout(book.size)).download(book.hash);
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
    // Сервер отвечает предупреждением, когда часы устройства разошлись с
    // его собственными. Молчать об этом нельзя: место сливается по времени,
    // и разъехавшиеся часы читатель иначе увидит только по странным прыжкам
    // позиции. Хватит и первого: жалоба одна на все книги.
    let warned = "";
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
      const { state: merged, warning } = await api.pushState(mine);
      if (warning && !warned) warned = warning;
      await store.applyState(hash, mergeState(mine, merged));
      if (changed(mine, merged)) updated += 1;
    }

    return {
      ok: true,
      text: tell({ sent, taken, updated, refused, waiting, warning: warned }),
      arrived: taken,
    };
  } catch (e) {
    // Читатель нажал кнопку и ждёт ответа: молчать нельзя, но и мешать
    // чтению эта неудача не должна.
    const why = e instanceof SyncError ? e.message : (e as Error).message;
    return { ok: false, text: `не вышло: ${why}`, arrived: 0 };
  }
}
