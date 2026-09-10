# Образ сервера синхронизации fb2read.
#
# Собирается из корня репозитория, потому что сервер берёт ядро из соседнего
# пакета:
#
#   docker build -f packages/server/Dockerfile -t fb2read-server .
#
# Внутрь кладётся только собранный бандл — ни исходников, ни node_modules:
# зависимости у сервера все свои, они уже внутри бандла.

FROM node:22-alpine AS build
WORKDIR /src

# Сначала манифесты: слой с установкой зависимостей переживает правку кода.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/

# Ставится только то, что нужно серверу: он сам, ядро и корень с tsup и tsc.
#
# Терминальная читалка сюда не попадает нарочно. За ней тянется node-pty,
# который собирается из исходников, а в этом образе нет ни компилятора, ни
# python — сборка обрывалась бы на нём, хотя серверу он не нужен вовсе.
#
# Версия pnpm закреплена в package.json: без этого corepack брал самый свежий,
# а он читает настройки из другого места, и установка падала на разрешении
# сборочных скриптов.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && pnpm install --frozen-lockfile \
    --filter "fb2read-server..." --filter fb2read-monorepo

COPY . .
RUN pnpm --filter @fb2read/core exec tsc -b && pnpm --filter fb2read-server build

FROM node:22-alpine
WORKDIR /app

# Не от суперпользователя: сервер принимает файлы из сети.
RUN addgroup -S fb2read && adduser -S -G fb2read fb2read \
    && mkdir -p /data && chown fb2read:fb2read /data

COPY --from=build /src/packages/server/dist/fb2read-server.mjs /app/fb2read-server.mjs

USER fb2read
VOLUME /data

ENV FB2READ_SERVER_DIR=/data \
    FB2READ_SERVER_PORT=8787 \
    FB2READ_SERVER_HOST=0.0.0.0

EXPOSE 8787

# Токены не задаются здесь намеренно: с токеном из образа сервер пускал бы
# любого, кто этот образ видел. Задаются при запуске.
HEALTHCHECK --interval=30s --timeout=3s \
    CMD wget -q -O- http://127.0.0.1:8787/api/v1/health || exit 1

CMD ["node", "/app/fb2read-server.mjs"]
