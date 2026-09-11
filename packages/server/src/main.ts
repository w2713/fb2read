/**
 * Запуск сервера синхронизации.
 *
 * Настраивается переменными окружения: так удобнее и в systemd, и в Docker,
 * и незачем заводить ещё один формат файла настроек.
 */

import { createServer, parseTokens } from "./server.js";

export const VERSION = "0.20.0";

const HELP = `Использование: fb2read-server

Сервер синхронизации книг и позиций чтения для fb2read.

Переменные окружения:
  FB2READ_SERVER_DIR      каталог с данными (по умолчанию ./fb2read-data)
  FB2READ_SERVER_TOKENS   токены через запятую в виде имя:токен;
                          без них сервер не запускается
  FB2READ_SERVER_PORT     порт (по умолчанию 8787)
  FB2READ_SERVER_HOST     на каком адресе слушать (по умолчанию 127.0.0.1)
  FB2READ_SERVER_MAX_MB   предел размера книги (по умолчанию 200)
  FB2READ_SERVER_ORIGIN   откуда пускать браузер, для будущей версии в вебе

Сертификаты не выдаются намеренно: сервер ставится за Caddy или nginx.
Пример разбора в README.`;

function number(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!/^\d+$/.test(raw.trim()) || Number.isNaN(value)) {
    throw new Error(`${name}: нужно целое число, а не «${raw}»`);
  }
  return value;
}

export function main(argv: string[] = process.argv.slice(2)): number {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (argv.includes("-V") || argv.includes("--version")) {
    process.stdout.write(`fb2read-server ${VERSION}\n`);
    return 0;
  }

  const tokens = parseTokens(process.env["FB2READ_SERVER_TOKENS"]);
  if (!tokens.size) {
    process.stderr.write(
      "fb2read-server: не задан FB2READ_SERVER_TOKENS.\n" +
        "Без токенов сервер пускал бы кого угодно, поэтому он не запускается.\n" +
        "Задайте, например: FB2READ_SERVER_TOKENS=я:$(openssl rand -hex 32)\n",
    );
    return 2;
  }

  const dir = process.env["FB2READ_SERVER_DIR"] ?? "./fb2read-data";
  const port = number("FB2READ_SERVER_PORT", 8787);
  const host = process.env["FB2READ_SERVER_HOST"] ?? "127.0.0.1";
  const maxBytes = number("FB2READ_SERVER_MAX_MB", 200) * 1024 * 1024;
  const origin = process.env["FB2READ_SERVER_ORIGIN"];

  const server = createServer(origin ? { dir, tokens, maxBytes, origin } : { dir, tokens, maxBytes });
  server.listen(port, host, () => {
    const users = [...tokens.keys()].join(", ");
    process.stdout.write(`fb2read-server ${VERSION}\n`);
    process.stdout.write(`слушаю http://${host}:${port}, данные в ${dir}\n`);
    process.stdout.write(`пользователи: ${users}\n`);
  });

  // Без этого контейнер останавливается по таймауту, а не сразу.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
    });
  }
  return 0;
}

const invoked = process.argv[1] ?? "";
if (invoked.includes("fb2read-server") || invoked.endsWith("main.ts")) {
  try {
    const code = main();
    if (code !== 0) process.exitCode = code;
  } catch (e) {
    process.stderr.write(`fb2read-server: ${(e as Error).message}\n`);
    process.exitCode = 1;
  }
}
