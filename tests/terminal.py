# -*- coding: utf-8 -*-
"""Запуск читалки в псевдотерминале и чтение того, что видит человек.

curses пишет напрямую в терминал, поэтому обычным перехватом stdout его
не проверить. Здесь программа запускается в pty, а вывод разбирается
эмулятором терминала pyte — так тесты видят ровно тот экран, который
увидел бы читатель, вместе с начертанием каждой ячейки.
"""

import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time

import pyte

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "fb2read.py")


def _attach_controlling_tty():
    """Делает pty управляющим терминалом процесса.

    Без этого ядро не шлёт SIGWINCH при изменении размера окна, и тест
    ресайза проверял бы не то, что происходит в настоящем терминале.
    """
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)


class Terminal:
    def __init__(self, args, rows=24, cols=100, env=None, timeout=2.0):
        self.rows, self.cols = rows, cols
        self.screen = pyte.Screen(cols, rows)
        self.stream = pyte.ByteStream(self.screen)
        self.raw = b""                 # весь поток: в нём видны картинки

        # размер терминала выставляем до запуска: если программа успеет
        # нарисовать первый кадр в другом размере, модель экрана разъедется
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ,
                    struct.pack("HHHH", rows, cols, 0, 0))
        environ = {"TERM": "xterm-256color",
                   "HOME": os.environ.get("HOME", "/tmp"),
                   "XDG_DATA_HOME": os.environ.get("XDG_DATA_HOME", "/tmp"),
                   "PATH": os.environ.get("PATH", "/usr/bin"),
                   "LC_ALL": "C.UTF-8"}
        environ.update(env or {})
        self.process = subprocess.Popen(
            [sys.executable, SCRIPT] + list(args),
            stdin=slave, stdout=slave, stderr=slave,
            env=environ, preexec_fn=_attach_controlling_tty)
        os.close(slave)
        self.fd = master
        self.pid = self.process.pid
        self.pump(0.8)

    # --- управление ------------------------------------------------------
    def resize(self, rows, cols):
        self.rows, self.cols = rows, cols
        self.screen.resize(rows, cols)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ,
                    struct.pack("HHHH", rows, cols, 0, 0))
        self.pump(0.5)
        self.send(redraw=True)      # Ctrl+L — полная перерисовка после ресайза
        return self

    def pump(self, seconds=0.35):
        end = time.time() + seconds
        while time.time() < end:
            if select.select([self.fd], [], [], 0.05)[0]:
                try:
                    data = os.read(self.fd, 65536)
                except OSError:
                    return
                if not data:
                    return
                self.raw += data
                self.stream.feed(data)

    def send(self, *keys, wait=0.3, redraw=True):
        """Нажимает клавиши и синхронизирует модель экрана.

        curses перерисовывает только изменившиеся ячейки, поэтому
        эмулятор в тесте обязан видеть ровно тот же поток, что и
        настоящий терминал. Ctrl+L просит программу перерисовать всё
        целиком — так сравнение экрана остаётся честным.
        """
        for key in keys:
            os.write(self.fd, key.encode())
            self.pump(wait)
        if redraw:
            os.write(self.fd, b"\x0c")
            self.pump(0.3)
        return self

    def close_with(self, key, wait=3.0):
        return self.close(wait=wait, key=key)

    def close(self, wait=3.0, key="q"):
        try:
            os.write(self.fd, key.encode())
        except OSError:
            pass
        self.pump(0.3)
        end = time.time() + wait
        while time.time() < end:
            if self.process.poll() is not None:
                break
            self.pump(0.1)
        else:
            self.process.kill()
            self.process.wait()
        try:
            os.close(self.fd)
        except OSError:
            pass
        return self.process.returncode

    # --- мышь -------------------------------------------------------------
    @staticmethod
    def mouse(button, x, y, release=True):
        """Репорт мыши в формате SGR (координаты с нуля, как на экране)."""
        press = f"\x1b[<{button};{x + 1};{y + 1}M"
        return press + (f"\x1b[<{button};{x + 1};{y + 1}m" if release else "")

    def click(self, x, y, button=0):
        return self.send(self.mouse(button, x, y))

    def wheel(self, direction, times=1, x=10, y=5):
        button = 64 if direction < 0 else 65
        for _ in range(times):
            self.send(self.mouse(button, x, y, release=False))
        return self

    def find(self, needle):
        """Координаты первого вхождения текста на экране."""
        for y, line in enumerate(self.lines()):
            x = line.find(needle)
            if x >= 0:
                return x, y
        return None

    # --- что видно на экране --------------------------------------------
    def lines(self):
        return [line.rstrip() for line in self.screen.display]

    def text(self):
        return "\n".join(self.lines())

    def body(self):
        """Строки текста без шапки и строки состояния."""
        return self.lines()[1:-1]

    def column(self, index, width, gutter=5):
        """Содержимое левой (0) или правой (1) страницы разворота."""
        left = (self.cols - (2 * width + gutter)) // 2
        x = left + index * (width + gutter)
        return [row[x:x + width].rstrip() for row in self.body()]

    def styled(self, kind):
        """Слова, отрисованные курсивом или полужирным."""
        found, current = [], ""
        for y in range(1, self.rows - 1):
            row = self.screen.buffer[y]
            for x in range(self.cols):
                cell = row[x]
                flag = getattr(cell, kind)
                if flag and cell.data.strip():
                    current += cell.data
                elif current:
                    found.append(current)
                    current = ""
            if current:
                found.append(current)
                current = ""
        return found
