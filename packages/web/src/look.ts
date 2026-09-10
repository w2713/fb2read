/**
 * Размер текста в книге.
 *
 * Вынесено отдельно и без DOM, потому что решать тут есть что: шаги, пределы и
 * то, как размер читается из настроек прошлого раза. Всё это проверяется без
 * браузера, а браузеру остаётся приписать одно число к корню страницы.
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
  let best = 0;
  for (let i = 1; i < TEXT_SIZES.length; i += 1) {
    if (Math.abs(TEXT_SIZES[i]! - value) < Math.abs(TEXT_SIZES[best]! - value)) best = i;
  }
  return best;
}
