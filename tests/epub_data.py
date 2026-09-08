# -*- coding: utf-8 -*-
"""Содержимое учебного EPUB 3 для тестов."""

CONTAINER = """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf"
media-type="application/oebps-package+xml"/></rootfiles></container>"""

OPF = """<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>Пример EPUB</dc:title><dc:creator>Анна Автор</dc:creator>
<dc:identifier id="id">urn:uuid:1</dc:identifier>
<meta name="calibre:series" content="Пробная серия"/></metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
<item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
<item id="nt" href="text/notes.xhtml" media-type="application/xhtml+xml"/>
<item id="img" href="images/cover.jpg" media-type="image/jpeg"/>
</manifest>
<spine><itemref idref="c1"/><itemref idref="c2"/><itemref idref="nt"/></spine>
</package>"""

NAV = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Оглавление</title></head><body>
<nav epub:type="toc"><ol>
<li><a href="text/ch1.xhtml">Глава первая</a>
  <ol><li><a href="text/ch1.xhtml#part2">Вторая часть главы</a></li></ol></li>
<li><a href="text/ch2.xhtml">Глава вторая</a></li>
<li><a href="text/notes.xhtml">Примечания</a></li>
</ol></nav></body></html>"""

CHAPTER1 = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Глава 1</title><link rel="stylesheet" href="../style.css"/></head>
<body><h1>Глава первая</h1>
<p>Абзац с <em>курсивом</em> и <strong>полужирным</strong>, а также
сноской<a epub:type="noteref" href="notes.xhtml#n1">[1]</a> в конце.</p>
<p>Второй абзац с ключесловом и неразрывным&#160;пробелом.</p>
<blockquote><p>Цитата с отступом.</p></blockquote>
<h2 id="part2">Вторая часть главы</h2>
<ul><li>первый пункт</li><li>второй пункт</li></ul>
<ol><li>раз</li><li>два</li></ol>
<img src="../images/cover.jpg" alt="обложка"/>
<div>Текст прямо в div без абзаца.</div>
<script>console.log("не показывать")</script>
</body></html>"""

CHAPTER2 = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Глава 2</title></head>
<body><h1>Глава вторая</h1><p>Текст второй главы.</p></body></html>"""

NOTES = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Примечания</title></head>
<body><h1>Примечания</h1><p id="n1">Это текст сноски из EPUB.</p></body></html>"""

FILES = {
    "META-INF/container.xml": CONTAINER,
    "OEBPS/content.opf": OPF,
    "OEBPS/nav.xhtml": NAV,
    "OEBPS/text/ch1.xhtml": CHAPTER1,
    "OEBPS/text/ch2.xhtml": CHAPTER2,
    "OEBPS/text/notes.xhtml": NOTES,
}

# EPUB 2 без навигационного документа — оглавление берётся из NCX
NCX = """<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<navMap>
<navPoint id="p1" playOrder="1"><navLabel><text>Глава первая</text></navLabel>
<content src="text/ch1.xhtml"/></navPoint>
<navPoint id="p2" playOrder="2"><navLabel><text>Глава вторая</text></navLabel>
<content src="text/ch2.xhtml"/></navPoint>
</navMap></ncx>"""

OPF_NCX = OPF.replace(
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml"'
    ' properties="nav"/>',
    '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>')

FILES_NCX = {
    "META-INF/container.xml": CONTAINER,
    "OEBPS/content.opf": OPF_NCX,
    "OEBPS/toc.ncx": NCX,
    "OEBPS/text/ch1.xhtml": CHAPTER1,
    "OEBPS/text/ch2.xhtml": CHAPTER2,
    "OEBPS/text/notes.xhtml": NOTES,
}
