# -*- coding: utf-8 -*-
"""Печатает разбор книги как JSON — эталон для сверки с версией на TypeScript.

Запуск: python3 scripts/dump-parse.py книга.fb2
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import fb2read  # noqa: E402


def dump(path):
    book = fb2read.Book(path)
    return {
        "format": book.format,
        "title": book.title,
        "author": book.author,
        "series": book.series,
        "repairs": book.repairs,
        "toc": [[level, title, index] for level, title, index in book.toc],
        "anchors": book.anchors,
        "blocks": [
            {
                "kind": b.kind,
                "text": b.text,
                "level": b.level,
                "refs": [list(r) for r in b.refs],
                "spans": [list(s) for s in b.spans],
                "src": b.src,
            }
            for b in book.blocks
        ],
    }


if __name__ == "__main__":
    print(json.dumps(dump(sys.argv[1]), ensure_ascii=False, indent=1, sort_keys=True))
