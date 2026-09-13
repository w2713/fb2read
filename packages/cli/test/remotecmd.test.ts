/**
 * `fb2read remote` — список книг на сервере.
 *
 * Сервер тут простейший, ровно на три нужных пути: проверяется не он, а то,
 * что команда печатает читателю. Первой строкой — с кем она говорит: когда
 * что-то не сходится, первый вопрос всегда этот.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cmdRemote } from "../src/sync.js";

let server: Server;
let url: string;
/** Чем сервер отвечает на пробу живости — в каждой проверке своё. */
let health: unknown;

beforeEach(async () => {
  health = { ok: true, version: "0.24.0" };
  server = createServer((request, response) => {
    const path = (request.url ?? "").split("?")[0];
    const body =
      path === "/api/v1/health"
        ? health
        : path === "/api/v1/books"
          ? { books: [{ hash: "a".repeat(64), name: "Книга.fb2", title: "Книга", size: 10 }] }
          : { states: [] };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Что команда написала в стандартный вывод. */
async function run(): Promise<string> {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  try {
    expect(await cmdRemote({ url, auto: false, upload: false })).toBe(0);
  } finally {
    spy.mockRestore();
  }
  return lines.join("");
}

describe("fb2read remote", () => {
  it("первой строкой называет версию сервера", async () => {
    const текст = await run();
    expect(текст.split("\n")[0]).toBe("сервер fb2read-server 0.24.0");
    // И список книг никуда не делся.
    expect(текст).toContain("Книга");
  });

  it("сервер постарее версии не называет — так и сказано", async () => {
    // Серверы, поднятые до этой правки, отвечают одним `ok`. Выдумывать за них
    // номер нельзя, а молчать — значит оставить читателя гадать.
    health = { ok: true };
    expect(await run()).toContain("сервер версии не назвал");
  });
});
