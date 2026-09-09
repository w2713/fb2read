# -*- coding: utf-8 -*-
"""Создаёт книги-образцы для сверки двух реализаций.

Тексты те же, что в tests/conftest.py и tests/epub_data.py: если книги
собирает один и тот же код, расхождение в дампе означает разницу в разборе,
а не разницу во входных данных.

Запуск: python3 scripts/make-fixtures.py <каталог>
"""

import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tests"))

import epub_data  # noqa: E402
from conftest import HEAD, SAMPLE, WIDE, _png  # noqa: E402


def big_book():
    import random
    rnd = random.Random(1)
    words = "время книга дорога вечер снег голос память город окно".split()
    parts = []
    for chapter in range(1, 41):
        paragraphs = []
        for _ in range(rnd.randint(10, 20)):
            sentences = " ".join(
                " ".join(rnd.choice(words) for _ in range(rnd.randint(6, 12))
                         ).capitalize() + "."
                for _ in range(rnd.randint(3, 6)))
            paragraphs.append("<p>%s</p>" % sentences)
        parts.append("<section><title><p>Глава %d</p></title>%s</section>"
                     % (chapter, "".join(paragraphs)))
    return (HEAD.format(enc="utf-8") +
            "<description><title-info><book-title>Большая книга</book-title>"
            "<author><last-name>Длинный</last-name></author></title-info>"
            "</description><body><title><p>Большая книга</p></title>" +
            "".join(parts) + "</body></FictionBook>")


def picture_book():
    import base64
    data = base64.b64encode(_png()).decode()
    return (HEAD.format(enc="utf-8") +
            "<description><title-info><book-title>С картинкой</book-title>"
            "</title-info></description><body><section>"
            "<title><p>Глава</p></title><p>Текст перед картинкой.</p>"
            '<image l:href="#pic1"/><p>Текст после.</p></section></body>'
            '<binary id="pic1" content-type="image/png">' + data +
            "</binary></FictionBook>")


BROKEN = (HEAD.format(enc="utf-8") +
          "<description><title-info><book-title>Битая книга</book-title>"
          "</title-info></description><body><section>"
          "<title><p>Глава</p></title>"
          "<p>Амперсанд & сам по себе, сущность &nbsp; и &mdash; тире.</p>"
          "<p>Управляющий\x01символ внутри.</p>"
          "</section></body></FictionBook>\nмусор после конца")


def make_epub(path, files):
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("mimetype", "application/epub+zip", zipfile.ZIP_STORED)
        for name, text in files.items():
            z.writestr(name, text)
        z.writestr("OEBPS/images/cover.jpg", b"\xff\xd8\xff")


def main(out):
    os.makedirs(out, exist_ok=True)
    write(os.path.join(out, "sample.fb2"), SAMPLE, "cp1251")
    write(os.path.join(out, "wide.fb2"), WIDE)
    write(os.path.join(out, "big.fb2"), big_book())
    write(os.path.join(out, "picture.fb2"), picture_book())
    write(os.path.join(out, "broken.fb2"), BROKEN)
    with zipfile.ZipFile(os.path.join(out, "sample.fb2.zip"), "w") as z:
        z.write(os.path.join(out, "sample.fb2"), "sample.fb2")
    make_epub(os.path.join(out, "book.epub"), epub_data.FILES)
    make_epub(os.path.join(out, "old.epub"), epub_data.FILES_NCX)
    print(out)


def write(path, text, encoding="utf-8"):
    with open(path, "wb") as f:
        f.write(text.encode(encoding))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "fixtures")
