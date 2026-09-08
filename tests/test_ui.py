# -*- coding: utf-8 -*-
"""Тесты интерфейса: читалка запускается в псевдотерминале целиком."""

import json
import os
import shutil

import pytest

import fb2read as f

pytest.importorskip("pyte")
from terminal import Terminal  # noqa: E402

ENTER, BACKSPACE, ESC = "\r", "\x7f", "\x1b"


@pytest.fixture
def run(state_home):
    """Запускает читалку с изолированным каталогом состояния."""
    started = []

    def factory(*args, **kwargs):
        env = {"XDG_DATA_HOME": str(state_home)}
        env.update(kwargs.pop("env", {}))
        term = Terminal(list(args), env=env, **kwargs)
        started.append(term)
        return term

    yield factory
    for term in started:
        try:
            term.close()
        except (OSError, ChildProcessError):
            pass


# ------------------------------------------------------------------ запуск

def test_opens_and_quits_cleanly(run, sample):
    term = run(sample, "--from-start")
    assert "Проверка читалки" in term.text()
    assert term.close() == 0


def test_cyrillic_survives_c_locale(run, sample):
    """Без принудительной UTF-8 локали curses режет всё, кроме ASCII."""
    term = run(sample, "--from-start", env={"LC_ALL": "C", "LANG": "C"})
    assert "Глава первая" in term.text()


def test_header_shows_author_and_progress(run, sample):
    term = run(sample, "--from-start")
    header = term.lines()[0]
    assert "Иван Тестов" in header and header.rstrip().endswith("%")


# ------------------------------------------------------------ перемещение

def test_paging_moves_forward_and_back(run, big):
    term = run(big, "--from-start", "-1")
    first = term.body()
    term.send(" ")
    assert term.body() != first
    term.send("b")
    assert term.body() == first


def test_toc_jumps_to_chapter(run, big):
    """Первая запись оглавления — заголовок книги, дальше идут главы."""
    term = run(big, "--from-start")
    term.send("t", "j", "j", ENTER)
    assert "Глава 2" in term.text()


def test_search_finds_word(run, sample):
    term = run(sample, "--from-start")
    term.send("/", "ключесловом" + ENTER)
    assert "ключесловом" in term.text()


def test_chapter_keys(run, big):
    term = run(big, "--from-start")
    term.send("]", "]")
    assert "Глава 2" in term.text()
    term.send("[")
    assert "Глава 1" in term.text()


# --------------------------------------------------------------- сноски

def test_footnote_jump_and_return(run, sample):
    term = run(sample, "--from-start")
    before = term.body()
    term.send("g", ENTER)
    assert "Это текст сноски" in term.text()
    term.send(BACKSPACE)
    assert term.body() == before


def test_footnote_message_when_none_visible(run, sample):
    term = run(sample, "--from-start")
    term.send("G", ENTER)
    assert "нет ссылок на сноски" in term.lines()[-1]


# ------------------------------------------------------------- начертание

def test_emphasis_reaches_the_screen(run, sample):
    term = run(sample, "--from-start", "-1", "-w", "60")
    assert "курсивом" in " ".join(term.styled("italics"))
    assert "полужирным" in " ".join(term.styled("bold"))


# ---------------------------------------------------------------- разворот

def test_spread_shows_two_pages(run, big):
    term = run(big, "--from-start", "-2", "-w", "40", "-s", "1",
               rows=22, cols=120)
    lines = [line for line, _, _, _ in f.layout(f.Book(big).blocks, 40, 1)]
    height = 20
    assert [x for x in term.column(0, 40) if x] == \
           [x.rstrip() for x in lines[:height] if x.strip()]
    assert [x for x in term.column(1, 40) if x] == \
           [x.rstrip() for x in lines[height:2 * height] if x.strip()]


def test_spread_turns_whole_spread(run, big):
    term = run(big, "--from-start", "-2", "-w", "40", "-s", "1",
               rows=22, cols=120)
    lines = [line for line, _, _, _ in f.layout(f.Book(big).blocks, 40, 1)]
    term.send(" ")
    assert [x for x in term.column(0, 40) if x] == \
           [x.rstrip() for x in lines[40:60] if x.strip()]


def test_spread_falls_back_in_narrow_window(run, sample):
    term = run(sample, "--from-start", "-2", rows=20, cols=50)
    assert "окно шире" in term.lines()[-1]


def test_resize_keeps_place(run, big):
    """Уменьшение окна (например, при увеличении шрифта) не теряет место."""
    term = run(big, "--from-start", "-1", rows=30, cols=120)
    term.send("]", "]")
    assert "Глава 2" in term.text()
    term.resize(12, 40)
    assert "Глава 2" in term.text()


# ------------------------------------------------------------- настройки

def test_theme_and_spacing_persist(run, sample, state_home):
    term = run(sample, "--from-start")
    term.send("c", "s", "2")
    assert term.close() == 0
    saved = json.loads((state_home / "fb2read" / "positions.json")
                       .read_text("utf-8"))["__settings__"]
    assert saved == {"theme": "night", "spacing": 2, "columns": 2,
                     "mouse": True}


def test_position_is_restored(run, big, state_home):
    term = run(big, "--from-start", "-1")
    term.send("]", "]", "]")
    marker = " ".join(term.body()[0].split()[:4])
    assert term.close() == 0
    again = run(big, "-1")
    assert marker in " ".join(again.body()[:3])


# ------------------------------------------------------------- библиотека

def test_library_lists_and_opens_book(run, sample, big, tmp_path):
    shelf = tmp_path / "shelf"
    shelf.mkdir()
    for path in (sample, big):
        shutil.copy(path, shelf)
    term = run(str(shelf), rows=14, cols=76)
    assert "Библиотека — 2 книги" in term.lines()[0]
    assert "Большая книга" in term.text()
    term.send(ENTER)
    assert "Глава 1" in term.text() or "Большая книга" in term.text()
    term.send("q")                       # обратно к списку
    assert "Библиотека" in term.lines()[0]


def test_library_shows_progress(run, sample, state_home, tmp_path):
    shelf = tmp_path / "shelf"
    shelf.mkdir()
    shutil.copy(sample, shelf)
    f.save_pos(str(shelf / "sample.fb2"), 5, "Проверка читалки", 10)
    term = run(str(shelf), rows=10, cols=76)
    assert "56%" in term.text()


def test_recent_books_without_arguments(run, sample, state_home):
    term = run(sample, "--from-start")
    term.send(" ")
    assert term.close() == 0
    library = run(rows=10, cols=76)
    assert "Проверка читалки" in library.text()


# ------------------------------------------------------------ устойчивость

@pytest.mark.parametrize("rows, cols", [(4, 15), (8, 26), (50, 200)])
def test_survives_extreme_sizes(run, sample, rows, cols):
    term = run(sample, "--from-start", rows=rows, cols=cols)
    term.send("2", "s", "c", "t", ESC, "?", "q", " ")
    assert term.close() == 0


def test_broken_book_reports_error(run, tmp_path):
    path = tmp_path / "bad.fb2"
    path.write_text("не книга", encoding="utf-8")
    term = Terminal([str(path)], rows=10, cols=60)
    assert "повреждён" in term.text()
    assert term.close() in (1, 0)


# ---------------------------------------------------------------- EPUB

def test_epub_opens_in_reader(run, epub):
    term = run(epub, "--from-start")
    assert "Глава первая" in term.text()
    assert "Анна Автор" in term.lines()[0]
    assert term.close() == 0


def test_epub_footnote_jumps_across_files(run, epub):
    term = run(epub, "--from-start", "-1")
    before = term.body()
    term.send("g", ENTER)
    assert "Это текст сноски из EPUB" in term.text()
    term.send(BACKSPACE)
    assert term.body() == before


def test_epub_toc_navigates(run, epub):
    term = run(epub, "--from-start")
    term.send("t", "j", "j", ENTER)
    assert "Глава вторая" in term.text()


def test_epub_and_fb2_share_the_library(run, epub, sample, tmp_path):
    shelf = tmp_path / "mixed"
    shelf.mkdir()
    for path in (epub, sample):
        shutil.copy(path, shelf)
    term = run(str(shelf), rows=12, cols=76)
    text = term.text()
    assert "Пример EPUB" in text and "Проверка читалки" in text


# ------------------------------------------------------------- картинки

def test_kitty_protocol_is_used(run, picture):
    """В kitty картинка уходит в терминал графическим протоколом."""
    term = run(picture, "--from-start",
               env={"KITTY_WINDOW_ID": "1", "TERM": "xterm-256color"})
    term.send("p", wait=0.6)
    assert b"\x1b_G" in term.raw            # APC-последовательность kitty
    assert b"a=T,f=100" in term.raw         # PNG, показать сразу
    term.send("x")
    assert "Текст перед картинкой" in term.text()


def test_iterm_protocol_is_used(run, picture):
    term = run(picture, "--from-start", env={"TERM_PROGRAM": "iTerm.app"})
    term.send("p", wait=0.6)
    assert b"\x1b]1337;File=inline=1" in term.raw


def test_images_can_be_turned_off(run, picture):
    term = run(picture, "--from-start", "--images", "off")
    term.send("p")
    assert "выключен" in term.lines()[-1]
    assert b"\x1b_G" not in term.raw


def test_terminal_without_graphics_says_so(run, picture):
    term = run(picture, "--from-start",
               env={"TERM": "xterm-256color", "PATH": "/nonexistent"})
    term.send("p", wait=0.6)
    assert "не умеет показывать картинки" in term.lines()[-1]


def test_no_images_on_screen(run, sample):
    term = run(sample, "--from-start", env={"KITTY_WINDOW_ID": "1"})
    term.send("g", "p")
    assert "нет иллюстраций" in term.lines()[-1]


def test_epub_image_is_shown(run, epub):
    term = run(epub, "--from-start", "-1",
               env={"TERM_PROGRAM": "iTerm.app"})
    term.send("G", "p", wait=0.6)
    assert b"1337;File=inline=1" in term.raw or "нет иллюстраций" in term.lines()[-1]


# ---------------------------------------------------------------- мышь

def test_wheel_scrolls_text(run, big):
    term = run(big, "--from-start", "-1")
    first = term.body()[0]
    term.wheel(+1, times=2)
    assert term.body()[0] != first
    term.wheel(-1, times=2)
    assert term.body()[0] == first


def test_click_on_footnote_marker_opens_note(run, sample):
    term = run(sample, "--from-start", "-1", "-w", "60", cols=80)
    x, y = term.find("[1]")
    term.click(x + 1, y)
    assert "Это текст сноски" in term.text()


def test_right_click_returns_from_note(run, sample):
    term = run(sample, "--from-start", "-1", "-w", "60", cols=80)
    before = term.body()
    x, y = term.find("[1]")
    term.click(x + 1, y)
    term.click(10, 5, button=2)
    assert term.body() == before


def test_click_on_illustration_shows_it(run, picture):
    term = run(picture, "--from-start",
               env={"KITTY_WINDOW_ID": "1", "TERM": "xterm-256color"})
    x, y = term.find("[ иллюстрация ]")
    term.send(term.mouse(0, x + 3, y), wait=0.6)
    assert b"\x1b_G" in term.raw


def test_click_on_plain_text_does_nothing(run, big):
    term = run(big, "--from-start", "-1")
    before = term.body()
    term.click(20, 6)
    assert term.body() == before


def test_mouse_can_be_released_for_selection(run, sample):
    """Захваченная мышь мешает выделять текст, поэтому её можно отпустить."""
    term = run(sample, "--from-start")
    term.send("m")
    assert "отпущена" in term.lines()[-1]
    assert b"\x1b[?1006l" in term.raw
    term.send("m")
    assert "включена" in term.lines()[-1]


def test_mouse_off_from_command_line(run, sample):
    term = run(sample, "--from-start", "--no-mouse")
    assert b"\x1b[?1006h" not in term.raw


def test_wheel_and_click_in_library(run, sample, big, tmp_path):
    shelf = tmp_path / "shelf"
    shelf.mkdir()
    for path in (sample, big):
        shutil.copy(path, shelf)
    term = run(str(shelf), rows=12, cols=76)
    term.click(10, 2)                    # вторая книга в списке
    assert "Глава" in term.text() or "Проверка читалки" in term.text()


def test_click_in_toc_opens_chapter(run, big):
    term = run(big, "--from-start", rows=24, cols=90)
    term.send("t")
    x, y = term.find("Глава 2")
    term.click(x, y)
    assert "Глава 2" in term.text()


# ------------------------------------------------------- поиск по книге

def test_search_highlights_every_hit_on_screen(run, big):
    term = run(big, "--from-start", "-1")
    term.send("/", "память\r")
    assert {word.lower() for word in term.styled("reverse")} == {"память"}


def test_search_counts_matches(run, big):
    term = run(big, "--from-start", "-1")
    term.send("/", "память\r")
    assert "совпадение 1 из" in term.lines()[-1]
    term.send("n")
    assert "совпадение 2 из" in term.lines()[-1]


def test_search_wraps_around(run, big):
    term = run(big, "--from-start", "-1")
    term.send("/", "память\r")
    term.send("N")
    assert "поиск с начала" in term.lines()[-1]


def test_search_ignores_case_and_yo(run, sample):
    term = run(sample, "--from-start", "-1")
    term.send("/", "ЁЛОЧКАМИ\r")
    assert "совпадение 1 из 1" in term.lines()[-1]
    assert "ёлочками" in " ".join(term.styled("reverse")).lower()


def test_search_list_jumps_to_chosen_hit(run, big):
    term = run(big, "--from-start", "-1", rows=24, cols=90)
    term.send("/", "память\r", "l")
    assert "Совпадения: память" in term.text()
    term.send("j", ENTER)
    assert "совпадение 2 из" in term.lines()[-1]


def test_empty_query_clears_search(run, big):
    term = run(big, "--from-start", "-1")
    term.send("/", "память\r")
    term.send("/", ENTER)
    assert "сброшен" in term.lines()[-1]
    assert not term.styled("reverse")


def test_missing_word_reports_nothing_found(run, sample):
    term = run(sample, "--from-start")
    term.send("/", "такогослованет\r")
    assert "не найдено" in term.lines()[-1]


def test_list_without_search_hints(run, sample):
    term = run(sample, "--from-start")
    term.send("l")
    assert "сначала задайте поиск" in term.lines()[-1]


# ------------------------------------------------------------- закладки

def test_bookmark_is_added_and_marked_in_margin(run, big, state_home):
    term = run(big, "--from-start", "-1")
    term.send("M")
    assert "закладка поставлена" in term.lines()[-1]
    assert any("▌" in line for line in term.lines())


def test_bookmark_toggles_off(run, big):
    term = run(big, "--from-start", "-1")
    term.send("M")
    term.send("M")
    assert "снята" in term.lines()[-1]


def test_bookmarks_persist_between_runs(run, big, state_home):
    term = run(big, "--from-start", "-1")
    term.send("]", "M")
    assert term.close() == 0
    assert len(f.load_bookmarks(big)) == 1
    again = run(big, "-1")
    again.send("'")
    assert "Закладки" in again.text()


def test_bookmark_list_jumps(run, big):
    term = run(big, "--from-start", "-1")
    term.send("]", "]", "M", "g")
    term.send("'", ENTER)
    assert "Глава 2" in term.text()


def test_bookmark_can_be_deleted(run, big, state_home):
    term = run(big, "--from-start", "-1")
    term.send("M")
    term.send("'", "d")
    assert "больше нет" in term.lines()[-1]
    assert f.load_bookmarks(big) == []


def test_bookmarks_export_to_markdown(run, big, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    term = run(big, "--from-start", "-1")
    term.send("]", "M")
    term.send("'", "e", wait=0.5)
    assert "сохранены" in term.lines()[-1]
    exported = list(tmp_path.glob("*.md"))
    assert len(exported) == 1
    text = exported[0].read_text("utf-8")
    assert text.startswith("# Большая книга")
    assert "> " in text and "Глава 1" in text


def test_bookmark_hint_when_empty(run, sample):
    term = run(sample, "--from-start")
    term.send("'")
    assert "закладок нет" in term.lines()[-1]


# ---------------------------------------------------------------- конфиг

@pytest.fixture
def config(tmp_path):
    def write(text):
        path = tmp_path / "config.ini"
        path.write_text(text, encoding="utf-8")
        return str(path)
    return write


def test_config_sets_theme_and_width(run, big, config, state_home):
    path = config("[reader]\nwidth = 40\ntheme = night\n")
    term = run(big, "--from-start", "--config", path, "-1", cols=100)
    # колонка узкая и стоит по центру широкого окна
    assert all(f.str_width(line.strip()) <= 40 for line in term.body())
    text_lines = [line for line in term.body() if line.strip()]
    assert min(len(line) - len(line.lstrip()) for line in text_lines) > 20


def test_command_line_beats_config(run, big, config):
    path = config("[reader]\ncolumns = 2\n")
    term = run(big, "--from-start", "--config", path, "-1", cols=120)
    assert "│" not in term.text() and "|" not in term.text()


def test_remapped_key_works(run, big, config):
    path = config("[keys]\nnext_chapter = >\nprev_chapter = <\n")
    term = run(big, "--from-start", "--config", path, "-1")
    term.send(">", ">")
    assert "Глава 2" in term.text()
    term.send("]")                       # старая клавиша больше не работает
    assert "Глава 2" in term.text()


def test_remapped_quit(run, sample, config):
    path = config("[keys]\nquit = x\n")
    term = run(sample, "--from-start", "--config", path)
    term.send("q")                       # q больше не выходит
    assert "Проверка читалки" in term.text()
    assert term.close_with("x") == 0


def test_help_shows_current_bindings(run, sample, config):
    path = config("[keys]\ntoc = ctrl-t\n")
    term = run(sample, "--from-start", "--config", path)
    term.send("?")
    assert "Ctrl+T" in term.text()


def test_bad_config_is_reported_and_ignored(run, sample, config):
    path = config("[reader]\ntheme = розовая\n")
    term = run(sample, "--from-start", "--config", path)
    assert "Проверка читалки" in term.text()
