#!/bin/sh
# Сверяет вывод версии на TypeScript с эталонной реализацией на Python.
#
# Книги-образцы собираются одним и тем же кодом, поэтому расхождение здесь
# означает разницу в разборе или вёрстке, а не разницу во входных данных.
# Проверяются и разбор целиком (JSON с блоками, оглавлением и якорями),
# и то, что видит читатель: --dump при нескольких ширинах, --toc, --info.
#
# Запуск: ./scripts/diff-dump.sh [каталог с книгами]

set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=${TMPDIR:-/tmp}/fb2read-parity.$$
FIXTURES=${1:-}
CLI="$ROOT/packages/cli/dist/fb2read.mjs"

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

mkdir -p "$WORK"

if [ ! -f "$CLI" ]; then
    echo "нет сборки $CLI — запустите pnpm --filter fb2read build" >&2
    exit 1
fi

if [ -z "$FIXTURES" ]; then
    FIXTURES="$WORK/books"
    python3 "$ROOT/scripts/make-fixtures.py" "$FIXTURES" >/dev/null
fi

# Ядро нужно собранным: скрипт дампа разбора импортирует его из dist.
npx tsc -b "$ROOT/packages/core" >/dev/null

# Состояние и настройки уводим в сторону, чтобы сверка не зависела от того,
# что читалка запомнила на этой машине.
XDG_DATA_HOME="$WORK/data"
XDG_CONFIG_HOME="$WORK/config"
FB2READ_ROOT="$ROOT"
export XDG_DATA_HOME XDG_CONFIG_HOME FB2READ_ROOT

failures=0
checked=0

compare() {
    name=$1
    shift
    if diff -u "$WORK/py.out" "$WORK/ts.out" > "$WORK/diff.out"; then
        checked=$((checked + 1))
    else
        failures=$((failures + 1))
        echo "РАСХОЖДЕНИЕ: $name"
        head -40 "$WORK/diff.out"
    fi
}

for book in "$FIXTURES"/*; do
    case "$book" in
        *.fb2 | *.fb2.zip | *.fbz | *.epub) ;;
        *) continue ;;
    esac
    label=$(basename "$book")

    python3 "$ROOT/scripts/dump-parse.py" "$book" > "$WORK/py.out"
    node "$ROOT/scripts/dump-parse.mjs" "$book" > "$WORK/ts.out"
    compare "$label: разбор"

    for mode in --info --toc; do
        python3 "$ROOT/fb2read.py" "$book" $mode > "$WORK/py.out"
        node "$CLI" "$book" $mode > "$WORK/ts.out"
        compare "$label: $mode"
    done

    # Разные ширины и интервалы ловят расхождения в переносе и отступах.
    for width in 40 72 100; do
        python3 "$ROOT/fb2read.py" "$book" --dump -w $width > "$WORK/py.out"
        node "$CLI" "$book" --dump -w $width > "$WORK/ts.out"
        compare "$label: --dump -w $width"
    done
    python3 "$ROOT/fb2read.py" "$book" --dump -w 60 -s 2 > "$WORK/py.out"
    node "$CLI" "$book" --dump -w 60 -s 2 > "$WORK/ts.out"
    compare "$label: --dump -w 60 -s 2"
done

# Позиция чтения должна пережить переход с одной реализации на другую:
# эталон записывает состояние, версия на TypeScript читает его тем же ключом.
compat_book="$FIXTURES/sample.fb2"
if [ -f "$compat_book" ]; then
    XDG_DATA_HOME="$WORK/compat"
    export XDG_DATA_HOME
    python3 - "$compat_book" <<'PY'
import sys, os
sys.path.insert(0, os.environ["FB2READ_ROOT"])
import fb2read
book = sys.argv[1]
fb2read.save_pos(book, 17, "Проверка читалки", 33, "Иван Тестов")
fb2read.save_bookmarks(book, [{"block": 5, "name": "метка", "percent": 15}],
                       "Проверка читалки", 33, "Иван Тестов")
PY
    if node "$ROOT/scripts/check-state-compat.mjs" "$compat_book" \
            "$WORK/compat/fb2read/positions.json"; then
        checked=$((checked + 1))
    else
        failures=$((failures + 1))
        echo "РАСХОЖДЕНИЕ: состояние эталонной реализации не читается"
    fi
    XDG_DATA_HOME="$WORK/data"
    export XDG_DATA_HOME
fi

if [ "$failures" -gt 0 ]; then
    echo "сверка не прошла: расхождений $failures, совпало $checked" >&2
    exit 1
fi

echo "сверка пройдена: совпало проверок $checked"
