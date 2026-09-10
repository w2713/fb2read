/*
 * Работник, который держит читалку в браузере.
 *
 * Шапку — имя кэша, базовый путь и список файлов — дописывает сборка: имена у
 * файлов с отпечатками, и взять их неоткуда, кроме как из неё самой.
 *
 * Стратегия простая: всё, что нужно приложению, лежит в кэше и оттуда же
 * отдаётся. Это безопасно именно из-за отпечатков в именах: изменился файл —
 * изменилось имя, и старое никому не подсунется. Книг это не касается вовсе,
 * они лежат в IndexedDB и через сеть не ходят.
 */

const SHELL = BASE + "index.html";

self.addEventListener("install", (event) => {
  // addAll атомарен: один промах в списке — и работник не установится вовсе,
  // то есть читалка молча останется без офлайна. Поэтому список собирается из
  // сборки, а не пишется руками.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith("fb2read-") && name !== CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

/*
 * Обновление встаёт только по просьбе страницы.
 *
 * Подменять файлы под ногами у читателя нельзя: он читает книгу, а половина
 * приложения уже новая. Страница спросит и перезагрузится сама.
 */
self.addEventListener("message", (event) => {
  if (event.data === "обновиться") void self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(BASE)) return;

  event.respondWith(
    (async () => {
      // Спрашиваем именно свой кэш, а не все сразу: старый ещё может лежать
      // рядом, и caches.match достал бы файл из него.
      const cache = await caches.open(CACHE);

      // Саму страницу берём из сети, если сеть есть, и только иначе из кэша.
      //
      // Наоборот было хуже: страница отдавалась из кэша всегда, и читатель,
      // открывший читалку с сетью, видел вчерашнюю. Правка выложена, а на
      // телефоне её нет — и деться от этого было некуда, кроме как закрыть
      // всё до единой вкладки. Страница весит четыре килобайта, разметка
      // ссылается на файлы с отпечатками, и лишний запрос за ней ничего не
      // стоит; в самолёте же кэш по-прежнему выручает.
      if (request.mode === "navigate") {
        try {
          const answer = await fetch(request);
          if (answer && answer.ok) return answer;
        } catch {
          // Сети нет — значит, читаем то, что лежит.
        }
        return (await cache.match(SHELL)) ?? Response.error();
      }

      return (await cache.match(request)) ?? fetch(request);
    })(),
  );
});
