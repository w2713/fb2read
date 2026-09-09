/**
 * Терминал: сырой режим, ввод, изменение размера окна.
 *
 * Всё, что касается системы, собрано здесь за небольшим интерфейсом —
 * тесты подставляют вместо него свою реализацию и проверяют читалку целиком,
 * не поднимая псевдотерминал.
 */

import {
  MOUSE_OFF,
  MOUSE_ON,
  colorDepth,
  enterSequence,
  leaveSequence,
} from "./ansi.js";
import { InputParser, type InputEvent } from "./input.js";

export interface Terminal {
  readonly columns: number;
  readonly rows: number;
  readonly colors: number;
  write(data: string): void;
  onInput(handler: (event: InputEvent) => void): void;
  onResize(handler: () => void): void;
  enterRaw(mouse: boolean): void;
  leaveRaw(): void;
  setMouse(on: boolean): void;
}

/** Пауза, после которой одинокий Esc считается нажатием, а не началом кода. */
const ESC_TIMEOUT_MS = 30;

/** Как часто проверять размер окна там, где о нём не сообщают. */
const RESIZE_POLL_MS = 1000;

export class NodeTerminal implements Terminal {
  readonly colors: number;
  private parser = new InputParser();
  private handlers: Array<(event: InputEvent) => void> = [];
  private resizeHandlers: Array<() => void> = [];
  private raw = false;
  private mouseOn = false;
  private escTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private lastSize = "";
  private cleanupInstalled = false;

  constructor(
    private readonly input: NodeJS.ReadStream = process.stdin,
    private readonly output: NodeJS.WriteStream = process.stdout,
  ) {
    this.colors = colorDepth(process.env, process.platform);
  }

  get columns(): number {
    return this.output.columns ?? 80;
  }

  get rows(): number {
    return this.output.rows ?? 24;
  }

  write(data: string): void {
    try {
      this.output.write(data);
    } catch {
      // Терминал закрыли из-под нас: рисовать больше некуда, но и падать
      // незачем — выход разберётся сам.
    }
  }

  onInput(handler: (event: InputEvent) => void): void {
    this.handlers.push(handler);
  }

  onResize(handler: () => void): void {
    this.resizeHandlers.push(handler);
  }

  enterRaw(mouse: boolean): void {
    if (this.raw) return;
    this.raw = true;
    if (this.input.isTTY) this.input.setRawMode(true);
    this.input.resume();
    this.input.on("data", this.onData);

    this.write(enterSequence(mouse));
    this.mouseOn = mouse;

    // Об изменении размера сообщают по-разному: событие потока есть не
    // везде, SIGWINCH не приходит на Windows, поэтому слушаем всё сразу
    // и добавляем опрос как последнюю опору.
    this.output.on("resize", this.onResizeEvent);
    process.on("SIGWINCH", this.onResizeEvent);
    this.lastSize = `${this.columns}x${this.rows}`;
    this.pollTimer = setInterval(() => {
      const size = `${this.columns}x${this.rows}`;
      if (size !== this.lastSize) {
        this.lastSize = size;
        this.onResizeEvent();
      }
    }, RESIZE_POLL_MS);
    this.pollTimer.unref?.();

    this.installCleanup();
  }

  leaveRaw(): void {
    if (!this.raw) return;
    this.raw = false;
    this.write(leaveSequence(this.mouseOn));
    this.mouseOn = false;

    if (this.escTimer) clearTimeout(this.escTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.escTimer = null;
    this.pollTimer = null;

    this.input.off("data", this.onData);
    this.output.off("resize", this.onResizeEvent);
    process.off("SIGWINCH", this.onResizeEvent);
    if (this.input.isTTY) this.input.setRawMode(false);
    this.input.pause();
  }

  setMouse(on: boolean): void {
    if (on === this.mouseOn) return;
    this.mouseOn = on;
    this.write(on ? MOUSE_ON : MOUSE_OFF);
  }

  private onData = (chunk: Buffer): void => {
    if (this.escTimer) {
      clearTimeout(this.escTimer);
      this.escTimer = null;
    }
    for (const event of this.parser.feed(new Uint8Array(chunk))) this.emit(event);
    if (this.parser.pending) {
      // Хвост может быть началом последовательности, а может — одиноким Esc.
      this.escTimer = setTimeout(() => {
        for (const event of this.parser.flush()) this.emit(event);
        this.escTimer = null;
      }, ESC_TIMEOUT_MS);
      this.escTimer.unref?.();
    }
  };

  private onResizeEvent = (): void => {
    for (const handler of this.resizeHandlers) handler();
  };

  private emit(event: InputEvent): void {
    for (const handler of this.handlers) handler(event);
  }

  /**
   * Возврат терминала в чувство при любом исходе.
   *
   * Без этого падение оставило бы пользователя в альтернативном экране без
   * курсора и с захваченной мышью — именно от такого спасал curses.wrapper.
   */
  private installCleanup(): void {
    if (this.cleanupInstalled) return;
    this.cleanupInstalled = true;
    const restore = () => this.leaveRaw();
    process.once("exit", restore);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.once(signal, () => {
        restore();
        process.exit(signal === "SIGINT" ? 130 : 143);
      });
    }
    process.once("uncaughtException", (error) => {
      restore();
      process.stderr.write(`fb2read: ${error.message}\n`);
      process.exit(1);
    });
  }
}
