#!/bin/sh
# Обновляет сервер синхронизации на месте, в Docker.
#
# Руками это пять команд, и дважды из-за них сервер ложился. Первый раз —
# потому что настройки работающего контейнера писались заново по примеру из
# README, и в них потерялся FB2READ_SERVER_ORIGIN: браузер получал отказ по
# CORS, а читалка показывала «сервер недоступен». Второй — потому что в команду
# ушла подстановка «ВАШ-ТОКЕН» как есть, а сервер не принимает токен не из
# латиницы и уходит в перезапуск по кругу.
#
# Поэтому скрипт ничего не сочиняет: настройки он снимает с работающего
# контейнера и переносит как есть. Что можно проверить до того, как трогать
# работающее, — проверяется до; прежний контейнер сносится только после того,
# как новый ответил, а если не ответил — возвращается назад.
#
# Запуск на сервере, из каталога репозитория:
#
#   ./scripts/deploy-server.sh            # обновить до main
#   ./scripts/deploy-server.sh v0.21.0    # обновить до тега
#
# Первый раз, когда контейнера ещё нет, токен задаётся окружением:
#
#   FB2READ_SERVER_TOKENS="я:$(openssl rand -hex 32)" \
#   FB2READ_SERVER_ORIGIN=https://w2713.github.io \
#     ./scripts/deploy-server.sh
#
# Так же задаётся и новое значение, когда что-то надо поменять: заданное
# окружением важнее того, что стояло в контейнере.

set -eu

NAME=${FB2READ_CONTAINER:-fb2read}
IMAGE=${FB2READ_IMAGE:-fb2read-server}
DATA_DEFAULT=${FB2READ_VOLUME:-fb2read-data}
PORT_DEFAULT=${FB2READ_PUBLISH:-8787:8787}
REF=${1:-main}
OLD="$NAME-old"
ROOT=$(cd "$(dirname "$0")/.." && pwd)

say() {
    printf '%s\n' "$*"
}

fail() {
    printf 'не вышло: %s\n' "$*" >&2
    exit 1
}

command -v docker >/dev/null 2>&1 || fail "нет docker"
command -v git >/dev/null 2>&1 || fail "нет git"
[ -f "$ROOT/packages/server/Dockerfile" ] || fail "это не каталог репозитория fb2read"

# Настройки лежат в файле, а не в -e: значение переменной из командной строки
# видно в списке процессов любому на этой машине, а там токен.
ENVFILE=$(mktemp)
chmod 600 "$ENVFILE"
cleanup() {
    rm -f "$ENVFILE" "$ENVFILE.new"
}
trap cleanup EXIT INT TERM

# --- что стоит сейчас -------------------------------------------------------

HAVE=$(docker ps -a --filter "name=^${NAME}$" --format '{{.ID}}' 2>/dev/null || true)

look() {
    docker inspect "$NAME" --format "$1" 2>/dev/null || true
}

if [ -n "$HAVE" ]; then
    say "перенимаю настройки работающего контейнера $NAME"
    # Первая привязка порта и том, примонтированный на /data. Нескольких у
    # этого сервера не бывает: он слушает один порт и хранит всё в одном месте.
    # $p и $c здесь — не переменные оболочки, а имена в шаблоне docker inspect,
    # и раскрывать их должен он, а не мы.
    # shellcheck disable=SC2016
    PUBLISH=$(look '{{range $p, $c := .HostConfig.PortBindings}}{{range $c}}{{.HostIp}}:{{.HostPort}}:{{$p}}
{{end}}{{end}}' | sed -e 's|/tcp$||' -e 's|^:||' | head -1)
    DATA=$(look '{{range .Mounts}}{{if eq .Destination "/data"}}{{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}')
    look '{{range .Config.Env}}{{println .}}{{end}}' | grep '^FB2READ_SERVER_' > "$ENVFILE" || true
else
    say "контейнера $NAME нет — запускаю впервые"
    PUBLISH=""
    DATA=""
fi

[ -n "$PUBLISH" ] || PUBLISH=$PORT_DEFAULT
[ -n "$DATA" ] || DATA=$DATA_DEFAULT

# --- что попросили поменять -------------------------------------------------

override() {
    [ -n "$2" ] || return 0
    grep -v "^$1=" "$ENVFILE" > "$ENVFILE.new" || true
    mv "$ENVFILE.new" "$ENVFILE"
    printf '%s=%s\n' "$1" "$2" >> "$ENVFILE"
}

override FB2READ_SERVER_TOKENS "${FB2READ_SERVER_TOKENS:-}"
override FB2READ_SERVER_ORIGIN "${FB2READ_SERVER_ORIGIN:-}"
override FB2READ_SERVER_MAX_MB "${FB2READ_SERVER_MAX_MB:-}"

# --- проверки до того, как трогать работающее -------------------------------

grep -q '^FB2READ_SERVER_TOKENS=.' "$ENVFILE" ||
    fail "нет токенов: задайте FB2READ_SERVER_TOKENS=\"имя:\$(openssl rand -hex 32)\""

TOKENS=$(grep '^FB2READ_SERVER_TOKENS=' "$ENVFILE" | cut -d= -f2-)
case $TOKENS in
    *[!\ -~]*)
        fail "в токене не латиница — сервер такой не примет.
Похоже, подстановку вроде «ВАШ-ТОКЕН» скопировали в команду как есть."
        ;;
esac

grep -q '^FB2READ_SERVER_ORIGIN=.' "$ENVFILE" ||
    say "внимание: FB2READ_SERVER_ORIGIN не задан — браузерная читалка получит отказ по CORS"

# Только правленые файлы репозитория: лишние файлы рядом сборке не мешают, а
# git checkout о них не спотыкается. Раньше проверялось и то и другое, и
# деплой вставал из-за какого-нибудь забытого рядом файла — причём молча, не
# показывая, из-за какого именно.
DIRTY=$(git -C "$ROOT" status --porcelain --untracked-files=no)
if [ -n "$DIRTY" ]; then
    printf 'в каталоге есть правленые файлы репозитория:\n%s\n' "$DIRTY" >&2
    fail "верните их как было (git restore .) или сохраните, иначе обновление их затрёт"
fi

# --- сборка -----------------------------------------------------------------

say "беру $REF"
git -C "$ROOT" fetch --quiet origin --tags --prune
git -C "$ROOT" checkout --quiet "$REF" || fail "нет такой ветки или тега: $REF"
# На ветке — ещё и подтянуть; на теге подтягивать нечего, HEAD там отсоединён.
if git -C "$ROOT" symbolic-ref -q HEAD > /dev/null; then
    git -C "$ROOT" pull --quiet --ff-only
fi
say "собран будет $(git -C "$ROOT" log --oneline -1)"

# Новый образ отдельным именем: неудачная сборка не должна портить то, чем
# сервер работает сейчас.
docker build -q -f "$ROOT/packages/server/Dockerfile" -t "$IMAGE:new" "$ROOT" > /dev/null ||
    fail "сборка образа не прошла — работающий контейнер не тронут"

# --- подмена ----------------------------------------------------------------

PORT=$(grep '^FB2READ_SERVER_PORT=' "$ENVFILE" | cut -d= -f2- || true)
[ -n "$PORT" ] || PORT=8787

if [ -n "$HAVE" ]; then
    docker rename "$NAME" "$OLD"
    docker stop "$OLD" > /dev/null
fi

set -- -p "$PUBLISH" -v "$DATA:/data" --env-file "$ENVFILE"
docker run -d --name "$NAME" --restart unless-stopped "$@" "$IMAGE:new" > /dev/null

# --- ответил ли -------------------------------------------------------------

ALIVE=""
TRY=0
while [ "$TRY" -lt 30 ]; do
    if docker exec "$NAME" wget -q -O- "http://127.0.0.1:$PORT/api/v1/health" > /dev/null 2>&1; then
        ALIVE=yes
        break
    fi
    TRY=$((TRY + 1))
    sleep 1
done

if [ -z "$ALIVE" ]; then
    say "новый контейнер не отвечает, вот что он говорит:"
    docker logs --tail 20 "$NAME" >&2 || true
    docker rm -f "$NAME" > /dev/null
    if [ -n "$HAVE" ]; then
        docker rename "$OLD" "$NAME"
        docker start "$NAME" > /dev/null
        fail "обновление откачено, прежний сервер поднят обратно"
    fi
    fail "сервер не поднялся"
fi

docker tag "$IMAGE:new" "$IMAGE:latest"
if [ -n "$HAVE" ]; then
    docker rm "$OLD" > /dev/null
fi

say "готово: $(docker exec "$NAME" node /app/fb2read-server.mjs --version)"
say "проверка: $(docker exec "$NAME" wget -q -O- "http://127.0.0.1:$PORT/api/v1/health")"
