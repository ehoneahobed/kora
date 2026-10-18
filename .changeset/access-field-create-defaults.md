---
"@korajs/core": minor
"@korajs/server": minor
---

Field rules on insert: a field left at its schema default no longer needs the field rule's `create`. Before, a field rule that declared only `update` (`resolved: { update: member(...) }` on `resolved: t.boolean().default(false)`) refused every insert, because each device fills in the default and the missing `create` denied it. Now the collection's `create` rule judges a field that is unset or holds its default (the client did not choose it), and any other value still needs the field's `create`: a rule without one refuses it with an `ACCESS_DENIED` message that says so. A field without a default, and an `auto()` field, are still refused under a rule without `create`.

The collection's `create` rule now applies to every insert. Before, it was skipped when every field of the collection had a field rule, so such a collection admitted inserts that leave fields unset with no rule consulted at all; a collection that relied on field rules alone to admit inserts now needs a `create` rule (leaving it out denies every client, as documented). `CollectionAccess` gains `fieldDefaults`.
