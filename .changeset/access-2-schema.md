---
"@korajs/core": minor
"korajs": minor
---

Schemas can declare access rules. A schema-level `access` block names the memberships collection, the ordered roles and the group collections whose creator becomes a member; each collection declares `read`, `create`, `update`, `delete` (or `write`) and per-field `fields` rules built from `owner()`, `member()`, `memberOfKey()`, `where()`, `anyone()`, `serverOnly()`, `or()`, `and()` and `custom()`. `t.string().stamp('userId')` marks a field the server sets to the writing user. `defineSchema` validates every rule against the schema with an actionable message (unknown fields, roles, ambiguous groups, `anyone()` writes without `{ writes: true }`, `custom()` in read rules, read rules that expand past 8 alternatives). Read rules compile per user into the scope predicate the sync stream uses, and writes are decided by one evaluator (field rules, immutable access fields, stamps, server-owned memberships). The sync server enforces them (see the access-rules entries of this release).

`where()` values must fit their field (type and enum domain). A group collection's owner field must be stamped (`t.string().stamp('userId')`).
