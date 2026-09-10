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

import type { Block, Ref, Span } from "@fb2read/core";

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
  return decorate(text, spans.map(fromSpan));
}

/** Кусок текста в обёртке: начертание, сноска или подсветка находки. */
interface Piece {
  start: number;
  end: number;
  open: string;
  close: string;
}

function fromSpan([start, end, kind]: Span): Piece {
  return { start, end, open: `<${kind}>`, close: `</${kind}>` };
}

/** Накладывает обёртки на текст по смещениям. */
function decorate(text: string, pieces: readonly Piece[]): string {
  if (!pieces.length) return escapeText(text);
  const out: string[] = [];
  let at = 0;
  for (const piece of [...pieces].sort((a, b) => a.start - b.start)) {
    if (piece.start < at || piece.end <= piece.start || piece.start < 0 || piece.end > text.length) {
      continue;
    }
    out.push(escapeText(text.slice(at, piece.start)));
    out.push(piece.open + escapeText(text.slice(piece.start, piece.end)) + piece.close);
    at = piece.end;
  }
  out.push(escapeText(text.slice(at)));
  return out.join("");
}

/**
 * Где в абзаце стоят маркеры сносок.
 *
 * Ядро отдаёт сноску парой «маркер, цель», без смещения: терминалу оно не
 * нужно, он ищет маркер при отрисовке строки. Здесь смещение приходится
 * восстановить — поиском по порядку, потому что маркеры в книге повторяются
 * («1» встречается и в тексте, и через сто абзацев снова).
 *
 * Маркер, которого в тексте нет, пропускается молча: книга чужая, и ссылка в
 * ней может не сойтись с текстом.
 */
export function noteRanges(text: string, refs: readonly Ref[] = []): Piece[] {
  const out: Piece[] = [];
  let from = 0;
  for (const [marker, target] of refs) {
    if (!marker || !target) continue;
    const at = text.indexOf(marker, from);
    if (at < 0) continue;
    out.push({
      start: at,
      end: at + marker.length,
      open: `<a class="note" href="#" data-note="${escapeAttr(target)}">`,
      close: "</a>",
    });
    from = at + marker.length;
  }
  return out;
}

/**
 * Всё оформление абзаца сразу: начертание, сноски и найденное слово.
 *
 * Подсветка находки главнее прочего: пересекающиеся с ней начертание и сноска
 * отбрасываются. Иначе совпадение, попавшее в середину курсива, осталось бы
 * невидимым — а его как раз и искали.
 */
function decorated(block: Block, found?: Found): string {
  const pieces = [...block.spans.map(fromSpan), ...noteRanges(block.text, block.refs)];
  if (!found || found.end <= found.start) return decorate(block.text, pieces);
  return decorate(block.text, [
    ...pieces.filter((p) => p.end <= found.start || p.start >= found.end),
    { start: found.start, end: found.end, open: '<mark class="found">', close: "</mark>" },
  ]);
}

/** Найденное место в абзаце: смещения в единицах UTF-16. */
export interface Found {
  start: number;
  end: number;
}

/** Заголовок по уровню: h1 — книга, дальше разделы, глубже шестого не бывает. */
function headingTag(level: number): string {
  return `h${Math.min(Math.max(level + 1, 1), 6)}`;
}

/** Разметка одного блока без обёрток. */
function renderBlock(block: Block, index: number, found?: Found): string {
  const at = ` data-block="${index}"`;
  const body = decorated(block, found);

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
/**
 * Один блок отдельно.
 *
 * Нужен, чтобы перерисовать абзац с подсветкой найденного, не собирая заново
 * всю книгу: на книге в сорок мегабайт это заметная задержка при каждом
 * переходе к следующему совпадению.
 */
export function renderOne(block: Block, index: number, found?: Found): string {
  return renderBlock(block, index, found);
}

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
