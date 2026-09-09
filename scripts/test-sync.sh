#!/bin/sh
# Проверяет синхронизацию двумя устройствами через настоящий сервер.
#
# Модульные тесты проверяют слияние и сервер по отдельности. Здесь проверяется
# обещание целиком: книга, выгруженная с одного устройства, читается на другом
# с того же места, а снятая закладка не воскресает. Работают собранные
# бинарники, а не исходники, — то есть ровно то, что попадает к человеку.
#
# Запуск: ./scripts/test-sync.sh

set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
PORT=${FB2READ_SYNC_TEST_PORT:-8793}
TOKEN=testtoken0123456789
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

CLI="$ROOT/packages/cli/dist/fb2read.mjs"
SRV="$ROOT/packages/server/dist/fb2read-server.mjs"
[ -f "$CLI" ] || fail "нет бандла читалки — запустите pnpm build"
[ -f "$SRV" ] || fail "нет бандла сервера — запустите pnpm build"

# --- книга -----------------------------------------------------------------

cat > "$WORK/Анна Каренина.fb2" <<'FB2'
<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">
<description><title-info>
<book-title>Анна Каренина</book-title>
<author><first-name>Лев</first-name><last-name>Толстой</last-name></author>
</title-info></description>
<body><section>
<title><p>Часть первая</p></title>
<p>Все счастливые семьи похожи друг на друга, каждая несчастливая семья несчастлива по-своему.</p>
<p>Всё смешалось в доме Облонских.</p>
</section></body>
</FictionBook>
FB2

# --- сервер ----------------------------------------------------------------

echo "поднимаю сервер на порту $PORT"
FB2READ_SERVER_DIR="$WORK/server" \
FB2READ_SERVER_TOKENS="chelovek:$TOKEN" \
FB2READ_SERVER_PORT="$PORT" \
    node "$SRV" > "$WORK/server.log" 2>&1 &
SERVER=$!
sleep 1
grep -q "слушаю" "$WORK/server.log" || { cat "$WORK/server.log"; fail "сервер не поднялся"; }

# --- два устройства --------------------------------------------------------

# У каждого свой HOME, то есть свои positions.json и config.ini: это и делает
# их разными устройствами с точки зрения читалки.
for dev in noutbuk telefon; do
    mkdir -p "$WORK/$dev/.config/fb2read" "$WORK/$dev/.local/share/fb2read"
    cat > "$WORK/$dev/.config/fb2read/config.ini" <<INI
[sync]
url = http://127.0.0.1:$PORT
token = $TOKEN
auto = yes
INI
done

# Ноутбук: XDG-переменные, чтобы состояние точно легло в свой каталог.
noutbuk() {
    env HOME="$WORK/noutbuk" \
        XDG_CONFIG_HOME="$WORK/noutbuk/.config" \
        XDG_DATA_HOME="$WORK/noutbuk/.local/share" \
        FB2READ_DEVICE=noutbuk \
        FB2READ_LIBRARY="$WORK/noutbuk/books" \
        node "$CLI" "$@"
}

telefon() {
    env HOME="$WORK/telefon" \
        XDG_CONFIG_HOME="$WORK/telefon/.config" \
        XDG_DATA_HOME="$WORK/telefon/.local/share" \
        FB2READ_DEVICE=telefon \
        FB2READ_LIBRARY="$WORK/telefon/books" \
        node "$CLI" "$@"
}

state_noutbuk="$WORK/noutbuk/.local/share/fb2read/positions.json"
state_telefon="$WORK/telefon/.local/share/fb2read/positions.json"

# --- ноутбук: прочитал часть книги и поставил закладку ----------------------

# Читалка пишет позицию сама, но интерфейсу нужен настоящий терминал.
# Поэтому запись состояния делается так же, как её сделала бы читалка:
# тот же ключ, те же поля.
python3 - "$WORK/Анна Каренина.fb2" "$state_noutbuk" <<'PY'
import hashlib, json, os, sys, time

book, state = sys.argv[1], sys.argv[2]
data = open(book, "rb").read()
path = os.path.abspath(book)
key = hashlib.sha1(f"{path}:{len(data)}".encode()).hexdigest()[:16]
now = time.time()
os.makedirs(os.path.dirname(state), exist_ok=True)
json.dump({
    key: {
        "block": 2,
        "title": "Анна Каренина",
        "author": "Лев Толстой",
        "total": 4,
        "path": path,
        "at": now,
        "hash": hashlib.sha256(data).hexdigest(),
        "bookmarks": [{"block": 1, "name": "про семьи", "percent": 33, "at": now}],
    }
}, open(state, "w"), ensure_ascii=False)
PY

echo "ноутбук: выгружаю книгу"
noutbuk push "$WORK/Анна Каренина.fb2" > "$WORK/push.log" 2>&1 || { cat "$WORK/push.log"; fail "push не удался"; }
grep -q "готово" "$WORK/push.log" || { cat "$WORK/push.log"; fail "push не сказал «готово»"; }

echo "ноутбук: смотрю, что на сервере"
noutbuk remote > "$WORK/remote.log" 2>&1 || { cat "$WORK/remote.log"; fail "remote не удался"; }
grep -q "Анна Каренина" "$WORK/remote.log" || { cat "$WORK/remote.log"; fail "remote не показал книгу"; }
grep -q "noutbuk" "$WORK/remote.log" || { cat "$WORK/remote.log"; fail "remote не показал устройство"; }

# --- телефон: скачал книгу и получил позицию -------------------------------

echo "телефон: скачиваю всё"
telefon pull --all > "$WORK/pull.log" 2>&1 || { cat "$WORK/pull.log"; fail "pull не удался"; }
[ -f "$WORK/telefon/books/Анна Каренина.fb2" ] || {
    ls -la "$WORK/telefon/books" || true
    fail "книга не появилась под своим именем"
}
cmp "$WORK/Анна Каренина.fb2" "$WORK/telefon/books/Анна Каренина.fb2" ||
    fail "скачанная книга отличается от выгруженной"
grep -q "позиция с сервера" "$WORK/pull.log" || { cat "$WORK/pull.log"; fail "позиция не перенеслась"; }

python3 - "$state_telefon" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
records = [v for k, v in data.items() if k != "__settings__"]
assert len(records) == 1, f"на телефоне записей: {len(records)}"
r = records[0]
assert r["block"] == 2, f"позиция на телефоне {r['block']}, а должна быть 2"
live = [m for m in r.get("bookmarks", []) if not m.get("deleted")]
assert len(live) == 1, f"закладок на телефоне: {live}"
print("телефон: позиция 2, закладка на месте")
PY

# --- телефон: дочитал дальше и снял закладку -------------------------------

python3 - "$state_telefon" <<'PY'
import json, sys, time
path = sys.argv[1]
data = json.load(open(path))
key = next(k for k in data if k != "__settings__")
now = time.time() + 10
data[key]["block"] = 3
data[key]["at"] = now
data[key]["bookmarks"] = [{"block": 1, "at": now, "deleted": True}]
json.dump(data, open(path, "w"), ensure_ascii=False)
PY

echo "телефон: отправляю прочитанное"
telefon sync > "$WORK/sync1.log" 2>&1 || { cat "$WORK/sync1.log"; fail "sync на телефоне не удался"; }

echo "ноутбук: забираю"
noutbuk sync > "$WORK/sync2.log" 2>&1 || { cat "$WORK/sync2.log"; fail "sync на ноутбуке не удался"; }

python3 - "$state_noutbuk" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
r = next(v for k, v in data.items() if k != "__settings__")
assert r["block"] == 3, f"на ноутбуке позиция {r['block']}, а телефон дочитал до 3"
live = [m for m in r.get("bookmarks", []) if not m.get("deleted")]
assert not live, f"снятая закладка воскресла: {live}"
graves = [m for m in r.get("bookmarks", []) if m.get("deleted")]
assert graves, "надгробие не сохранилось — закладка вернётся при следующем обмене"
print("ноутбук: позиция 3, снятая закладка не вернулась")
PY

# --- ноутбук шлёт закладку заново: она не должна воскреснуть ---------------

python3 - "$state_noutbuk" <<'PY'
import json, sys
path = sys.argv[1]
data = json.load(open(path))
key = next(k for k in data if k != "__settings__")
# Устройство, которое о снятии не знало: старая закладка со старым временем.
data[key]["bookmarks"] = [{"block": 1, "name": "про семьи", "at": 1}]
json.dump(data, open(path, "w"), ensure_ascii=False)
PY

noutbuk sync > "$WORK/sync3.log" 2>&1 || { cat "$WORK/sync3.log"; fail "третий sync не удался"; }

python3 - "$state_noutbuk" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
r = next(v for k, v in data.items() if k != "__settings__")
live = [m for m in r.get("bookmarks", []) if not m.get("deleted")]
assert not live, f"закладка воскресла с устройства, не знавшего о снятии: {live}"
print("закладка не воскресла и со старого устройства")
PY

# --- без сети читалка всё равно открывает книгу ----------------------------

kill "$SERVER" 2>/dev/null || true
SERVER=""
sleep 0.3

echo "сервер выключен: проверяю, что читалка не встала"
start=$(date +%s)
noutbuk --info "$WORK/Анна Каренина.fb2" > "$WORK/offline.log" 2>&1 || {
    cat "$WORK/offline.log"
    fail "без сервера --info перестал работать"
}
took=$(( $(date +%s) - start ))
grep -q "Анна Каренина" "$WORK/offline.log" || { cat "$WORK/offline.log"; fail "книга не прочиталась"; }
[ "$took" -le 5 ] || fail "без сервера читалка думала $took с — синхронизация не должна задерживать"

noutbuk sync > "$WORK/offsync.log" 2>&1 && fail "sync без сервера отчитался успехом"
grep -q "сервер недоступен" "$WORK/offsync.log" || {
    cat "$WORK/offsync.log"
    fail "sync без сервера не объяснил, что случилось"
}

echo
echo "синхронизация проверена: два устройства, позиция, закладки, надгробия, работа без сети"
