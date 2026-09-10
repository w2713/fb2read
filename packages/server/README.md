# fb2read-server

Сервер синхронизации книг и позиций чтения для [fb2read](https://github.com/w2713/fb2read) —
читалки FB2 и EPUB для терминала.

Начали книгу на ноутбуке — продолжаете с того же места на другой машине.
Сервер ваш, не чужой: читалка не отправляет ничего никуда, кроме адреса,
который вы сами укажете.

## Запуск

```bash
npm install -g fb2read-server

FB2READ_SERVER_TOKENS="я:$(openssl rand -hex 32)" \
FB2READ_SERVER_DIR=~/fb2read-data \
  fb2read-server
```

Без токенов сервер не запускается: иначе он пускал бы кого угодно.

## Настройки

| Переменная | Что задаёт |
|---|---|
| `FB2READ_SERVER_TOKENS` | токены `имя:токен` через запятую; обязательна |
| `FB2READ_SERVER_DIR` | каталог с данными, по умолчанию `./fb2read-data` |
| `FB2READ_SERVER_PORT` | порт, по умолчанию 8787 |
| `FB2READ_SERVER_HOST` | адрес, по умолчанию только 127.0.0.1 |
| `FB2READ_SERVER_MAX_MB` | предел размера книги, по умолчанию 200 |
| `FB2READ_SERVER_ORIGIN` | откуда пускать браузер (CORS) |

Несколько токенов — несколько человек, у каждого свой каталог и свои книги.
Токен должен состоять из латиницы: в заголовке HTTP другого не передать.

## Данные

Просто файлы: скопировать, положить в архив, посмотреть глазами.

```
<каталог>/<пользователь>/books/<отпечаток>.fb2
<каталог>/<пользователь>/state/<отпечаток>.json
<каталог>/<пользователь>/index.json
```

Отпечаток — sha256 содержимого книги. По нему книга узнаётся на другом
устройстве, где путь и имя файла другие.

## TLS

Сертификаты сервер не выдаёт намеренно: этим лучше занимается reverse proxy.
Caddy хватает двух строк:

```caddyfile
books.example.org {
    reverse_proxy 127.0.0.1:8787
}
```

Для nginx строк больше, и одна из них обязательна:

```nginx
server {
    listen 443 ssl;
    server_name books.example.org;

    ssl_certificate     /etc/letsencrypt/live/books.example.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/books.example.org/privkey.pem;

    # Без этого nginx рубит всё тяжелее мегабайта, а книга едет файлом целиком.
    # Предел ставится выше серверного (FB2READ_SERVER_MAX_MB, по умолчанию 200):
    # тогда отказ придёт от сервера — внятными словами и с заголовками CORS, —
    # а не голым 413 от nginx, который браузер покажет как «сервер недоступен».
    client_max_body_size 210m;
    proxy_request_buffering off;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

Пускать сервер в интернет без TLS не стоит: токен уходит в заголовке, и по
открытому HTTP его увидит любой по дороге. Для читалки в браузере TLS и вовсе
обязателен: страница живёт на `https://`, и запрос на `http://` браузер не
выпустит — молча.

## В контейнере

```bash
git clone https://github.com/w2713/fb2read.git && cd fb2read
docker build -f packages/server/Dockerfile -t fb2read-server .

docker volume create fb2read-data
docker run -d --name fb2read --restart unless-stopped \
  -p 127.0.0.1:8787:8787 -v fb2read-data:/data \
  -e FB2READ_SERVER_TOKENS="я:$(openssl rand -hex 32)" \
  -e FB2READ_SERVER_ORIGIN="https://w2713.github.io" \
  fb2read-server
```

Именованный том, а не каталог с диска: внутри сервер работает не от
суперпользователя, и подключённый каталог хоста ему обычно недоступен на
запись. Если каталог всё же нужен, узнайте, от кого работает сервер
(`docker run --rm fb2read-server id`), и отдайте каталог ему.

`FB2READ_SERVER_ORIGIN` нужен только для читалки в браузере; без него браузер к
серверу не постучится вовсе.

Настройка читалки и остальное — в [README проекта](https://github.com/w2713/fb2read#синхронизация).

## Лицензия

MIT.
