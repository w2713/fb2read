/**
 * Разметка книги.
 *
 * Функция чистая, поэтому браузер тут не нужен: проверяется ровно та строка,
 * которую потом получит страница.
 */

import { makeBlock, type Block } from "@fb2read/core";
import { describe, expect, it } from "vitest";
import { escapeAttr, escapeText, renderBook, withSpans } from "../src/render.js";

describe("экранирование", () => {
  it("обезвреживает разметку из книги", () => {
    // Текст книги — это данные из чужого файла. Без экранирования любая книга
    // могла бы выполнить свой скрипт на странице читателя.
    expect(escapeText('<script>alert(1)</script>')).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  it("не ломает амперсанд дважды", () => {
    expect(escapeText("Смит & сын")).toBe("Смит &amp; сын");
    expect(escapeText("&amp;")).toBe("&amp;amp;");
  });

  it("в атрибуте закрывает и кавычки", () => {
    expect(escapeAttr('обложка" onerror="alert(1)')).toBe(
      "обложка&quot; onerror=&quot;alert(1)",
    );
  });
});

describe("начертание", () => {
  it("оборачивает выделенные куски", () => {
    const text = "совсем другое дело";
    expect(withSpans(text, [[7, 13, "em"]])).toBe("совсем <em>другое</em> дело");
  });

  it("держит несколько кусков подряд", () => {
    const text = "раз два три";
    const html = withSpans(text, [
      [0, 3, "strong"],
      [4, 7, "em"],
    ]);
    expect(html).toBe("<strong>раз</strong> <em>два</em> три");
  });

  it("экранирует и внутри выделения", () => {
    expect(withSpans("<b>", [[0, 3, "em"]])).toBe("<em>&lt;b&gt;</em>");
  });

  it("пропускает участок, залезший на предыдущий", () => {
    // Испорченный файл не должен рассыпать разметку страницы.
    const html = withSpans("абвгде", [
      [0, 3, "em"],
      [1, 4, "strong"],
    ]);
    expect(html).toBe("<em>абв</em>где");
  });

  it("пропускает участок за пределами текста", () => {
    expect(withSpans("коротко", [[3, 99, "em"]])).toBe("коротко");
  });

  it("не спотыкается о суррогатные пары", () => {
    // Смещения в ядре считаны в единицах UTF-16 — тех же, которыми режет JS.
    const text = "до 𝒜 после";
    const at = text.indexOf("𝒜");
    expect(withSpans(text, [[at, at + 2, "strong"]])).toBe("до <strong>𝒜</strong> после");
  });
});

describe("книга целиком", () => {
  const book = (kinds: Array<[Block["kind"], string, number?]>): Block[] =>
    kinds.map(([kind, text, level]) => makeBlock(kind, text, level ?? 0));

  it("на каждом блоке стоит его номер", () => {
    const html = renderBook(book([["p", "первый"], ["p", "второй"]]));
    expect(html).toContain('data-block="0"');
    expect(html).toContain('data-block="1"');
  });

  it("заголовки идут по уровням", () => {
    const html = renderBook(book([["title", "Книга", 0], ["title", "Глава", 1]]));
    expect(html).toContain("<h1 data-block=\"0\">Книга</h1>");
    expect(html).toContain("<h2 data-block=\"1\">Глава</h2>");
  });

  it("глубже шестого уровня не уходит", () => {
    const html = renderBook(book([["title", "Глубоко", 12]]));
    expect(html).toContain("<h6");
  });

  it("цитаты подряд складываются в одну", () => {
    // Это одна цитата, а не три; но номера блоков внутри сохраняются.
    const html = renderBook(
      book([["p", "до"], ["cite", "раз"], ["cite", "два"], ["p", "после"]]),
    );
    expect(html.match(/<blockquote/g)).toHaveLength(1);
    expect(html.match(/<\/blockquote>/g)).toHaveLength(1);
    expect(html).toContain('<p data-block="1">раз</p>');
    expect(html).toContain('<p data-block="2">два</p>');
  });

  it("цитата в конце книги закрывается", () => {
    const html = renderBook(book([["p", "до"], ["cite", "последняя"]]));
    expect(html.match(/<blockquote/g)).toHaveLength(1);
    expect(html.trimEnd().endsWith("</blockquote>")).toBe(true);
  });

  it("пустой блок остаётся на месте: номера не должны съезжать", () => {
    const html = renderBook(book([["p", "до"], ["empty", ""], ["p", "после"]]));
    expect(html).toContain('<p class="empty" data-block="1"></p>');
    expect(html).toContain('data-block="2"');
  });

  it("картинка ждёт своего адреса", () => {
    const blocks = [makeBlock("image", "Обложка", 0, [], [], "cover.jpg")];
    const html = renderBook(blocks);
    // Настоящий blob-URL появится, когда до картинки дойдут.
    expect(html).toContain('data-src="cover.jpg"');
    expect(html).toContain('alt="Обложка"');
    expect(html).toContain("<figcaption>Обложка</figcaption>");
    expect(html).not.toContain(" src=");
  });

  it("картинка без подписи обходится без пустой подписи", () => {
    const html = renderBook([makeBlock("image", "", 0, [], [], "pic.png")]);
    expect(html).not.toContain("figcaption");
  });

  it("стихотворная строка — отдельный блок", () => {
    const html = renderBook(book([["v", "Мой дядя самых честных правил"]]));
    expect(html).toContain('<p class="verse" data-block="0">');
  });

  it("пустая книга даёт пустую разметку", () => {
    expect(renderBook([])).toBe("");
  });
});
