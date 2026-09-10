/**
 * Расширение по содержимому.
 *
 * Имя файла книги приезжает с чужого устройства и расширения может не иметь:
 * скачанное браузером из сети нередко ложится в систему безымянным по формату.
 * Такой файл читалка откроет — формат она узнаёт по байтам, — но в списке
 * каталога его не будет: список отбирает файлы по имени. Поэтому расширение
 * восстанавливается при записи на диск, и берётся оно из самих байтов.
 */

import { describe, expect, it } from "vitest";
import { nameWithExt } from "../src/meta.js";
import { epubBytes, sampleBytes, zipped } from "./fixtures.js";

describe("расширение по содержимому", () => {
  it("дописывает .fb2 книге без расширения", () => {
    expect(nameWithExt("Война и мир", sampleBytes())).toBe("Война и мир.fb2");
  });

  it("узнаёт EPUB и FB2 в архиве, а не гадает по имени", () => {
    // Оба — zip, и различить их можно только заглянув внутрь.
    expect(nameWithExt("Пример", epubBytes())).toBe("Пример.epub");
    expect(nameWithExt("Пример", zipped("<FictionBook/>"))).toBe("Пример.fb2.zip");
  });

  it("не трогает имя, у которого расширение уже есть", () => {
    for (const name of ["к.fb2", "к.fb2.zip", "к.fbz", "к.epub"]) {
      expect(nameWithExt(name, sampleBytes())).toBe(name);
    }
  });

  it("не путается в регистре", () => {
    // «Книга.FB2» — обычное дело для файлов, приехавших с Windows.
    expect(nameWithExt("Книга.FB2", sampleBytes())).toBe("Книга.FB2");
    expect(nameWithExt("Книга.EPUB", epubBytes())).toBe("Книга.EPUB");
  });

  it("не считает расширением точку в середине имени", () => {
    // «Дюна. Книга 1» — точка есть, расширения нет.
    expect(nameWithExt("Дюна. Книга 1", sampleBytes())).toBe("Дюна. Книга 1.fb2");
  });
});
