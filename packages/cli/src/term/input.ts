/**
 * Разбор того, что приходит из терминала.
 *
 * Чистый разбор без обращений к системе: на вход байты, на выход события.
 * Поэтому клавиши, мышь и обрывы посреди последовательности проверяются
 * обычными тестами, а не запуском в псевдотерминале.
 *
 * Клавиши сразу получают канонические имена (`"j"`, `"pgdn"`, `"ctrl-l"`),
 * так что разные коды одного смысла — CR и LF, DEL и BS — сводятся здесь,
 * а раскладка о них уже не знает.
 */

/** Нажатие клавиши. */
export interface KeyEvent {
  kind: "key";
  /** Каноническое имя: то же, что понимает раскладка. */
  name: string;
}

/** Событие мыши. Колонка и строка считаются от нуля. */
export interface MouseEvent {
  kind: "mouse";
  button: "left" | "middle" | "right" | "wheel-up" | "wheel-down" | "none";
  column: number;
  row: number;
  press: boolean;
  motion: boolean;
}

export type InputEvent = KeyEvent | MouseEvent;

const NAMED_CSI: Readonly<Record<string, string>> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  Z: "shift-tab",
};

const NUMBERED: Readonly<Record<string, string>> = {
  "1": "home",
  "2": "insert",
  "3": "delete",
  "4": "end",
  "5": "pgup",
  "6": "pgdn",
  "7": "home",
  "8": "end",
};

/** Сколько байтов занимает символ UTF-8, судя по первому байту. */
function utf8Length(byte: number): number {
  if (byte < 0x80) return 1;
  if ((byte & 0xe0) === 0xc0) return 2;
  if ((byte & 0xf0) === 0xe0) return 3;
  if ((byte & 0xf8) === 0xf0) return 4;
  return 1; // мусор: съедим один байт и пойдём дальше
}

export class InputParser {
  private buffer: number[] = [];
  private readonly decoder = new TextDecoder("utf-8");

  /**
   * Отдаёт события из очередного куска байтов.
   *
   * Незавершённая последовательность остаётся в буфере: клавиша может
   * приехать двумя чтениями, и терять её нельзя.
   */
  feed(chunk: Uint8Array): InputEvent[] {
    for (const byte of chunk) this.buffer.push(byte);
    const events: InputEvent[] = [];

    while (this.buffer.length) {
      const consumed = this.step(events);
      if (consumed === 0) break; // ждём продолжения
      this.buffer.splice(0, consumed);
    }
    return events;
  }

  /**
   * Всё, что осталось в буфере, считается законченным.
   *
   * Одинокий Esc приходит без продолжения, и отличить его от начала
   * последовательности можно только паузой: её отмеряет вызывающий.
   */
  flush(): InputEvent[] {
    const events: InputEvent[] = [];
    if (this.buffer.length === 1 && this.buffer[0] === 0x1b) {
      this.buffer.length = 0;
      events.push({ kind: "key", name: "esc" });
    }
    return events;
  }

  /** Есть ли неразобранный хвост — значит стоит подождать продолжения. */
  get pending(): boolean {
    return this.buffer.length > 0;
  }

  private step(events: InputEvent[]): number {
    const first = this.buffer[0]!;

    if (first === 0x1b) return this.escape(events);

    if (first === 0x0d || first === 0x0a) {
      events.push({ kind: "key", name: "enter" });
      return 1;
    }
    if (first === 0x7f || first === 0x08) {
      events.push({ kind: "key", name: "backspace" });
      return 1;
    }
    if (first === 0x09) {
      events.push({ kind: "key", name: "tab" });
      return 1;
    }
    if (first < 0x20) {
      // Управляющий код: Ctrl и буква отличаются на пять старших бит.
      events.push({ kind: "key", name: `ctrl-${String.fromCharCode(first + 96)}` });
      return 1;
    }

    const length = utf8Length(first);
    if (this.buffer.length < length) return 0; // символ ещё не доехал
    const bytes = new Uint8Array(this.buffer.slice(0, length));
    events.push({ kind: "key", name: this.decoder.decode(bytes) });
    return length;
  }

  private escape(events: InputEvent[]): number {
    if (this.buffer.length < 2) return 0;
    const second = this.buffer[1]!;

    if (second === 0x5b) return this.csi(events); // '['
    if (second === 0x4f) return this.ss3(events); // 'O'
    if (second === 0x5d || second === 0x50 || second === 0x5f) {
      return this.stringSequence(); // OSC, DCS, APC — проглатываем целиком
    }

    // Esc и обычная клавиша: Alt+что-то. Такие сочетания читалка не
    // использует, поэтому Esc отдаём отдельно, а клавишу разберём следом.
    events.push({ kind: "key", name: "esc" });
    return 1;
  }

  private csi(events: InputEvent[]): number {
    let at = 2;
    if (this.buffer[at] === 0x3c) return this.sgrMouse(events); // '<'
    if (this.buffer[at] === 0x4d) return this.x10Mouse(events); // 'M'

    let params = "";
    while (at < this.buffer.length) {
      const byte = this.buffer[at]!;
      if (byte >= 0x40 && byte <= 0x7e) break; // финальный байт
      params += String.fromCharCode(byte);
      at += 1;
    }
    if (at >= this.buffer.length) return 0;

    const final = String.fromCharCode(this.buffer[at]!);
    const length = at + 1;

    const named = NAMED_CSI[final];
    if (named) {
      events.push({ kind: "key", name: named });
      return length;
    }
    if (final === "~") {
      const name = NUMBERED[params.split(";")[0] ?? ""];
      if (name) events.push({ kind: "key", name });
      return length;
    }
    return length; // неизвестная последовательность: съели и молчим
  }

  private ss3(events: InputEvent[]): number {
    if (this.buffer.length < 3) return 0;
    const final = String.fromCharCode(this.buffer[2]!);
    const named = NAMED_CSI[final];
    if (named) events.push({ kind: "key", name: named });
    return 3;
  }

  /** Проглатывает OSC, DCS и APC до ST или BEL, чтобы не сыпать мусором. */
  private stringSequence(): number {
    for (let at = 2; at < this.buffer.length; at++) {
      const byte = this.buffer[at]!;
      if (byte === 0x07) return at + 1; // BEL
      if (byte === 0x1b && this.buffer[at + 1] === 0x5c) return at + 2; // ST
      if (byte === 0x1b && at + 1 >= this.buffer.length) return 0;
    }
    return 0;
  }

  /** Отчёты SGR: работают и в окнах шире 223 колонок. */
  private sgrMouse(events: InputEvent[]): number {
    let at = 3;
    let params = "";
    while (at < this.buffer.length) {
      const byte = this.buffer[at]!;
      if (byte === 0x4d || byte === 0x6d) break; // 'M' нажатие, 'm' отпускание
      params += String.fromCharCode(byte);
      at += 1;
    }
    if (at >= this.buffer.length) return 0;

    const press = this.buffer[at] === 0x4d;
    const [code, column, row] = params.split(";").map((n) => Number.parseInt(n, 10));
    if (code === undefined || column === undefined || row === undefined) return at + 1;
    if (!Number.isFinite(code) || !Number.isFinite(column) || !Number.isFinite(row)) {
      return at + 1;
    }

    events.push({
      kind: "mouse",
      ...decodeButton(code),
      column: column - 1,
      row: row - 1,
      press,
    });
    return at + 1;
  }

  /** Старый формат отчётов: на всякий случай, ограничен 223 колонками. */
  private x10Mouse(events: InputEvent[]): number {
    if (this.buffer.length < 6) return 0;
    const code = this.buffer[3]! - 32;
    const column = this.buffer[4]! - 33;
    const row = this.buffer[5]! - 33;
    events.push({ kind: "mouse", ...decodeButton(code), column, row, press: true });
    return 6;
  }
}

function decodeButton(code: number): Pick<MouseEvent, "button" | "motion"> {
  const motion = (code & 32) !== 0;
  if (code & 64) {
    return { button: code & 1 ? "wheel-down" : "wheel-up", motion };
  }
  const which = code & 3;
  const button = which === 0 ? "left" : which === 1 ? "middle" : which === 2 ? "right" : "none";
  return { button, motion };
}
