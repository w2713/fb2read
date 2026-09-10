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
 * Какой блок считать текущим.
 *
 * Берётся самый верхний из видимых: читатель смотрит в верх окна, и именно
 * туда его надо будет вернуть. Брать самый заметный неверно — на длинном
 * абзаце это уводило бы позицию вперёд.
 */
export function topmost(entries: readonly { block: number; top: number }[]): number | null {
  if (!entries.length) return null;

  // Верх окна — это ноль. Абзац, который читают сейчас, обычно начался выше
  // края экрана, то есть его top отрицателен; из таких берём последний
  // начавшийся — ближайший к краю сверху.
  let above: { block: number; top: number } | null = null;
  let below: { block: number; top: number } | null = null;
  for (const entry of entries) {
    if (entry.top <= 0) {
      if (!above || entry.top > above.top) above = entry;
    } else if (!below || entry.top < below.top) {
      below = entry;
    }
  }

  // Ничего выше края нет — значит, книга в самом начале: берём первый видимый.
  return (above ?? below)!.block;
}
