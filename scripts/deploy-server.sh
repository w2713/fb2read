#!/bin/sh
# Обновляет сервер синхронизации, поднятый через docker compose.
#
# Само обновление — это две команды, `git pull` и `docker compose up -d
# --build`, и скрипт их не заменяет, а обкладывает тем, чего compose не делает.
# А не делает он ровно того, на чём этот сервер уже дважды ложился:
#
#  * не смотрит в токен. Токен без имени впереди («токен» вместо «я:токен»)
#    compose проглотит молча, сервер поднимется пользователем default — и
#    читатель увидит пустую библиотеку, потому что книги лежат в каталоге с
#    другим именем. Токен не из латиницы сервер не примет вовсе и уйдёт в
#    перезапуск по кругу;
#  * не смотрит, тот ли том подцепился. Том из раздела volumes без пометки
#    external compose называет по имени проекта и заводит новый, пустой. Со
#    стороны это неотличимо от «книги пропали»;
#  * не откатывает. Если новый контейнер не поднялся, compose оставит его
#    перезапускаться, а прежний образ к тому времени уже перезаписан.
#
# Запуск на сервере, из каталога репозитория:
#
#   ./scripts/deploy-server.sh            # обновить до main
#   ./scripts/deploy-server.sh v0.21.0    # обновить до тега
#
# Настройки берутся из compose-файла, а токен — из .env рядом с ним. Ничего
# перенимать с работающего контейнера не нужно: всё написано в файле.

set -eu

REF=${1:-main}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
FILE=${FB2READ_COMPOSE:-}

say() {
    printf '%s\n' "$*"
}

fail() {
    printf 'не вышло: %s\n' "$*" >&2
    exit 1
}

command -v docker > /dev/null 2>&1 || fail "нет docker"
command -v git > /dev/null 2>&1 || fail "нет git"
docker compose version > /dev/null 2>&1 || fail "нет docker compose"

if [ -z "$FILE" ]; then
    for name in docker-compose.yml docker-compose.yaml compose.yml compose.yaml; do
        [ -f "$ROOT/$name" ] || continue
        FILE=$ROOT/$name
        break
    done
fi
[ -n "$FILE" ] || fail "рядом нет compose-файла — см. README, раздел «Свой сервер»"

compose() {
    docker compose -f "$FILE" "$@"
}

# --- проверки до того, как трогать работающее -------------------------------

# Заодно проверяется и сам файл, и что .env с токеном на месте: без него
# ${FB2READ_SERVER_TOKENS:?...} остановит compose прямо здесь.
compose config > /dev/null 2>&1 || {
    compose config > /dev/null || true
    fail "compose-файл не сходится — исправьте его прежде, чем обновлять"
}

SERVICE=$(compose config --services | head -1)
[ -n "$SERVICE" ] || fail "в compose-файле нет ни одной службы"

# Значение токена нигде не печатается: из вывода берётся только оно само, и
# дальше о нём говорится «есть имя» или «одна латиница».
TOKENS=$(compose config | sed -n 's/^ *FB2READ_SERVER_TOKENS: *//p' | head -1 | sed -e 's/^"//' -e 's/"$//')
[ -n "$TOKENS" ] || fail "в настройках нет FB2READ_SERVER_TOKENS"

case $TOKENS in
    *[!\ -~]*)
        fail "в токене не латиница — сервер такой не примет.
Похоже, подстановку вроде «ВАШ-ТОКЕН» скопировали в файл как есть."
        ;;
esac

USER_NAME=${TOKENS%%:*}
case $TOKENS in
    *:*) ;;
    *)
        fail "в токене нет имени пользователя: надо «имя:токен», а не просто токен.
Без имени сервер поднимется пользователем default, и библиотека окажется пустой."
        ;;
esac
[ -n "$USER_NAME" ] || fail "перед двоеточием в токене пусто — там должно быть имя пользователя"

DIRTY=$(git -C "$ROOT" status --porcelain --untracked-files=no)
if [ -n "$DIRTY" ]; then
    printf 'в каталоге есть правленые файлы репозитория:\n%s\n' "$DIRTY" >&2
    fail "верните их как было (git restore .) или сохраните, иначе обновление их затрёт"
fi

# --- что стоит сейчас -------------------------------------------------------

IMAGE=$(compose config | sed -n 's/^ *image: *//p' | head -1)
PREV=""
if [ -n "$IMAGE" ]; then
    PREV=$(docker image inspect "$IMAGE" --format '{{.Id}}' 2>/dev/null || true)
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

compose build --quiet || fail "сборка образа не прошла — работающий контейнер не тронут"
compose up -d

# --- ответил ли -------------------------------------------------------------

PORT=$(compose config | sed -n 's/^ *FB2READ_SERVER_PORT: *//p' | head -1 | tr -d '"')
[ -n "$PORT" ] || PORT=8787

alive() {
    compose exec -T "$SERVICE" wget -q -O- "http://127.0.0.1:$PORT/api/v1/health" > /dev/null 2>&1
}

back() {
    say "возвращаю прежний сервер"
    if [ -n "$PREV" ] && [ -n "$IMAGE" ]; then
        docker tag "$PREV" "$IMAGE"
        compose up -d
    else
        compose down > /dev/null 2>&1 || true
    fi
}

OK=""
TRY=0
while [ "$TRY" -lt 30 ]; do
    if alive; then
        OK=yes
        break
    fi
    TRY=$((TRY + 1))
    sleep 1
done

if [ -z "$OK" ]; then
    say "новый контейнер не отвечает, вот что он говорит:"
    compose logs --tail 20 "$SERVICE" >&2 || true
    back
    fail "обновление откачено"
fi

# --- та ли библиотека -------------------------------------------------------

# Книги лежат в каталоге по имени пользователя. Если каталоги есть, а нужного
# среди них нет — значит, подцепился не тот том или у токена другое имя, и
# читатель увидит пустую полку. Пустой /data — дело другое: это новый сервер,
# каталог заводится при первой записи.
SEEN=$(compose exec -T "$SERVICE" ls /data 2>/dev/null | tr -d '\r' || true)
if [ -n "$SEEN" ] && ! printf '%s\n' "$SEEN" | grep -qx "$USER_NAME"; then
    printf 'в /data лежат каталоги других пользователей:\n%s\n' "$SEEN" >&2
    say "а нужен «$USER_NAME» — значит, подцепился не тот том или в токене другое имя"
    back
    fail "обновление откачено: библиотека оказалась бы пустой"
fi

say "готово: $(compose exec -T "$SERVICE" node /app/fb2read-server.mjs --version | tr -d '\r')"
say "проверка: $(compose exec -T "$SERVICE" wget -q -O- "http://127.0.0.1:$PORT/api/v1/health")"
