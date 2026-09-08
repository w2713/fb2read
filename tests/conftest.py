# -*- coding: utf-8 -*-
"""Общие приспособления для тестов: книги-образцы и эмулятор терминала."""

import os
import sys
import zipfile

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import epub_data  # noqa: E402
import fb2read  # noqa: E402

HEAD = ('<?xml version="1.0" encoding="{enc}"?>'
        '<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" '
        'xmlns:l="http://www.w3.org/1999/xlink">')

SAMPLE = HEAD.format(enc="windows-1251") + '''
<description><title-info>
<author><first-name>Иван</first-name><last-name>Тестов</last-name></author>
<book-title>Проверка читалки</book-title>
<sequence name="Опыты" number="2"/>
</title-info></description>
<body>
<title><p>Проверка читалки</p></title>
<epigraph><p>Всякая книга есть письмо неизвестному другу.</p>
<text-author>Некто</text-author></epigraph>
<section>
<title><p>Глава первая</p><p>в которой всё начинается</p></title>
<p>Абзац с <emphasis>курсивом</emphasis> и <strong>полужирным</strong>,
а также сноской<a l:href="#n1" type="note">[1]</a> в конце. Текст должен
переноситься по словам и укладываться в заданную ширину колонки.</p>
<empty-line/>
<p>Второй абзац с ключесловом внутри, кавычками «ёлочками» и тире —.</p>
<subtitle>Подзаголовок</subtitle>
<poem><stanza><v>Мороз и солнце; день чудесный!</v>
<v>Ещё ты дремлешь, друг прелестный —</v></stanza>
<text-author>А. С. Пушкин</text-author></poem>
<cite><p>Цитата с отступом.</p><text-author>Источник</text-author></cite>
<section><title><p>Вложенный раздел</p></title><p>Текст раздела.</p></section>
</section>
<section><title><p>Глава вторая</p></title>
<p>Ещё текст для проверки прокрутки.</p>
<image l:href="#pic1"/>
<table><tr><td>Ячейка 1</td><td>Ячейка 2</td></tr></table>
</section>
</body>
<body name="notes"><section id="n1"><title><p>1</p></title>
<p>Это текст сноски.</p></section></body>
</FictionBook>'''

WIDE = HEAD.format(enc="utf-8") + '''
<description><title-info><book-title>日本語 и эмодзи</book-title>
<author><last-name>Тестов</last-name></author></title-info></description>
<body><section><title><p>Глава 日本語</p></title>
<p>Иероглифы 日本語 東京 大阪 и эмодзи 😀🎉 вперемешку с русским текстом.</p>
<p>Абзац с <emphasis>курсивом 日本</emphasis> и <strong>полужирным 東京</strong>.</p>
<p>ОченьДлинноеСловоБезПробеловКотороеПридётсяРазрезатьПоШиринеКолонки.</p>
</section></body></FictionBook>'''


def _write(path, text, encoding="utf-8"):
    path.write_bytes(text.encode(encoding))
    return str(path)


@pytest.fixture
def sample(tmp_path):
    """Книга в cp1251 со всеми видами разметки."""
    return _write(tmp_path / "sample.fb2", SAMPLE, "cp1251")


@pytest.fixture
def wide(tmp_path):
    """Книга с широкими символами и длинным словом."""
    return _write(tmp_path / "wide.fb2", WIDE)


@pytest.fixture
def sample_zip(tmp_path, sample):
    path = tmp_path / "sample.fb2.zip"
    with zipfile.ZipFile(path, "w") as z:
        z.write(sample, "sample.fb2")
    return str(path)


@pytest.fixture
def big(tmp_path):
    """Книга на 40 глав — для проверки перелистывания."""
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
    xml = (HEAD.format(enc="utf-8") +
           "<description><title-info><book-title>Большая книга</book-title>"
           "<author><last-name>Длинный</last-name></author></title-info>"
           "</description><body><title><p>Большая книга</p></title>" +
           "".join(parts) + "</body></FictionBook>")
    return _write(tmp_path / "big.fb2", xml)


def _make_epub(path, files):
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("mimetype", "application/epub+zip", zipfile.ZIP_STORED)
        for name, text in files.items():
            z.writestr(name, text)
        z.writestr("OEBPS/images/cover.jpg", b"\xff\xd8\xff")
    return str(path)


@pytest.fixture
def epub(tmp_path):
    """EPUB 3: навигация, списки, цитата и сноска в отдельном файле."""
    return _make_epub(tmp_path / "book.epub", epub_data.FILES)


@pytest.fixture
def epub_ncx(tmp_path):
    """Старый EPUB 2: оглавление только в NCX."""
    return _make_epub(tmp_path / "old.epub", epub_data.FILES_NCX)


def _png(width=8, height=8, color=(200, 60, 60)):
    """Минимальная настоящая PNG — kitty принимает только этот формат."""
    import struct
    import zlib
    raw = b"".join(b"\x00" + bytes(color) * width for _ in range(height))

    def chunk(tag, payload):
        body = tag + payload
        return (struct.pack(">I", len(payload)) + body +
                struct.pack(">I", zlib.crc32(body)))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))


@pytest.fixture
def picture(tmp_path):
    """FB2 с картинкой: разбор её пропускает, показ достаёт по требованию."""
    import base64
    data = base64.b64encode(_png()).decode()
    xml = (HEAD.format(enc="utf-8") +
           "<description><title-info><book-title>С картинкой</book-title>"
           "</title-info></description><body><section>"
           "<title><p>Глава</p></title><p>Текст перед картинкой.</p>"
           '<image l:href="#pic1"/><p>Текст после.</p></section></body>'
           '<binary id="pic1" content-type="image/png">' + data +
           "</binary></FictionBook>")
    return _write(tmp_path / "picture.fb2", xml)


@pytest.fixture
def state_home(tmp_path, monkeypatch):
    """Изолированный каталог для позиций и настроек."""
    home = tmp_path / "state"
    monkeypatch.setenv("XDG_DATA_HOME", str(home))
    return home


@pytest.fixture
def module():
    return fb2read
