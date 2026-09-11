/**
 * Где читатель сейчас и как это запомнить.
 *
 * Наблюдение за экраном и запись разведены нарочно. За экраном следит
 * IntersectionObserver — его в тестах не подделать без браузера; а вот когда
 * записывать, решает чистая логика, и её проверить надо обязательно: ошибка
 * здесь стоит потерянного места в книге.
 */

import type { StateStore, PositionRecord } from "@fb2read/core";

/**
 * Придержка записи.
 *
 * Прокрутка меняет текущий блок десятки раз в секунду, и писать каждый раз в
 * IndexedDB — значит толкать телефон в постоянную запись на диск. Раз в
 * секунду достаточно: больше секунды чтения при внезапном закрытии не теряется.
 */
export const SAVE_EVERY_MS = 1000;

export interface Keeper {
  /** Читатель оказался на этом блоке. */
  moved(block: number): void;
  /** Записать немедленно: страница уходит, тянуть нельзя. */
  flush(): Promise<void>;
  /** Где сейчас. */
  current(): number;
  /** Прекратить слежение: книгу закрыли. */
  stop(): void;
}

export interface KeeperOptions {
  store: StateStore;
  key: string;
  meta: Omit<PositionRecord, "block" | "at">;
  /** Подменяется в тестах. */
  now?: () => number;
  /** Подменяется в тестах. */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (id: unknown) => void;
}

/**
 * Копит перемещения и пишет их не чаще, чем нужно.
 *
 * Последнее известное место не теряется: если придержка отложила запись, её
 * всё равно сделают — по таймеру или по `flush`.
 */
export function keepPosition(options: KeeperOptions): Keeper {
  const now = options.now ?? (() => Date.now());
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = options.cancel ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));

  let block = 0;
  let written = -1;
  let lastWriteAt = -Infinity;
  let timer: unknown = null;
  let stopped = false;

  async function write(): Promise<void> {
    if (written === block) return;
    written = block;
    lastWriteAt = now();
    await options.store.savePosition(options.key, {
      ...options.meta,
      block,
      at: now() / 1000,
    });
  }

  function later(): void {
    if (timer !== null || stopped) return;
    const wait = Math.max(SAVE_EVERY_MS - (now() - lastWriteAt), 0);
    timer = schedule(() => {
      timer = null;
      void write();
    }, wait);
  }

  return {
    moved(next: number): void {
      if (stopped || next === block) return;
      block = next;
      later();
    },
    async flush(): Promise<void> {
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
      await write();
    },
    current: () => block,
    stop(): void {
      stopped = true;
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
    },
  };
}

/**
 * Какой блок читают — двоичным поиском по странице.
 *
 * Берётся самый верхний из видимых: читатель смотрит в верх окна, и именно
 * туда его надо будет вернуть. Брать самый заметный неверно — на длинном
 * абзаце это уводило бы позицию вперёд.
 *
 * Раньше тут перебирались все видимые абзацы, которые называл наблюдатель за
 * экраном. Перебор стоил шести тысяч замеров на книгу, а наблюдатель отвечал с
 * запозданием — и то и другое обходилось читателю потерянным местом. Абзацы
 * лежат в странице по порядку, и верх каждого следующего не меньше
 * предыдущего, поэтому нужный находится делением пополам: тринадцать замеров
 * вместо шести тысяч, и ответ не вчерашний, а сиюминутный.
 *
 * `topAt` спрашивают лениво — в этом весь смысл: измеряется только то, о чём
 * поиск действительно спросил. Отсчёт идёт от низа панели, а не от верха окна:
 * под панелью текста не видно, и абзац, спрятанный за ней, читают уже не его.
 */
export function searchTop(count: number, topAt: (index: number) => number): number | null {
  if (count <= 0) return null;

  // Начало книги — случай без отдельной ветки: выше края тогда нет ничего,
  // граница так и не сдвигается с нуля, и ответом выходит первый видимый
  // абзац. Ровно он и нужен. Отдельная проверка на этот случай тут была, и
  // оказалась мёртвой: убрать её ни одна проверка не заметила.
  let low = 0;
  let high = count - 1;
  while (low < high) {
    // Середина с округлением вверх: иначе `low = mid` не сдвинет границу и
    // поиск завертится на месте.
    const mid = (low + high + 1) >> 1;
    if (topAt(mid) <= 0) low = mid;
    else high = mid - 1;
  }
  return low;
}
