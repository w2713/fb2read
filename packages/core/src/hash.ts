/**
 * Отпечатки: sha256 содержимого книги и sha1 для ключа позиции.
 *
 * WebCrypto есть и в Node, и в Bun, и в браузере, так что ядру не нужен
 * ни node:crypto, ни своя реализация.
 */

function hex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Отпечаток содержимого книги: по нему она узнаётся на другом устройстве. */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const view = new Uint8Array(data.length);
  view.set(data);
  return hex(await crypto.subtle.digest("SHA-256", view));
}

/** sha1 в hex — нужен для ключа позиции, совместимого с версией на Python. */
export async function sha1Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  return hex(await crypto.subtle.digest("SHA-1", data));
}
