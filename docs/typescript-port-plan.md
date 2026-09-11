# План: перенос fb2read на TypeScript с установкой на любое устройство и синхронизацией

## Контекст

Сейчас fb2read — один файл `fb2read.py` (2598 строк) на Python 3.8 без зависимостей плюс 1100 строк
тестов (73 в `test_core.py`, 61 в `test_ui.py`). Работает там, где есть Python и полноценный curses:
Linux, macOS, Termux. На Windows curses слабый (мышь, ресайз, цвета), на iPhone/iPad терминала нет,
установка требует `pip`.

Внутри код уже разделён на слои, и это главное, что упрощает перенос:

| Слой | Строки в `fb2read.py` | Зависит от платформы |
|---|---|---|
| Разбор fb2/epub, ремонт битого XML, `Block` | 58–765 | нет |
| Вёрстка: ширина символов, перенос, `layout()` | 765–965 | нет |
| Состояние (`positions.json`), конфиг, быстрые метаданные | 965–1230 | только пути к файлам |
| TUI: `choose_book`, `Reader`, мышь, картинки | 1230–2600 | curses, termios, locale |

Решено с пользователем:
- устройства: Windows, macOS, Linux, Android (Termux), iPhone/iPad, браузер;
- стек: TypeScript;
- установка: `curl | sh` и `install.ps1`, скачивающие готовые бинарники из GitHub Releases; npm вторым каналом;
- синхронизация книг и позиций чтения с сервером: выгрузка книг на сервер и загрузка с него;
- сейчас нужен только план.

## Ключевые решения

1. **Python остаётся эталоном.** Тот же формат `Block`, тот же вывод `layout()` при той же ширине, те же
   русские сообщения, тот же `positions.json` и та же схема `book_key` (sha1 от `абсолютный путь:размер`,
   первые 16 символов), чтобы позиции чтения пережили смену бинарника.
2. **Ядро чистое.** В `packages/core` нет `fs`, `process`, `Buffer`, `child_process`. Всё, что касается файлов,
   терминала, сети и времени, за интерфейсами `ByteSource`, `StateStore`, `SyncTransport`. Это и позволяет
   запустить то же ядро в браузере для iPhone.
3. **Node ≥ 20 и Bun.** Bun собирает автономные бинарники, Node — рантайм для Termux, npm и тестов.
   В этой среде уже есть Node 22.22 и Bun 1.3.11, на них и проверялись утверждения ниже.
4. **Зависимости ядра — три маленькие:** `fflate` 0.8 (zip), `@rgrove/parse-xml` 5.0 (XML),
   `get-east-asian-width` 1.6 (ширина символов). Все без собственных зависимостей. CLI ничего не добавляет.
   Web добавляет `idb` и `vite-plugin-pwa`. Сервер — ничего сверх `node:http`.
5. **TUI пишем сами на ANSI-последовательностях**, без curses и без blessed/ink: нужны ~600 строк,
   и тесты и так проверяют байты (`\x1b[?1006h`, kitty `\x1b_G`, iTerm `1337;File=`).
6. **Книга между устройствами опознаётся по содержимому**, а не по пути: sha256 файла. Локальный
   `book_key` по пути остаётся для совместимости, в запись состояния добавляется поле `hash`.

## Структура репозитория

```
fb2read/
├── package.json, pnpm-workspace.yaml, tsconfig.base.json, vitest.workspace.ts
├── fb2read.py, tests/          остаются как эталон до M4, потом удаляются
├── .github/workflows/
│   ├── ci.yml                  typecheck + vitest: ubuntu/macos/windows × node 20/22 + bun
│   ├── release.yml             tag v* → bun compile (8 целей, darwin на macos-раннере) → Release + SHA256SUMS → npm
│   └── pages.yml               PWA + install.sh/install.ps1 → GitHub Pages
├── scripts/
│   ├── install.sh              POSIX sh, curl | sh
│   ├── install.ps1             irm | iex
│   └── diff-dump.sh            сравнение --dump Python и TS на корпусе книг (M1)
└── packages/
    ├── core/                   @fb2read/core, чистое ядро (Node + браузер)
    ├── cli/                    fb2read: терминальный интерфейс, публикуется в npm, компилируется Bun
    ├── server/                 fb2read-server: сервер синхронизации, тот же конвейер сборки
    └── web/                    PWA (Vite, без фреймворка), GitHub Pages
```

## Ядро: соответствие Python → TypeScript (`packages/core/src/`)

| Модуль | Что поглощает из `fb2read.py` | Замечания |
|---|---|---|
| `source.ts` | половина `read_source` | `ByteSource { name, size, bytes(), slice(a,b) }`. CLI даёт реализацию на fs, web — на `File`. `slice` нужен сразу: картинки FB2 читаются лениво по байтовым смещениям |
| `zip.ts` | `zipfile`, `is_epub`, `image_data` для EPUB | `fflate.unzipSync(bytes, {filter})` распаковывает только нужный файл; `zipSync` для фикстур |
| `encoding.ts` | цикл кодировок `utf-8, cp1251, koi8-r, cp1252, utf-16` в `parse_xml`, `_ENC_RE` | **Свои таблицы cp1251 и koi8-r обязательны, а не на всякий случай:** Bun 1.3.11 не знает эти метки `TextDecoder` (проверено: `Unsupported encoding label "windows-1251"`), Node 22 знает. cp1252 и utf-16 есть везде. Свои таблицы дают и `encodeLegacy()` для фикстур: `TextEncoder` умеет только UTF-8. В таблице cp1251 байт 0x98 не определён, чтобы строгое декодирование падало как в Python |
| `entities.ts` | `html.entities.name2codepoint` | 252 имени HTML 4.01 литералом (проверено) |
| `repair.ts` | `strip_binaries`, `fix_entities`, `repair` | Байты → latin1-строка через `String.fromCharCode`, чтобы смещения `binary` остались байтовыми |
| `xml.ts` | `ET.fromstring`, `local`, `text_of` | Единственное место, где импортируется парсер. Вся лестница повторных попыток `parse_xml` здесь |
| `inline.ts` | `_Runs`, `inline_runs`, `text_and_refs` | Смещения в UTF-16 code units, одно соглашение на всё ядро |
| `block.ts`, `fb2.ts`, `epub.ts`, `book.ts` | `Block`, `_load_fb2`, `_meta`, `_walk`, `_EpubMixin`, `Book` | `Book.open(src): Promise<Book>`, `imageData(src): Promise<{data, mime}|null>` (async из-за `File` в браузере). `Book.hash` считается при открытии (sha256, `crypto.subtle` есть и в Node, и в браузере) |
| `mime.ts` | `mimetypes` | карта на 10 записей |
| `width.ts` | `char_width`, `str_width`, `cut_to_width` | `eastAsianWidth(cp)` из библиотеки уже возвращает 1 или 2 и по умолчанию считает ambiguous узкими, ровно как Python. Комбинируемые (`\p{M}`) и ZW-символы → 0. Быстрый путь: код < 0x300 (латиница, кириллица) → 1 без таблиц |
| `wrap.ts`, `layout.ts` | `_push_word`, `wrap_words`, `STYLE`, `_line_styles`, `layout` | `Line { text, attr, block, styles }` вместо кортежа |
| `search.ts` | `normalize`, `find_matches`, `match_context` | ё → е, lowercase только если длина символа не меняется |
| `state.ts` | `load_pos`/`save_pos`/закладки/`load_settings`/`recent_books`/`progress_percent` | Объявляет `StateStore` (все методы async) и формы записей; реализации в cli (JSON-файл) и web (IndexedDB) |
| `sync.ts` | нового в Python нет | Чистые функции слияния и HTTP-клиент на `fetch` (см. раздел «Синхронизация») |
| `bookmarks.ts` | `bookmark_label`, текстовая часть `export_bookmarks` | Возвращает markdown строкой, запись — дело платформы |
| `config.ts` | `CONFIG_SAMPLE`, `load_config`, `write_config`, `THEME_ORDER`, `IMAGE_BACKENDS` | Свой `parseIni` на ~40 строк; добавляется секция `[sync]` |
| `keymap.ts` | `ACTIONS`, `KEY_NAMES`, `parse_key`, `build_keymap`, `key_title`, `help_rows` | Клавиши — канонические имена (`"j"`, `"ctrl-l"`, `"pgdn"`), не числа curses |
| `meta.ts` | `quick_meta`, `epub_meta`, `BOOK_SUFFIXES` | Для голого fb2 читает первые 300 000 байт через `slice`; для zip Python читает файл целиком и режет, здесь то же самое |
| `text.ts` | `plural` | |

Не переносятся в ядро: `state_file`, `config_file`, `scan_dir`, `choose_book`, `Reader`, картинки, мышь,
`setup_locale`, `main`.

**Почему `@rgrove/parse-xml` (проверено на версии 5.0.0).** Нужен строгий парсер, который *падает* на битом
XML (на этом держится `repair`), сохраняет порядок текста и хвостов, хранит префиксные атрибуты (`l:href`),
отвергает неизвестные сущности и одинаково ведёт себя в Node, Bun и браузерах. Прогон показал: атрибут
`l:href` остаётся как есть, `&#1076;` декодируется, пробельные текстовые узлы сохраняются, `&nbsp;`,
голый `&` и управляющий байт дают `XmlError` со строкой и колонкой. Есть опция `resolveUndefinedEntity`,
но ремонт лучше оставить в `repair.ts`, чтобы правки попадали в `--info`, как сейчас.
`DOMParser` есть только в браузере и вместо ошибки возвращает `<parsererror>`; `fast-xml-parser` намеренно
снисходительный; `sax` строгий, но дерево пришлось бы строить самим.

**Контракт ядра для CLI, web и сервера** (фиксируется в M1):

```
ByteSource, Book.open, Book#imageData, Book#hash, Block/Ref/Span/TocEntry
layout, wrapWords, strWidth, charWidth, cutToWidth
normalize, findMatches, matchContext
StateStore { loadPosition, savePosition, loadBookmarks, saveBookmarks,
             loadSettings, saveSettings, recent, changedSince(ts) }   // все async
PositionRecord { block, total, title, author, path, at, hash, bookmarks }
mergePosition, mergeBookmarks, SyncClient, SyncTransport
bookmarkLabel, bookmarksMarkdown, readConfig, CONFIG_SAMPLE
ACTIONS, parseKey, buildKeymap, keyTitle, helpRows
quickMeta, epubMeta, BOOK_SUFFIXES, plural, progressPercent
```

Правила: в `packages/core` нет `@types/node`, на входе `Uint8Array`, весь ввод-вывод через `Promise`,
сеть только через `fetch` (есть в Node ≥ 18, Bun и браузерах).

## CLI: терминал без curses (`packages/cli/src/`)

```
main.ts, args.ts        util.parseArgs (проверено: цифровые короткие ключи -2/-1 работают в Node 22), вручную только -V и текст справки
paths.ts                XDG на unix; %APPDATA%\fb2read (конфиг) и %LOCALAPPDATA%\fb2read (данные) на Windows
fsSource.ts, store.ts   ByteSource на node:fs; JsonFileStore, байт-в-байт совместимый positions.json (+ поле hash)
library.ts              scanDir, recentBooks, книги с сервера, текстовый список при не-TTY
sync.ts                 команды sync/push/pull/remote, фоновая синхронизация при открытии и выходе
term/ansi.ts            константы последовательностей, определение глубины цвета, карта 256 → 16 (= _FALLBACK)
term/screen.ts          сетка ячеек, put(y,x,text,attr), отрисовка diff-ом, invalidate() для полной перерисовки
term/input.ts           чистая функция feed(bytes) → KeyEvent | MouseEvent, тестируется без TTY
term/terminal.ts        interface Terminal { columns, rows, write, onInput, onResize, enterRaw, leaveRaw } + NodeTerminal
ui/theme.ts, popup.ts, prompt.ts, reader.ts, chooser.ts, images.ts
```

- **Экран.** Ячейка `{ch, width, attr}`, широкие символы занимают две ячейки. `flush()` сравнивает с прошлым
  кадром построчно, шлёт `CUP` и SGR только при изменении, кадр обёрнут в `?2026h/l` (синхронный вывод).
  `invalidate()` — полная перерисовка на Ctrl+L, ресайз и возврат из показа картинки, как и сейчас.
- **Ввод.** Сборка UTF-8 через границы чанков; CR/LF → `enter`, DEL/BS → `backspace`, `0x00–0x1f` → `ctrl-x`;
  одиночный Esc по таймеру 30 мс; CSI-стрелки, Home/End/PgUp/PgDn/Delete, SS3-варианты; SGR-мышь
  `\x1b[<b;x;yM|m` плюс защитный разбор X10; неизвестные CSI/OSC/DCS проглатываются.
- **Жизненный цикл.** `enterRaw`: `setRawMode`, `?1049h ?25l`, при мыши `?1000h ?1006h`, всегда `?1007h`
  (alternate scroll: колесо превращается в стрелки там, где мышь не работает). `leaveRaw` идемпотентен,
  вешается на `exit`, `SIGINT`, `SIGTERM`, `SIGHUP`, `uncaughtException` — замена `curses.wrapper`.
  Ресайз: `stdout.on("resize")` + `SIGWINCH` + опрос раз в секунду (conhost), всё в один debounce.
- **Картинки.** kitty и iTerm — это просто escape-последовательности, переносятся как есть.
  `chafa`/`img2sixel` через `child_process.spawnSync` и `os.tmpdir()`, остаются необязательными.
- **Windows.** libuv переводит клавиши в VT-последовательности, кириллица выводится без `chcp`. Мышь libuv
  не пробрасывает, а запрос в Node добавить это (issue nodejs/node#56338) закрыт как «не планируется».
  Поэтому на win32 мышь выключена по умолчанию, колесо работает через `?1007h`, `--mouse` включает
  принудительно. Требуем Windows 10 1809+.
- **Не-TTY.** `--dump | head` не падает на `EPIPE`: обработчик `error` на stdout (аналог `_safe_print_lines`).

## Синхронизация с сервером

**Зачем именно свой сервер, а не WebDAV.** WebDAV (Nextcloud, Яндекс Диск) даст перенос файлов без своего
кода, но не умеет сливать позиции и закладки с двух устройств и не даёт браузеру CORS. Свой сервер —
это ~400 строк на `node:http`, зато с честным слиянием и одинаковым API для CLI и PWA. Именно через
сервер книги попадают на iPhone: без кабеля, по одной кнопке в PWA.

**`packages/server`** — `fb2read-server`, тот же конвейер: npm-пакет и автономный бинарник через Bun,
плюс `Dockerfile`. Хранилище — каталог на диске: `books/<hash>.<ext>`, `state/<hash>.json`, `index.json`.
Авторизация — bearer-токен из `FB2READ_SERVER_TOKENS` (несколько токенов = несколько пользователей,
у каждого свой подкаталог). TLS через reverse proxy (Caddy, nginx), в README пример на Caddy.
Ограничение размера загрузки (по умолчанию 200 МБ), CORS для адреса PWA.

**API (`/api/v1`):**

| Метод и путь | Что делает |
|---|---|
| `GET /books` | список `{hash, name, size, title, author, updatedAt}` |
| `PUT /books/:hash` | загрузить книгу (тело — файл, заголовок `X-Name`); идемпотентно, сервер сверяет sha256 |
| `GET /books/:hash` | скачать книгу |
| `DELETE /books/:hash` | удалить книгу и её состояние |
| `GET /state?since=<ts>` | все записи состояния, изменённые после `ts` |
| `PUT /state/:hash` | прислать `{block, total, title, author, at, bookmarks, device}`; сервер сливает и возвращает результат |

**Правила слияния (чистые функции в `core/sync.ts`, покрываются тестами):**
- позиция: побеждает запись с большим `at`; при равенстве — та, что пришла на сервер позже;
- закладки: объединение по номеру блока; удаление хранится как надгробие `{block, deleted: true, at}`,
  чтобы снятая на одном устройстве закладка не воскресала с другого;
- настройки (тема, интервал, колонки) не синхронизируются: они зависят от терминала.

**CLI:**
- `fb2read sync` — двусторонний обмен состоянием без передачи книг;
- `fb2read push book.fb2` — выгрузить книгу и её состояние;
- `fb2read pull [hash|--all]` — скачать в `$FB2READ_LIBRARY` (по умолчанию `~/Books/fb2read`);
- `fb2read remote` — список книг на сервере с прогрессом;
- если в конфиге есть `[sync] url`, при открытии и выходе из книги состояние сливается в фоне с таймаутом
  3 с; отсутствие сети переживается молча, сообщение в строке состояния;
- в библиотеке книги, которых нет локально, помечены `☁` и скачиваются по Enter.

**Конфиг:**

```ini
[sync]
# url = https://books.example.org
# token = ...            либо переменная FB2READ_SYNC_TOKEN
# auto = yes             сливать позицию при открытии и выходе
```

Файл конфига с токеном создаётся с правами 600.

**PWA:** тот же `SyncClient` из ядра; библиотека показывает книги с сервера, скачивает в IndexedDB,
выгружает локальные; позиция сливается при открытии и при уходе со страницы (`visibilitychange`).

**Тесты:** слияние — vitest на чистых функциях; сервер поднимается в процессе на случайном порту;
сквозной тест: два `MemoryStore` синхронизируются через сервер, проверяются гонки позиций и надгробия.

## Дистрибуция

**Бинарники: `bun build --compile`.** Кросс-компиляция в 8 целей (список сверен с документацией Bun):
`bun-linux-x64`, `bun-linux-arm64`, `bun-linux-x64-musl`, `bun-linux-arm64-musl`, `bun-darwin-x64`,
`bun-darwin-arm64`, `bun-windows-x64`, `bun-windows-arm64`. Суффиксы `-baseline`/`-modern` теперь
принимаются только для совместимости: Bun собирает один x64-бинарник под Nehalem (SSE4.2), так что
отдельной проверки AVX2 в инсталляторе не нужно. Вход для Bun — тот же `packages/cli/dist/fb2read.mjs`
(tsup, `noExternal`), что уходит в npm. Флаги `--minify --bytecode`. Размер ~90 МБ сырой, ~35 МБ в архиве.

Node SEA пересмотрен: в Node 25.5+ появился `--build-sea` без `postject` и с поддержкой ESM, но сборка
по-прежнему нужна на раннере каждой ОС, macOS проверяется только на arm64, Alpine не поддерживается.
Bun остаётся выбором из-за кросс-компиляции с одного раннера.

**macOS и подпись.** Документация Bun предлагает подписывать через `codesign` с `entitlements.plist`
(JIT). На Linux-раннере `codesign` нет, а Apple Silicon отказывается запускать неподписанные arm64-бинарники,
поэтому darwin-цели собираются на `macos-latest` и там же подписываются ad-hoc (`codesign -s -`).
`curl` не ставит атрибут карантина, `curl | sh` работает без `xattr`. Нотаризация вне объёма.

**Android (Termux).** Bun под Android не запускается: официальный aarch64-бинарник собран без PIE, а
Android требует PIE (issue oven-sh/bun#28924). Node в Termux есть, `nodejs-lts` сейчас 24.18.
`install.sh` распознаёт Termux (`$PREFIX` содержит `com.termux` или `uname -o` = `Android`) и выполняет
`pkg install -y nodejs-lts && npm install -g fb2read`. Бандл без нативных модулей, без postinstall.
Termux шлёт касания как SGR-мышь, так что мышь там работает.

**iPhone/iPad.** Терминала нет, единственный путь — PWA плюс сервер синхронизации для доставки книг.

**`scripts/install.sh`** (POSIX sh): `uname -s`/`uname -m` → цель; ветка Termux; musl по `ldd`/`/etc/alpine-release`;
`${FB2READ_VERSION:-latest}` → `releases/latest/download/fb2read-<цель>.tar.gz`; `curl -fsSL` или `wget -qO-`;
скачать `SHA256SUMS`, проверить `sha256sum -c`/`shasum -a 256`, при несовпадении прервать; распаковать в
`${FB2READ_INSTALL_DIR:-$HOME/.local/bin}`, `chmod +x`, прогнать `fb2read --version`; если каталога нет
в `PATH`, напечатать строку для `~/.profile`/`~/.zshrc`/`config.fish`. Тот же скрипт с `--server` ставит
`fb2read-server`. Хостится на GitHub Pages вместе с PWA, `raw.githubusercontent` как запасной адрес.

**`scripts/install.ps1`**: `Invoke-WebRequest` архива и `SHA256SUMS`, `Get-FileHash`, распаковка в
`$env:LOCALAPPDATA\Programs\fb2read`, добавление в пользовательский `Path` через
`[Environment]::SetEnvironmentVariable`, подсказка открыть новый терминал и поставить Windows Terminal.

**`release.yml`**: на тег `v*`: тесты → матрица `bun build --compile` (ubuntu для linux и windows,
macos для darwin с `codesign`) → `sha256sum * > SHA256SUMS` → `softprops/action-gh-release` →
`npm publish --provenance` для `fb2read` и `fb2read-server`. Версия в `package.json` должна совпадать с тегом.

**npm**: пакет `fb2read`, `bin: dist/fb2read.mjs`, `engines.node >= 20`, без зависимостей (всё вбандлено).
`npx fb2read book.fb2` работает. `@fb2read/core` пока приватный workspace-пакет.

## PWA (`packages/web`, этап M5, контракт фиксируется в M1)

- Vite + vanilla TS, `vite-plugin-pwa` (precache оболочки, `navigateFallback`), `manifest.webmanifest`
  с `display: standalone` — обязательно для установки на экран «Домой» в iOS.
- `db.ts`: `IdbStore implements StateStore` на `idb`, хранилища `books` (blob + метаданные), `state`, `settings`.
  Ключ книги — тот же sha256 содержимого, что и на сервере. `navigator.storage.persist()` при первом
  импорте, иначе iOS чистит хранилище после простоя.
- `library.ts`: `<input type=file accept=".fb2,.zip,.fbz,.epub">`, drag-and-drop, `File` как `ByteSource`,
  список книг с сервера.
- `reader.ts`: `Block[]` → семантический HTML (`h1..h6`, `p`, `blockquote`, `figure` с ленивыми blob-URL,
  `a.note`), `data-block` на каждом элементе, `IntersectionObserver` сохраняет позицию; поиск и закладки из ядра;
  темы — CSS-переменные с именами четырёх тем Python. Разбор в Web Worker.
- `pages.yml`: `vite build --base=/fb2read/`, копирование инсталляторов в `dist/`, `deploy-pages`.

## Тесты

- **Ядро**: vitest, порт `tests/test_core.py` один к одному. Фикстуры из `conftest.py`/`epub_data.py`
  переносятся в `packages/core/test/fixtures.ts`: cp1251 через свой `encodeLegacy`, EPUB через `fflate.zipSync`,
  PNG 8×8 через `deflateSync` + CRC32, `big.fb2` на seeded PRNG. `MemorySource` и `MemoryStore` вместо файлов.
  Тесты формата `positions.json` уезжают в `packages/cli/test/store.test.ts`.
- **UI**: основной набор — `FakeTerminal` + `@xterm/headless` 6.0 внутри процесса (API сверен: `getLine(y).translateToString()`,
  `getCell(x).isItalic()/isBold()/isInverse()/isUnderline()`, `resize`, `write` — всё без `allowProposedApi`).
  `write()` пишет в сырой лог и в xterm; `sendKeys`/`click`/`wheel` подают те же последовательности, что писал
  `tests/terminal.py` в pty; протоколы картинок и мыши проверяются по сырому логу.
  Плюсы: детерминированно, без `sleep`, работает на Windows CI, в ~50 раз быстрее.
  Отдельно `smoke.pty.test.ts` на `node-pty` (только Linux/macOS): запуск собранного бандла, `pty.resize`,
  выход с кодом 0, `--dump | head` без падения.
- **Синхронизация**: см. раздел выше.
- **Статика**: `tsc --noEmit` в каждом пакете, порог покрытия для `layout.ts`/`wrap.ts`/`repair.ts`/`sync.ts`,
  бенчмарк `layout` большой фикстуры ×10 < 300 мс.

## Этапы

| Этап | Объём | Оценка | Готово, когда |
|---|---|---|---|
| **M0 каркас** | pnpm workspace, tsconfig, vitest, CI на трёх ОС | 0.5 нед | `pnpm test` зелёный на ubuntu/macos/windows |
| **M1 ядро** | все модули ядра, включая `hash` и чистое слияние; в cli только `main`, `args`, `fsSource`, `store`, `--dump/--toc/--info/--write-config`, текстовая библиотека | 1.5 нед | порт `test_core` зелёный; `--dump` байт-в-байт совпадает с Python на корпусе ≥ 20 реальных книг; `--info` печатает те же правки; старый `positions.json` читается без изменений |
| **M2 чтение в TUI** | `term/*`, `reader.ts`: листание, главы, оглавление, сноски, разворот, интервал, ширина, темы, справка, поиск, ресайз | 2 нед | UI-тесты навигации/разворота/ресайза/поиска/конфига из `test_ui.py` зелёные; ручная проверка в kitty, WezTerm, GNOME Terminal, Terminal.app, Windows Terminal, conhost |
| **M3 библиотека, закладки, картинки, мышь** | `chooser.ts`, `library.ts`, экспорт закладок, `images.ts`, SGR-мышь и хотспоты, `m` | 1.5 нед | остальные случаи `test_ui.py` перенесены; `pnpm test` полностью заменяет `pytest`; таблица клавиш README сверена |
| **M4 дистрибуция** | tsup, матрица Bun, `release.yml`, инсталляторы, Pages, npm, новый README, удаление `fb2read.py` | 1 нед | `curl … \| sh` ставит рабочий бинарник на Linux x64/arm64, macOS x64/arm64, Alpine; `irm … \| iex` на Windows 11; Termux через npm; подменённый архив отвергается по SHA256 |
| **M5 синхронизация** | `packages/server`, `SyncClient`, команды `sync/push/pull/remote`, фоновое слияние, `☁` в библиотеке, Dockerfile, сборка сервера | 1.5 нед | два ноутбука обмениваются позицией и закладками через сервер; книга, выгруженная с одного, читается на другом с того же места; удалённая закладка не возвращается |
| **M6 PWA** | `packages/web` целиком, включая синхронизацию | 2 нед | FB2 и EPUB открываются в Safari на iPhone с экрана «Домой»; книга, выгруженная с ноутбука, появляется на iPhone и открывается на нужной позиции; всё переживает перезагрузку и авиарежим |

Итого 10 недель на всё; M4 можно вести параллельно с M3, инсталляторам достаточно работающего `--version`.

## Риски

| Риск | Что делаем |
|---|---|
| Мышь на Windows: libuv не отдаёт события мыши, Node не включает VT-ввод, запрос закрыт как «не планируется» | мышь выключена по умолчанию на win32, колесо через `?1007h`, `--mouse` для включения; задокументировать |
| Пробелы Bun: нет cp1251/koi8-r в `TextDecoder` (подтверждено), `stdout.resize`, raw mode, подпись darwin | свои таблицы кодировок; `SIGWINCH` + опрос; отдельная Bun-задача в CI; darwin собирается и подписывается на macos-раннере; npm как запасной канал |
| Termux без Bun, Node из `pkg` может отставать | инсталлятор распознаёт Termux и идёт через npm; `engines.node >= 20` заведомо ниже `nodejs-lts` 24 |
| Дрейф ширины Unicode между `unicodedata` (здесь Python 3.11, Unicode 14), таблицами библиотеки и терминалом | та же политика, что в Python; версия библиотеки пришпилена; тесты сравнивают с нашей `strWidth`, а не с терминалом |
| Индексы UTF-16 против code points в Python | одно соглашение везде; тесты `text.slice(offset, offset + line.length) === line` переносятся из Python |
| Большие книги в памяти, скорость `layout` в JS | `binary` режется до декодирования; `ByteSource.slice` для ленивых чтений; быстрый путь для кириллицы; бенчмарк в CI; ленивая вёрстка сделана в браузере (`content-visibility` плюс своя придержка места в `packages/web/src/hold.ts`: нажатие «крупнее» перестало зависеть от размера книги — 200 → 67 мс); в терминале не делается намеренно — 258 мс из 737 мс открытия, один раз, а плоский `Line[]` держит на себе листание, процент, переход к блоку и две колонки |
| Расхождение часов устройств при слиянии позиций | сравнение по `at` с сервером как арбитром при равенстве; при заметном расхождении (> 5 мин) сервер отвечает предупреждением, CLI показывает его в строке состояния |
| Токен синхронизации в конфиге | файл 600, переменная окружения как альтернатива, токен никогда не печатается в `--info` и логах |
| Терминалы без terminfo (Linux VT, старый screen) | только xterm-подмножество; `TERM=linux` → 16 цветов; Ctrl+L всегда доступен |
| Gatekeeper для бинарников, скачанных браузером | `curl \| sh` обходит карантин; подсказка про `xattr` в README; нотаризация позже при необходимости |
| Разрастание PWA (выключка, переносы, шрифты) | MVP = рендер блоков + позиция + поиск + закладки + офлайн + синхронизация; остальное потом |

## Проверка

- **M1**: `scripts/diff-dump.sh` прогоняет `python fb2read.py X --dump`, `--toc`, `--info` и
  `node packages/cli/dist/fb2read.mjs X --dump` на корпусе книг и падает при любом расхождении.
  Открыть книгу старым Python-бинарником, закрыть, открыть новым — позиция та же.
- **M2–M3**: `pnpm test` (vitest, `@xterm/headless`) плюс ручной прогон по списку терминалов из таблицы этапов.
- **M4**: на чистых машинах/контейнерах (ubuntu, alpine, macOS, Windows 11, Termux) выполнить строку
  установки из README, затем `fb2read --version` и `fb2read book.fb2`. Подменить байт в архиве и убедиться,
  что инсталлятор отказывается ставить.
- **M5**: поднять сервер в Docker, с двух машин `push`, читать, `sync`, сверить `fb2read remote`;
  отключить сеть и убедиться, что читалка открывается без задержки.
- **M6**: iPhone Safari → «На экран Домой» → книга с сервера → перезагрузить в авиарежиме → позиция и
  закладки на месте; Lighthouse показывает «installable».

## Что перепроверено после первой версии плана

Подтвердилось:
- `parse-xml` 5.0: строгий, префиксные атрибуты как есть, числовые ссылки декодируются, пробелы сохраняются,
  `XmlError` со строкой и колонкой (прогон в Node);
- `@xterm/headless` 6.0 даёт нужный API для тестов без экспериментальных флагов;
- `fflate.unzipSync` принимает `filter`, `zipSync` есть;
- Bun под Termux не запускается (нет PIE), Node в Termux есть (`nodejs-lts` 24.18);
- мышь в Node на Windows не работает, запрос nodejs/node#56338 закрыт;
- в `name2codepoint` 252 имени; `book_key` — sha1 от `путь:размер`; кэш вёрстки на 6 записей.

Исправлено:
- `util.parseArgs` умеет `-2` и `-1`, самодельный разбор аргументов не нужен;
- `get-east-asian-width` возвращает 1 или 2, а не буквы категорий; ambiguous по умолчанию узкие, как в Python;
- Bun 1.3.11 не знает `windows-1251` и `koi8-r` в `TextDecoder`, свои таблицы стали обязательными;
- цели Bun: baseline-суффиксы устарели (один x64-бинарник под SSE4.2), проверка AVX2 из инсталлятора убрана,
  добавлена цель `windows-arm64`;
- Node SEA больше не требует `postject` и поддерживает ESM, но по-прежнему требует раннер под каждую ОС;
- подпись darwin-бинарников делается через `codesign` на macos-раннере, а не автоматически при кросс-компиляции;
- в списке кодировок Python есть `utf-16`, добавлена в `encoding.ts`.

## Ключевые файлы

- `fb2read.py` — эталон; каждый модуль ядра переписывает названный участок (разбор 58–765, вёрстка 765–965,
  состояние и конфиг 965–1230, TUI 1230–2600).
- `tests/test_core.py` — приёмочный набор для M1.
- `tests/test_ui.py` и `tests/terminal.py` — приёмочный набор и образец харнесса для M2–M3.
- `tests/conftest.py`, `tests/epub_data.py` — фикстуры для `packages/core/test/fixtures.ts`.
- `README.md` — перечень функций и таблица клавиш, которые M3 должен воспроизвести, а M4 переписать
  с новым разделом установки.
