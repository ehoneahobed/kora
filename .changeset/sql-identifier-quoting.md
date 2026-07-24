---
"@korajs/core": patch
"@korajs/store": patch
"@korajs/server": patch
"@korajs/cli": patch
---

SQL identifiers are now quoted everywhere they are generated, so a collection or
field name that is valid JavaScript always produces valid SQL. camelCase
(`formResponses`), PascalCase (`UserProfiles`), and names that happen to be SQL
reserved words (`order`, `select`) now work end to end across the client store,
both server stores, migrations, and CLI-generated migration files. Previously a
camelCase collection was rejected at `defineSchema` and a reserved-word name
produced a runtime SQL syntax error.

A new `quoteIdent` helper is exported from `@korajs/core`. Schema validation
still fails fast for genuinely malformed names (empty, or containing characters
that are not letters, numbers, or underscores). Existing all-lowercase schemas
are unaffected: quoting a lowercase identifier is a no-op in both SQLite and
Postgres.
