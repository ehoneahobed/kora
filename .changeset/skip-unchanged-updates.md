---
"@korajs/store": patch
---

An update whose values are already the record's no longer writes an operation. `update(id, { title: 'same' })` returns the record untouched, a mixed update writes only the fields that changed, and atomic ops (`op.increment`), richtext and secret fields are always applied. An autosave that re-saved one form hundreds of times used to leave a log in which 975 of 983 updates changed nothing, and every new device downloaded and applied each of them. Existing logs are not rewritten.
