// Печатает разбор книги как JSON — то же, что scripts/dump-parse.py.
// Запуск: npx tsc -b packages/core && node scripts/dump-parse.mjs книга.fb2
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { Book } from "../packages/core/dist/src/index.js";

const path = process.argv[2];
const data = new Uint8Array(readFileSync(path));
const source = {
  name: basename(path),
  size: statSync(path).size,
  async bytes() { return data; },
  async slice(a, b) { return data.subarray(a, b); },
};
const book = await Book.open(source);
const out = {
  format: book.format,
  title: book.title,
  author: book.author,
  series: book.series,
  repairs: book.repairs,
  toc: book.toc.map((t) => [t.level, t.title, t.block]),
  anchors: book.anchors,
  blocks: book.blocks.map((b) => ({
    kind: b.kind, text: b.text, level: b.level,
    refs: b.refs.map((r) => [...r]),
    spans: b.spans.map((s) => [...s]),
    src: b.src,
  })),
};
// Ключи сортируются рекурсивно, как json.dumps(sort_keys=True) в Python.
const sorted = (value) => {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sorted(value[k])]));
  }
  return value;
};
process.stdout.write(JSON.stringify(sorted(out), null, 1) + "\n");
