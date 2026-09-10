/**
 * Решения обмена, которые проверяются без сервера.
 *
 * Сам обмен проверяется настоящим сервером в настоящем браузере — здесь
 * только то, что можно спросить у чистых функций: как читаются настройки и
 * что считать изменением.
 */

import type { SyncState } from "@fb2read/core";
import { describe, expect, it } from "vitest";
import { changed, guessDevice, syncSettings, tell } from "../src/sync.js";

const state = (block: number, bookmarks: SyncState["bookmarks"] = []): SyncState => ({
  hash: "a".repeat(64),
  block,
  total: 100,
  title: "Книга",
  author: "Автор",
  at: 1000,
  bookmarks,
});

describe("настройки обмена", () => {
  it("без адреса обмена нет вовсе", () => {
    // Это обычное состояние читалки, а не ошибка: сервер нужен не всем.
    expect(syncSettings({})).toBeNull();
    expect(syncSettings({ syncUrl: "   " })).toBeNull();
  });

  it("читаются полностью", () => {
    expect(
      syncSettings({
        syncUrl: " https://books.example.org ",
        syncToken: "секрет",
        device: "телефон",
        syncAuto: false,
      }),
    ).toEqual({
      url: "https://books.example.org",
      token: "секрет",
      device: "телефон",
      auto: false,
    });
  });

  it("обмен при закрытии книги включён, пока его не выключили", () => {
    expect(syncSettings({ syncUrl: "https://x" })!.auto).toBe(true);
  });

  it("устройство узнаётся по браузеру", () => {
    expect(guessDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe("iPhone");
    expect(guessDevice("Mozilla/5.0 (Linux; Android 14)")).toBe("Android");
    expect(guessDevice("что-то незнакомое")).toBe("браузер");
  });
});

describe("что считать изменением", () => {
  it("другое место — изменение", () => {
    expect(changed(state(10), state(40))).toBe(true);
  });

  it("снятая и поставленная закладка дают ту же длину, но это изменение", () => {
    // На эту удочку читалка в терминале однажды уже попалась: список сравнивали
    // по длине, и снятые закладки воскресали при каждом обмене.
    const было = state(10, [{ block: 5, at: 100 }]);
    const стало = state(10, [{ block: 5, at: 200, deleted: true }]);
    expect(changed(было, стало)).toBe(true);
  });

  it("то же самое изменением не считается", () => {
    const marks = [{ block: 5, at: 100 }];
    expect(changed(state(10, marks), state(10, [...marks]))).toBe(false);
  });
});

describe("итог обмена словами", () => {
  it("когда ничего не менялось, так и сказано", () => {
    expect(tell(0, 0, 0)).toBe("всё и так совпадало");
  });

  it("перечисляет только то, что было", () => {
    expect(tell(2, 0, 1)).toBe("отправлено книг: 2, обновилось мест: 1");
    expect(tell(0, 3, 0)).toBe("получено книг: 3");
  });
});
