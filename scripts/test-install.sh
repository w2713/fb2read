#!/bin/sh
# Проверяет установщик на поддельном выпуске.
#
# Настоящий релиз выкладывается редко, а сломать установщик можно любой
# правкой. Здесь поднимается локальный сервер с собранным архивом, и
# установщик проходит весь путь: скачал, сверил сумму, распаковал, запустил.
# Заодно проверяется, что подменённый архив он ставить отказывается.
#
# Запуск: ./scripts/test-install.sh

set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
PORT=${FB2READ_TEST_PORT:-8749}
SERVER=""

cleanup() {
    [ -n "$SERVER" ] && kill "$SERVER" 2>/dev/null
    rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

fail() {
    printf 'НЕ ПРОШЛО: %s\n' "$*" >&2
    exit 1
}

command -v bun >/dev/null 2>&1 || {
    echo "нужен bun, пропускаю проверку установщика"
    exit 0
}
[ -f "$ROOT/packages/cli/dist/fb2read.mjs" ] || fail "нет бандла — запустите pnpm build"

# Собираем ровно ту цель, на которой сейчас работаем: установщик должен
# выбрать её сам, и это тоже часть проверки.
case "$(uname -s)" in
    Linux) platform=linux ;;
    Darwin) platform=darwin ;;
    *) echo "проверка установщика рассчитана на Linux и macOS"; exit 0 ;;
esac
case "$(uname -m)" in
    x86_64 | amd64) cpu=x64 ;;
    aarch64 | arm64) cpu=arm64 ;;
    *) echo "неизвестный процессор, пропускаю"; exit 0 ;;
esac
target="$platform-$cpu"
if [ "$platform" = linux ]; then
    if [ -f /etc/alpine-release ] || (ldd --version 2>&1 | grep -qi musl); then
        target="$target-musl"
    fi
fi

echo "собираю $target"
"$ROOT/scripts/build-binaries.sh" "$WORK/release" "$target" >/dev/null

echo "поднимаю сервер на порту $PORT"
(cd "$WORK/release" && python3 -m http.server "$PORT" >/dev/null 2>&1) &
SERVER=$!
sleep 1

# --- обычная установка -----------------------------------------------------

mkdir -p "$WORK/home"
HOME="$WORK/home" FB2READ_BASE_URL="http://127.0.0.1:$PORT" \
    sh "$ROOT/scripts/install.sh" >"$WORK/log" 2>&1 ||
    { cat "$WORK/log"; fail "установщик завершился с ошибкой"; }

grep -q "контрольная сумма сошлась" "$WORK/log" ||
    fail "установщик не проверил контрольную сумму"

installed="$WORK/home/.local/bin/fb2read"
[ -x "$installed" ] || fail "программа не появилась в ~/.local/bin"
"$installed" --version >/dev/null || fail "установленная программа не запускается"
echo "обычная установка: прошла"

# --- подменённый архив -----------------------------------------------------

printf 'подмена' >> "$WORK/release/fb2read-$target.tar.gz"
mkdir -p "$WORK/home2"
if HOME="$WORK/home2" FB2READ_BASE_URL="http://127.0.0.1:$PORT" \
        sh "$ROOT/scripts/install.sh" >"$WORK/log2" 2>&1; then
    fail "установщик поставил подменённый архив"
fi
grep -q "не сошлась" "$WORK/log2" || fail "установщик не объяснил, что не так"
[ -e "$WORK/home2/.local/bin/fb2read" ] && fail "после отказа что-то всё же установилось"
echo "подменённый архив: отвергнут"

# --- установщик для Windows ------------------------------------------------

# Windows PowerShell 5.1 при `irm ... | iex` декодирует скачанный скрипт как
# латиницу: сервер не объявляет кодировку. Любое русское слово в выводе
# превратилось бы в мусор вида «ÑÐºÐ°ÑÐ¸Ð²Ð°Ñ». Поэтому весь вывод
# install.ps1 обязан быть латиницей, и это надо стеречь.
python3 - "$ROOT/scripts/install.ps1" <<'PY' || fail "в выводе install.ps1 есть символы вне латиницы"
import sys

path = sys.argv[1]
data = open(path, "rb").read()
shown = [
    line
    for line in data.decode("utf-8").split("\n")
    if "Write-Host" in line or line.strip().startswith("Fail ") or " Fail " in line
]
bad = [line for line in shown if any(ord(ch) > 127 for ch in line)]
for line in bad:
    print("  не латиница:", line.strip()[:70])
sys.exit(1 if bad else 0)
PY
echo "вывод install.ps1: только латиница, искажений в PowerShell не будет"

echo
echo "установщик проверен"
