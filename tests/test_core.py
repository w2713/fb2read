# -*- coding: utf-8 -*-
"""Тесты разбора FB2, починки битых файлов, вёрстки и хранения состояния."""

import json
import os

import pytest

import fb2read as f

HEAD = ('<?xml version="1.0" encoding="utf-8"?>'
        '<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">')


def book_from(tmp_path, body, name="case.fb2", encoding="utf-8"):
    path = tmp_path / name
    path.write_bytes((HEAD + body + "</FictionBook>").encode(encoding))
    return f.Book(str(path))


# ------------------------------------------------------------- ширина строк

@pytest.mark.parametrize("text, width", [
    ("日本語", 6),
    ("😀", 2),
    ("е\u0301", 1),          # буква с комбинирующим ударением
    ("обычный текст", 13),
    ("", 0),
])
def test_str_width(text, width):
    assert f.str_width(text) == width


def test_cut_to_width_never_overflows():
    text = "Текст 日本語 с 😀 эмодзи"
    for limit in range(0, 24):
        assert f.str_width(f.cut_to_width(text, limit)) <= limit


def test_wrap_respects_width_and_returns_exact_slices():
    text = ("Иероглифы 日本語 東京 大阪 и эмодзи 😀🎉 вперемешку "
            "с обычным русским текстом для проверки переноса")
    for width in range(8, 60):
        for line, offset in f.wrap_words(text, width):
            assert f.str_width(line) <= width
            assert text[offset:offset + len(line)] == line


def test_wrap_splits_long_word():
    word = "О" * 100
    lines = f.wrap_words(word, 10)
    assert all(f.str_width(line) <= 10 for line, _ in lines)
    assert "".join(line for line, _ in lines) == word


def test_wrap_counts_real_gaps():
    """Между словами может быть не один пробел — ширина считается по факту."""
    text = "Ячейка 1  |  Ячейка 2"
    for line, _ in f.wrap_words(text, 12):
        assert f.str_width(line) <= 12


# ------------------------------------------------------------------ разбор

def test_metadata_and_encoding(sample):
    book = f.Book(sample)
    assert book.title == "Проверка читалки"
    assert book.author == "Иван Тестов"
    assert book.series == "Опыты #2"


def test_toc_structure(sample):
    titles = [title for _, title, _ in f.Book(sample).toc]
    assert "Глава первая в которой всё начинается" in titles
    assert "Вложенный раздел" in titles
    assert "Примечания" in titles


def test_nested_section_level(sample):
    levels = {title: level for level, title, _ in f.Book(sample).toc}
    assert levels["Вложенный раздел"] > levels["Глава вторая"]


def test_footnote_reference_resolves(sample):
    book = f.Book(sample)
    refs = [(marker, target) for b in book.blocks for marker, target in b.refs]
    assert ("[1]", "n1") in refs
    target = book.anchors["n1"]
    tail = " ".join(b.text for b in book.blocks[target:target + 4])
    assert "Это текст сноски" in tail


def test_inline_emphasis_spans(sample):
    book = f.Book(sample)
    block = next(b for b in book.blocks if "курсивом" in b.text)
    styles = {kind: block.text[start:end] for start, end, kind in block.spans}
    assert styles == {"em": "курсивом", "strong": "полужирным"}


def test_poem_lines_stay_separate(sample):
    verses = [b.text for b in f.Book(sample).blocks if b.kind == "v"]
    assert "Мороз и солнце; день чудесный!" in verses


def test_zip_is_read(sample_zip):
    assert f.Book(sample_zip).title == "Проверка читалки"


def test_binary_is_stripped(tmp_path):
    body = ('<body><section><p>Текст.</p></section></body>'
            '<binary id="p1" content-type="image/jpeg">' + "A" * 50000 +
            '</binary>')
    book = book_from(tmp_path, body)
    assert any("вложений" in note for note in book.repairs)
    assert [b.text for b in book.blocks if b.text] == ["Текст."]


# ------------------------------------------------------- починка поломок

@pytest.mark.parametrize("body, expected", [
    ('<body><section><p>Тула &amp; Смит & Вессон</p></section></body>',
     "Тула & Смит & Вессон"),
    ('<body><section><p>Слово&nbsp;и&mdash;тире</p></section></body>',
     "Слово и—тире"),
    ('<body><section><p>Знак &unknown; внутри</p></section></body>',
     "Знак &unknown; внутри"),
    ('<body><section><p>Текст\x07с\x00мусором</p></section></body>',
     "Текстсмусором"),
])
def test_repairs_broken_files(tmp_path, body, expected):
    book = book_from(tmp_path, body)
    assert [b.text for b in book.blocks if b.text][0] == expected
    assert book.repairs


def test_junk_around_document(tmp_path):
    path = tmp_path / "junk.fb2"
    path.write_text("мусор\n" + HEAD +
                    "<body><section><p>Текст книги.</p></section></body>"
                    "</FictionBook>\nхвост", encoding="utf-8")
    book = f.Book(str(path))
    assert [b.text for b in book.blocks if b.text] == ["Текст книги."]
    assert len(book.repairs) == 2


def test_cp1251_without_declaration(tmp_path):
    path = tmp_path / "cp.fb2"
    path.write_bytes((HEAD + "<body><section><p>Текст в кодировке.</p>"
                      "</section></body></FictionBook>").encode("cp1251"))
    book = f.Book(str(path))
    assert [b.text for b in book.blocks if b.text] == ["Текст в кодировке."]
    assert any("cp1251" in note for note in book.repairs)


def test_not_a_book_raises(tmp_path):
    path = tmp_path / "bad.fb2"
    path.write_text("совсем не xml", encoding="utf-8")
    with pytest.raises(ValueError):
        f.Book(str(path))


# ------------------------------------------------------------------ вёрстка

@pytest.mark.parametrize("width", [20, 33, 47, 80, 100])
@pytest.mark.parametrize("spacing", [1, 2, 3])
def test_layout_never_exceeds_width(sample, wide, big, width, spacing):
    for path in (sample, wide, big):
        for line, _, _, _ in f.layout(f.Book(path).blocks, width, spacing):
            assert f.str_width(line) <= width


def test_layout_styles_point_inside_line(wide):
    for line, _, _, styles in f.layout(f.Book(wide).blocks, 40, 1):
        for column, fragment, kind in styles:
            assert fragment in line
            assert kind in ("em", "strong")
            assert column + f.str_width(fragment) <= f.str_width(line)


def test_spacing_adds_blank_lines(sample):
    single = f.layout(f.Book(sample).blocks, 60, 1)
    double = f.layout(f.Book(sample).blocks, 60, 2)
    assert len(double) > len(single)
    assert [l[0] for l in single if l[0]] == [l[0] for l in double if l[0]]


def test_layout_has_no_trailing_blanks(sample):
    lines = f.layout(f.Book(sample).blocks, 60, 1)
    assert lines[-1][0].strip()


# --------------------------------------------------------------- состояние

def test_position_roundtrip(state_home, sample):
    f.save_pos(sample, 42, "Проверка читалки", 100, "Иван Тестов")
    assert f.load_pos(sample) == 42
    data = json.loads((state_home / "fb2read" / "positions.json").read_text("utf-8"))
    entry = next(v for k, v in data.items() if k != "__settings__")
    assert entry["total"] == 100 and entry["author"] == "Иван Тестов"


def test_settings_roundtrip(state_home):
    f.save_settings(theme="night", spacing=2, columns=2)
    assert f.load_settings() == {"theme": "night", "spacing": 2, "columns": 2}


def test_settings_survive_broken_file(state_home):
    path = state_home / "fb2read"
    path.mkdir(parents=True)
    (path / "positions.json").write_text("{битый json", encoding="utf-8")
    assert f.load_settings() == {}
    f.save_settings(theme="day")
    assert f.load_settings()["theme"] == "day"


def test_recent_books_and_progress(state_home, sample, big):
    f.save_pos(sample, 5, "Проверка читалки", 10, "Иван Тестов")
    f.save_pos(big, 0, "Большая книга", 100, "Длинный")
    recent = f.recent_books()
    assert [e["title"] for e in recent] == ["Большая книга", "Проверка читалки"]
    assert recent[1]["percent"] == 56


def test_missing_files_drop_out_of_library(state_home, tmp_path):
    ghost = tmp_path / "ghost.fb2"
    ghost.write_text("x", encoding="utf-8")
    f.save_pos(str(ghost), 1, "Призрак", 10)
    os.remove(ghost)
    assert f.recent_books() == []


def test_scan_dir_reads_metadata(sample, big, state_home):
    entries = f.scan_dir(os.path.dirname(sample))
    titles = {e["title"] for e in entries}
    assert {"Проверка читалки", "Большая книга"} <= titles


@pytest.mark.parametrize("n, expected", [
    (1, "1 книга"), (2, "2 книги"), (5, "5 книг"),
    (11, "11 книг"), (21, "21 книга"), (104, "104 книги"),
])
def test_plural(n, expected):
    assert f.plural(n, "книга", "книги", "книг") == expected


@pytest.mark.parametrize("block, total, expected", [
    (0, 10, 0), (9, 10, 100), (5, 10, 56), (5, 0, None),
])
def test_progress_percent(block, total, expected):
    assert f.progress_percent(block, total) == expected


# ---------------------------------------------------------------- EPUB

def test_epub_is_detected(epub, sample):
    assert f.is_epub(epub) and not f.is_epub(sample)
    assert f.Book(epub).format == "EPUB"
    assert f.Book(sample).format == "FB2"


def test_epub_metadata(epub):
    book = f.Book(epub)
    assert (book.title, book.author, book.series) == \
           ("Пример EPUB", "Анна Автор", "Пробная серия")


def test_epub_reads_spine_in_order(epub):
    texts = [b.text for b in f.Book(epub).blocks if b.text]
    assert texts.index("Глава первая") < texts.index("Глава вторая") \
           < texts.index("Примечания")


def test_epub_toc_from_nav_with_nesting(epub):
    toc = f.Book(epub).toc
    assert [title for _, title, _ in toc] == \
           ["Глава первая", "Вторая часть главы", "Глава вторая", "Примечания"]
    levels = {title: level for level, title, _ in toc}
    assert levels["Вторая часть главы"] > levels["Глава первая"]


def test_epub_toc_from_ncx(epub_ncx):
    titles = [title for _, title, _ in f.Book(epub_ncx).toc]
    assert titles[:2] == ["Глава первая", "Глава вторая"]


def test_epub_footnote_points_to_another_file(epub):
    book = f.Book(epub)
    marker, target = next((m, t) for b in book.blocks for m, t in b.refs)
    assert marker == "[1]"
    assert book.blocks[book.anchors[target]].text == "Это текст сноски из EPUB."


def test_epub_inline_emphasis(epub):
    block = next(b for b in f.Book(epub).blocks if "курсивом" in b.text)
    assert {kind: block.text[a:b] for a, b, kind in block.spans} == \
           {"em": "курсивом", "strong": "полужирным"}


def test_epub_lists_and_quote(epub):
    texts = [b.text for b in f.Book(epub).blocks]
    assert "• первый пункт" in texts and "1. раз" in texts
    quote = next(b for b in f.Book(epub).blocks if b.text == "Цитата с отступом.")
    assert quote.kind == "cite"


def test_epub_skips_scripts_and_keeps_bare_div(epub):
    texts = " ".join(b.text for b in f.Book(epub).blocks)
    assert "не показывать" not in texts
    assert "Текст прямо в div без абзаца." in texts


def test_epub_entities_are_decoded(epub):
    texts = " ".join(b.text for b in f.Book(epub).blocks)
    assert "&#160;" not in texts and "неразрывным пробелом" in texts


def test_epub_layout_and_search_work(epub):
    lines = f.layout(f.Book(epub).blocks, 50, 1)
    assert all(f.str_width(line) <= 50 for line, _, _, _ in lines)
    assert any("ключесловом" in line for line, _, _, _ in lines)


def test_epub_meta_without_full_parse(epub):
    assert f.epub_meta(epub) == ("Пример EPUB", "Анна Автор")


def test_library_lists_epub(epub, sample, state_home):
    entries = f.scan_dir(os.path.dirname(epub))
    assert "Пример EPUB" in {e["title"] for e in entries}


def test_broken_epub_reports_error(tmp_path):
    import zipfile as zf
    path = tmp_path / "broken.epub"
    with zf.ZipFile(path, "w") as z:
        z.writestr("META-INF/container.xml", "<container/>")
    with pytest.raises(ValueError):
        f.Book(str(path))


# ------------------------------------------------------------- картинки

def test_image_block_keeps_source(picture):
    block = next(b for b in f.Book(picture).blocks if b.kind == "image")
    assert block.src == "pic1"


def test_image_data_is_read_on_demand(picture):
    book = f.Book(picture)
    assert book._images["pic1"]["type"] == "image/png"
    data, mime = book.image_data("pic1")
    assert data.startswith(b"\x89PNG") and mime == "image/png"


def test_image_data_missing_is_quiet(picture):
    assert f.Book(picture).image_data("нет-такой") == (None, "")


def test_binary_never_reaches_the_text(picture):
    texts = " ".join(b.text for b in f.Book(picture).blocks)
    assert "iVBOR" not in texts and "[ иллюстрация ]" in texts


def test_epub_image_source_and_alt(epub):
    block = next(b for b in f.Book(epub).blocks if b.kind == "image")
    assert block.src == "OEBPS/images/cover.jpg"
    assert block.text == "[ обложка ]"


def test_epub_image_data_from_zip(epub):
    data, mime = f.Book(epub).image_data("OEBPS/images/cover.jpg")
    assert data == b"\xff\xd8\xff" and mime == "image/jpeg"


@pytest.mark.parametrize("env, expected", [
    ({"KITTY_WINDOW_ID": "1"}, "kitty"),
    ({"TERM": "xterm-kitty"}, "kitty"),
    ({"TERM_PROGRAM": "iTerm.app"}, "iterm"),
    ({"WEZTERM_PANE": "0"}, "iterm"),
])
def test_backend_detection(monkeypatch, env, expected):
    for name in ("KITTY_WINDOW_ID", "TERM_PROGRAM", "WEZTERM_PANE"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("TERM", "xterm-256color")
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    assert f.detect_image_backend() == expected


def test_kitty_refuses_non_png(monkeypatch, capsysbinary):
    assert f._kitty_image(b"\xff\xd8\xff not a png", 10, 10) is False


# ---------------------------------------------------------------- поиск

@pytest.mark.parametrize("text", ["Ёлка", "ПРИВЕТ", "Straße", "日本語 Ёж"])
def test_normalize_keeps_length(text):
    """Смещения совпадений должны оставаться пригодными для исходной строки."""
    assert len(f.normalize(text)) == len(text)


def test_normalize_folds_case_and_yo():
    assert f.normalize("ЁЛка") == f.normalize("елка") == "елка"


def test_find_matches_ignores_case_and_yo(sample):
    blocks = f.Book(sample).blocks
    assert f.find_matches(blocks, "ЁЛОЧКАМИ") == f.find_matches(blocks, "елочками")
    assert len(f.find_matches(blocks, "ёлочками")) == 1


def test_find_matches_offsets_point_at_text(big):
    blocks = f.Book(big).blocks
    matches = f.find_matches(blocks, "память")
    assert matches
    for block, offset in matches[:20]:
        assert f.normalize(blocks[block].text[offset:offset + 6]) == "память"


def test_find_matches_finds_every_occurrence(tmp_path):
    book = book_from(tmp_path, "<body><section><p>кот кот КОТ</p></section></body>")
    assert [offset for _, offset in f.find_matches(book.blocks, "кот")] == [0, 4, 8]


def test_empty_query_finds_nothing(sample):
    assert f.find_matches(f.Book(sample).blocks, "   ") == []


def test_match_context_surrounds_the_hit(big):
    blocks = f.Book(big).blocks
    block, offset = f.find_matches(blocks, "память")[5]
    context = f.match_context(blocks[block], offset, 6)
    assert "память" in f.normalize(context)
    assert len(context) < len(blocks[block].text) + 4


# ------------------------------------------------------------- закладки

def test_bookmarks_roundtrip(state_home, sample):
    marks = [{"block": 12, "name": "Глава", "percent": 30},
             {"block": 3, "name": "Начало", "percent": 5}]
    f.save_bookmarks(sample, marks, "Проверка читалки", 40, "Иван Тестов")
    saved = f.load_bookmarks(sample)
    assert [m["block"] for m in saved] == [3, 12]      # хранятся по порядку


def test_bookmarks_survive_position_save(state_home, sample):
    f.save_bookmarks(sample, [{"block": 7, "name": "метка", "percent": 20}],
                     "Проверка читалки", 40)
    f.save_pos(sample, 25, "Проверка читалки", 40, "Иван Тестов")
    assert [m["block"] for m in f.load_bookmarks(sample)] == [7]
    assert f.load_pos(sample) == 25


def test_bookmarks_of_unknown_book_are_empty(state_home, sample):
    assert f.load_bookmarks(sample) == []


def test_broken_bookmarks_are_ignored(state_home, sample):
    f.save_bookmarks(sample, [{"block": 1, "name": "ok", "percent": 1}], "к", 10)
    data = json.loads((state_home / "fb2read" / "positions.json").read_text("utf-8"))
    key = next(k for k in data if k != "__settings__")
    data[key]["bookmarks"] = ["мусор", {"name": "без блока"},
                              {"block": 2, "name": "годная", "percent": 5}]
    (state_home / "fb2read" / "positions.json").write_text(
        json.dumps(data, ensure_ascii=False), encoding="utf-8")
    assert [m["block"] for m in f.load_bookmarks(sample)] == [2]


# ---------------------------------------------------------------- конфиг

def test_default_keymap_covers_every_action():
    keymap, bindings, problems = f.build_keymap()
    assert not problems
    assert set(bindings) == {action for action, _, _ in f.ACTIONS}
    assert keymap[ord("j")] == "line_down"
    assert keymap[10] == "note_follow" and keymap[13] == "note_follow"


@pytest.mark.parametrize("name, expected", [
    ("j", ord("j")),
    ("space", ord(" ")),
    ("ctrl-l", 12),
    ("PgDn", None),          # регистр не важен
])
def test_parse_key(name, expected):
    codes = f.parse_key(name)
    assert codes
    if expected is not None:
        assert codes[0] == expected


@pytest.mark.parametrize("name", ["", "F13", "ctrl-", "неизвестно"])
def test_parse_key_rejects_nonsense(name):
    assert f.parse_key(name) == []


def test_keymap_override_replaces_defaults():
    keymap, bindings, problems = f.build_keymap({"quit": "x, ctrl-q"})
    assert not problems
    assert keymap[ord("x")] == "quit" and keymap[17] == "quit"
    assert ord("q") not in keymap or keymap[ord("q")] != "quit"


def test_keymap_reports_bad_entries():
    _, _, problems = f.build_keymap({"нетакого": "z", "toc": "F13"})
    assert len(problems) == 2


def test_help_is_built_from_bindings():
    _, bindings, _ = f.build_keymap({"quit": "x"})
    rows = dict(f.help_rows(bindings))
    assert "x" in rows and rows["x"].startswith("выход")


def test_config_is_read(tmp_path):
    path = tmp_path / "config.ini"
    path.write_text("[reader]\nwidth = 64\ntheme = night\nmouse = no\n"
                    "[keys]\nquit = x\n", encoding="utf-8")
    prefs, keys, notes = f.load_config(str(path))
    assert prefs == {"width": 64, "theme": "night", "mouse": False}
    assert keys == {"quit": "x"}
    assert notes == []


def test_config_complains_about_bad_values(tmp_path):
    path = tmp_path / "config.ini"
    path.write_text("[reader]\nwidth = широко\ntheme = розовая\n", encoding="utf-8")
    prefs, _, notes = f.load_config(str(path))
    assert prefs == {} and len(notes) == 2


def test_missing_config_is_not_an_error(tmp_path):
    assert f.load_config(str(tmp_path / "нет.ini")) == ({}, {}, [])


def test_broken_config_is_reported(tmp_path):
    path = tmp_path / "config.ini"
    path.write_text("это не конфиг вовсе", encoding="utf-8")
    prefs, keys, notes = f.load_config(str(path))
    assert prefs == {} and keys == {} and notes


def test_write_config_creates_sample(tmp_path):
    path = tmp_path / "sub" / "config.ini"
    message = f.write_config(str(path))
    assert "записан" in message and path.exists()
    prefs, keys, notes = f.load_config(str(path))
    assert (prefs, keys, notes) == ({}, {}, [])       # всё закомментировано
    text = path.read_text("utf-8")
    for action, _, _ in f.ACTIONS:
        assert f"# {action} = " in text
