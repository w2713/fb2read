/**
 * Работа с zip: .fb2.zip, .fbz и EPUB.
 *
 * Распаковывается только запрошенный файл — книга с картинками может весить
 * сотню мегабайт, и разворачивать её целиком ради одной страницы незачем.
 */

import { unzipSync } from "fflate";

const SIGNATURE = [0x50, 0x4b]; // "PK"

/** Похоже ли начало данных на zip-архив. */
export function isZip(data: Uint8Array): boolean {
  return data.length > 4 && data[0] === SIGNATURE[0] && data[1] === SIGNATURE[1];
}

/**
 * Имена файлов в архиве.
 *
 * Фильтр отсекает всё, поэтому fflate только проходит записи и ничего не
 * распаковывает — свой разбор центрального каталога не нужен.
 */
export function zipNames(data: Uint8Array): string[] {
  const names: string[] = [];
  unzipSync(data, {
    filter: (file) => {
      names.push(file.name);
      return false;
    },
  });
  return names;
}

/** Содержимое одного файла архива или null, если его там нет. */
export function zipRead(data: Uint8Array, name: string): Uint8Array | null {
  const found = unzipSync(data, { filter: (file) => file.name === name });
  return found[name] ?? null;
}

/** EPUB — это zip с META-INF/container.xml внутри. */
export function isEpubData(data: Uint8Array): boolean {
  if (!isZip(data)) return false;
  try {
    return zipNames(data).includes("META-INF/container.xml");
  } catch {
    return false;
  }
}

/**
 * Сырой XML книги: из архива берётся первый .fb2, иначе первый файл вообще.
 */
export function readBookData(data: Uint8Array): Uint8Array {
  if (!isZip(data)) return data;
  const names = zipNames(data);
  const fb2 = names.filter((n) => n.toLowerCase().endsWith(".fb2"));
  const pick = (fb2.length ? fb2 : names.filter((n) => !n.endsWith("/")))[0];
  if (!pick) throw new Error("в архиве нет файлов");
  const content = zipRead(data, pick);
  if (!content) throw new Error("в архиве нет файлов");
  return content;
}
