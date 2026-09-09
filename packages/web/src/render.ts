/**
 * Блоки книги в семантический HTML.
 *
 * Терминальная вёрстка сюда не переносится намеренно. В терминале текст режется
 * на строки по знакоместам, потому что иначе нельзя; браузер верстает сам, и
 * пересказывать ему это значит испортить перенос, выделение и увеличение шрифта.
 * Отсюда берётся только то, что выше вёрстки: виды блоков, начертание, картинки.
 *
 * На каждом элементе стоит `data-block` — номер блока. Позиция чтения хранится
 * этим же числом и в терминале, и в файле состояния, поэтому книга, брошенная
 * на 120-м абзаце на ноутбуке, откроется здесь на 120-м абзаце.
 *
 * Функция чистая: ни DOM, ни сети. Значит, проверяется без браузера.
 */

import type { Block, Span } from "@fb2read/core";

/** Экранирование текста книги: она пришла из файла и доверия ей нет. */
export function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** То же для значения атрибута: там опасны ещё и кавычки. */
export function escapeAttr(text: string): string {
  return escapeText(text).replace(/"/g, "&quot;");
}

/**
 * Накладывает начертание на текст абзаца.
 *
 * Смещения в ядре считаны в единицах UTF-16 — в тех же, которыми режет строку
 * JS, — поэтому `slice` здесь безопасен и на суррогатных парах.
 *
 * Пересечений в разметке не бывает: ядро отдаёт участки по порядку и без
 * наложений. Всё же участок, залезший на предыдущий, пропускается — испорченный
 * файл не должен рассыпать разметку страницы.
 */
export function withSpans(text: string, spans: readonly Span[] = []): string {
  if (!spans.length) return escapeText(text);
  const out: string[] = [];
  let at = 0;
  for (const [start, end, kind] of [...spans].sort((a, b) => a[0] - b[0])) {
    if (start < at || end <= start || start < 0 || end > text.length) continue;
    out.push(escapeText(text.slice(at, start)));
    out.push(`<${kind}>${escapeText(text.slice(start, end))}</${kind}>`);
    at = end;
  }
  out.push(escapeText(text.slice(at)));
  return out.join("");
}

/** Заголовок по уровню: h1 — книга, дальше разделы, глубже шестого не бывает. */
function headingTag(level: number): string {
  return `h${Math.min(Math.max(level + 1, 1), 6)}`;
}

/** Разметка одного блока без обёрток. */
function renderBlock(block: Block, index: number): string {
  const at = ` data-block="${index}"`;
  const body = withSpans(block.text, block.spans);

  switch (block.kind) {
    case "title": {
      const tag = headingTag(block.level);
      return `<${tag}${at}>${body}</${tag}>`;
    }
    case "subtitle":
      return `<p class="subtitle"${at}>${body}</p>`;
    case "author":
      return `<p class="author"${at}>${body}</p>`;
    case "v":
      // Стихотворная строка остаётся отдельным блоком: позиция чтения
      // указывает на строку, а не на строфу.
      return `<p class="verse"${at}>${body}</p>`;
    case "cite":
      return `<p${at}>${body}</p>`;
    case "image":
      // Картинка подставляется лениво: `data-src` — это идентификатор внутри
      // книги, а не адрес. Настоящий blob-URL появится, когда до неё дойдут.
      return (
        `<figure class="image"${at}>` +
        `<img data-src="${escapeAttr(block.src)}" alt="${escapeAttr(block.text)}">` +
        (block.text ? `<figcaption>${body}</figcaption>` : "") +
        `</figure>`
      );
    case "empty":
      // Пустой блок — это отбивка. Он всё равно нужен на странице: номера
      // блоков должны совпадать с теми, что в файле состояния.
      return `<p class="empty"${at}></p>`;
    default:
      return `<p${at}>${body}</p>`;
  }
}

/**
 * Собирает всю книгу.
 *
 * Идущие подряд цитаты складываются в одну `blockquote`: так это и есть одна
 * цитата, а не десять. Внутри у каждого абзаца свой `data-block`, поэтому на
 * точность позиции группировка не влияет.
 */
export function renderBook(blocks: readonly Block[]): string {
  const out: string[] = [];
  let inQuote = false;

  blocks.forEach((block, index) => {
    const quote = block.kind === "cite";
    if (quote && !inQuote) out.push('<blockquote class="cite">');
    if (!quote && inQuote) out.push("</blockquote>");
    inQuote = quote;
    out.push(renderBlock(block, index));
  });

  if (inQuote) out.push("</blockquote>");
  return out.join("\n");
}
