# fb2read

Читалка книг FB2 и EPUB для терминала: листание, оглавление, сноски, поиск,
закладки, книжный разворот, темы, мышь и картинки.

```bash
npm install -g fb2read

fb2read книга.fb2            # читать книгу
fb2read книга.epub           # EPUB работает так же
fb2read ~/books              # список книг в каталоге
fb2read                      # недавние книги с прогрессом
fb2read книга.fb2 --dump | less -R
```

Если Node ставить не хочется, есть готовые бинарники — они ничего не требуют:

```bash
curl -fsSL https://w2713.github.io/fb2read/install.sh | sh   # Linux и macOS
irm https://w2713.github.io/fb2read/install.ps1 | iex         # Windows
```

Описание всех клавиш и настроек — в [README проекта](https://github.com/w2713/fb2read#readme).
