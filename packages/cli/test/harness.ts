/**
 * Испытательный стенд: читалка перед настоящим эмулятором терминала.
 *
 * В эталонной реализации для этого поднимался псевдотерминал, а экран
 * разбирался эмулятором на Python. Здесь то же самое, но внутри процесса:
 * байты уходят в xterm, и тесты читают ровно тот экран, который увидел бы
 * человек, вместе с начертанием каждой ячейки. Это на порядок быстрее,
 * детерминированно и работает на Windows.
 */

import { Terminal as Xterm } from "@xterm/headless";
import { MOUSE_OFF, MOUSE_ON, enterSequence, leaveSequence } from "../src/term/ansi.js";
import type { InputEvent } from "../src/term/input.js";
import { InputParser } from "../src/term/input.js";
import type { Terminal } from "../src/term/terminal.js";
import { Session } from "../src/ui/session.js";
import { createReader, type ReadOptions } from "../src/ui/read.js";
import { Chooser, type ChooserEntry } from "../src/ui/chooser.js";
import { Theme } from "../src/ui/theme.js";
import type { Reader } from "../src/ui/reader.js";

/** Терминал, который вместо системы пишет в эмулятор и в сырой журнал. */
export class FakeTerminal implements Terminal {
  readonly colors = 256;
  readonly xterm: Xterm;
  /** Всё, что программа вывела: сюда смотрят проверки протоколов. */
  raw = "";

  private inputHandlers: Array<(event: InputEvent) => void> = [];
  private resizeHandlers: Array<() => void> = [];
  private parser = new InputParser();
  private writes: Array<Promise<void>> = [];
  mouseEnabled = false;
  entered = false;

  constructor(
    public rows = 24,
    public columns = 80,
  ) {
    this.xterm = new Xterm({ rows, cols: columns, allowProposedApi: true });
  }

  write(data: string): void {
    this.raw += data;
    // Эмулятор разбирает поток не сразу: запоминаем обещание, чтобы тест
    // мог дождаться, пока экран действительно обновится.
    this.writes.push(new Promise((resolve) => this.xterm.write(data, resolve)));
  }

  /** Ждёт, пока эмулятор разберёт всё, что ему послали. */
  async drain(): Promise<void> {
    while (this.writes.length) {
      const pending = this.writes;
      this.writes = [];
      await Promise.all(pending);
    }
  }

  onInput(handler: (event: InputEvent) => void): void {
    this.inputHandlers.push(handler);
  }

  onResize(handler: () => void): void {
    this.resizeHandlers.push(handler);
  }

  enterRaw(mouse: boolean): void {
    this.entered = true;
    this.mouseEnabled = mouse;
    // Те же байты, что шлёт настоящий терминал: иначе проверки протоколов
    // подтверждали бы поведение подмены, а не программы.
    this.write(enterSequence(mouse));
  }

  leaveRaw(): void {
    this.entered = false;
    this.write(leaveSequence(this.mouseEnabled));
    this.mouseEnabled = false;
  }

  setMouse(on: boolean): void {
    if (on === this.mouseEnabled) return;
    this.mouseEnabled = on;
    // Настоящий терминал шлёт при этом байты, и проверки на них смотрят.
    this.write(on ? MOUSE_ON : MOUSE_OFF);
  }

  /** Посылает то же, что послал бы терминал при нажатии клавиш. */
  send(...sequences: string[]): void {
    const encoder = new TextEncoder();
    for (const sequence of sequences) {
      for (const event of this.parser.feed(encoder.encode(sequence))) {
        for (const handler of this.inputHandlers) handler(event);
      }
      for (const event of this.parser.flush()) {
        for (const handler of this.inputHandlers) handler(event);
      }
    }
  }

  /** Клик левой кнопкой: колонка и строка считаются от нуля. */
  click(column: number, row: number, button: 0 | 2 = 0): void {
    this.send(`\x1b[<${button};${column + 1};${row + 1}M`);
  }

  /** Колесо мыши. */
  wheel(direction: "up" | "down", column = 1, row = 1): void {
    this.send(`\x1b[<${direction === "up" ? 64 : 65};${column + 1};${row + 1}M`);
  }

  resize(rows: number, columns: number): void {
    this.rows = rows;
    this.columns = columns;
    this.xterm.resize(columns, rows);
    for (const handler of this.resizeHandlers) handler();
  }

  /** Строка экрана как её видит читатель. */
  line(row: number): string {
    return this.xterm.buffer.active.getLine(row)?.translateToString(true) ?? "";
  }

  /** Весь экран построчно. */
  lines(): string[] {
    return Array.from({ length: this.rows }, (_, i) => this.line(i));
  }

  /** Экран одной строкой — удобно искать текст. */
  text(): string {
    return this.lines().join("\n");
  }

  /** Начертание ячейки: то, что раньше давал pyte. */
  style(row: number, column: number): {
    char: string;
    bold: boolean;
    italic: boolean;
    underline: boolean;
    inverse: boolean;
    dim: boolean;
  } {
    const cell = this.xterm.buffer.active.getLine(row)?.getCell(column);
    return {
      char: cell?.getChars() ?? "",
      bold: !!cell?.isBold(),
      italic: !!cell?.isItalic(),
      underline: !!cell?.isUnderline(),
      inverse: !!cell?.isInverse(),
      dim: !!cell?.isDim(),
    };
  }

  /** Ищет строку экрана, содержащую текст. */
  findRow(text: string): number {
    return this.lines().findIndex((line) => line.includes(text));
  }
}

/** Экран, готовый к проверкам: первый кадр уже нарисован. */
export interface Harness {
  terminal: FakeTerminal;
  session: Session;
  /** Посылает клавиши и ждёт, пока экран обновится. */
  press(...sequences: string[]): Promise<void>;
  /** Ждёт, пока разойдутся отложенные дела, и обновляет экран. */
  settle(): Promise<void>;
  /** Меняет размер окна и ждёт перерисовки. */
  resize(rows: number, columns: number): Promise<void>;
  /** Терминал прислал новый размер, но время ещё не пошло: так тянут окно мышью. */
  dragTo(rows: number, columns: number): void;
  /** Отпустили: даёт сработать придержке перевёрстки. */
  letGo(): Promise<void>;
}

/** Стенд с читалкой. */
export interface ReaderHarness extends Harness {
  reader: Reader;
}

/** Стенд со списком книг. */
export interface ChooserHarness extends Harness {
  chooser: Chooser;
  /** Что выбрал читатель, когда список закончился. */
  picked(): Promise<string | null>;
}

function controls(
  terminal: FakeTerminal,
  session: Session,
  clock: Clock,
): Omit<Harness, "terminal" | "session"> {
  return {
    async press(...sequences: string[]) {
      terminal.send(...sequences);
      await new Promise((resolve) => setImmediate(resolve));
      await terminal.drain();
    },
    async settle() {
      await new Promise((resolve) => setImmediate(resolve));
      session.paint();
      await terminal.drain();
    },
    async resize(rows: number, columns: number) {
      terminal.resize(rows, columns);
      clock.run();
      await terminal.drain();
    },
    dragTo(rows: number, columns: number) {
      terminal.resize(rows, columns);
    },
    async letGo() {
      clock.run();
      await terminal.drain();
    },
  };
}

/**
 * Часы под управлением проверки.
 *
 * Перевёрстка книги при изменении размера окна придержана на восемьдесят
 * миллисекунд, иначе протяжка окна мышью выбрасывает её на пол на каждый
 * пиксель. Ждать эти миллисекунды по-настоящему в проверках незачем, а вот
 * управлять ими нужно: только так видно, что за протяжку перевёрстка случилась
 * один раз, а не тридцать.
 */
interface Clock {
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (id: unknown) => void;
  /** Выполняет всё отложенное. */
  run: () => void;
}

function clockwork(): Clock {
  const timers = new Map<number, () => void>();
  let next = 1;
  return {
    schedule(fn) {
      const id = next;
      next += 1;
      timers.set(id, fn);
      return id;
    },
    cancel(id) {
      timers.delete(id as number);
    },
    run() {
      const due = [...timers.values()];
      timers.clear();
      for (const fn of due) fn();
    },
  };
}

/** Собирает читалку поверх поддельного терминала и рисует первый кадр. */
export async function harness(
  options: Omit<ReadOptions, "images"> & { images?: ReadOptions["images"] },
  size: { rows?: number; columns?: number } = {},
): Promise<ReaderHarness> {
  const terminal = new FakeTerminal(size.rows ?? 24, size.columns ?? 80);
  const clock = clockwork();
  const session = new Session(terminal, clock);
  session.begin(options.mouse);

  const reader = createReader(session, { images: "off", ...options });
  // Показ не ждём, но терминал возвращаем, как это делает настоящий запуск.
  void session.show(reader).then(() => session.end());
  await terminal.drain();

  return { terminal, session, reader, ...controls(terminal, session, clock) };
}

/** Собирает список книг поверх поддельного терминала. */
export async function libraryHarness(
  entries: ChooserEntry[],
  options: {
    theme?: string;
    mouse?: boolean;
    rows?: number;
    columns?: number;
    onSync?: () => Promise<{ text: string; entries?: ChooserEntry[] }>;
    onAdd?: (path: string) => Promise<{ text: string; entries?: ChooserEntry[] }>;
  } = {},
): Promise<ChooserHarness> {
  const terminal = new FakeTerminal(options.rows ?? 24, options.columns ?? 80);
  const clock = clockwork();
  const session = new Session(terminal, clock);
  session.begin(options.mouse ?? true);
  const chooser = new Chooser(entries, new Theme(options.theme ?? "night"), options.mouse ?? true, {
    ...(options.onSync ? { onSync: options.onSync } : {}),
    ...(options.onAdd ? { onAdd: options.onAdd } : {}),
    requestPaint: () => session.paint(),
  });
  const shown = session.show(chooser).then(() => {
    session.end();
    return chooser.picked;
  });
  await terminal.drain();

  return {
    terminal,
    session,
    chooser,
    picked: () => shown,
    ...controls(terminal, session, clock),
  };
}
