# -*- coding: utf-8 -*-
"""Генератор packages/core/src/encoding-tables.ts.

Однобайтовые кодировки берутся из Python, чтобы TypeScript-версия
декодировала книги ровно так же, как эталонная реализация. Bun не знает
меток windows-1251 и koi8-r в TextDecoder, поэтому свои таблицы нужны
не для подстраховки, а для работы вообще.

Запуск: python3 scripts/gen-tables.py > packages/core/src/encoding-tables.ts
"""

import html.entities as he


def table(codec):
    out = []
    for b in range(256):
        try:
            out.append(hex(ord(bytes([b]).decode(codec))))
        except UnicodeDecodeError:
            out.append("-1")          # байт не определён в кодировке
    return out


print("// Сгенерировано из таблиц Python: см. scripts/gen-tables.py.")
print("// Однобайтовые кодировки, которых нет в TextDecoder у Bun.")
print("// -1 — байт не определён в кодировке (строгое декодирование обязано упасть).")
print()
for name, codec in (("CP1251", "cp1251"), ("KOI8_R", "koi8-r"), ("CP1252", "cp1252")):
    vals = table(codec)
    print(f"export const {name}: readonly number[] = [")
    for i in range(0, 256, 16):
        print("  " + ", ".join(vals[i:i + 16]) + ",")
    print("];")
    print()

print("/** Именованные сущности HTML 4.01 — то же, что html.entities.name2codepoint. */")
print("export const NAME_TO_CODEPOINT: Readonly<Record<string, number>> = {")
for k in sorted(he.name2codepoint):
    print(f"  {k}: {he.name2codepoint[k]},")
print("};")
