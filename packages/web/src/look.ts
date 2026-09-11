/**
 * Облик книги: размер текста, ширина колонки, интервал, выключка, переносы.
 *
 * Вынесено отдельно и без DOM, потому что решать тут есть что: шаги, пределы и
 * то, как настройка читается из записи прошлого раза. Всё это проверяется без
 * браузера, а браузеру остаётся приписать числа к корню страницы.
 *
 * Величины — те же, что в терминале, и переключаются теми же клавишами: читать
 * одну и ту же книгу двумя способами и переучиваться ради этого никто не
 * станет.
 */

/**
 * Размеры в рем, от мелкого к крупному.
 *
 * Список, а не «плюс-минус десятая доля»: у шрифта с засечками не всякий
 * размер хорош, а перебирать по списку читателю понятнее, чем угадывать шаг.
 * Начало — 1.125: столько было до появления настройки, и у тех, кто уже читает,
 * ничего не съедет.
 */
export const TEXT_SIZES = [0.95, 1.0625, 1.125, 1.25, 1.375, 1.5, 1.75] as const;

/** Размер по умолчанию: тот, что был до появления настройки. */
export const DEFAULT_TEXT = 1.125;

/**
 * Следующий размер в нужную сторону.
 *
 * На краях список не заворачивается: «крупнее» на самом крупном должно
 * оставить как есть, а не швырнуть в самый мелкий — иначе одно лишнее нажатие
 * делает текст нечитаемым.
 */
export function stepSize(current: number, delta: number): number {
  const at = nearest(current);
  const next = Math.min(Math.max(at + delta, 0), TEXT_SIZES.length - 1);
  return TEXT_SIZES[next]!;
}

/** Дошли ли до края: кнопку тогда незачем показывать живой. */
export function atEdge(current: number, delta: number): boolean {
  return stepSize(current, delta) === TEXT_SIZES[nearest(current)];
}

/**
 * Размер из настроек прошлого раза.
 *
 * Настройки приходят из хранилища и могут быть какими угодно: чужая версия,
 * правка руками, испорченная запись. Поэтому число не только проверяется, но и
 * притягивается к ближайшему из списка — читать книгу шрифтом в сорок рем
 * никто не собирался.
 */
export function textSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TEXT;
  return TEXT_SIZES[nearest(value)]!;
}

/** Номер ближайшего размера в списке. */
function nearest(value: number): number {
  return nearestIn(TEXT_SIZES, value);
}

/* --- ширина колонки -------------------------------------------------------- */

/**
 * Ширины колонки в рем, от узкой к широкой.
 *
 * Списком, как и размеры текста: ширина строки — не дело вкуса, а мера, и за
 * её пределами чтение портится. Сорок четыре рем — примерно девяносто знаков,
 * дальше глаз уже не находит начало следующей строки. Двадцать шесть — около
 * пятидесяти, меньше делать нечего: слова начинают рваться переносами чаще,
 * чем читаются.
 *
 * Тридцать четыре — то, чем читалка верстала до появления настройки, и у тех,
 * кто уже читает, ничего не съедет.
 */
export const COLUMN_WIDTHS = [26, 30, 34, 38, 44] as const;

/** Ширина по умолчанию: та, что была до появления настройки. */
export const DEFAULT_COLUMN = 34;

/** Следующая ширина в нужную сторону; на краях списка — та же. */
export function stepColumn(current: number, delta: number): number {
  const at = nearestIn(COLUMN_WIDTHS, current);
  const next = Math.min(Math.max(at + delta, 0), COLUMN_WIDTHS.length - 1);
  return COLUMN_WIDTHS[next]!;
}

/** Ширина из настроек прошлого раза, притянутая к ближайшей из списка. */
export function columnWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_COLUMN;
  return COLUMN_WIDTHS[nearestIn(COLUMN_WIDTHS, value)]!;
}

/* --- число колонок в развороте --------------------------------------------- */

/**
 * Сколько колонок в развороте: 0 — сколько поместится.
 *
 * Ноль стоит первым нарочно: он и есть разумное поведение, а числа — для тех,
 * кому четыре колонки на широком мониторе кажутся газетой.
 */
export const COLUMN_COUNTS = [0, 2, 3, 4] as const;

/** По умолчанию колонок столько, сколько влезет в окно. */
export const DEFAULT_COUNT = 0;

/**
 * Число колонок из настроек прошлого раза.
 *
 * Чужое число не притягивается к ближайшему, а отбрасывается: «сколько
 * поместится» — ответ, годный для любой записи, а вот семь колонок из чужой
 * версии лучше не показывать вовсе.
 */
export function columnCount(value: unknown): number {
  return (COLUMN_COUNTS as readonly number[]).includes(value as number)
    ? (value as number)
    : DEFAULT_COUNT;
}

/* --- межстрочный интервал --------------------------------------------------- */

/** Интервалы: те же 1, 2, 3, что в терминале. */
export const SPACINGS = [1, 2, 3] as const;

/** Обычный интервал — тот, которым читалка верстала до появления настройки. */
export const DEFAULT_SPACING = 2;

/**
 * Высота строки для каждого интервала.
 *
 * В терминале интервал — это пустые строки между строками текста, и целое
 * число там единственно возможное. В браузере строка раздвигается плавно, и
 * двойной интервал вышел бы пустыней; поэтому числа подобраны по виду, а не
 * умножением. Средний — 1.65, ровно то, чем читалка верстала до настройки.
 */
const LINE_HEIGHTS = [1.4, 1.65, 2] as const;

/** Высота строки для этого интервала. */
export function lineHeight(spacing: number): number {
  return LINE_HEIGHTS[nearestIn(SPACINGS, spacing)]!;
}

/** Следующий интервал по кругу — как клавиша `s` в терминале. */
export function nextSpacing(current: number): number {
  return (spacingOf(current) % SPACINGS.length) + 1;
}

/** Интервал из настроек прошлого раза. */
export function spacingOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SPACING;
  return SPACINGS[nearestIn(SPACINGS, value)]!;
}

/* --- да или нет ------------------------------------------------------------- */

/**
 * Выключка и переносы: их значение из записи прошлого раза.
 *
 * Отдельная забота — чего не было в записи вовсе. В браузерной читалке
 * выключка и переносы работали с самого начала и выключить их было нечем, так
 * что «не записано» здесь значит «как было», а не «выключено».
 */
export function flagOf(value: unknown, byDefault: boolean): boolean {
  return typeof value === "boolean" ? value : byDefault;
}

/** Номер ближайшего числа в списке. */
function nearestIn(list: readonly number[], value: number): number {
  let best = 0;
  for (let i = 1; i < list.length; i += 1) {
    if (Math.abs(list[i]! - value) < Math.abs(list[best]! - value)) best = i;
  }
  return best;
}
