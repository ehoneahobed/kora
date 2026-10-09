---
"@korajs/core": minor
"korajs": minor
---

Schemas can declare access rules. A schema-level `access` block names the memberships collection, the ordered roles and the group collections whose creator becomes a member; each collection declares `read`, `create`, `update`, `delete` (or `write`) and per-field `fields` rules built from `owner()`, `member()`, `memberOfKey()`, `where()`, `anyone()`, `serverOnly()`, `or()`, `and()` and `custom()`. `t.string().stamp('userId')` marks a field the server sets to the writing user. `defineSchema` validates every rule against the schema with an actionable message (unknown fields, roles, ambiguous groups, `anyone()` writes without `{ writes: true }`, `custom()` in read rules, read rules that expand past 8 alternatives). Read rules compile per user into the scope predicate the sync stream uses, and writes are decided by one evaluator (field rules, immutable access fields, stamps, server-owned memberships). The rules are not enforced by the sync server yet; that lands in the following steps of the beta.15 access work.

Until the server enforces access rules, the built-in server stores refuse to install a schema that declares `access`, and the sync server refuses such a schema from a custom store (at start and on every session message, relay and delivery), so no deployment runs with rules it ignores (`ACCESS_RULES_NOT_ENFORCED`). `where()` values must fit their field (type and enum domain). A group collection's owner field must be stamped (`t.string().stamp('userId')`).
