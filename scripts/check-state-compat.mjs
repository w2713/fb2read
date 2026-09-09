// Проверяет, что состояние, записанное эталонной реализацией, читается
// версией на TypeScript: тот же ключ книги, та же позиция, те же закладки.
//
// Запуск: node scripts/check-state-compat.mjs <файл книги> <positions.json>
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { bookKey } from "../packages/core/dist/src/index.js";

const [book, statePath] = process.argv.slice(2);
const key = await bookKey(resolve(book), statSync(book).size);
const data = JSON.parse(readFileSync(statePath, "utf-8"));
const entry = data[key];

const problems = [];
if (!entry) problems.push(`ключ книги не найден в состоянии: ${key}`);
else {
  if (entry.block !== 17) problems.push(`позиция ${entry.block}, ожидалась 17`);
  const marks = (entry.bookmarks ?? []).map((m) => m.block);
  if (marks.join() !== "5") problems.push(`закладки ${marks.join()}, ожидалась 5`);
}

if (problems.length) {
  for (const p of problems) console.error(p);
  process.exit(1);
}
console.log("состояние эталонной реализации читается: ключ, позиция и закладки совпали");
