/**
 * Что подставляет Vite при сборке.
 *
 * Полный `vite/client` не берётся нарочно: он тянет объявления для картинок,
 * стилей и прочего, чего читалка не импортирует, а в этом пакете `types: []`
 * именно ради того, чтобы лишнего в глобальном пространстве не заводилось.
 *
 * `url` объявляется здесь же: он нужен `new Worker(new URL(...))`, и, объявив
 * `ImportMeta` своими руками, потерять его легче лёгкого.
 */
/** Версия читалки: подставляется при сборке из package.json пакета. */
declare const __VERSION__: string;

interface ImportMeta {
  readonly url: string;
  readonly env: {
    readonly PROD: boolean;
    readonly DEV: boolean;
    readonly BASE_URL: string;
  };
}
