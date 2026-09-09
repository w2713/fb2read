#!/bin/sh
# Собирает автономные бинарники для всех поддерживаемых систем.
#
# Внутрь бинарника кладётся тот же бандл, что уходит в npm, поэтому обе
# дороги установки дают одну и ту же программу. Bun умеет кросс-компиляцию,
# так что почти всё собирается с одной машины — кроме macOS, которую надо
# подписывать на самой macOS, иначе Apple Silicon откажется запускать.
#
# Запуск: ./scripts/build-binaries.sh [каталог] [цель ...]
#   ./scripts/build-binaries.sh                 всё, что собирается здесь
#   ./scripts/build-binaries.sh dist linux-x64  только одна цель

set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=${1:-$ROOT/release}
if [ $# -gt 0 ]; then
    shift
fi

BUNDLE="$ROOT/packages/cli/dist/fb2read.mjs"
SERVER_BUNDLE="$ROOT/packages/server/dist/fb2read-server.mjs"

# Слева — как цель называется у нас (и в имени файла), справа — у Bun.
# Отдельной сборки под Android нет: Bun там не запускается, потому что его
# бинарник собран не как PIE, а ядро Android этого требует. На Termux
# установщик ставит Node из пакетов и берёт программу из npm.
all_targets() {
    cat <<'EOF'
linux-x64 bun-linux-x64
linux-arm64 bun-linux-arm64
linux-x64-musl bun-linux-x64-musl
linux-arm64-musl bun-linux-arm64-musl
windows-x64 bun-windows-x64
windows-arm64 bun-windows-arm64
darwin-x64 bun-darwin-x64
darwin-arm64 bun-darwin-arm64
EOF
}

# Сервер синхронизации собирается только под Linux: его ставят на машину,
# которая работает круглосуточно, а это почти всегда Linux. Кому нужно
# иначе — есть пакет в npm и образ Docker, оба без привязки к системе.
server_targets() {
    cat <<'EOF'
server-linux-x64 bun-linux-x64
server-linux-arm64 bun-linux-arm64
server-linux-x64-musl bun-linux-x64-musl
server-linux-arm64-musl bun-linux-arm64-musl
EOF
}

if ! command -v bun >/dev/null 2>&1; then
    echo "нужен bun: https://bun.com" >&2
    exit 1
fi

if [ ! -f "$BUNDLE" ]; then
    echo "нет бандла $BUNDLE — запустите pnpm build" >&2
    exit 1
fi

# Сервер нужен только тем целям, что начинаются на server-; проверяем лениво,
# чтобы сборка одной читалки не требовала лишнего.
case " $* " in
    *" server-"*)
        if [ ! -f "$SERVER_BUNDLE" ]; then
            echo "нет бандла $SERVER_BUNDLE — запустите pnpm build" >&2
            exit 1
        fi
        ;;
esac

mkdir -p "$OUT"
wanted=$*

build_one() {
    name=$1
    target=$2
    case "$name" in
        server-*) source_bundle=$SERVER_BUNDLE; binary="fb2read-server" ;;
        *windows*) source_bundle=$BUNDLE; binary="fb2read.exe" ;;
        *) source_bundle=$BUNDLE; binary="fb2read" ;;
    esac

    echo "собираю $name"
    work=$(mktemp -d)
    bun build --compile --minify --target="$target" "$source_bundle" \
        --outfile "$work/$binary" >/dev/null

    # macOS отказывается запускать неподписанное на Apple Silicon. Подпись
    # своими силами (ad-hoc) снимает вопрос и доступна только на macOS.
    case "$name" in
        darwin-*)
            if command -v codesign >/dev/null 2>&1; then
                codesign --sign - --force "$work/$binary" 2>/dev/null ||
                    echo "  подписать не вышло — на Apple Silicon может не запуститься" >&2
            else
                echo "  codesign недоступен: собирайте darwin на macOS" >&2
            fi
            ;;
    esac

    case "$name" in
        *windows*)
            (cd "$work" && zip -q "$OUT/fb2read-$name.zip" "$binary")
            ;;
        *)
            (cd "$work" && tar czf "$OUT/fb2read-$name.tar.gz" "$binary")
            ;;
    esac
    rm -rf "$work"
}

{ all_targets; server_targets; } | while read -r name target; do
    [ -n "$name" ] || continue
    if [ -n "$wanted" ]; then
        case " $wanted " in
            *" $name "*) ;;
            *) continue ;;
        esac
    fi
    build_one "$name" "$target"
done

# Контрольные суммы: установщик сверяет по ним скачанное, поэтому файл
# должен лежать рядом с архивами и покрывать их все. Имена без «./» —
# так `sha256sum -c` находит файлы, лежащие в текущем каталоге.
(
    cd "$OUT"
    rm -f SHA256SUMS
    for archive in *.tar.gz *.zip; do
        [ -f "$archive" ] || continue
        sha256sum "$archive" >> SHA256SUMS
    done
)

echo
echo "готово, в $OUT:"
ls -la "$OUT"
