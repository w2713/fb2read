/** Поиск: приведение к общему виду, все совпадения, контекст. */

import { describe, expect, it } from "vitest";
import { findMatches, matchContext, normalize, squeeze } from "../src/search.js";
import { bigBookParsed, bookFromBody, sampleBook } from "./fixtures.js";

describe("приведение текста", () => {
  it.each(["Ёлка", "ПРИВЕТ", "Straße", "日本語 Ёж"])(
    "не меняет длину строки %j",
    (text) => {
      // Смещения совпадений должны оставаться пригодными для исходной строки.
      expect(normalize(text).length).toBe(text.length);
    },
  );

  it("равняет регистр и ё с е", () => {
    expect(normalize("ЁЛка")).toBe("елка");
    expect(normalize("елка")).toBe("елка");
  });
});

describe("поиск", () => {
  it("не различает регистр и букву ё", async () => {
    const blocks = (await sampleBook()).blocks;
    expect(findMatches(blocks, "ЁЛОЧКАМИ")).toEqual(findMatches(blocks, "елочками"));
    expect(findMatches(blocks, "ёлочками")).toHaveLength(1);
  });

  it("смещения указывают на найденное слово", async () => {
    const blocks = (await bigBookParsed()).blocks;
    const matches = findMatches(blocks, "память");
    expect(matches.length).toBeGreaterThan(0);
    for (const { block, offset } of matches.slice(0, 20)) {
      expect(normalize(blocks[block]!.text.slice(offset, offset + 6))).toBe("память");
    }
  });

  it("находит каждое вхождение, включая соседние", async () => {
    const book = await bookFromBody("<body><section><p>кот кот КОТ</p></section></body>");
    expect(findMatches(book.blocks, "кот").map((m) => m.offset)).toEqual([0, 4, 8]);
  });

  it("пустой запрос ничего не находит", async () => {
    expect(findMatches((await sampleBook()).blocks, "   ")).toEqual([]);
  });

  it("контекст окружает совпадение и короче всего абзаца", async () => {
    const blocks = (await bigBookParsed()).blocks;
    const { block, offset } = findMatches(blocks, "память")[5]!;
    const context = matchContext(blocks[block]!, offset, 64);
    expect(normalize(context)).toContain("память");
    expect(context.length).toBeLessThan(blocks[block]!.text.length + 4);
  });
});

describe("сжатие пробелов", () => {
  it("подряд идущие пробелы становятся одним", () => {
    expect(squeeze("а   б").text).toBe("а б");
  });

  it("по сжатому месту находится исходное", () => {
    // Ради этого всё и заведено: найти в сжатом, а подсветить в настоящем.
    const тесно = squeeze("аб    вг");
    const at = тесно.text.indexOf("аб вг");
    expect(at).toBe(0);
    expect("аб    вг".slice(тесно.at[at]!, тесно.at[at + 5]!)).toBe("аб    вг");
  });

  it("текст без лишних пробелов не меняется", () => {
    const было = "аб вг де";
    const тесно = squeeze(было);
    expect(тесно.text).toBe(было);
    expect(тесно.at).toHaveLength(было.length + 1);
  });

  it("неразрывный пробел не схлопывается", () => {
    // Его ставят нарочно, и выключка его не трогает — значит, и тут не надо.
    expect(squeeze("аб\u00A0\u00A0вг").text).toBe("аб\u00A0\u00A0вг");
  });

  it("конец текста тоже отображается", () => {
    // Последнее число нужно, чтобы у совпадения в конце строки был конец.
    const тесно = squeeze("а  б");
    expect(тесно.at[тесно.text.length]).toBe(4);
  });
});
