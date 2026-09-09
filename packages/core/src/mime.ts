/** Типы вложений: карта расширений, которой хватает книгам. */

const BY_EXT: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".avif": "image/avif",
};

const BY_TYPE: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/bmp": ".bmp",
  "image/tiff": ".tif",
  "image/avif": ".avif",
};

/** Тип по имени файла. */
export function guessType(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : (BY_EXT[name.slice(dot).toLowerCase()] ?? "");
}

/** Расширение по типу — нужно, когда картинку отдают внешней программе. */
export function guessExtension(mime: string): string {
  return BY_TYPE[mime.toLowerCase()] ?? "";
}
