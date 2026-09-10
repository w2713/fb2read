/**
 * Разметка книги.
 *
 * Функция чистая, поэтому браузер тут не нужен: проверяется ровно та строка,
 * которую потом получит страница.
 */

import { makeBlock, type Block } from "@fb2read/core";
import { describe, expect, it } from "vitest";
import { escapeAttr, escapeText, renderBook, renderOne, withSpans } from "../src/render.js";

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

describe("сноски", () => {
  const withNote = (text: string, refs: Array<readonly [string, string]>): Block =>
    makeBlock("p", text, 0, refs);

  it("маркер становится ссылкой на примечание", () => {
    const html = renderOne(withNote("Дуэль[1] случилась в среду.", [["[1]", "n1"]]), 4);
    expect(html).toContain('<a class="note" href="#" data-note="n1">[1]</a>');
    expect(html).toContain('data-block="4"');
  });

  it("одинаковые маркеры в одном абзаце не путаются", () => {
    // «1» встречается в тексте и как маркер: брать первое попавшееся нельзя,
    // иначе ссылка окажется на числе из текста.
    const html = renderOne(
      withNote("В 1 час пополудни[1] он вышел[2].", [
        ["[1]", "n1"],
        ["[2]", "n2"],
      ]),
      0,
    );
    expect(html).toBe(
      '<p data-block="0">В 1 час пополудни<a class="note" href="#" data-note="n1">[1]</a>' +
        ' он вышел<a class="note" href="#" data-note="n2">[2]</a>.</p>',
    );
  });

  it("маркер, которого нет в тексте, просто пропускается", () => {
    // Книга чужая, и ссылки в ней могут не сойтись с текстом; рассыпаться от
    // этого страница не должна.
    const html = renderOne(withNote("Обычный абзац.", [["[9]", "n9"]]), 1);
    expect(html).toBe('<p data-block="1">Обычный абзац.</p>');
  });

  it("цель ссылки экранируется", () => {
    const html = renderOne(withNote("Текст[1].", [['[1]', 'x" onload="alert(1)']]), 0);
    expect(html).toContain('data-note="x&quot; onload=&quot;alert(1)"');
    expect(html).not.toContain('onload="alert');
  });

  it("уживается с начертанием в том же абзаце", () => {
    const block = makeBlock("p", "Слово и сноска[1].", 0, [["[1]", "n1"]], [[0, 5, "em"]]);
    expect(renderOne(block, 0)).toBe(
      '<p data-block="0"><em>Слово</em> и сноска<a class="note" href="#" data-note="n1">[1]</a>.</p>',
    );
  });
});

describe("подсветка найденного", () => {
  it("оборачивает совпадение", () => {
    const block = makeBlock("p", "Всё смешалось в доме Облонских");
    expect(renderOne(block, 2, { start: 4, end: 13 })).toBe(
      '<p data-block="2">Всё <mark class="found">смешалось</mark> в доме Облонских</p>',
    );
  });

  it("видна и внутри курсива", () => {
    // Начертание, накрывшее совпадение, отбрасывается: искали именно его, и
    // остаться невидимым оно не должно.
    const block = makeBlock("p", "совсем другое дело", 0, [], [[0, 18, "em"]]);
    const html = renderOne(block, 0, { start: 7, end: 13 });
    expect(html).toContain('<mark class="found">другое</mark>');
    expect(html).not.toContain("<em>");
  });

  it("без подсветки блок такой же, как в книге целиком", () => {
    const blocks = [makeBlock("p", "Первый"), makeBlock("p", "Второй")];
    expect(renderOne(blocks[1]!, 1)).toBe(renderBook(blocks).split("\n")[1]);
  });

  it("не даёт книге подсунуть разметку через подсветку", () => {
    const block = makeBlock("p", "<b>жирно</b> и дальше");
    expect(renderOne(block, 0, { start: 0, end: 12 })).toContain(
      '<mark class="found">&lt;b&gt;жирно&lt;/b&gt;</mark>',
    );
  });
});
