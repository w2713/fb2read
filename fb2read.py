#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fb2read — читалка книг FB2 для терминала.

Без внешних зависимостей: только стандартная библиотека Python 3.8+.

Возможности:
  * .fb2, .fb2.zip (и любой zip с fb2 внутри), .epub
  * типографика: заголовки, стихи, цитаты, эпиграфы, сноски
  * оглавление (t), поиск (/, n, N), переход по главам ([ ])
  * переход к сноске (Enter) и возврат в текст (Backspace)
  * цветовые темы: авто / ночь / сепия / день (клавиша c, ключ --theme)
  * межстрочный интервал (клавиша s) — для крупного шрифта терминала
  * книжный разворот: две страницы рядом (клавиши 2 / 1, ключ --spread)
  * иллюстрации в терминалах kitty и iTerm2, через chafa или sixel (клавиша p)
  * мышь: колесо листает, клик открывает сноску или картинку (клавиша m)
  * закладки (M и '), экспорт закладок с текстом в markdown
  * настройки и переназначение клавиш в ~/.config/fb2read/config.ini
  * курсив и полужирный сохраняются, ширина символов считается честно
  * библиотека: запуск без аргументов или с каталогом книг
  * запоминание позиции чтения между запусками
  * режимы --dump / --toc / --info для конвейеров (| less -R)

Клавиши в режиме чтения — см. `?`.
"""

from __future__ import annotations

import argparse
import base64
import configparser
import curses
import hashlib
import html.entities
import json
import locale
import mimetypes
import os
import posixpath
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unicodedata
import urllib.parse
import zipfile
import xml.etree.ElementTree as ET

APP = "fb2read"
__version__ = "0.11.0"

# ---------------------------------------------------------------- разбор FB2


def local(tag: str) -> str:
    """Имя тега без пространства имён."""
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def read_source(path: str) -> bytes:
    """Читает .fb2 или .fb2.zip и возвращает сырые байты XML."""
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as z:
            names = [n for n in z.namelist() if n.lower().endswith(".fb2")]
            if not names:
                names = [n for n in z.namelist() if not n.endswith("/")]
            if not names:
                raise ValueError("в архиве нет файлов")
            return z.read(names[0])
    with open(path, "rb") as f:
        return f.read()


_BINARY_RE = re.compile(rb"<binary\b([^>]*)>(.*?)</binary\s*>", re.S)
_BINARY_ID_RE = re.compile(rb"""id\s*=\s*["']([^"']+)["']""")
_BINARY_TYPE_RE = re.compile(rb"""content-type\s*=\s*["']([^"']+)["']""")
_CTRL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")
_ENTITY_RE = re.compile(r"&([#A-Za-z0-9]{1,32});")
_BARE_AMP_RE = re.compile(r"&(?![#A-Za-z0-9]{1,32};)")
_XML_ENTITIES = {"amp", "lt", "gt", "quot", "apos"}
_ESCAPE = {"&": "&amp;", "<": "&lt;", ">": "&gt;"}


def strip_binaries(data: bytes):
    """Убирает base64-вложения из разбираемого XML.

    Сами данные не хранятся: запоминаются только границы каждого
    вложения в исходном файле, чтобы картинку можно было достать
    по требованию, не держа книгу целиком в памяти.
    """
    index = {}
    for match in _BINARY_RE.finditer(data):
        attrs = match.group(1)
        found = _BINARY_ID_RE.search(attrs)
        if not found:
            continue
        mime = _BINARY_TYPE_RE.search(attrs)
        index[found.group(1).decode("ascii", "replace")] = {
            "start": match.start(2),
            "end": match.end(2),
            "type": mime.group(1).decode("ascii", "replace") if mime else "",
        }
    data, count = _BINARY_RE.subn(b"", data)
    return data, count, index


def fix_entities(text: str):
    """&nbsp; и прочие HTML-сущности -> символы, одиночный & -> &amp;."""
    fixed = 0

    def replace(match):
        nonlocal fixed
        name = match.group(1)
        if name in _XML_ENTITIES or name.startswith("#"):
            return match.group(0)
        code = html.entities.name2codepoint.get(name)
        fixed += 1
        if code is None:
            return "&amp;" + name + ";"        # оставим видимым как текст
        char = chr(code)
        return _ESCAPE.get(char, char)

    text = _ENTITY_RE.sub(replace, text)
    text, bare = _BARE_AMP_RE.subn("&amp;", text)
    return text, fixed + bare


def repair(text: str):
    """Приводит в чувство типичные поломки FB2 из реальных библиотек."""
    notes = []

    text = re.sub(r"^\ufeff?\s*<\?xml[^>]*\?>", "", text, count=1).lstrip()

    cleaned = _CTRL_RE.sub("", text)
    if cleaned != text:
        notes.append("убраны управляющие символы")
        text = cleaned

    start = text.find("<")
    if start > 0:
        text = text[start:]
        notes.append("отброшен мусор перед началом документа")

    end = text.rfind("</FictionBook>")
    if end != -1 and end + len("</FictionBook>") < len(text):
        text = text[: end + len("</FictionBook>")]
        notes.append("отброшен мусор после конца документа")

    text, fixed = fix_entities(text)
    if fixed:
        notes.append(f"исправлено сущностей и амперсандов: {fixed}")

    return text, notes


def parse_xml(data: bytes):
    """Разбирает XML, переживая кривую кодировку, мусор и битые сущности.

    Возвращает (корень дерева, список правок, указатель на вложения).
    """
    notes = []
    data, cut, images = strip_binaries(data)
    if cut:
        notes.append(f"вложений пропущено при разборе: {cut}")
    try:
        return ET.fromstring(data), notes, images
    except ET.ParseError:
        pass

    for enc in ("utf-8", "cp1251", "koi8-r", "cp1252", "utf-16"):
        try:
            text = data.decode(enc)
        except (UnicodeDecodeError, UnicodeError):
            continue
        for attempt in ("as-is", "repair"):
            body = text
            extra = []
            if attempt == "as-is":
                body = re.sub(r"^\ufeff?\s*<\?xml[^>]*\?>", "", body, count=1).lstrip()
                stripped = _CTRL_RE.sub("", body)
                if stripped != body:
                    extra = ["убраны управляющие символы"]
                    body = stripped
            else:
                body, extra = repair(text)
            try:
                root = ET.fromstring(body)
            except ET.ParseError:
                continue
            if enc != "utf-8":
                notes.append(f"кодировка определена как {enc}")
            notes.extend(extra)
            return root, notes, images

    raise ValueError("не удалось разобрать XML: файл повреждён или это не FB2")


def text_of(el: ET.Element) -> str:
    """Плоский текст элемента вместе с вложенной разметкой."""
    parts = []
    if el.text:
        parts.append(el.text)
    for child in el:
        if local(child.tag) != "image":
            parts.append(text_of(child))
        if child.tail:
            parts.append(child.tail)
    return re.sub(r"\s+", " ", "".join(parts)).strip()


# теги начертания: слева FB2, справа XHTML из EPUB
_INLINE_STYLE = {"emphasis": "em", "strong": "strong", "code": "strong",
                 "em": "em", "i": "em", "cite": "em", "var": "em",
                 "b": "strong", "mark": "strong"}


class _Runs:
    """Собирает текст абзаца вместе с разметкой и ссылками."""

    def __init__(self):
        self.parts = []
        self.length = 0
        self.spans = []          # (начало, конец, вид) — курсив, полужирный
        self.marks = []          # (начало, конец, id цели) — сноски

    def add(self, raw):
        if not raw:
            return
        chunk = re.sub(r"\s+", " ", raw)
        tail_space = self.length == 0 or self.parts[-1].endswith(" ")
        if chunk.startswith(" ") and tail_space:
            chunk = chunk[1:]
        if not chunk:
            return
        self.parts.append(chunk)
        self.length += len(chunk)

    def result(self):
        text = "".join(self.parts).rstrip()
        limit = len(text)
        spans = tuple((a, min(b, limit), k) for a, b, k in self.spans if a < limit)
        refs = [(text[a:min(b, limit)], target)
                for a, b, target in self.marks if a < limit and text[a:b].strip()]
        return text, refs, spans


def inline_runs(el, resolve=None):
    """Текст элемента, ссылки на сноски и разметка курсива/полужирного.

    resolve — как превратить href в ключ якоря; для FB2 достаточно
    отбросить решётку, в EPUB ссылка может вести в соседний файл.
    """
    runs = _Runs()

    def rec(node):
        if node.text:
            runs.add(node.text)
        for child in node:
            tag = local(child.tag)
            start = runs.length
            if tag == "image":
                pass
            elif tag == "a":
                href = next((v for k, v in child.attrib.items()
                             if local(k) == "href"), "")
                rec(child)
                target = (resolve(href) if resolve
                          else (href[1:] if href.startswith("#") else None))
                if target and runs.length > start:
                    runs.marks.append((start, runs.length, target))
            else:
                rec(child)
                kind = _INLINE_STYLE.get(tag)
                if kind and runs.length > start:
                    runs.spans.append((start, runs.length, kind))
            if child.tail:
                runs.add(child.tail)

    rec(el)
    return runs.result()


def text_and_refs(el):
    """Текст элемента и найденные в нём ссылки: [(маркер, id цели)]."""
    refs = []

    def rec(node):
        parts = []
        if node.text:
            parts.append(node.text)
        for child in node:
            tag = local(child.tag)
            if tag == "image":
                pass
            elif tag == "a":
                inner = text_of(child)
                href = next((v for k, v in child.attrib.items()
                             if local(k) == "href"), "")
                if href.startswith("#") and inner:
                    refs.append((inner, href[1:]))
                parts.append(inner)
            else:
                parts.append(rec(child))
            if child.tail:
                parts.append(child.tail)
        return "".join(parts)

    return re.sub(r"\s+", " ", rec(el)).strip(), refs


class Block:
    __slots__ = ("kind", "text", "level", "refs", "spans", "src")

    def __init__(self, kind, text, level=0, refs=(), spans=(), src=""):
        self.kind = kind
        self.text = text
        self.level = level
        self.refs = list(refs)      # [(маркер, id цели), ...] — сноски абзаца
        self.spans = tuple(spans)   # [(начало, конец, вид), ...] — начертание
        self.src = src              # где лежит картинка (id в FB2, путь в EPUB)


def is_epub(path):
    """EPUB — это zip с META-INF/container.xml внутри."""
    if not zipfile.is_zipfile(path):
        return False
    try:
        with zipfile.ZipFile(path) as z:
            return "META-INF/container.xml" in z.namelist()
    except (zipfile.BadZipFile, OSError):
        return False


# --------------------------------------------------------------- EPUB

XHTML_SKIP = {"head", "script", "style", "title", "meta", "link", "svg"}
XHTML_HEADINGS = {"h1": 0, "h2": 1, "h3": 2, "h4": 3, "h5": 4, "h6": 5}
XHTML_PARAGRAPHS = {"p", "dd", "dt", "pre", "figcaption", "td", "th",
                    "caption", "address"}
XHTML_BREAKS = {"section", "article", "div", "figure", "table", "aside"}


def epub_path(base, href):
    """Приводит ссылку внутри книги к пути от корня архива."""
    href = urllib.parse.unquote(href.split("#")[0])
    if not href:
        return base
    return posixpath.normpath(posixpath.join(base, href)).lstrip("./")


def _epub_key(doc, href):
    """Ключ якоря: путь к файлу плюс идентификатор внутри него."""
    anchor = href.split("#", 1)[1] if "#" in href else ""
    if href.startswith("#"):
        target = doc
    else:
        target = epub_path(posixpath.dirname(doc), href)
    return f"{target}#{anchor}" if anchor else target


class _EpubMixin:
    """Разбор EPUB в те же блоки, что и FB2."""

    def _load_epub(self, path):
        with zipfile.ZipFile(path) as z:
            container = self._epub_xml(z, "META-INF/container.xml")
            opf_name = next((el.get("full-path") for el in container.iter()
                             if local(el.tag) == "rootfile" and el.get("full-path")),
                            None)
            if not opf_name:
                raise ValueError("в EPUB не указан файл описания")
            opf = self._epub_xml(z, opf_name)
            base = posixpath.dirname(opf_name)

            manifest, spine = {}, []
            for el in opf.iter():
                tag = local(el.tag)
                if tag == "item" and el.get("id"):
                    manifest[el.get("id")] = {
                        "href": epub_path(base, el.get("href", "")),
                        "type": el.get("media-type", ""),
                        "props": el.get("properties", "") or "",
                    }
                elif tag == "itemref" and el.get("idref"):
                    spine.append(el.get("idref"))

            self._epub_meta(opf)

            documents = [manifest[i]["href"] for i in spine
                         if i in manifest and "html" in manifest[i]["type"]]
            if not documents:
                raise ValueError("в EPUB нет текстовых документов")
            for doc in documents:
                self._epub_document(z, doc)
            self._epub_toc(z, manifest)

    # --- служебное --------------------------------------------------------
    def _epub_xml(self, z, name):
        try:
            data = z.read(name)
        except KeyError:
            raise ValueError(f"в EPUB нет файла {name}")
        root, notes, _ = parse_xml(data)
        self.repairs.extend(notes)
        return root

    def _epub_meta(self, opf):
        for el in opf.iter():
            tag = local(el.tag)
            if tag == "title" and not self.title:
                self.title = text_of(el)
            elif tag == "creator" and not self.author:
                self.author = text_of(el)
            elif tag == "meta":
                name, prop = el.get("name", ""), el.get("property", "")
                if name == "calibre:series" and not self.series:
                    self.series = el.get("content", "")
                elif prop == "belongs-to-collection" and not self.series:
                    self.series = text_of(el)

    # --- один документ книги ---------------------------------------------
    def _epub_document(self, z, doc):
        try:
            root = self._epub_xml(z, doc)
        except ValueError:
            return
        self.anchors.setdefault(doc, len(self.blocks))
        body = next((el for el in root.iter() if local(el.tag).lower() == "body"),
                    root)
        self._level = 1
        self._xhtml(body, doc)
        self._add("empty")

    def _paragraph(self, el, doc, kind="p", prefix=""):
        text, refs, spans = inline_runs(el, lambda h: _epub_key(doc, h))
        if not text:
            return None
        if prefix:
            shift = len(prefix)
            text = prefix + text
            spans = tuple((a + shift, b + shift, k) for a, b, k in spans)
        return self._add(kind, text, refs, spans)

    def _xhtml(self, el, doc):
        tag = local(el.tag).lower()
        if tag in XHTML_SKIP:
            return
        node_id = el.get("id")
        if node_id:
            self.anchors.setdefault(f"{doc}#{node_id}", len(self.blocks))

        if tag in XHTML_HEADINGS:
            index = self._paragraph(el, doc, "title")
            if index is not None:
                self.toc.append((XHTML_HEADINGS[tag], self.blocks[index].text,
                                 index))
        elif tag in XHTML_PARAGRAPHS:
            self._paragraph(el, doc)
        elif tag == "blockquote":
            self._style.append("cite")
            self._add("empty")
            for child in el:
                self._xhtml(child, doc)
            self._style.pop()
            self._add("empty")
        elif tag in ("ul", "ol"):
            number = 0
            for child in el:
                if local(child.tag).lower() == "li":
                    number += 1
                    prefix = f"{number}. " if tag == "ol" else "• "
                    self._paragraph(child, doc, prefix=prefix)
                else:
                    self._xhtml(child, doc)
            self._add("empty")
        elif tag == "hr":
            self._add("empty")
        elif tag in ("img", "image"):
            src = el.get("src") or next(
                (v for k, v in el.attrib.items() if local(k) == "href"), "")
            target = epub_path(posixpath.dirname(doc), src) if src else ""
            alt = (el.get("alt") or "").strip()
            self._add("image", f"[ {alt} ]" if alt else "[ иллюстрация ]",
                      src=target)
        elif tag == "br":
            return
        elif tag == "div" and not self._has_blocks(el):
            self._paragraph(el, doc)
        else:
            for child in el:
                self._xhtml(child, doc)
            if tag in XHTML_BREAKS:
                self._add("empty")

    @staticmethod
    def _has_blocks(el):
        """Есть ли внутри блочные элементы — или это просто абзац в div."""
        block = (set(XHTML_PARAGRAPHS) | set(XHTML_HEADINGS) | XHTML_BREAKS |
                 {"blockquote", "ul", "ol", "hr", "dl"})
        return any(local(child.tag).lower() in block for child in el.iter()
                   if child is not el)

    # --- оглавление -------------------------------------------------------
    def _epub_toc(self, z, manifest):
        entries = []
        nav = next((i["href"] for i in manifest.values() if "nav" in i["props"]),
                   None)
        if nav:
            entries = self._toc_from_nav(z, nav)
        if not entries:
            ncx = next((i["href"] for i in manifest.values()
                        if i["type"] == "application/x-dtbncx+xml"), None)
            if ncx:
                entries = self._toc_from_ncx(z, ncx)
        resolved = []
        for level, title, key in entries:
            index = self.anchors.get(key)
            if index is None and "#" in key:
                index = self.anchors.get(key.split("#")[0])
            if index is not None and title:
                resolved.append((level, title, index))
        if len(resolved) >= 2:
            resolved.sort(key=lambda item: item[2])
            self.toc = resolved

    def _toc_from_nav(self, z, nav_doc):
        try:
            root = self._epub_xml(z, nav_doc)
        except ValueError:
            return []
        navs = [el for el in root.iter() if local(el.tag).lower() == "nav"]
        chosen = next((n for n in navs
                       if any(local(k) == "type" and v == "toc"
                              for k, v in n.attrib.items())), None)
        if chosen is None and navs:
            chosen = navs[0]
        if chosen is None:
            return []

        entries = []

        def walk(node, level):
            for child in node:
                tag = local(child.tag).lower()
                if tag == "li":
                    link = next((e for e in child.iter()
                                 if local(e.tag).lower() == "a"), None)
                    if link is not None:
                        href = link.get("href", "")
                        if href:
                            entries.append((level, text_of(link),
                                            _epub_key(nav_doc, href)))
                    for sub in child:
                        if local(sub.tag).lower() in ("ol", "ul"):
                            walk(sub, level + 1)
                elif tag in ("ol", "ul"):
                    walk(child, level)

        walk(chosen, 0)
        return entries

    def _toc_from_ncx(self, z, ncx_doc):
        try:
            root = self._epub_xml(z, ncx_doc)
        except ValueError:
            return []
        entries = []

        def walk(node, level):
            for child in node:
                if local(child.tag) != "navPoint":
                    continue
                label = next((text_of(e) for e in child.iter()
                              if local(e.tag) == "text"), "")
                content = next((e.get("src", "") for e in child.iter()
                                if local(e.tag) == "content"), "")
                if content:
                    entries.append((level, label, _epub_key(ncx_doc, content)))
                walk(child, level + 1)

        nav_map = next((el for el in root.iter() if local(el.tag) == "navMap"),
                       root)
        walk(nav_map, 0)
        return entries


class Book(_EpubMixin):
    def __init__(self, path: str):
        self.path = os.path.abspath(path)
        self.title = self.author = self.series = ""
        self.repairs = []
        self.blocks = []
        self.toc = []          # (уровень, заголовок, номер блока)
        self.anchors = {}      # ссылка -> номер блока (цели сносок)
        self._level = 0
        self._style = []
        self._images = {}      # id вложения -> где искать данные в файле

        if is_epub(path):
            self.format = "EPUB"
            self._load_epub(path)
        else:
            self.format = "FB2"
            self._load_fb2(path)

        # одни и те же правки в нескольких файлах книги не повторяем
        seen = []
        for note in self.repairs:
            if note not in seen:
                seen.append(note)
        self.repairs = seen

        if not self.blocks:
            raise ValueError("в файле не найдено текста книги")
        if not self.title:
            self.title = os.path.basename(self.path)

    def image_data(self, src):
        """Байты картинки и её тип; читаются только в момент показа."""
        if not src:
            return None, ""
        if self.format == "EPUB":
            try:
                with zipfile.ZipFile(self.path) as z:
                    return z.read(src), mimetypes.guess_type(src)[0] or ""
            except (KeyError, OSError, zipfile.BadZipFile):
                return None, ""
        spot = self._images.get(src)
        if not spot:
            return None, ""
        try:
            raw = read_source(self.path)[spot["start"]:spot["end"]]
            return base64.b64decode(raw, validate=False), spot["type"]
        except (OSError, ValueError, zipfile.BadZipFile):
            return None, ""

    def _load_fb2(self, path):
        root, self.repairs, self._images = parse_xml(read_source(path))
        self.title, self.author, self.series = self._meta(root)
        self._parse_bodies(root)

    # --- метаданные -------------------------------------------------------
    def _meta(self, root):
        title = author = series = ""
        for desc in root.iter():
            if local(desc.tag) != "title-info":
                continue
            for el in desc:
                tag = local(el.tag)
                if tag == "book-title" and not title:
                    title = text_of(el)
                elif tag == "author" and not author:
                    names = [
                        text_of(p) for p in el
                        if local(p.tag) in
                        ("first-name", "middle-name", "last-name", "nickname")
                    ]
                    author = " ".join(n for n in names if n)
                elif tag == "sequence" and not series:
                    name, num = el.get("name", ""), el.get("number", "")
                    series = f"{name} #{num}".strip() if name else ""
            break
        return title, author, series

    # --- тело книги -------------------------------------------------------
    def _add(self, kind, text="", refs=(), spans=(), src=""):
        if self._style and kind in ("p", "v"):
            kind = self._style[-1]
        self.blocks.append(Block(kind, text, self._level, refs, spans, src))
        return len(self.blocks) - 1

    def _parse_bodies(self, root):
        bodies = [el for el in root if local(el.tag) == "body"]
        if not bodies:
            bodies = [el for el in root.iter() if local(el.tag) == "body"]
        for i, body in enumerate(bodies):
            if i and not any(local(c.tag) == "title" for c in body):
                raw = (body.get("name") or "notes").lower()
                name = {"notes": "Примечания",
                        "comments": "Комментарии"}.get(raw, raw.capitalize())
                idx = self._add("title", name)
                self.toc.append((0, name, idx))
            self._walk(body)

    def _walk(self, el):
        tag = local(el.tag)
        eid = el.get("id")
        if eid:
            self.anchors.setdefault(eid, len(self.blocks))

        if tag in ("body", "section"):
            if tag == "section":
                self._level += 1
            for child in el:
                self._walk(child)
            if tag == "section":
                self._level -= 1
                self._add("empty")

        elif tag == "title":
            lines = [t for t in (text_of(p) for p in el) if t]
            if lines:
                idx = self._add("title", "\n".join(lines))
                self.toc.append((max(self._level - 1, 0), " ".join(lines), idx))

        elif tag == "subtitle":
            text, refs, spans = inline_runs(el)
            self._add("subtitle", text, refs, spans)

        elif tag == "p":
            text, refs, spans = inline_runs(el)
            self._add("p", text, refs, spans)

        elif tag == "empty-line":
            self._add("empty")

        elif tag in ("cite", "epigraph", "annotation"):
            self._style.append("cite")
            self._add("empty")
            for child in el:
                self._walk(child)
            self._style.pop()
            self._add("empty")

        elif tag == "poem":
            self._add("empty")
            for child in el:
                self._walk(child)
            self._add("empty")

        elif tag == "stanza":
            for child in el:
                self._walk(child)
            self._add("empty")

        elif tag == "v":
            text, refs, spans = inline_runs(el)
            self._add("v", text, refs, spans)

        elif tag == "text-author":
            self._add("author", text_of(el))

        elif tag == "image":
            href = next((v for k, v in el.attrib.items()
                         if local(k) == "href"), "")
            self._add("image", "[ иллюстрация ]", src=href.lstrip("#"))

        elif tag == "table":
            for row in el:
                self._add("p", "  |  ".join(text_of(c) for c in row))

        elif tag in ("binary", "description"):
            return

        else:
            for child in el:
                self._walk(child)


# ------------------------------------------------------------------ поиск

def normalize(text):
    """Приводит текст к виду для поиска, сохраняя длину строки.

    Регистр не важен, ё и е считаются одной буквой — иначе половина
    книг ищется не так, как их набирали. Длина не меняется, поэтому
    смещения совпадений остаются пригодными для исходного текста.
    """
    lowered = "".join(ch.lower() if len(ch.lower()) == 1 else ch for ch in text)
    return lowered.replace("ё", "е")


def find_matches(blocks, query):
    """Все совпадения в книге: [(номер блока, смещение), ...]."""
    needle = normalize(query.strip())
    if not needle:
        return []
    found = []
    for index, block in enumerate(blocks):
        if not block.text:
            continue
        hay = normalize(block.text)
        at = hay.find(needle)
        while at >= 0:
            found.append((index, at))
            at = hay.find(needle, at + len(needle))
    return found


def match_context(block, offset, length, width=64):
    """Кусочек текста вокруг совпадения — для списка результатов."""
    text = block.text
    start = max(offset - width // 3, 0)
    end = min(start + width, len(text))
    piece = text[start:end].strip()
    return ("…" if start else "") + piece + ("…" if end < len(text) else "")


# ------------------------------------------------------------------ вёрстка

STYLE = {
    "title":    dict(indent=0, first=0, center=True,  attr="title", before=2, after=1),
    "subtitle": dict(indent=0, first=0, center=True,  attr="sub",   before=1, after=1),
    "p":        dict(indent=0, first=3, center=False, attr="text",  before=0, after=0),
    "cite":     dict(indent=4, first=4, center=False, attr="dim",   before=0, after=0),
    "v":        dict(indent=6, first=4, center=False, attr="dim",   before=0, after=0),
    "author":   dict(indent=6, first=6, center=False, attr="dim",   before=0, after=1),
    "image":    dict(indent=0, first=0, center=True,  attr="dim",   before=1, after=1),
}


def char_width(ch):
    """Сколько знакомест занимает символ в терминале."""
    if unicodedata.combining(ch) or ch in "\u200b\u200c\u200d\ufeff\ufe0f":
        return 0
    return 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1


def str_width(text):
    return sum(char_width(c) for c in text)


def cut_to_width(text, width):
    """Обрезает строку так, чтобы она заняла не больше width знакомест."""
    if width <= 0:
        return ""
    total, out = 0, []
    for ch in text:
        w = char_width(ch)
        if total + w > width:
            break
        out.append(ch)
        total += w
    return "".join(out)


def _push_word(lines, text, start, end, budget):
    """Кладёт слово, разрезая его, если оно шире строки.

    budget — функция, возвращающая доступную ширину для текущей строки
    (у первой строки абзаца отступ свой, поэтому и ширина своя).
    Возвращает (начало, конец, ширина) хвоста, с которого пойдёт строка.
    """
    w = str_width(text[start:end])
    while w > budget():
        head = cut_to_width(text[start:end], budget())
        if not head:
            break
        lines.append((head, start))
        start += len(head)
        w = str_width(text[start:end])
    return start, end, w


def wrap_words(text, width, first_width=None):
    """Перенос по словам с учётом реальной ширины символов.

    Возвращает [(строка, смещение в исходном тексте)]; строки — точные
    срезы исходного текста, поэтому по ним можно восстановить разметку.
    """
    width = max(width, 1)
    first = max(width if first_width is None else first_width, 1)
    lines = []

    def budget():
        return first if not lines else width

    cs = ce = None
    cw = 0
    for m in re.finditer(r"\S+", text):
        if cs is None:
            cs, ce, cw = _push_word(lines, text, m.start(), m.end(), budget)
            if cs >= ce:
                cs = None
            continue
        # промежуток между словами не обязан быть одним пробелом
        grow = str_width(text[ce:m.end()])
        if cw + grow <= budget():
            ce, cw = m.end(), cw + grow
        else:
            lines.append((text[cs:ce], cs))
            cs, ce, cw = _push_word(lines, text, m.start(), m.end(), budget)
            if cs >= ce:
                cs = None
    if cs is not None and ce > cs:
        lines.append((text[cs:ce], cs))
    return lines


def _line_styles(spans, base, chunk, offset, column):
    """Переводит разметку абзаца в отрезки внутри готовой строки."""
    if not spans:
        return ()
    start, end = base + offset, base + offset + len(chunk)
    out = []
    for s_start, s_end, kind in spans:
        lo, hi = max(s_start, start), min(s_end, end)
        if lo >= hi:
            continue
        local = lo - start
        fragment = chunk[local:hi - start]
        if fragment.strip():
            out.append((column + str_width(chunk[:local]), fragment, kind))
    return tuple(out)


def layout(blocks, width, spacing=1):
    """Раскладывает блоки в строки: (текст, атрибут, номер блока).

    spacing — межстрочный интервал (1 — обычный, 2 — двойной и т. д.);
    полезен при крупном шрифте терминала, когда строк на экране мало.
    """
    out = []
    width = max(width, 20)
    for i, b in enumerate(blocks):
        if b.kind == "empty":
            if out and out[-1][0].strip():
                out.append(("", "text", i, ()))
            continue
        st = STYLE.get(b.kind, STYLE["p"])
        for _ in range(st["before"]):
            if out and out[-1][0].strip():
                out.append(("", st["attr"], i, ()))

        base = 0
        for para in b.text.split("\n"):
            if not para:
                base += 1
                continue
            if st["center"]:
                for chunk, offset in wrap_words(para, width) or [("", 0)]:
                    pad = max((width - str_width(chunk)) // 2, 0)
                    out.append((" " * pad + chunk, st["attr"], i,
                                _line_styles(b.spans, base, chunk, offset, pad)))
            else:
                chunks = wrap_words(para, width - st["indent"],
                                    width - st["first"]) or [("", 0)]
                for n, (chunk, offset) in enumerate(chunks):
                    pad = st["first"] if n == 0 else st["indent"]
                    out.append((" " * pad + chunk, st["attr"], i,
                                _line_styles(b.spans, base, chunk, offset, pad)))
            base += len(para) + 1

        for _ in range(st["after"]):
            out.append(("", st["attr"], i, ()))

    while out and not out[-1][0].strip():
        out.pop()
    if spacing > 1:
        spaced = []
        for line in out:
            spaced.append(line)
            if line[0].strip():
                spaced.extend(("", line[1], line[2], ())
                              for _ in range(spacing - 1))
        out = spaced
    return out


# --------------------------------------------------------- позиция чтения

def state_file():
    base = os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
    d = os.path.join(base, APP)
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, "positions.json")


def book_key(path):
    try:
        size = os.path.getsize(path)
    except OSError:
        size = 0
    return hashlib.sha1(f"{os.path.abspath(path)}:{size}".encode()).hexdigest()[:16]


def load_pos(path):
    entry = _read_state().get(book_key(path))
    try:
        return int(entry.get("block", 0)) if isinstance(entry, dict) else 0
    except (TypeError, ValueError):
        return 0


def _read_state():
    try:
        with open(state_file(), encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_state(data):
    try:
        with open(state_file(), "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
    except OSError:
        pass


def save_pos(path, block, title, total=0, author=""):
    data = _read_state()
    entry = data.get(book_key(path))
    marks = entry.get("bookmarks", []) if isinstance(entry, dict) else []
    data[book_key(path)] = {"block": block, "title": title, "total": total,
                            "author": author, "path": os.path.abspath(path),
                            "at": time.time(), "bookmarks": marks}
    _write_state(data)


def load_bookmarks(path):
    """Закладки книги: [{"block": …, "name": …, "text": …}, …]."""
    entry = _read_state().get(book_key(path))
    marks = entry.get("bookmarks", []) if isinstance(entry, dict) else []
    return [m for m in marks if isinstance(m, dict) and "block" in m]


def save_bookmarks(path, marks, title="", total=0, author=""):
    data = _read_state()
    entry = data.get(book_key(path))
    if not isinstance(entry, dict):
        entry = {"block": 0, "title": title, "total": total, "author": author,
                 "path": os.path.abspath(path), "at": time.time()}
    entry["bookmarks"] = sorted(marks, key=lambda m: m["block"])
    data[book_key(path)] = entry
    _write_state(data)


# ---------------------------------------------------------------- конфиг

CONFIG_SAMPLE = """# Настройки fb2read. Значения отсюда сильнее того, что
# читалка запомнила сама, но слабее ключей командной строки.

[reader]
# width = 80          ширина текстовой колонки
# spacing = 1         межстрочный интервал: 1, 2 или 3
# columns = 1         1 — одна колонка, 2 — книжный разворот
# theme = auto        auto, night, sepia, day
# images = auto       auto, kitty, iterm, chafa, sixel, off
# mouse = yes         захватывать ли мышь

[keys]
# Клавиши через запятую. Понимаются одиночные символы, имена
# space, enter, backspace, tab, esc, delete, up, down, left, right,
# pgup, pgdn, home, end и сочетания вида ctrl-l.
{actions}
"""


def config_file():
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    return os.path.join(base, APP, "config.ini")


def load_config(path=None):
    """Читает файл настроек. Возвращает (настройки, клавиши, замечания)."""
    path = path or config_file()
    parser = configparser.ConfigParser(interpolation=None)
    notes = []
    if not os.path.exists(path):
        return {}, {}, notes
    try:
        parser.read(path, encoding="utf-8")
    except (configparser.Error, OSError) as error:
        return {}, {}, [f"конфиг не прочитан: {error}"]

    prefs = {}
    reader = parser["reader"] if parser.has_section("reader") else {}
    for name in ("width", "spacing", "columns"):
        if name in reader:
            try:
                prefs[name] = int(reader[name])
            except ValueError:
                notes.append(f"в конфиге неверное значение {name}")
    for name, allowed in (("theme", THEME_ORDER), ("images", IMAGE_BACKENDS)):
        if name in reader:
            value = reader[name].strip()
            if value in allowed:
                prefs[name] = value
            else:
                notes.append(f"в конфиге неизвестное значение {name}={value}")
    if "mouse" in reader:
        try:
            prefs["mouse"] = parser.getboolean("reader", "mouse")
        except ValueError:
            notes.append("в конфиге mouse должно быть yes или no")

    keys = dict(parser["keys"]) if parser.has_section("keys") else {}
    return prefs, keys, notes


def write_config(path=None):
    """Кладёт образец конфига со всеми действиями."""
    path = path or config_file()
    lines = [f"# {action} = {', '.join(default)}"
             for action, _, default in ACTIONS]
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(CONFIG_SAMPLE.format(actions="\n".join(lines)))
    except OSError as error:
        return f"не удалось записать {path}: {error}"
    return f"образец настроек записан: {path}"


# ------------------------------------------------------------ библиотека

BOOK_SUFFIXES = (".fb2", ".fb2.zip", ".fbz", ".epub")
_TITLE_RE = re.compile(r"<book-title[^>]*>(.*?)</book-title>", re.S)
_AUTHOR_RE = re.compile(r"<author>(.*?)</author>", re.S)
_NAME_RE = re.compile(r"<(first-name|middle-name|last-name|nickname)[^>]*>"
                      r"(.*?)</\1>", re.S)
_ENC_RE = re.compile(rb"encoding=[\"']([\w-]+)[\"']")


def epub_meta(path):
    """Автор и название из описания EPUB, без разбора всей книги."""
    try:
        with zipfile.ZipFile(path) as z:
            container, _, _ = parse_xml(z.read("META-INF/container.xml"))
            opf_name = next(el.get("full-path") for el in container.iter()
                            if local(el.tag) == "rootfile" and el.get("full-path"))
            opf, _, _ = parse_xml(z.read(opf_name))
    except (OSError, KeyError, ValueError, StopIteration,
            zipfile.BadZipFile, ET.ParseError):
        return "", ""
    title = author = ""
    for el in opf.iter():
        tag = local(el.tag)
        if tag == "title" and not title:
            title = text_of(el)
        elif tag == "creator" and not author:
            author = text_of(el)
    return title, author


def quick_meta(path):
    """Быстро достаёт автора и название, не разбирая книгу целиком."""
    if path.lower().endswith(".epub") or is_epub(path):
        return epub_meta(path)
    try:
        if zipfile.is_zipfile(path):
            head = read_source(path)[:300_000]
        else:
            with open(path, "rb") as f:
                head = f.read(300_000)
    except (OSError, ValueError, zipfile.BadZipFile):
        return "", ""
    match = _ENC_RE.search(head[:200])
    encodings = [match.group(1).decode("ascii", "replace")] if match else []
    encodings += ["utf-8", "cp1251"]
    text = ""
    for enc in encodings:
        try:
            text = head.decode(enc, "replace")
            break
        except (LookupError, UnicodeError):
            continue
    title = _TITLE_RE.search(text)
    title = re.sub(r"\s+", " ", title.group(1)).strip() if title else ""
    author = ""
    found = _AUTHOR_RE.search(text)
    if found:
        parts = [re.sub(r"\s+", " ", m.group(2)).strip()
                 for m in _NAME_RE.finditer(found.group(1))]
        author = " ".join(p for p in parts if p)
    return title, author


def recent_books():
    """Недавно читанные книги с прогрессом, самые свежие сверху."""
    entries = []
    for key, value in _read_state().items():
        if key == "__settings__" or not isinstance(value, dict):
            continue
        path = value.get("path", "")
        if not path or not os.path.exists(path):
            continue
        entries.append({
            "path": path,
            "title": value.get("title") or os.path.basename(path),
            "author": value.get("author", ""),
            "percent": progress_percent(value.get("block", 0), value.get("total", 0)),
            "at": value.get("at", 0),
        })
    entries.sort(key=lambda e: e["at"], reverse=True)
    return entries


def scan_dir(path):
    """Книги в каталоге с подтянутым прогрессом чтения."""
    progress = {e["path"]: e["percent"] for e in recent_books()}
    entries = []
    for name in sorted(os.listdir(path)):
        full = os.path.join(path, name)
        if not os.path.isfile(full) or not name.lower().endswith(BOOK_SUFFIXES):
            continue
        title, author = quick_meta(full)
        entries.append({
            "path": full,
            "title": title or name,
            "author": author,
            "percent": progress.get(os.path.abspath(full)),
            "at": os.path.getmtime(full),
        })
    return entries


def plural(n, one, few, many):
    """Русское склонение: 1 книга, 2 книги, 5 книг."""
    if n % 10 == 1 and n % 100 != 11:
        word = one
    elif 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        word = few
    else:
        word = many
    return f"{n} {word}"


def progress_percent(block, total):
    if not total:
        return None
    return max(0, min(100, round(100 * block / max(total - 1, 1))))


def choose_book(scr, entries, theme, mouse=True):
    """Экран выбора книги. Возвращает путь или None."""
    apply_theme(scr, theme)
    enable_mouse(mouse)
    try:
        curses.curs_set(0)
    except curses.error:
        pass
    cur = top = 0
    while True:
        scr.erase()
        rows, cols = scr.getmaxyx()
        view = max(rows - 3, 1)
        top = max(0, min(top, max(len(entries) - view, 0)))
        if cur < top:
            top = cur
        elif cur >= top + view:
            top = cur - view + 1

        title = f" Библиотека — {plural(len(entries), 'книга', 'книги', 'книг')} "
        scr.attron(curses.color_pair(PAIR_HEADER) | curses.A_BOLD)
        scr.addnstr(0, 0, title + " " * max(cols - str_width(title), 0), cols - 1)
        scr.attroff(curses.color_pair(PAIR_HEADER) | curses.A_BOLD)

        for i in range(view):
            j = top + i
            if j >= len(entries):
                break
            e = entries[j]
            mark = "%3d%%" % e["percent"] if e["percent"] is not None else "  · "
            name = f"{e['author']} — {e['title']}" if e["author"] else e["title"]
            row = f" {mark}  {name}"
            row = cut_to_width(row, cols - 2)
            row += " " * max(cols - 2 - str_width(row), 0)
            scr.addnstr(i + 1, 0, row, cols - 1,
                        curses.A_REVERSE if j == cur else entry_attr(e))
        hint = " Enter или клик — читать,  q — выход "
        scr.attron(curses.A_DIM | curses.color_pair(PAIR_DIM))
        scr.addnstr(rows - 1, 0, hint[: cols - 1], cols - 1)
        scr.attroff(curses.A_DIM | curses.color_pair(PAIR_DIM))
        scr.refresh()

        ch = scr.getch()
        if ch in (ord("q"), ord("Q"), 27):
            return None
        elif ch == 12:                          # Ctrl+L
            scr.clearok(True)
        elif ch == curses.KEY_MOUSE:
            try:
                _, _, my, _, state = curses.getmouse()
            except curses.error:
                continue
            if state & WHEEL_UP:
                cur = max(cur - 1, 0)
            elif state & WHEEL_DOWN:
                cur = min(cur + 1, len(entries) - 1)
            elif state & CLICK and 1 <= my <= view:
                picked = top + my - 1
                if picked < len(entries):
                    return entries[picked]["path"]
        elif ch in (curses.KEY_DOWN, ord("j")):
            cur = min(cur + 1, len(entries) - 1)
        elif ch in (curses.KEY_UP, ord("k")):
            cur = max(cur - 1, 0)
        elif ch == curses.KEY_NPAGE:
            cur = min(cur + view, len(entries) - 1)
        elif ch == curses.KEY_PPAGE:
            cur = max(cur - view, 0)
        elif ch in (curses.KEY_HOME, ord("g")):
            cur = 0
        elif ch in (curses.KEY_END, ord("G")):
            cur = len(entries) - 1
        elif ch in (curses.KEY_ENTER, 10, 13):
            return entries[cur]["path"]


def entry_attr(entry):
    """Дочитанные книги показываем приглушённо."""
    if entry["percent"] is not None and entry["percent"] >= 99:
        return curses.A_DIM | curses.color_pair(PAIR_DIM)
    return curses.color_pair(PAIR_TEXT)


def _write_raw(payload):
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()


# ------------------------------------------------------------------ мышь

WHEEL_UP = curses.BUTTON4_PRESSED
WHEEL_DOWN = getattr(curses, "BUTTON5_PRESSED", 0x200000)
CLICK = curses.BUTTON1_CLICKED | curses.BUTTON1_PRESSED
BACK_CLICK = curses.BUTTON3_CLICKED | curses.BUTTON3_PRESSED
MOUSE_MASK = curses.ALL_MOUSE_EVENTS


def enable_mouse(on):
    """Включает или отпускает мышь.

    Пока мышь захвачена, терминал отдаёт клики программе, и выделить
    текст мышью нельзя (в большинстве терминалов помогает Shift).
    Поэтому захват всегда можно снять клавишей m.
    """
    try:
        curses.mousemask(MOUSE_MASK if on else 0)
        # SGR-репорты: без них координаты за 223-й колонкой не приходят
        _write_raw(b"\x1b[?1006h" if on else b"\x1b[?1006l")
    except (curses.error, OSError):
        return False
    return True


# ------------------------------------------------------------- картинки

IMAGE_BACKENDS = ("auto", "kitty", "iterm", "chafa", "sixel", "off")


def wait_for_key():
    """Ждёт нажатия, пока curses выключен."""
    try:
        import termios
        import tty
        saved = termios.tcgetattr(sys.stdin)
        try:
            tty.setcbreak(sys.stdin.fileno())
            os.read(sys.stdin.fileno(), 1)
        finally:
            termios.tcsetattr(sys.stdin, termios.TCSADRAIN, saved)
    except Exception:
        try:
            sys.stdin.readline()
        except Exception:
            pass


def detect_image_backend():
    """Чем этот терминал умеет показывать картинки."""
    term = os.environ.get("TERM", "")
    if os.environ.get("KITTY_WINDOW_ID") or "kitty" in term:
        return "kitty"
    if (os.environ.get("TERM_PROGRAM") in ("iTerm.app", "WezTerm")
            or os.environ.get("WEZTERM_PANE")):
        return "iterm"
    if shutil.which("chafa"):
        return "chafa"
    if shutil.which("img2sixel"):
        return "sixel"
    return ""


def _kitty_image(data, cols, rows):
    """Графический протокол kitty: сами байты PNG, порциями по 4 КБ."""
    if not data.startswith(b"\x89PNG"):
        return False                    # kitty принимает PNG или сырой растр
    payload = base64.standard_b64encode(data)
    chunks = [payload[i:i + 4096] for i in range(0, len(payload), 4096)] or [b""]
    for number, chunk in enumerate(chunks):
        head = (f"a=T,f=100,c={cols},r={rows},m={int(number < len(chunks) - 1)}"
                if number == 0 else f"m={int(number < len(chunks) - 1)}")
        _write_raw(b"\x1b_G" + head.encode() + b";" + chunk + b"\x1b\\")
    return True


def _iterm_image(data, cols, rows):
    """Протокол iTerm2 и WezTerm: файл целиком в OSC 1337."""
    head = (f"1337;File=inline=1;width={cols};height={rows};"
            f"preserveAspectRatio=1;size={len(data)}:")
    _write_raw(b"\x1b]" + head.encode() + base64.standard_b64encode(data)
               + b"\x07")
    return True


def _external_image(command, data, suffix):
    """Показ через внешнюю программу (chafa или img2sixel)."""
    with tempfile.NamedTemporaryFile(suffix=suffix or ".img", delete=False) as tmp:
        tmp.write(data)
        name = tmp.name
    try:
        result = subprocess.run(command + [name], capture_output=True, timeout=20)
        if result.returncode != 0:
            return False
        _write_raw(result.stdout)
        return True
    except (OSError, subprocess.SubprocessError):
        return False
    finally:
        try:
            os.remove(name)
        except OSError:
            pass


def render_image(data, mime, backend, cols, rows):
    """Рисует картинку в текущем терминале. Возвращает, получилось ли."""
    suffix = mimetypes.guess_extension(mime or "") or ".jpg"
    if backend == "kitty" and _kitty_image(data, cols, rows):
        return True
    if backend == "iterm":
        return _iterm_image(data, cols, rows)
    if backend == "sixel":
        return _external_image(["img2sixel", "-w", str(cols * 8)], data, suffix)
    if backend in ("chafa", "kitty", "iterm") and shutil.which("chafa"):
        return _external_image(
            ["chafa", "--clear", "--size", f"{cols}x{rows}"], data, suffix)
    return False


# ---------------------------------------------------------- оформление

# роль -> (цвет текста, цвет фона); -1 — цвет терминала по умолчанию
THEMES = {
    "auto":  dict(text=(-1, -1), title=(curses.COLOR_YELLOW, -1), dim=(-1, -1),
                  header=(curses.COLOR_BLACK, curses.COLOR_CYAN),
                  note=(curses.COLOR_CYAN, -1)),
    "night": dict(text=(250, 233), title=(179, 233), dim=(243, 233),
                  header=(250, 236), note=(109, 233)),
    "sepia": dict(text=(94, 223), title=(52, 223), dim=(138, 223),
                  header=(223, 94), note=(24, 223)),
    "day":   dict(text=(235, 255), title=(24, 255), dim=(245, 255),
                  header=(255, 24), note=(26, 255)),
}
THEME_ORDER = ["auto", "night", "sepia", "day"]

# чем заменить 256-цветные оттенки на бедной палитре
_FALLBACK = {
    233: curses.COLOR_BLACK, 235: curses.COLOR_BLACK, 236: curses.COLOR_BLACK,
    52: curses.COLOR_RED,
    94: curses.COLOR_YELLOW, 138: curses.COLOR_YELLOW, 179: curses.COLOR_YELLOW,
    223: curses.COLOR_WHITE, 243: curses.COLOR_WHITE, 245: curses.COLOR_WHITE,
    250: curses.COLOR_WHITE, 255: curses.COLOR_WHITE,
    24: curses.COLOR_BLUE, 26: curses.COLOR_BLUE, 109: curses.COLOR_CYAN,
}

PAIR_HEADER, PAIR_TITLE, PAIR_TEXT, PAIR_DIM, PAIR_NOTE = 1, 2, 3, 4, 5

# курсив поддерживают не все терминалы, там он превращается в подчёркивание
EMPHASIS = {
    "em": getattr(curses, "A_ITALIC", curses.A_UNDERLINE),
    "strong": curses.A_BOLD,
}


def _color(value):
    if value < 0 or value < 8:
        return value
    if getattr(curses, "COLORS", 8) >= 256:
        return value
    return _FALLBACK.get(value, curses.COLOR_WHITE)


def apply_theme(scr, name):
    """Перенастраивает цветовые пары под выбранную тему."""
    spec = THEMES.get(name, THEMES["auto"])
    try:
        curses.start_color()
        curses.use_default_colors()
        for pair, role in ((PAIR_HEADER, "header"), (PAIR_TITLE, "title"),
                           (PAIR_TEXT, "text"), (PAIR_DIM, "dim"),
                           (PAIR_NOTE, "note")):
            fg, bg = spec[role]
            curses.init_pair(pair, _color(fg), _color(bg))
        scr.bkgd(" ", curses.color_pair(PAIR_TEXT))
    except curses.error:
        pass


def load_settings():
    saved = _read_state().get("__settings__", {})
    return saved if isinstance(saved, dict) else {}


def save_prefs(prefs):
    """Сохраняет настройки, кроме зависящих от терминала и заданных конфигом."""
    skip = {"images", "keys", "width"}
    save_settings(**{k: v for k, v in prefs.items() if k not in skip})


def save_settings(**values):
    data = _read_state()
    current = data.get("__settings__")
    current = current if isinstance(current, dict) else {}
    current.update(values)
    data["__settings__"] = current
    _write_state(data)


# ------------------------------------------------------------ интерфейс

# действие -> (что делает, клавиши по умолчанию). В этом же порядке
# действия показываются в справке и в образце конфига.
ACTIONS = [
    ("line_down",      "строка вниз",                       ["down", "j"]),
    ("line_up",        "строка вверх",                      ["up", "k"]),
    ("page_down",      "страница вперёд (в развороте — обе)",
     ["space", "pgdn", "f", "right"]),
    ("page_up",        "страница назад",                    ["b", "pgup", "left"]),
    ("half_down",      "полстраницы вниз",                  ["d"]),
    ("half_up",        "полстраницы вверх",                 ["u"]),
    ("book_start",     "в начало книги",                    ["g", "home"]),
    ("book_end",       "в конец книги",                     ["G", "end"]),
    ("next_chapter",   "следующая глава",                   ["]"]),
    ("prev_chapter",   "предыдущая глава",                  ["["]),
    ("toc",            "оглавление",                        ["t", "o"]),
    ("note_follow",    "перейти к сноске на экране",        ["enter"]),
    ("note_back",      "вернуться из сноски",               ["backspace"]),
    ("image",          "показать иллюстрацию",              ["p"]),
    ("search",         "поиск по книге",                    ["/"]),
    ("search_next",    "следующее совпадение",              ["n"]),
    ("search_prev",    "предыдущее совпадение",             ["N"]),
    ("match_list",     "список всех совпадений",            ["l"]),
    ("bookmark_add",   "поставить или снять закладку",      ["M"]),
    ("bookmark_list",  "закладки: переход, удаление, экспорт", ["'", '"']),
    ("wider",          "шире колонка",                      ["+", "="]),
    ("narrower",       "уже колонка",                       ["-"]),
    ("spacing",        "межстрочный интервал (1 / 2 / 3)",  ["s"]),
    ("one_column",     "одна колонка",                      ["1"]),
    ("two_columns",    "книжный разворот",                  ["2"]),
    ("toggle_columns", "переключить разворот",              ["v"]),
    ("theme",          "тема: авто, ночь, сепия, день",     ["c"]),
    ("mouse",          "отпустить мышь и вернуть захват",   ["m"]),
    ("info",           "сведения о книге",                  ["i"]),
    ("redraw",         "перерисовать экран",                ["ctrl-l"]),
    ("help",           "эта справка",                       ["?", "h"]),
    ("quit",           "выход (позиция сохраняется)",       ["q", "Q"]),
]

KEY_NAMES = {
    "space": ord(" "), "enter": 10, "return": 10, "tab": 9, "esc": 27,
    "backspace": curses.KEY_BACKSPACE, "delete": curses.KEY_DC,
    "up": curses.KEY_UP, "down": curses.KEY_DOWN,
    "left": curses.KEY_LEFT, "right": curses.KEY_RIGHT,
    "pgup": curses.KEY_PPAGE, "pgdn": curses.KEY_NPAGE,
    "home": curses.KEY_HOME, "end": curses.KEY_END,
}

# один и тот же смысл приходит разными кодами в зависимости от терминала
KEY_ALIASES = {10: (13, curses.KEY_ENTER),
               curses.KEY_BACKSPACE: (127, 8)}


def parse_key(name):
    """Имя клавиши из конфига -> её коды. Пустой список, если имя непонятно."""
    name = name.strip()
    if not name:
        return []
    low = name.lower()
    if low in KEY_NAMES:
        code = KEY_NAMES[low]
    elif low.startswith("ctrl-") and len(low) == 6:
        code = ord(low[5]) & 0x1F
    elif len(name) == 1:
        code = ord(name)
    else:
        return []
    return [code] + list(KEY_ALIASES.get(code, ()))


def build_keymap(overrides=None):
    """Раскладка: код клавиши -> действие. Ещё возвращает привязки и ошибки."""
    overrides = overrides or {}
    keymap, bindings, problems = {}, {}, []
    known = {action for action, _, _ in ACTIONS}
    for action in overrides:
        if action not in known:
            problems.append(f"неизвестное действие в конфиге: {action}")
    for action, _, default in ACTIONS:
        names = default
        if action in overrides:
            names = [part for part in re.split(r"[,\s]+", overrides[action]) if part]
        chosen = []
        for name in names:
            codes = parse_key(name)
            if not codes:
                problems.append(f"непонятная клавиша «{name}» для {action}")
                continue
            chosen.append(name)
            for code in codes:
                keymap.setdefault(code, action)
        bindings[action] = chosen
    return keymap, bindings, problems


def key_title(name):
    """Как клавиша выглядит в справке."""
    pretty = {"space": "Space", "enter": "Enter", "backspace": "Backspace",
              "pgup": "PgUp", "pgdn": "PgDn", "home": "Home", "end": "End",
              "up": "↑", "down": "↓", "left": "←", "right": "→",
              "esc": "Esc", "tab": "Tab"}
    low = name.lower()
    if low in pretty:
        return pretty[low]
    if low.startswith("ctrl-"):
        return "Ctrl+" + name[5:].upper()
    return name


def help_rows(bindings):
    """Справка собирается из действующей раскладки, а не из готовой таблицы."""
    rows = [(" ".join(key_title(k) for k in bindings.get(action, [])), text)
            for action, text, _ in ACTIONS]
    rows += [
        ("", ""),
        ("колесо / клик", "листать, клик по сноске или картинке"),
        ("правая кнопка", "вернуться из сноски"),
        ("", ""),
        ("Размер шрифта", "задаётся терминалом, а не читалкой:"),
        ("", "Ctrl + «+» и Ctrl + «-» в большинстве эмуляторов,"),
        ("", "Ctrl + колесо мыши, в консоли Linux — setfont."),
        ("", "Текст сам переливается под новый размер окна."),
    ]
    return rows


class Reader:
    GUTTER = 5          # ширина «корешка» между страницами разворота
    MIN_COL = 28        # уже этого вторая колонка не имеет смысла

    def __init__(self, stdscr, book, width, start_block, path="", theme="auto",
                 spacing=1, columns=1, images="auto", mouse=True, keys=None):
        self.scr = stdscr
        self.book = book
        self.maxwidth = width
        self.spacing = min(max(int(spacing), 1), 3)
        self.columns = 2 if int(columns) == 2 else 1
        self.eff_columns = 1
        self.images = detect_image_backend() if images == "auto" else images
        self.mouse = bool(mouse)
        self.hotspots = []
        self.path = path or book.path
        self.keymap, self.bindings, self.key_problems = build_keymap(keys)
        self.bookmarks = load_bookmarks(self.path)
        self.marked_blocks = {m["block"] for m in self.bookmarks}
        self._cache = {}                # (ширина, интервал) -> готовые строки
        self.theme = theme if theme in THEMES else "auto"
        self.jump_stack = []            # позиции, куда вернуться из сносок
        self.top = 0
        self.lines = []
        self.query = ""
        self.matches = []
        self.match = -1
        self.message = ("файл открыт с исправлениями, подробности по i"
                        if book.repairs else "")
        self.width = width
        self.margin = 0
        apply_theme(self.scr, self.theme)
        enable_mouse(self.mouse)
        self.relayout()
        if self.columns == 2 and self.eff_columns == 1:
            self.message = "для разворота нужно окно шире — пока одна колонка"
        self.goto_block(start_block)

    # --- служебное --------------------------------------------------------
    @property
    def height(self):
        """Высота одной страницы в строках."""
        return max(self.scr.getmaxyx()[0] - 2, 1)

    @property
    def visible(self):
        """Сколько строк книги видно целиком (обе страницы разворота)."""
        return self.height * self.eff_columns

    @property
    def page_step(self):
        """Шаг перелистывания: страница с нахлёстом, разворот — целиком."""
        return self.visible - 1 if self.eff_columns == 1 else self.visible

    def column_x(self, col):
        return self.margin + col * (self.width + self.GUTTER)

    def relayout(self, keep_block=None):
        _, cols = self.scr.getmaxyx()
        room = cols >= 2 * self.MIN_COL + self.GUTTER + 2
        self.eff_columns = 2 if (self.columns == 2 and room) else 1
        if self.eff_columns == 2:
            self.width = max(min(self.maxwidth,
                                 (cols - self.GUTTER - 4) // 2), self.MIN_COL)
            spread = self.width * 2 + self.GUTTER
            self.margin = max((cols - spread) // 2, 0)
        else:
            self.width = max(min(self.maxwidth, cols - 4), 20)
            self.margin = max((cols - self.width) // 2, 0)
        key = (self.width, self.spacing)
        cached = self._cache.get(key)
        if cached is None:
            cached = layout(self.book.blocks, self.width, self.spacing)
            if len(self._cache) >= 6:            # держим только свежие раскладки
                self._cache.pop(next(iter(self._cache)))
            self._cache[key] = cached
        self.lines = cached
        if keep_block is not None:
            self.goto_block(keep_block)
        self.clamp()

    def clamp(self):
        self.top = max(0, min(self.top, max(len(self.lines) - self.visible, 0)))

    def set_columns(self, count):
        self.columns = 2 if count == 2 else 1
        self.relayout(keep_block=self.current_block())
        if self.columns == 2 and self.eff_columns == 1:
            self.message = "для разворота нужно окно шире — пока одна колонка"
        else:
            self.message = ("книжный разворот: две страницы" if self.columns == 2
                            else "одна колонка")

    def current_block(self):
        if not self.lines:
            return 0
        return self.lines[min(self.top, len(self.lines) - 1)][2]

    def goto_block(self, block):
        for i, line in enumerate(self.lines):
            b = line[2]
            if b >= block:
                self.top = i
                break
        else:
            self.top = max(len(self.lines) - self.height, 0)
        self.clamp()

    # --- отрисовка --------------------------------------------------------
    def draw(self):
        self.scr.erase()
        self.hotspots = []              # (строка, от, до, что, куда) для мыши
        rows, cols = self.scr.getmaxyx()

        head = self.book.title
        if self.book.author:
            head = f"{self.book.author} — {head}"
        if len(self.lines) > self.visible:
            pct = int(100 * self.top / (len(self.lines) - self.visible))
        else:
            pct = 100 if self.lines else 0
        right = f" {pct:3d}% "
        head = cut_to_width(head, max(cols - len(right) - 1, 0))
        bar = head + " " * max(cols - len(right) - str_width(head), 0) + right
        self.scr.attron(curses.color_pair(1) | curses.A_BOLD)
        self.scr.addnstr(0, 0, bar, max(cols - 1, 1))
        self.scr.attroff(curses.color_pair(1) | curses.A_BOLD)

        for col in range(self.eff_columns):
            x0 = self.column_x(col)
            start = self.top + col * self.height
            for row in range(self.height):
                idx = start + row
                if idx >= len(self.lines):
                    break
                text, attr, blk, styles = self.lines[idx]
                if not text:
                    continue
                room = max(cols - x0 - 1, 0)
                self.scr.addnstr(row + 1, x0, cut_to_width(text, room),
                                 max(room, 1), self.attr(attr))
                for col, fragment, kind in styles:
                    x = x0 + col
                    if 0 <= x < cols - 1:
                        self.scr.addnstr(row + 1, x,
                                         cut_to_width(fragment, cols - x - 1),
                                         max(cols - x - 1, 1),
                                         self.attr(attr) | EMPHASIS[kind])
                self.mark_refs(row + 1, x0, text, blk, cols)
                self.mark_query(row + 1, x0, text, cols)
                if blk in self.marked_blocks and x0 >= 2:
                    try:
                        self.scr.addstr(row + 1, x0 - 2, "▌",
                                        self.attr("dim"))
                    except curses.error:
                        pass
                item = self.book.blocks[blk]
                if item.kind == "image" and item.src:
                    self.hotspots.append((row + 1, x0, x0 + str_width(text),
                                          "image", item.src))

        if self.eff_columns == 2:
            x = self.margin + self.width + self.GUTTER // 2
            if 0 <= x < cols - 1:
                for row in range(1, rows - 1):
                    try:
                        self.scr.addch(row, x, curses.ACS_VLINE, self.attr("dim"))
                    except curses.error:
                        pass

        status = self.message or "?  — справка,  t — оглавление,  q — выход"
        self.scr.attron(curses.A_DIM | curses.color_pair(PAIR_DIM))
        self.scr.addnstr(rows - 1, 0, status[: max(cols - 1, 1)], max(cols - 1, 1))
        self.scr.attroff(curses.A_DIM | curses.color_pair(PAIR_DIM))
        self.scr.noutrefresh()
        curses.doupdate()

    @staticmethod
    def attr(name):
        return {
            "title": curses.A_BOLD | curses.color_pair(PAIR_TITLE),
            "sub": curses.A_BOLD | curses.color_pair(PAIR_TEXT),
            "dim": curses.A_DIM | curses.color_pair(PAIR_DIM),
            "text": curses.color_pair(PAIR_TEXT),
        }.get(name, curses.color_pair(PAIR_TEXT))

    def mark_query(self, row, x0, text, cols):
        """Подсвечивает то, что сейчас ищут."""
        if not self.query or not self.matches:
            return
        needle = normalize(self.query)
        hay = normalize(text)
        style = curses.A_REVERSE
        at = hay.find(needle)
        while at >= 0:
            x = x0 + str_width(text[:at])
            fragment = text[at:at + len(needle)]
            if 0 <= x < cols - 1:
                try:
                    self.scr.addnstr(row, x, fragment, cols - x - 1, style)
                except curses.error:
                    pass
            at = hay.find(needle, at + len(needle))

    def mark_refs(self, row, x0, text, block, cols):
        """Подсвечивает маркеры сносок внутри уже отрисованной строки."""
        refs = self.book.blocks[block].refs
        if not refs:
            return
        style = curses.color_pair(PAIR_NOTE) | curses.A_UNDERLINE | curses.A_BOLD
        for marker, target in refs:
            if target not in self.book.anchors:
                continue
            pos = text.find(marker)
            while pos >= 0:
                x = x0 + str_width(text[:pos])
                if 0 <= x < cols - 1:
                    try:
                        self.scr.addnstr(row, x, marker, cols - x - 1, style)
                    except curses.error:
                        pass
                    self.hotspots.append((row, x, x + str_width(marker),
                                          "note", target))
                pos = text.find(marker, pos + len(marker))

    # --- закладки ---------------------------------------------------------
    def bookmark_label(self, block):
        """Имя закладки берём из текста, к которому она поставлена."""
        for item in self.book.blocks[block:block + 6]:
            if item.text and item.kind != "image":
                return item.text[:80]
        return f"абзац {block}"

    def add_bookmark(self):
        block = self.current_block()
        if any(mark["block"] == block for mark in self.bookmarks):
            self.bookmarks = [m for m in self.bookmarks if m["block"] != block]
            self.message = "закладка снята"
        else:
            self.bookmarks.append({
                "block": block,
                "name": self.bookmark_label(block),
                "percent": progress_percent(block, len(self.book.blocks)) or 0,
                "at": time.time(),
            })
            self.message = f"закладка поставлена ({len(self.bookmarks)} всего)"
        self.store_bookmarks()

    def store_bookmarks(self):
        save_bookmarks(self.path, self.bookmarks, self.book.title,
                       len(self.book.blocks), self.book.author)
        self.marked_blocks = {m["block"] for m in self.bookmarks}

    def show_bookmarks(self):
        if not self.bookmarks:
            self.message = "закладок нет: поставить — M"
            return
        while True:
            items = [f"{m.get('percent', 0):3d}%  {m['name']}"
                     for m in self.bookmarks]
            choice = self.popup("Закладки", items, select=0, actions="de",
                                hint=" Enter — перейти, d — удалить, "
                                     "e — экспорт, q — закрыть ")
            if choice is None:
                return
            if isinstance(choice, tuple):
                key, index = choice
                if key == "d":
                    self.bookmarks.pop(index)
                    self.store_bookmarks()
                    if not self.bookmarks:
                        self.message = "закладок больше нет"
                        return
                    continue
                if key == "e":
                    self.export_bookmarks()
                    return
            else:
                self.goto_block(self.bookmarks[choice]["block"])
                return

    def export_bookmarks(self):
        """Выгружает закладки вместе с текстом в markdown."""
        name = re.sub(r"[^\w\- ]+", "", self.book.title).strip() or "закладки"
        target = os.path.join(os.getcwd(), f"{name} — закладки.md")
        lines = [f"# {self.book.title}", ""]
        if self.book.author:
            lines += [f"*{self.book.author}*", ""]
        for mark in sorted(self.bookmarks, key=lambda m: m["block"]):
            block = mark["block"]
            lines.append(f"## {mark.get('percent', 0)}% — {mark['name']}")
            lines.append("")
            quoted = 0
            for item in self.book.blocks[block:block + 8]:
                if quoted >= 3:
                    break
                if item.text and item.kind in ("p", "cite", "v"):
                    lines.append("> " + item.text)
                    lines.append("")
                    quoted += 1
        try:
            with open(target, "w", encoding="utf-8") as f:
                f.write("\n".join(lines))
        except OSError as error:
            self.message = f"не удалось записать файл: {error}"
            return
        self.message = f"закладки сохранены: {target}"

    # --- картинки ---------------------------------------------------------
    def visible_images(self):
        """Иллюстрации в пределах текущего экрана, сверху вниз."""
        found, seen = [], set()
        for i in range(self.top, min(self.top + self.visible, len(self.lines))):
            block = self.lines[i][2]
            if block in seen:
                continue
            seen.add(block)
            item = self.book.blocks[block]
            if item.kind == "image" and item.src:
                found.append((item.text, item.src))
        return found

    def show_image(self, src, caption=""):
        """Выходит из curses, рисует картинку, ждёт клавишу и возвращается."""
        data, mime = self.book.image_data(src)
        if not data:
            self.message = "картинку не удалось прочитать"
            return
        rows, cols = self.scr.getmaxyx()
        curses.def_prog_mode()
        curses.endwin()
        shown = False
        try:
            _write_raw(b"\x1b[2J\x1b[H")
            shown = render_image(data, mime, self.images, cols - 2, rows - 3)
            if shown:
                label = caption or "картинка"
                _write_raw(f"\r\n{label} — любая клавиша\r\n".encode())
                wait_for_key()
        finally:
            curses.reset_prog_mode()
            self.scr.clearok(True)
        if not shown:
            self.message = ("терминал не умеет показывать картинки; "
                            "поставьте chafa или используйте kitty/iTerm2")

    def open_image(self):
        images = self.visible_images()
        if not images:
            self.message = "на экране нет иллюстраций"
            return
        if self.images == "off":
            self.message = "показ картинок выключен ключом --images off"
            return
        if len(images) == 1:
            pick = 0
        else:
            pick = self.popup("Иллюстрации на экране",
                              [f"{n + 1}. {text}" for n, (text, _)
                               in enumerate(images)], select=0)
            if pick is None:
                return
        caption, src = images[pick]
        self.show_image(src, caption.strip("[] "))

    # --- сноски -----------------------------------------------------------
    def visible_refs(self):
        """Ссылки на сноски в пределах текущего экрана, сверху вниз."""
        found, seen = [], set()
        for i in range(self.top, min(self.top + self.visible, len(self.lines))):
            blk = self.lines[i][2]
            if blk in seen:
                continue
            seen.add(blk)
            for marker, target in self.book.blocks[blk].refs:
                dest = self.book.anchors.get(target)
                if dest is not None:
                    found.append((marker, dest))
        return found

    def note_preview(self, dest):
        for b in self.book.blocks[dest:dest + 5]:
            if b.kind in ("p", "cite") and b.text:
                return b.text
        return ""

    def follow_note(self):
        refs = self.visible_refs()
        if not refs:
            self.message = "на экране нет ссылок на сноски"
            return
        if len(refs) == 1:
            pick = 0
        else:
            items = [f"{m}  {self.note_preview(d)}"[:100] for m, d in refs]
            pick = self.popup("Сноски на экране", items, select=0)
            if pick is None:
                return
        self.jump_stack.append(self.current_block())
        self.goto_block(refs[pick][1])
        self.message = "Backspace — вернуться к тексту"

    def go_back(self):
        if not self.jump_stack:
            self.message = "возвращаться некуда"
            return
        self.goto_block(self.jump_stack.pop())
        self.message = "вернулись к тексту"

    def cycle_theme(self, step=1):
        i = (THEME_ORDER.index(self.theme) + step) % len(THEME_ORDER)
        self.theme = THEME_ORDER[i]
        apply_theme(self.scr, self.theme)
        self.message = f"тема: {self.theme}"

    # --- всплывающие окна -------------------------------------------------
    def popup(self, title, items, select=None, actions="", hint=""):
        """Список с выбором. Возвращает номер, («клавиша», номер) или None."""
        rows, cols = self.scr.getmaxyx()
        h = max(min(len(items) + 4, rows - 2), 5)
        w = max(min(max((str_width(s) for s in items), default=20) + 6,
                    cols - 4), 24)
        win = curses.newwin(h, w, max((rows - h) // 2, 0), max((cols - w) // 2, 0))
        win.keypad(True)
        try:
            win.bkgd(" ", curses.color_pair(PAIR_TEXT))
        except curses.error:
            pass
        cur = select or 0
        top = 0
        view = h - 4
        while True:
            win.erase()
            win.box()
            win.addnstr(0, 2, f" {title} ", w - 4, curses.A_BOLD)
            top = max(0, min(top, max(len(items) - view, 0)))
            if cur < top:
                top = cur
            elif cur >= top + view:
                top = cur - view + 1
            for i in range(view):
                j = top + i
                if j >= len(items):
                    break
                mark = (curses.A_REVERSE
                        if (select is not None and j == cur) else curses.A_NORMAL)
                item = cut_to_width(items[j], w - 4)
                item += " " * max(w - 4 - str_width(item), 0)
                win.addnstr(i + 2, 2, item, w - 4, mark)
            footer = hint or (" Enter — перейти, q — закрыть "
                              if select is not None else " q — закрыть ")
            win.addnstr(h - 1, 2, cut_to_width(footer, w - 4), w - 4,
                        curses.A_DIM)
            win.refresh()
            ch = win.getch()
            if ch in (ord("q"), 27, ord("t"), ord("o")):
                return None
            if ch == curses.KEY_MOUSE and select is not None:
                try:
                    _, mx, my, _, state = curses.getmouse()
                except curses.error:
                    continue
                if state & WHEEL_UP:
                    cur = max(cur - 1, 0)
                elif state & WHEEL_DOWN:
                    cur = min(cur + 1, len(items) - 1)
                elif state & CLICK:
                    top_y, left_x = win.getbegyx()
                    row = my - top_y - 2
                    if 0 <= row < view and left_x <= mx < left_x + w:
                        picked = top + row
                        if picked < len(items):
                            return picked
                continue
            if select is None:
                continue
            if ch in (curses.KEY_DOWN, ord("j")):
                cur = min(cur + 1, len(items) - 1)
            elif ch in (curses.KEY_UP, ord("k")):
                cur = max(cur - 1, 0)
            elif ch == curses.KEY_NPAGE:
                cur = min(cur + view, len(items) - 1)
            elif ch == curses.KEY_PPAGE:
                cur = max(cur - view, 0)
            elif ch in (curses.KEY_HOME, ord("g")):
                cur = 0
            elif ch in (curses.KEY_END, ord("G")):
                cur = len(items) - 1
            elif ch in (curses.KEY_ENTER, 10, 13):
                return cur
            elif actions and 0 <= ch < 256 and chr(ch) in actions:
                return chr(ch), cur

    def show_toc(self):
        if not self.book.toc:
            self.message = "в книге нет оглавления"
            return
        here = self.current_block()
        cur = 0
        items = []
        for i, (lvl, title, blk) in enumerate(self.book.toc):
            items.append("  " * min(lvl, 4) + title)
            if blk <= here:
                cur = i
        pick = self.popup("Оглавление", items, select=cur)
        if pick is not None:
            self.goto_block(self.book.toc[pick][2])

    def show_help(self):
        rows = help_rows(self.bindings)
        width = max(str_width(keys) for keys, _ in rows) + 2
        self.popup("Клавиши", [f"{keys}{' ' * (width - str_width(keys))}{text}"
                               for keys, text in rows])

    def show_info(self):
        b = self.book
        self.popup("О книге", [
            f"Формат   : {b.format}",
            f"Название : {b.title}",
            f"Автор    : {b.author or '—'}",
            f"Серия    : {b.series or '—'}",
            f"Файл     : {b.path}",
            f"Абзацев  : {len(b.blocks)}",
            f"Строк    : {len(self.lines)} (ширина {self.width},"
            f" интервал {self.spacing})",
            f"Экран    : {self.scr.getmaxyx()[1]}x{self.scr.getmaxyx()[0]} знакомест",
            f"Колонок  : {self.eff_columns}"
            + (" (запрошено 2, окно узкое)"
               if self.columns == 2 and self.eff_columns == 1 else ""),
            f"Глав     : {len(b.toc)}",
            f"Закладок : {len(self.bookmarks)}",
            *([""] + [f"Правка   : {n}" for n in b.repairs] if b.repairs else []),
        ])

    def prompt(self, label):
        rows, cols = self.scr.getmaxyx()
        curses.echo()
        try:
            curses.curs_set(1)
        except curses.error:
            pass
        self.scr.move(rows - 1, 0)
        self.scr.clrtoeol()
        self.scr.addnstr(rows - 1, 0, label, max(cols - 1, 1))
        try:
            text = self.scr.getstr(rows - 1, len(label), 120).decode("utf-8", "replace")
        except Exception:
            text = ""
        curses.noecho()
        try:
            curses.curs_set(0)
        except curses.error:
            pass
        return text.strip()

    def search(self, direction=1, fresh=False):
        if fresh:
            query = self.prompt("/")
            if not query:
                self.query, self.matches, self.match = "", [], -1
                self.message = "поиск сброшен"
                return
            self.query = query
            self.matches = find_matches(self.book.blocks, query)
            self.match = -1
            if not self.matches:
                self.message = f"не найдено: {query}"
                return
            here = self.current_block()
            start = next((n for n, (block, _) in enumerate(self.matches)
                          if block >= here), 0)
            self.goto_match(start)
            return
        if not self.query:
            self.message = "сначала задайте поиск клавишей /"
            return
        if not self.matches:
            self.message = f"не найдено: {self.query}"
            return
        self.goto_match((self.match + direction) % len(self.matches),
                        wrapped=not 0 <= self.match + direction < len(self.matches))

    def goto_match(self, index, wrapped=False):
        """Переходит к совпадению и показывает, какое оно по счёту."""
        if not self.matches:
            return
        self.match = index % len(self.matches)
        block, offset = self.matches[self.match]
        self.goto_block(block)
        needle = normalize(self.query)
        for i in range(self.top, len(self.lines)):
            line, _, line_block, _ = self.lines[i]
            if line_block > block:
                break
            if line_block == block and needle in normalize(line):
                self.top = max(i - self.height // 3, 0)
                break
        self.clamp()
        self.message = (f"совпадение {self.match + 1} из {len(self.matches)}"
                        f"{', поиск с начала' if wrapped else ''}"
                        f" — l покажет список")

    def show_matches(self):
        """Список всех совпадений с кусочком текста вокруг каждого."""
        if not self.matches:
            self.message = "сначала задайте поиск клавишей /"
            return
        items = []
        total = max(len(self.book.blocks) - 1, 1)
        for block, offset in self.matches:
            percent = round(100 * block / total)
            items.append(f"{percent:3d}%  " + match_context(
                self.book.blocks[block], offset, len(self.query)))
        pick = self.popup(f"Совпадения: {self.query}", items,
                          select=max(self.match, 0))
        if pick is not None:
            self.goto_match(pick)

    def jump_chapter(self, direction):
        here = self.current_block()
        blocks = [b for _, _, b in self.book.toc]
        if direction > 0:
            nxt = next((b for b in blocks if b > here), None)
        else:
            nxt = next((b for b in reversed(blocks) if b < here), None)
        if nxt is None:
            self.message = "дальше глав нет" if direction > 0 else "это начало книги"
            return
        self.goto_block(nxt)

    # --- мышь -------------------------------------------------------------
    def toggle_mouse(self):
        self.mouse = not self.mouse
        enable_mouse(self.mouse)
        self.message = ("мышь включена: колесо листает, клик по сноске "
                        "открывает её" if self.mouse
                        else "мышь отпущена — можно выделять текст")

    def handle_mouse(self):
        try:
            _, x, y, _, state = curses.getmouse()
        except curses.error:
            return
        if state & WHEEL_UP:
            self.top -= 3
        elif state & WHEEL_DOWN:
            self.top += 3
        elif state & BACK_CLICK:
            self.go_back()
        elif state & CLICK:
            for row, left, right, kind, target in self.hotspots:
                if row == y and left <= x < right:
                    if kind == "note":
                        destination = self.book.anchors.get(target)
                        if destination is not None:
                            self.jump_stack.append(self.current_block())
                            self.goto_block(destination)
                            self.message = "правая кнопка или Backspace — назад"
                    else:
                        self.show_image(target)
                    return

    # --- главный цикл -----------------------------------------------------
    def build_actions(self):
        """Что делает каждое действие. Клавиши к ним привязывает раскладка."""
        def scroll(delta):
            def move():
                self.top += delta()
            return move

        return {
            "line_down": scroll(lambda: 1),
            "line_up": scroll(lambda: -1),
            "page_down": scroll(lambda: self.page_step),
            "page_up": scroll(lambda: -self.page_step),
            "half_down": scroll(lambda: max(self.visible // 2, 1)),
            "half_up": scroll(lambda: -max(self.visible // 2, 1)),
            "book_start": lambda: setattr(self, "top", 0),
            "book_end": lambda: setattr(self, "top", len(self.lines)),
            "next_chapter": lambda: self.jump_chapter(1),
            "prev_chapter": lambda: self.jump_chapter(-1),
            "toc": self.show_toc,
            "note_follow": self.follow_note,
            "note_back": self.go_back,
            "image": self.open_image,
            "search": lambda: self.search(1, fresh=True),
            "search_next": lambda: self.search(1),
            "search_prev": lambda: self.search(-1),
            "match_list": self.show_matches,
            "bookmark_add": self.add_bookmark,
            "bookmark_list": self.show_bookmarks,
            "wider": lambda: self.change_width(+4),
            "narrower": lambda: self.change_width(-4),
            "spacing": self.cycle_spacing,
            "one_column": lambda: self.set_columns(1),
            "two_columns": lambda: self.set_columns(2),
            "toggle_columns": lambda: self.set_columns(
                1 if self.columns == 2 else 2),
            "theme": self.cycle_theme,
            "mouse": self.toggle_mouse,
            "info": self.show_info,
            "redraw": lambda: self.scr.clearok(True),
            "help": self.show_help,
        }

    def change_width(self, delta):
        self.maxwidth = max(self.maxwidth + delta, 24)
        self.relayout(keep_block=self.current_block())

    def cycle_spacing(self):
        self.spacing = self.spacing % 3 + 1
        self.relayout(keep_block=self.current_block())
        self.message = f"межстрочный интервал: {self.spacing}"

    def run(self):
        try:
            curses.curs_set(0)
        except curses.error:
            pass
        actions = self.build_actions()
        while True:
            self.draw()
            ch = self.scr.getch()
            action = self.keymap.get(ch)
            if action != "redraw":          # перерисовка сообщение не гасит
                self.message = ""
            if action == "quit":
                return
            if ch == curses.KEY_RESIZE:
                self.scr.clearok(True)
                self.relayout(keep_block=self.current_block())
            elif ch == curses.KEY_MOUSE:
                self.handle_mouse()
            elif action in actions:
                actions[action]()
            self.clamp()


# ------------------------------------------------------------------- запуск

def _safe_print_lines(lines):
    """Печать, переживающая обрыв конвейера (| head, | less и т.п.)."""
    try:
        for line in lines:
            print(line)
        sys.stdout.flush()
    except BrokenPipeError:
        devnull = os.open(os.devnull, os.O_WRONLY)
        os.dup2(devnull, sys.stdout.fileno())
        return 0
    return 0


def setup_locale():
    """Включает вывод не-ASCII в curses.

    Без setlocale библиотека curses режет всё, кроме ASCII, и кириллица
    просто исчезает с экрана. Если локаль окружения не юникодная
    (типичный случай LC_ALL=C в ssh, docker или cron), подбираем UTF-8
    принудительно.
    """
    try:
        locale.setlocale(locale.LC_ALL, "")
    except locale.Error:
        pass
    codeset = locale.getlocale()[1] or ""
    if "UTF" in codeset.upper():
        return True
    for candidate in ("C.UTF-8", "en_US.UTF-8", "ru_RU.UTF-8", "en_GB.UTF-8"):
        try:
            locale.setlocale(locale.LC_ALL, candidate)
            return True
        except locale.Error:
            continue
    return False


def read_book(stdscr, book, path, width, start, prefs):
    """Показывает книгу и запоминает позицию с настройками."""
    reader = Reader(stdscr, book, width, start, path, prefs["theme"],
                    prefs["spacing"], prefs["columns"], prefs["images"],
                    prefs["mouse"], prefs.get("keys"))
    reader.run()
    save_pos(path, reader.current_block(), book.title, len(book.blocks),
             book.author)
    prefs.update(theme=reader.theme, spacing=reader.spacing,
                 columns=reader.columns, mouse=reader.mouse)   # backend картинок не сохраняем:
    # он зависит от терминала, в котором книгу открыли сейчас


def run_library(entries, args, prefs):
    """Список книг: выбрал, прочитал, вернулся к списку."""
    def bootstrap(stdscr):
        while True:
            path = choose_book(stdscr, entries, prefs["theme"],
                               prefs.get("mouse", True))
            if path is None:
                return
            try:
                book = Book(path)
            except (OSError, ValueError, ET.ParseError) as e:
                stdscr.erase()
                stdscr.addnstr(0, 0, f"{os.path.basename(path)}: {e}",
                               stdscr.getmaxyx()[1] - 1)
                stdscr.addnstr(2, 0, "любая клавиша — назад к списку",
                               stdscr.getmaxyx()[1] - 1)
                stdscr.getch()
                continue
            start = 0 if args.from_start else load_pos(path)
            read_book(stdscr, book, path, prefs["width"], start, prefs)
            for entry in entries:               # обновим прогресс в списке
                if entry["path"] == os.path.abspath(path) or entry["path"] == path:
                    entry["percent"] = progress_percent(load_pos(path),
                                                        len(book.blocks))
            save_prefs(prefs)

    try:
        curses.wrapper(bootstrap)
    except KeyboardInterrupt:
        return 130
    save_prefs(prefs)
    return 0


def main(argv=None):
    unicode_ok = setup_locale()

    ap = argparse.ArgumentParser(prog=APP, description="Читалка FB2 для терминала")
    ap.add_argument("file", nargs="?",
                    help="книга .fb2 / .fb2.zip / .epub либо каталог с книгами; "
                         "без аргумента открывается список недавних")
    ap.add_argument("-w", "--width", type=int, default=None,
                    help="ширина текстовой колонки (по умолчанию 80)")
    ap.add_argument("--dump", action="store_true",
                    help="вывести текст в stdout (например, | less -R)")
    ap.add_argument("--toc", action="store_true", help="вывести оглавление")
    ap.add_argument("--info", action="store_true", help="вывести сведения о книге")
    ap.add_argument("-s", "--spacing", type=int, choices=(1, 2, 3), default=None,
                    help="межстрочный интервал (удобно при крупном шрифте)")
    ap.add_argument("-2", "--spread", dest="columns", action="store_const",
                    const=2, default=None,
                    help="книжный разворот: две страницы рядом")
    ap.add_argument("-1", "--single", dest="columns", action="store_const",
                    const=1, help="одна колонка")
    ap.add_argument("--config", metavar="ФАЙЛ", default=None,
                    help="файл настроек (по умолчанию ~/.config/fb2read/config.ini)")
    ap.add_argument("--write-config", action="store_true",
                    help="записать образец файла настроек и выйти")
    ap.add_argument("--no-mouse", dest="mouse", action="store_false",
                    default=None, help="не захватывать мышь")
    ap.add_argument("--images", choices=IMAGE_BACKENDS, default=None,
                    help="чем показывать иллюстрации (по умолчанию auto)")
    ap.add_argument("--theme", choices=THEME_ORDER, default=None,
                    help="цветовая тема; по умолчанию — выбранная в прошлый раз")
    ap.add_argument("--from-start", action="store_true",
                    help="не восстанавливать сохранённую позицию")
    ap.add_argument("-V", "--version", action="version",
                    version=f"{APP} {__version__}")
    args = ap.parse_args(argv)

    if args.write_config:
        print(write_config(args.config))
        return 0

    file_prefs, key_overrides, config_notes = load_config(args.config)
    for note in config_notes:
        print(f"{APP}: {note}", file=sys.stderr)

    settings = load_settings()

    def choose(name, default):
        """Ключ командной строки, затем конфиг, затем прошлый запуск."""
        value = getattr(args, name, None)
        if value is not None:
            return value
        if name in file_prefs:
            return file_prefs[name]
        return settings.get(name, default)

    prefs = {
        "theme": choose("theme", "auto"),
        "spacing": choose("spacing", 1),
        "columns": choose("columns", 1),
        "images": choose("images", "auto"),
        "mouse": choose("mouse", True),
        "width": choose("width", 80),
        "keys": key_overrides,
    }

    # режим библиотеки: без аргумента или с каталогом
    if not args.file or os.path.isdir(args.file):
        if args.dump or args.toc or args.info:
            print(f"{APP}: для --dump/--toc/--info нужен файл книги",
                  file=sys.stderr)
            return 2
        entries = scan_dir(args.file) if args.file else recent_books()
        if not entries:
            where = args.file or "истории чтения"
            print(f"{APP}: в {where} книг не нашлось", file=sys.stderr)
            return 1
        if not sys.stdout.isatty():
            return _safe_print_lines(
                (f"{e['percent'] if e['percent'] is not None else '-':>4}  "
                 f"{e['title']}  ({e['path']})") for e in entries)
        return run_library(entries, args, prefs)

    try:
        book = Book(args.file)
    except (OSError, ValueError, ET.ParseError) as e:
        print(f"{APP}: {args.file}: {e}", file=sys.stderr)
        return 1

    if args.info:
        return _safe_print_lines([
            f"Формат:   {book.format}",
            *([f"Правки:   {n}" for n in book.repairs] or []),
            f"Название: {book.title}",
            f"Автор:    {book.author or '—'}",
            f"Серия:    {book.series or '—'}",
            f"Абзацев:  {len(book.blocks)}",
            f"Глав:     {len(book.toc)}",
        ])

    if args.toc:
        return _safe_print_lines(
            f"{'  ' * min(lvl, 4)}{title}" for lvl, title, _ in book.toc)

    if args.dump:
        return _safe_print_lines(
            line[0] for line in layout(book.blocks, prefs["width"],
                                       prefs["spacing"]))

    if not sys.stdout.isatty():
        print(f"{APP}: вывод не в терминал, используйте --dump", file=sys.stderr)
        return 2

    if not unicode_ok:
        print(f"{APP}: в системе нет UTF-8 локали, текст может отображаться "
              f"неверно; попробуйте LC_ALL=C.UTF-8", file=sys.stderr)

    start = 0 if args.from_start else load_pos(args.file)
    def bootstrap(stdscr):
        read_book(stdscr, book, args.file, prefs["width"], start, prefs)


    try:
        curses.wrapper(bootstrap)
    except KeyboardInterrupt:
        return 130
    save_prefs(prefs)
    return 0


if __name__ == "__main__":
    sys.exit(main())
