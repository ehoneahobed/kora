---
'@korajs/server': patch
---

`orderBy: 'id'` on the Postgres server store now sorts by code point like every other text column. It used to follow the database's locale collation, so on a database with an `en_US` collation it disagreed with the memory and SQLite stores. The documented query rules now also say that strings containing U+0000, U+FFFF or a lone surrogate are ordered by their stored escape.
