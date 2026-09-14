/**
 * Полка: чем её разложить и что на ней оставить.
 *
 * Полка собирается в `shelf.ts` — там решается, какие строки на ней стоят.
 * Здесь решается другое: в каком порядке их показать, какие скрыть и подходит
 * ли книга под то, что читатель набрал в поле. Ни DOM, ни хранилища здесь нет,
 * поэтому всё это проверяется обычными проверками.
 *
 * Зачем это вообще. До сих пор полка была одной лентой по времени, и на
 * телефоне с пятью книгами этого хватало. На настольном экране книг видно
 * десятки, а лента отвечает только на вопрос «что я читал последним» — тогда
 * как спрашивают ещё «где вторая книга этого автора», «что я так и не открыл»
 * и «что тут занимает место».
 *
 * Отбор — не поиск по книгам: тот перебирает текст всех книг и живёт в
 * `libfind.ts` ядра. Здесь смотрят только на название и автора, то есть ответ
 * получается сразу, на каждое нажатие клавиши.
 */

import { normalize } from "@fb2read/core";
import type { ShelfEntry } from "./shelf.js";

/** Чем разложить полку. */
export const ORDERS = ["recent", "title", "author", "size"] as const;

export type ShelfOrder = (typeof ORDERS)[number];

/** По времени — то, чем полка была всегда: последнее читанное сверху. */
export const DEFAULT_ORDER: ShelfOrder = "recent";

export const ORDER_NAMES: Record<ShelfOrder, string> = {
  recent: "по времени",
  title: "по названию",
  author: "по автору",
  size: "по размеру",
};

/** Какие книги показывать. */
export const KINDS = ["all", "reading", "fresh", "done"] as const;

export type ShelfKind = (typeof KINDS)[number];

export const DEFAULT_KIND: ShelfKind = "all";

export const KIND_NAMES: Record<ShelfKind, string> = {
  all: "Все",
  reading: "Читаю",
  fresh: "Не начатые",
  done: "Дочитанные",
};

/**
 * С какого процента книга считается дочитанной.
 *
 * Не с сотого, и это не вкусовщина, а измерение. Процент считается по абзацу у
 * верхнего края экрана, поэтому у конца книги он упирается в потолок: последний
 * экран текста так и остаётся ниже отметки. В настоящем Chromium, окно
 * 1280×720, книга, прокрученная до самого низа, показывает
 *
 *     200 абзацев — 95 %       800 абзацев — 99 %
 *     400 абзацев — 98 %      3000 абзацев — 100 %
 *
 * Отсюда порог: 95. О брошюре он сказать ничего не может — тридцать абзацев в
 * конце дают 63 %, потому что последний экран занимает треть такой книги; но
 * брошюру и не ищут в отборе «дочитанные». Расплата за порог обратная: книга,
 * оставленная за двадцать страниц до конца, тоже попадёт в дочитанные. Для
 * отбора это не беда — хуже было бы, если бы в «читаю» вечно висело то, что
 * прочитано.
 */
export const DONE_PERCENT = 95;

/** Как читатель хочет видеть полку. */
export interface ShelfView {
  order: ShelfOrder;
  kind: ShelfKind;
  /** Название или автор; пустая строка — показывать всё. */
  query: string;
}

/** Вид полки по умолчанию: всё по времени, как было. */
export const DEFAULT_VIEW: ShelfView = { order: DEFAULT_ORDER, kind: DEFAULT_KIND, query: "" };

/** Дочитана ли книга. */
export function isDone(entry: ShelfEntry): boolean {
  return entry.percent !== null && entry.percent >= DONE_PERCENT;
}

/**
 * Начато ли чтение.
 *
 * Не «открывали ли книгу»: в браузере книгу открывают тем же движением, каким
 * кладут на полку, — выбрал файл, и он уже на экране. Нечитанное отличается
 * поэтому не открытием, а тем, что чтение не двинулось с начала. Книга без
 * записи о месте — тоже нетронутая: так приезжают книги с сервера.
 */
export function isFresh(entry: ShelfEntry): boolean {
  return !entry.read || entry.percent === 0;
}

/** Подходит ли книга под этот отбор. */
export function inKind(entry: ShelfEntry, kind: ShelfKind): boolean {
  switch (kind) {
    case "fresh":
      return isFresh(entry);
    case "done":
      return isDone(entry);
    case "reading":
      // То, к чему возвращаются: начато и не дочитано.
      return !isFresh(entry) && !isDone(entry);
    default:
      return true;
  }
}

/**
 * Подходит ли книга под набранное.
 *
 * Слова запроса ищутся по названию и автору вместе, каждое по отдельности, —
 * так «толстой война» находит книгу, хотя автор и название лежат в разных
 * полях и в другом порядке. Регистр не важен, ё и е считаются одной буквой:
 * приведение то же, что в поиске по тексту книги.
 */
export function matchBook(entry: ShelfEntry, query: string): boolean {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = normalize(`${entry.title} ${entry.author}`);
  return words.every((word) => haystack.includes(word));
}

/**
 * Сравнение названий и имён по-русски.
 *
 * Сравнение по знакам поставило бы строчную «ё» после всех прописных, а
 * «Том 10» — перед «Томом 2». Сличатель с `numeric` и без разбора регистра
 * отвечает так, как читатель и ожидает увидеть.
 */
const collator = new Intl.Collator("ru", { numeric: true, sensitivity: "base" });

/** Сколько книг в каждом отборе: по числу видно, есть ли смысл туда ходить. */
export function shelfCounts(entries: readonly ShelfEntry[]): Record<ShelfKind, number> {
  const counts = { all: 0, reading: 0, fresh: 0, done: 0 };
  for (const entry of entries) {
    for (const kind of KINDS) if (inKind(entry, kind)) counts[kind] += 1;
  }
  return counts;
}

/**
 * Раскладывает полку: отбор, поиск по названию и порядок.
 *
 * Исходный список не переставляется: из него же считаются числа у отборов, и
 * перестановка на месте сдвинула бы полку под читателем.
 *
 * У каждого порядка есть второй ключ, и он не для красоты: без него две книги
 * с одинаковым именем автора вставали бы то так, то иначе, и полка
 * перемешивалась бы сама собой при каждой перерисовке. Книги одного автора
 * идут по названию, а всё прочее при равенстве — по времени, то есть привычной
 * лентой.
 */
export function arrangeShelf(entries: readonly ShelfEntry[], view: ShelfView): ShelfEntry[] {
  const kept = entries.filter((entry) => inKind(entry, view.kind) && matchBook(entry, view.query));
  const byTitle = (a: ShelfEntry, b: ShelfEntry): number => collator.compare(a.title, b.title);
  const byTime = (a: ShelfEntry, b: ShelfEntry): number => b.at - a.at;
  switch (view.order) {
    case "title":
      return kept.sort((a, b) => byTitle(a, b) || byTime(a, b));
    case "author":
      // Книга без автора — обычное дело у самодельных файлов. Пустое имя уходит
      // в конец, а не возглавляет полку.
      return kept.sort(
        (a, b) =>
          Number(!a.author) - Number(!b.author) ||
          collator.compare(a.author, b.author) ||
          byTitle(a, b),
      );
    case "size":
      // Крупные сверху: по размеру смотрят, когда решают, что убрать.
      return kept.sort((a, b) => b.size - a.size || byTitle(a, b));
    default:
      return kept.sort(byTime);
  }
}

/**
 * Порядок из запомненного значения.
 *
 * Чужое значение не исправляется на ближайшее, а отбрасывается: в хранилище оно
 * могло попасть из будущей версии читалки, и угадывать, что там имелось в виду,
 * незачем — привычная лента вернее.
 */
export function orderOf(value: unknown): ShelfOrder {
  return ORDERS.includes(value as ShelfOrder) ? (value as ShelfOrder) : DEFAULT_ORDER;
}

/** Отбор из запомненного значения — так же. */
export function kindOf(value: unknown): ShelfKind {
  return KINDS.includes(value as ShelfKind) ? (value as ShelfKind) : DEFAULT_KIND;
}
