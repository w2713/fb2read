/**
 * Слежение за местом в книге.
 *
 * Здесь проверяется не браузер, а решения: какой блок считать текущим и когда
 * его записывать. Цена ошибки — потерянное место в книге, а это ровно то, ради
 * чего затевалась и синхронизация.
 */

import type { PositionRecord, StateStore } from "@fb2read/core";
import { describe, expect, it, vi } from "vitest";
import { SAVE_EVERY_MS, keepPosition, topmost } from "../src/position.js";

describe("какой блок читают", () => {
  it("тот, что начался выше края экрана", () => {
    // Абзац, который читают, обычно уже уехал верхом за край.
    expect(topmost([
      { block: 3, top: -200 },
      { block: 4, top: -20 },
      { block: 5, top: 300 },
    ])).toBe(4);
  });

  it("в самом начале книги — первый видимый", () => {
    expect(topmost([
      { block: 0, top: 40 },
      { block: 1, top: 300 },
    ])).toBe(0);
  });

  it("не уводит вперёд на длинном абзаце", () => {
    // Самый заметный на экране — следующий, но читают всё ещё этот.
    expect(topmost([
      { block: 7, top: -10 },
      { block: 8, top: 700 },
    ])).toBe(7);
  });

  it("ровно по краю считается текущим", () => {
    expect(topmost([{ block: 2, top: 0 }, { block: 3, top: 500 }])).toBe(2);
  });

  it("когда ничего не видно, ответа нет", () => {
    expect(topmost([])).toBeNull();
  });
});

/** Хранилище, которое запоминает, что и когда в него писали. */
function spyStore(): StateStore & { writes: PositionRecord[] } {
  const writes: PositionRecord[] = [];
  return {
    writes,
    async loadPosition() {
      return 0;
    },
    async savePosition(_key, record) {
      writes.push(record);
    },
    async loadBookmarks() {
      return [];
    },
    async saveBookmarks() {},
    async loadSettings() {
      return {};
    },
    async saveSettings() {},
    async recent() {
      return [];
    },
  };
}

const meta = { title: "Книга", author: "Автор", total: 500, path: "", hash: "abc" };

/** Часы и таймеры под управлением теста: ждать по-настоящему тут нечего. */
function harness() {
  const store = spyStore();
  let time = 100_000;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const keeper = keepPosition({
    store,
    key: "kniga",
    meta,
    now: () => time,
    schedule: (fn, ms) => {
      const timer = { at: time + ms, fn };
      timers.push(timer);
      return timer;
    },
    cancel: (id) => {
      const at = timers.indexOf(id as { at: number; fn: () => void });
      if (at >= 0) timers.splice(at, 1);
    },
  });
  /**
   * Проматывает время и запускает то, что подошло.
   *
   * Неподошедшие таймеры остаются на месте: вынуть их все и запустить только
   * часть — значит потерять отложенную запись.
   */
  const tick = async (ms: number) => {
    time += ms;
    const due = timers.filter((t) => t.at <= time);
    for (const timer of due) timers.splice(timers.indexOf(timer), 1);
    for (const timer of due) timer.fn();
    await Promise.resolve();
  };
  return { store, keeper, tick, at: () => time };
}

describe("запись позиции", () => {
  it("не пишет на каждое движение", async () => {
    // Прокрутка меняет блок десятки раз в секунду; писать каждый раз в
    // IndexedDB значит держать телефон в постоянной записи на диск.
    const { store, keeper, tick } = harness();
    for (let block = 1; block <= 30; block += 1) keeper.moved(block);

    // Первую запись придержка не откладывает: она ограничивает частоту, а не
    // начало. Записывается при этом последнее место, а не первое.
    await tick(0);
    expect(store.writes.map((w) => w.block)).toEqual([30]);

    // Дальше — не чаще раза в секунду.
    for (let block = 31; block <= 60; block += 1) keeper.moved(block);
    await tick(0);
    expect(store.writes).toHaveLength(1);
    await tick(SAVE_EVERY_MS);
    expect(store.writes.map((w) => w.block)).toEqual([30, 60]);
  });

  it("уход со страницы записывает немедленно", async () => {
    // На iOS вкладку закрывают, не спрашивая; ждать таймера нельзя.
    const { store, keeper } = harness();
    keeper.moved(42);
    await keeper.flush();
    expect(store.writes.map((w) => w.block)).toEqual([42]);
  });

  it("не пишет одно и то же дважды", async () => {
    const { store, keeper, tick } = harness();
    keeper.moved(7);
    await tick(SAVE_EVERY_MS);
    await keeper.flush();
    await keeper.flush();
    expect(store.writes).toHaveLength(1);
  });

  it("возврат на прежнее место после записи не теряется", async () => {
    const { store, keeper, tick } = harness();
    keeper.moved(10);
    await tick(SAVE_EVERY_MS);
    keeper.moved(20);
    keeper.moved(10);
    await keeper.flush();
    // Читатель вернулся туда же — записывать нечего.
    expect(store.writes.map((w) => w.block)).toEqual([10]);
  });

  it("после остановки не пишет ничего", async () => {
    const { store, keeper, tick } = harness();
    keeper.stop();
    keeper.moved(99);
    await tick(SAVE_EVERY_MS * 3);
    expect(store.writes).toEqual([]);
  });

  it("сохраняет сведения о книге вместе с местом", async () => {
    const { store, keeper } = harness();
    keeper.moved(5);
    await keeper.flush();
    const written = store.writes[0]!;
    expect(written.title).toBe("Книга");
    expect(written.total).toBe(500);
    expect(written.at).toBeGreaterThan(0);
  });

  it("знает, где сейчас находится", () => {
    const { keeper } = harness();
    keeper.moved(33);
    expect(keeper.current()).toBe(33);
  });
});

describe("придержка по умолчанию", () => {
  it("берёт настоящий setTimeout, когда его не подменили", async () => {
    vi.useFakeTimers();
    const store = spyStore();
    const keeper = keepPosition({ store, key: "k", meta });
    keeper.moved(3);
    await vi.advanceTimersByTimeAsync(SAVE_EVERY_MS + 10);
    vi.useRealTimers();
    expect(store.writes.map((w) => w.block)).toEqual([3]);
  });
});
