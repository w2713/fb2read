#!/bin/sh
# Установщик fb2read.
#
#   curl -fsSL https://w2713.github.io/fb2read/install.sh | sh
#
# Скачивает готовый бинарник под вашу систему, сверяет контрольную сумму и
# кладёт в ~/.local/bin. Ничего, кроме curl или wget, не требуется: Node и
# прочее внутрь уже вложено.
#
# Переменные:
#   FB2READ_VERSION      какую версию ставить (по умолчанию последнюю)
#   FB2READ_INSTALL_DIR  куда класть (по умолчанию ~/.local/bin)

set -eu

REPO=${FB2READ_REPO:-w2713/fb2read}
VERSION=${FB2READ_VERSION:-latest}
INSTALL_DIR=${FB2READ_INSTALL_DIR:-$HOME/.local/bin}
# Отсюда берутся архивы; можно подменить, чтобы поставить из своей сборки.
BASE=${FB2READ_BASE_URL:-}

say() { printf '%s\n' "$*"; }
die() {
    printf 'fb2read: %s\n' "$*" >&2
    exit 1
}

# --- чем качать ------------------------------------------------------------

if command -v curl >/dev/null 2>&1; then
    fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
    fetch() { wget -q "$1" -O "$2"; }
else
    die "нужен curl или wget"
fi

# --- Termux ----------------------------------------------------------------

# Bun под Android не запускается: его бинарник собран не как PIE, а ядро
# Android этого требует. Node в Termux есть в пакетах, поэтому там программа
# ставится из npm — она без нативных модулей и работает сразу.
is_termux() {
    case "${PREFIX:-}" in
        *com.termux*) return 0 ;;
    esac
    [ "$(uname -o 2>/dev/null || echo)" = "Android" ]
}

if is_termux; then
    say "Termux: ставлю через Node, потому что готовый бинарник под Android не работает"
    command -v pkg >/dev/null 2>&1 || die "не нашёл pkg — это точно Termux?"
    pkg install -y nodejs-lts || die "не удалось поставить Node"
    npm install -g fb2read || die "не удалось поставить fb2read из npm"
    say "готово: fb2read"
    exit 0
fi

# --- какая это система -----------------------------------------------------

os=$(uname -s)
arch=$(uname -m)

case "$os" in
    Linux) platform="linux" ;;
    Darwin) platform="darwin" ;;
    *) die "система $os пока не поддерживается; попробуйте npm install -g fb2read" ;;
esac

case "$arch" in
    x86_64 | amd64) cpu="x64" ;;
    aarch64 | arm64) cpu="arm64" ;;
    *) die "процессор $arch пока не поддерживается; попробуйте npm install -g fb2read" ;;
esac

target="$platform-$cpu"

# Alpine и прочие на musl: там своя сборка, обычная не запустится.
if [ "$platform" = "linux" ]; then
    if [ -f /etc/alpine-release ] || (ldd --version 2>&1 | grep -qi musl); then
        target="$target-musl"
    fi
fi

archive="fb2read-$target.tar.gz"

if [ -z "$BASE" ]; then
    if [ "$VERSION" = "latest" ]; then
        BASE="https://github.com/$REPO/releases/latest/download"
    else
        BASE="https://github.com/$REPO/releases/download/$VERSION"
    fi
fi

# --- скачиваем и проверяем -------------------------------------------------

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM

say "скачиваю $archive"
fetch "$BASE/$archive" "$work/$archive" ||
    die "не удалось скачать $BASE/$archive"

if fetch "$BASE/SHA256SUMS" "$work/SHA256SUMS" 2>/dev/null; then
    # Считаем сумму тем, что есть: на macOS свой инструмент.
    if command -v sha256sum >/dev/null 2>&1; then
        actual=$(sha256sum "$work/$archive" | cut -d' ' -f1)
    elif command -v shasum >/dev/null 2>&1; then
        actual=$(shasum -a 256 "$work/$archive" | cut -d' ' -f1)
    else
        actual=""
        say "нечем проверить контрольную сумму — пропускаю"
    fi
    if [ -n "$actual" ]; then
        expected=$(grep " $archive\$" "$work/SHA256SUMS" | cut -d' ' -f1)
        [ -n "$expected" ] || die "в SHA256SUMS нет записи про $archive"
        [ "$actual" = "$expected" ] ||
            die "контрольная сумма не сошлась — файл повреждён или подменён, ставить не буду"
        say "контрольная сумма сошлась"
    fi
else
    say "не нашёл SHA256SUMS — ставлю без проверки"
fi

# --- ставим ----------------------------------------------------------------

tar xzf "$work/$archive" -C "$work" || die "не удалось распаковать $archive"
[ -f "$work/fb2read" ] || die "в архиве нет программы"

mkdir -p "$INSTALL_DIR" || die "не удалось создать $INSTALL_DIR"
# Пишем через временное имя: если файл сейчас запущен, замена всё равно
# пройдёт, а оборванная установка не оставит покалеченный бинарник.
mv "$work/fb2read" "$INSTALL_DIR/fb2read.new" || die "не удалось записать в $INSTALL_DIR"
chmod +x "$INSTALL_DIR/fb2read.new"
mv "$INSTALL_DIR/fb2read.new" "$INSTALL_DIR/fb2read"

version=$("$INSTALL_DIR/fb2read" --version 2>/dev/null) ||
    die "программа установилась, но не запускается"
say "установлено: $version → $INSTALL_DIR/fb2read"

# --- PATH ------------------------------------------------------------------

case ":$PATH:" in
    *":$INSTALL_DIR:"*) exit 0 ;;
esac

say ""
say "$INSTALL_DIR не в PATH. Добавьте строку в файл своей оболочки:"
case "$(basename "${SHELL:-sh}")" in
    zsh) say "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.zshrc" ;;
    fish) say "  fish_add_path $INSTALL_DIR" ;;
    *) say "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.profile" ;;
esac
say "и откройте терминал заново."
