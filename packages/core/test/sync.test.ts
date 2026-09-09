/** Слияние состояния и клиент синхронизации. */

import { describe, expect, it } from "vitest";
import type { Bookmark } from "../src/state.js";
import {
  SyncClient,
  SyncError,
  liveBookmarks,
  mergeBookmarks,
  mergePosition,
  mergeState,
  type SyncRequest,
  type SyncResponse,
  type SyncState,
} from "../src/sync.js";

function state(patch: Partial<SyncState> = {}): SyncState {
  return {
    hash: "abc",
    block: 0,
    total: 100,
    title: "Книга",
    author: "Автор",
    at: 1000,
    bookmarks: [],
    ...patch,
  };
}

describe("слияние позиции", () => {
  it("оставляет ту, что записана позже", () => {
    const дома = state({ block: 10, at: 1000, device: "ноутбук" });
    const вдороге = state({ block: 40, at: 2000, device: "телефон" });
    expect(mergePosition(дома, вдороге).block).toBe(40);
    expect(mergePosition(вдороге, дома).block).toBe(40);
  });

  it("при равном времени берёт вторую", () => {
    // Порядок не произволен: на сервере вторая — та, что пришла сейчас.
    // Без этого правила ответ зависел бы от порядка аргументов.
    const первая = state({ block: 10, at: 1000 });
    const вторая = state({ block: 20, at: 1000 });
    expect(mergePosition(первая, вторая).block).toBe(20);
  });

  it("не путает возврат назад с потерей", () => {
    // Читатель вернулся к началу — это осознанное действие, а не сбой.
    const прочитано = state({ block: 500, at: 1000 });
    const вернулся = state({ block: 5, at: 2000 });
    expect(mergePosition(прочитано, вернулся).block).toBe(5);
  });
});

describe("слияние закладок", () => {
  const mark = (block: number, at: number, extra: Partial<Bookmark> = {}): Bookmark => ({
    block,
    at,
    name: `на ${block}`,
    ...extra,
  });

  it("объединяет закладки с разных устройств", () => {
    const merged = mergeBookmarks([mark(3, 100)], [mark(7, 200)]);
    expect(merged.map((m) => m.block)).toEqual([3, 7]);
  });

  it("на один блок оставляет одну запись — новее", () => {
    const merged = mergeBookmarks([mark(3, 100, { name: "старая" })], [mark(3, 200, { name: "новая" })]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.name).toBe("новая");
  });

  it("снятая закладка не воскресает с другого устройства", () => {
    // Ради этого надгробия и заведены: телефон о снятии не знает и
    // прислал бы закладку обратно.
    const ноутбук = [mark(3, 200, { deleted: true })];
    const телефон = [mark(3, 100)];
    const merged = mergeBookmarks(ноутбук, телефон);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.deleted).toBe(true);
    expect(liveBookmarks(merged)).toEqual([]);
  });

  it("заново поставленная закладка сильнее старого надгробия", () => {
    const merged = mergeBookmarks([mark(3, 100, { deleted: true })], [mark(3, 300)]);
    expect(liveBookmarks(merged).map((m) => m.block)).toEqual([3]);
  });

  it("не растёт от повторных постановки и снятия", () => {
    // Записей ровно столько, сколько разных блоков отмечали, — иначе файл
    // состояния пух бы от каждого нажатия.
    let marks: Bookmark[] = [];
    for (let i = 0; i < 20; i += 1) {
      marks = mergeBookmarks(marks, [mark(3, 100 + i, { deleted: i % 2 === 0 })]);
    }
    expect(marks).toHaveLength(1);
  });

  it("закладку без времени считает самой давней", () => {
    // Такие приходят из файлов старой версии, которая времени не писала.
    const старая: Bookmark = { block: 3, name: "без времени" };
    const merged = mergeBookmarks([старая], [mark(3, 50, { name: "с временем" })]);
    expect(merged[0]!.name).toBe("с временем");
  });

  it("выдерживает мусор в списке", () => {
    const мусор = [null, { name: "без блока" }, mark(2, 10)] as unknown as Bookmark[];
    expect(mergeBookmarks(мусор, []).map((m) => m.block)).toEqual([2]);
  });

  it("отдаёт закладки по порядку блоков", () => {
    const merged = mergeBookmarks([mark(9, 10), mark(1, 10)], [mark(5, 10)]);
    expect(merged.map((m) => m.block)).toEqual([1, 5, 9]);
  });
});

describe("слияние состояния целиком", () => {
  it("берёт позицию новее, а закладки — обе", () => {
    const a = state({ block: 10, at: 1000, bookmarks: [{ block: 1, at: 1 }] });
    const b = state({ block: 40, at: 2000, bookmarks: [{ block: 2, at: 2 }] });
    const merged = mergeState(a, b);
    expect(merged.block).toBe(40);
    expect(merged.bookmarks.map((m) => m.block)).toEqual([1, 2]);
  });

  it("не теряет закладки проигравшей записи", () => {
    // Позиция проиграла по времени, но закладки на этом устройстве
    // читатель ставил вполне сознательно.
    const проигравшая = state({ block: 10, at: 1000, bookmarks: [{ block: 7, at: 900 }] });
    const победившая = state({ block: 40, at: 2000, bookmarks: [] });
    expect(mergeState(проигравшая, победившая).bookmarks.map((m) => m.block)).toEqual([7]);
  });
});

describe("клиент", () => {
  function fakeFetch(handler: (url: string, init?: SyncRequest) => unknown) {
    return async (url: string, init?: SyncRequest): Promise<SyncResponse> => {
      const value = handler(url, init);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(value),
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      } as unknown as SyncResponse;
    };
  }

  it("складывает адрес и не спотыкается о лишнюю косую черту", async () => {
    let seen = "";
    const client = new SyncClient({
      url: "https://books.example.org/",
      fetch: fakeFetch((url) => {
        seen = url;
        return { books: [] };
      }),
    });
    await client.list();
    expect(seen).toBe("https://books.example.org/api/v1/books");
  });

  it("подписывает запросы токеном", async () => {
    let auth: string | undefined;
    const client = new SyncClient({
      url: "http://localhost",
      token: "секрет",
      fetch: fakeFetch((_url, init) => {
        auth = init?.headers?.["Authorization"];
        return { books: [] };
      }),
    });
    await client.list();
    expect(auth).toBe("Bearer секрет");
  });

  it("кодирует русское имя книги: в заголовке допустима только латиница", async () => {
    let name: string | undefined;
    const client = new SyncClient({
      url: "http://localhost",
      fetch: fakeFetch((_url, init) => {
        name = init?.headers?.["X-Name"];
        return {};
      }),
    });
    await client.upload("hash", "Война и мир.fb2", new Uint8Array([1]));
    expect(name).toBe(encodeURIComponent("Война и мир.fb2"));
    expect(decodeURIComponent(name!)).toBe("Война и мир.fb2");
  });

  it("объясняет отказ сервера словами", async () => {
    const client = new SyncClient({
      url: "http://localhost",
      fetch: async () =>
        ({
          ok: false,
          status: 401,
          text: async () => "",
        }) as unknown as SyncResponse,
    });
    await expect(client.list()).rejects.toThrow(/токен/);
  });

  it("не ждёт вечно, когда сервер молчит", async () => {
    const client = new SyncClient({
      url: "http://localhost",
      timeoutMs: 10,
      // Сеть, которая не отвечает и не разрывает соединение: без таймаута
      // читалка висла бы на открытии книги.
      fetch: (_url: string, init?: SyncRequest) =>
        new Promise<SyncResponse>((_resolve, reject) => {
          const signal = init?.signal as unknown as {
            addEventListener?: (name: string, fn: () => void) => void;
          };
          signal?.addEventListener?.("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    });
    await expect(client.list()).rejects.toThrow(SyncError);
  });

  it("без адреса не создаётся", () => {
    expect(() => new SyncClient({ url: "" })).toThrow(SyncError);
  });
});
