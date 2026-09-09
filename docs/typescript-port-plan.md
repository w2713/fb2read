# План: перенос fb2read на TypeScript с установкой на любое устройство

## Контекст

Сейчас fb2read — один файл `fb2read.py` (2598 строк) на Python 3.8 без зависимостей плюс 1100 строк
тестов. Работает там, где есть Python и полноценный curses: Linux, macOS, Termux. На Windows curses
слабый (мышь, ресайз, цвета), на iPhone/iPad терминала нет, установка требует `pip`.

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
- сейчас нужен только план.

## Ключевые решения

1. **Python остаётся эталоном.** Тот же формат `Block`, тот же вывод `layout()` при той же ширине, те же
   русские сообщения, тот же `positions.json` и та же схема `book_key` (sha1 от `путь:размер`, 16 символов),
   чтобы позиции чтения пережили смену бинарника.
2. **Ядро чистое.** В `packages/core` нет `fs`, `process`, `Buffer`, `child_process`. Всё, что касается файлов,
   терминала и времени, за интерфейсами `ByteSource` и `StateStore`. Это и есть то, что позволяет запустить
   то же ядро в браузере для iPhone.
3. **Node ≥ 20 и Bun.** Bun собирает автономные бинарники, Node — рантайм для Termux, npm и тестов.
4. **Зависимости ядра — три маленькие:** `fflate` (zip), `@rgrove/parse-xml` (XML), `get-east-asian-width`
   (ширина символов). CLI ничего не добавляет. Web добавляет `idb` и `vite-plugin-pwa`.
5. **TUI пишем сами на ANSI-последовательностях**, без curses и без blessed/ink: нужны ~600 строк,
   и тесты и так проверяют байты (`\x1b[?1006h`, kitty `\x1b_G`, iTerm `1337;File=`).

## Структура репозитория

```
fb2read/
├── package.json, pnpm-workspace.yaml, tsconfig.base.json, vitest.workspace.ts
├── fb2read.py, tests/          остаются как эталон до M4, потом удаляются
├── .github/workflows/
│   ├── ci.yml                  typecheck + vitest: ubuntu/macos/windows × node 20/22 + bun
│   ├── release.yml             tag v* → bun compile (8 целей) → Release + SHA256SUMS → npm publish
│   └── pages.yml               PWA + install.sh/install.ps1 → GitHub Pages
├── scripts/
│   ├── install.sh              POSIX sh, curl | sh
│   ├── install.ps1             irm | iex
│   └── diff-dump.sh            сравнение --dump Python и TS на корпусе книг (M1)
└── packages/
    ├── core/                   @fb2read/core, чистое ядро (Node + браузер)
    ├── cli/                    fb2read: терминальный интерфейс, публикуется в npm, компилируется Bun
    └── web/                    PWA (Vite, без фреймворка), GitHub Pages
```

## Ядро: соответствие Python → TypeScript (`packages/core/src/`)

| Модуль | Что поглощает из `fb2read.py` | Замечания |
|---|---|---|
| `source.ts` | половина `read_source` | `ByteSource { name, size, bytes(), slice(a,b) }`. CLI даёт реализацию на fs, web — на `File`. `slice` нужен сразу: картинки читаются лениво по смещениям |
| `zip.ts` | `zipfile`, `is_epub`, `image_data` для EPUB | `fflate.unzipSync` с `filter`, чтобы распаковывать только нужный файл |
| `encoding.ts` | цикл кодировок в `parse_xml`, `_ENC_RE` | `TextDecoder(label, {fatal:true})` плюс свои таблицы cp1251/koi8-r/cp1252 (по 256 записей): Bun не гарантирует все метки, а `TextEncoder` умеет только UTF-8, значит фикстуры в cp1251 без своих таблиц не собрать |
| `entities.ts` | `html.entities.name2codepoint` | 252 имени HTML 4.01 литералом |
| `repair.ts` | `strip_binaries`, `fix_entities`, `repair` | Байты → latin1-строка через `String.fromCharCode`, чтобы смещения `binary` остались байтовыми |
| `xml.ts` | `ET.fromstring`, `local`, `text_of` | Единственное место, где импортируется парсер. Вся лестница повторных попыток `parse_xml` здесь |
| `inline.ts` | `_Runs`, `inline_runs`, `text_and_refs` | Смещения в UTF-16 code units, одно соглашение на всё ядро |
| `block.ts`, `fb2.ts`, `epub.ts`, `book.ts` | `Block`, `_load_fb2`, `_meta`, `_walk`, `_EpubMixin`, `Book` | `Book.open(src): Promise<Book>`, `imageData(src): Promise<{data, mime}|null>` (async из-за `File` в браузере) |
| `mime.ts` | `mimetypes` | карта на 10 записей |
| `width.ts` | `char_width`, `str_width`, `cut_to_width` | W/F → 2, `\p{M}` и ZW-символы → 0, иначе 1. Быстрый путь: код < 0x300 (латиница, кириллица) → 1 без таблиц |
| `wrap.ts`, `layout.ts` | `_push_word`, `wrap_words`, `STYLE`, `_line_styles`, `layout` | `Line { text, attr, block, styles }` вместо кортежа |
| `search.ts` | `normalize`, `find_matches`, `match_context` | ё → е, lowercase только если длина не меняется |
| `state.ts` | `load_pos`/`save_pos`/закладки/`load_settings`/`recent_books`/`progress_percent` | Объявляет `StateStore` (все методы async) и формы записей; реализации в cli (JSON-файл) и web (IndexedDB) |
| `bookmarks.ts` | `bookmark_label`, текстовая часть `export_bookmarks` | Возвращает markdown строкой, запись — дело платформы |
| `config.ts` | `CONFIG_SAMPLE`, `load_config`, `write_config`, `THEME_ORDER`, `IMAGE_BACKENDS` | Свой `parseIni` на ~40 строк |
| `keymap.ts` | `ACTIONS`, `KEY_NAMES`, `parse_key`, `build_keymap`, `key_title`, `help_rows` | Клавиши — канонические имена (`"j"`, `"ctrl-l"`, `"pgdn"`), не числа curses |
| `meta.ts` | `quick_meta`, `epub_meta`, `BOOK_SUFFIXES` | Читает первые 300 000 байт через `slice` |
| `text.ts` | `plural` | |

Не переносятся в ядро: `state_file`, `config_file`, `scan_dir`, `choose_book`, `Reader`, картинки, мышь,
`setup_locale`, `main`.

**Почему `@rgrove/parse-xml`.** Нужен строгий парсер, который *падает* на битом XML (на этом держится
`repair`), сохраняет порядок текста и хвостов, хранит префиксные атрибуты (`l:href`), отвергает неизвестные
сущности и одинаково ведёт себя в Node, Bun и браузерах. `DOMParser` есть только в браузере и вместо ошибки
возвращает `<parsererror>` разной формы; `fast-xml-parser` намеренно снисходительный; `sax` строгий, но дерево
пришлось бы строить самим. `@rgrove/parse-xml` — 10 КБ, без зависимостей, бросает `XmlError` со строкой и
колонкой, пространства имён не разрешает (нам это и нужно, `local()` режет префикс как раньше).

**Контракт ядра для CLI и web** (фиксируется в M1, чтобы CLI не запер браузер снаружи):

```
ByteSource, Book.open, Book#imageData, Block/Ref/Span/TocEntry
layout, wrapWords, strWidth, charWidth, cutToWidth
normalize, findMatches, matchContext
StateStore { loadPosition, savePosition, loadBookmarks, saveBookmarks,
             loadSettings, saveSettings, recent }   // все async
bookmarkLabel, bookmarksMarkdown, readConfig, CONFIG_SAMPLE
ACTIONS, parseKey, buildKeymap, keyTitle, helpRows
quickMeta, epubMeta, BOOK_SUFFIXES, plural, progressPercent
```

Правила: в `packages/core` нет `@types/node`, на входе `Uint8Array`, весь ввод-вывод через `Promise`.

## CLI: терминал без curses (`packages/cli/src/`)

```
main.ts, args.ts        разбор argv вручную (util.parseArgs не умеет -2/-1), режимы --dump/--toc/--info/--write-config/библиотека/чтение
paths.ts                XDG на unix; %APPDATA%\fb2read (конфиг) и %LOCALAPPDATA%\fb2read (данные) на Windows
fsSource.ts, store.ts   ByteSource на node:fs; JsonFileStore, байт-в-байт совместимый positions.json
library.ts              scanDir, recentBooks, текстовый список при не-TTY
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
  (alternate scroll: колесо превращается в стрелки там, где мышь не работает, например Windows Terminal).
  `leaveRaw` идемпотентен, вешается на `exit`, `SIGINT`, `SIGTERM`, `SIGHUP`, `uncaughtException` — замена
  `curses.wrapper`. Ресайз: `stdout.on("resize")` + `SIGWINCH` + опрос раз в секунду (conhost), всё в один
  debounce.
- **Картинки.** kitty и iTerm — это просто escape-последовательности, переносятся как есть.
  `chafa`/`img2sixel` через `child_process.spawnSync` и `os.tmpdir()`, остаются необязательными.
- **Windows.** libuv переводит клавиши в VT-последовательности, кириллица выводится без `chcp`. Мышь libuv
  не пробрасывает и Node не может включить `ENABLE_VIRTUAL_TERMINAL_INPUT`, поэтому на win32 мышь выключена
  по умолчанию, колесо работает через `?1007h`, `--mouse` включает принудительно. Требуем Windows 10 1809+.
- **Не-TTY.** `--dump | head` не падает на `EPIPE`: обработчик `error` на stdout (аналог `_safe_print_lines`).

## Дистрибуция

**Бинарники: `bun build --compile`.** Кросс-компиляция с одного Linux-раннера в 8 целей: `linux-x64`,
`linux-x64-baseline`, `linux-x64-musl`, `linux-arm64`, `linux-arm64-musl`, `darwin-x64`, `darwin-arm64`,
`windows-x64`. Baseline нужен: обычная сборка Bun требует AVX2 и падает на CPU старше ~2015 года.
Node SEA отвергнут: нужен раннер под каждую ОС, `postject`, CJS-бандл, статус «в разработке».
Вход для Bun — тот же `packages/cli/dist/fb2read.mjs` (tsup, `noExternal`), что уходит в npm.
Размер ~90 МБ сырой, ~35 МБ в архиве. macOS: Bun ad-hoc подписывает darwin-сборки, проверить в M4;
`curl` не ставит карантин, поэтому `curl | sh` работает без `xattr`.

**Android (Termux).** У Bun нет сборки под Android, Node есть в пакетах Termux. `install.sh` распознаёт
Termux (`$PREFIX` содержит `com.termux` или `uname -o` = `Android`) и выполняет
`pkg install -y nodejs-lts && npm install -g fb2read`. Бандл без нативных модулей, без postinstall.
Termux шлёт касания как SGR-мышь, так что мышь там работает.

**iPhone/iPad.** Терминала нет, единственный путь — PWA (ниже).

**`scripts/install.sh`** (POSIX sh): `uname -s`/`uname -m` → цель; ветка Termux; musl по `ldd`/`/etc/alpine-release`;
AVX2 по `/proc/cpuinfo`/`sysctl`; `${FB2READ_VERSION:-latest}` → `releases/latest/download/fb2read-<цель>.tar.gz`;
`curl -fsSL` или `wget -qO-`; скачать `SHA256SUMS`, проверить `sha256sum -c`/`shasum -a 256`, при несовпадении
прервать; распаковать в `${FB2READ_INSTALL_DIR:-$HOME/.local/bin}`, `chmod +x`, прогнать `fb2read --version`;
если каталога нет в `PATH`, напечатать строку для `~/.profile`/`~/.zshrc`/`config.fish`.
Хостится на GitHub Pages вместе с PWA, `raw.githubusercontent` как запасной адрес.

**`scripts/install.ps1`**: `Invoke-WebRequest` архива и `SHA256SUMS`, `Get-FileHash`, распаковка в
`$env:LOCALAPPDATA\Programs\fb2read`, добавление в пользовательский `Path` через
`[Environment]::SetEnvironmentVariable`, подсказка открыть новый терминал и поставить Windows Terminal.

**`release.yml`**: на тег `v*`: тесты → матрица `bun build --compile` → `sha256sum * > SHA256SUMS` →
`softprops/action-gh-release` → `npm publish --provenance` из `packages/cli`. Версия в `package.json`
должна совпадать с тегом.

**npm**: пакет `fb2read`, `bin: dist/fb2read.mjs`, `engines.node >= 20`, без зависимостей (всё вбандлено).
`npx fb2read book.fb2` работает. `@fb2read/core` пока приватный workspace-пакет.

## PWA (`packages/web`, этап M5, контракт фиксируется в M1)

- Vite + vanilla TS, `vite-plugin-pwa` (precache оболочки, `navigateFallback`), `manifest.webmanifest`
  с `display: standalone` — обязательно для установки на экран «Домой» в iOS.
- `db.ts`: `IdbStore implements StateStore` на `idb`, хранилища `books` (blob + метаданные), `state`, `settings`.
  Ключ книги = sha1 от `имя:размер:lastModified` через `crypto.subtle`. `navigator.storage.persist()` при первом
  импорте, иначе iOS чистит хранилище после простоя.
- `library.ts`: `<input type=file accept=".fb2,.zip,.fbz,.epub">`, drag-and-drop, `File` как `ByteSource`.
- `reader.ts`: `Block[]` → семантический HTML (`h1..h6`, `p`, `blockquote`, `figure` с ленивыми blob-URL,
  `a.note`), `data-block` на каждом элементе, `IntersectionObserver` сохраняет позицию; поиск и закладки из ядра;
  темы — CSS-переменные с именами четырёх тем Python. Разбор в Web Worker.
- `pages.yml`: `vite build --base=/fb2read/`, копирование инсталляторов в `dist/`, `deploy-pages`.

## Тесты

- **Ядро**: vitest, порт `tests/test_core.py` один к одному. Фикстуры из `conftest.py`/`epub_data.py`
  переносятся в `packages/core/test/fixtures.ts`: cp1251 через свой `encodeLegacy`, EPUB через `fflate.zipSync`,
  PNG 8×8 через `deflateSync` + CRC32, `big.fb2` на seeded PRNG. `MemorySource` и `MemoryStore` вместо файлов.
  Тесты формата `positions.json` уезжают в `packages/cli/test/store.test.ts`.
- **UI**: основной набор — `FakeTerminal` + `@xterm/headless` внутри процесса. `write()` пишет в сырой лог и
  в xterm; `sendKeys`/`click`/`wheel` подают те же последовательности, что писал `tests/terminal.py` в pty;
  экран читается через `buffer.active.getLine(y).translateToString()`, начертание через `getCell(x).isItalic()`
  и прочие, что заменяет `pyte.styled()`; протоколы картинок и мыши проверяются по сырому логу.
  Плюсы: детерминированно, без `sleep`, работает на Windows CI, в ~50 раз быстрее.
  Отдельно `smoke.pty.test.ts` на `node-pty` (только Linux/macOS): запуск собранного бандла, `pty.resize`,
  выход с кодом 0, `--dump | head` без падения.
- **Статика**: `tsc --noEmit` в каждом пакете, порог покрытия для `layout.ts`/`wrap.ts`/`repair.ts`,
  бенчмарк `layout` большой фикстуры ×10 < 300 мс.

## Этапы

| Этап | Объём | Оценка | Готово, когда |
|---|---|---|---|
| **M0 каркас** | pnpm workspace, tsconfig, vitest, CI на трёх ОС | 0.5 нед | `pnpm test` зелёный на ubuntu/macos/windows |
| **M1 ядро** | все модули ядра; в cli только `main`, `args`, `fsSource`, `store`, `--dump/--toc/--info/--write-config`, текстовая библиотека | 1.5 нед | порт `test_core` зелёный; `--dump` байт-в-байт совпадает с Python на корпусе ≥ 20 реальных книг; `--info` печатает те же правки; старый `positions.json` читается без изменений |
| **M2 чтение в TUI** | `term/*`, `reader.ts`: листание, главы, оглавление, сноски, разворот, интервал, ширина, темы, справка, поиск, ресайз | 2 нед | UI-тесты навигации/разворота/ресайза/поиска/конфига из `test_ui.py` зелёные; ручная проверка в kitty, WezTerm, GNOME Terminal, Terminal.app, Windows Terminal, conhost |
| **M3 библиотека, закладки, картинки, мышь** | `chooser.ts`, `library.ts`, экспорт закладок, `images.ts`, SGR-мышь и хотспоты, `m` | 1.5 нед | остальные случаи `test_ui.py` перенесены; `pnpm test` полностью заменяет `pytest`; таблица клавиш README сверена |
| **M4 дистрибуция** | tsup, матрица Bun, `release.yml`, инсталляторы, Pages, npm, новый README, удаление `fb2read.py` | 1 нед | `curl … \| sh` ставит рабочий бинарник на Linux x64/arm64, macOS x64/arm64, Alpine; `irm … \| iex` на Windows 11; Termux через npm; подменённый архив отвергается по SHA256 |
| **M5 PWA** | `packages/web` целиком | 2 нед | FB2 и EPUB открываются в Safari на iPhone с экрана «Домой», позиция и закладки переживают перезагрузку и авиарежим |

Итого 8–9 недель на всё; M4 можно вести параллельно с M3, инсталляторам достаточно работающего `--version`.

## Риски

| Риск | Что делаем |
|---|---|
| Мышь на Windows: libuv не отдаёт события мыши, Node не включает VT-ввод | мышь выключена по умолчанию на win32, колесо через `?1007h`, `--mouse` для включения; задокументировать |
| Пробелы Bun: метки `TextDecoder`, `stdout.resize`, raw mode, подпись darwin-бинарников | свои таблицы кодировок; `SIGWINCH` + опрос; отдельная Bun-задача в CI; проверка подписи на Apple Silicon раннере в M4; npm как запасной канал |
| Termux без Bun, Node из `pkg` может отставать | инсталлятор распознаёт Termux и идёт через npm; `engines.node >= 20` совпадает с `nodejs-lts` |
| Дрейф ширины Unicode между `unicodedata`, таблицами библиотеки и терминалом | та же политика, что в Python; версия библиотеки пришпилена; тесты сравнивают с нашей `strWidth`, а не с терминалом |
| Индексы UTF-16 против code points в Python | одно соглашение везде; тесты `text.slice(offset, offset + line.length) === line` переносятся из Python |
| Большие книги в памяти, скорость `layout` в JS | `binary` режется до декодирования; `ByteSource.slice` для ленивых чтений; быстрый путь для кириллицы; бенчмарк в CI; ленивая вёрстка остаётся следующим шагом, как и в README сейчас |
| Терминалы без terminfo (Linux VT, старый screen) | только xterm-подмножество; `TERM=linux` → 16 цветов; Ctrl+L всегда доступен |
| Gatekeeper для бинарников, скачанных браузером | `curl \| sh` обходит карантин; подсказка про `xattr` в README; нотаризация позже при необходимости |
| Разрастание PWA (выключка, переносы, шрифты) | MVP = рендер блоков + позиция + поиск + закладки + офлайн; остальное потом |

## Проверка

- **M1**: `scripts/diff-dump.sh` прогоняет `python fb2read.py X --dump`, `--toc`, `--info` и
  `node packages/cli/dist/fb2read.mjs X --dump` на корпусе книг и падает при любом расхождении.
  Открыть книгу старым Python-бинарником, закрыть, открыть новым — позиция та же.
- **M2–M3**: `pnpm test` (vitest, `@xterm/headless`) плюс ручной прогон по списку терминалов из таблицы этапов.
- **M4**: на чистых машинах/контейнерах (ubuntu, alpine, macOS, Windows 11, Termux) выполнить строку
  установки из README, затем `fb2read --version` и `fb2read book.fb2`. Подменить байт в архиве и убедиться,
  что инсталлятор отказывается ставить.
- **M5**: iPhone Safari → «На экран Домой» → открыть FB2 и EPUB → перезагрузить в авиарежиме → позиция и
  закладки на месте; Lighthouse показывает «installable».

## Ключевые файлы

- `fb2read.py` — эталон; каждый модуль ядра переписывает названный участок (разбор 58–765, вёрстка 765–965,
  состояние и конфиг 965–1230, TUI 1230–2600).
- `tests/test_core.py` — приёмочный набор для M1.
- `tests/test_ui.py` и `tests/terminal.py` — приёмочный набор и образец харнесса для M2–M3.
- `tests/conftest.py`, `tests/epub_data.py` — фикстуры для `packages/core/test/fixtures.ts`.
- `README.md` — перечень функций и таблица клавиш, которые M3 должен воспроизвести, а M4 переписать
  с новым разделом установки.
