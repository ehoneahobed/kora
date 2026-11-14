---
"@korajs/core": patch
---

An insert now treats `null` as "no value", the same as leaving the field out, as an update already did (where `null` clears the field). A form's "None" choice for an optional field (`categoryId: null`) no longer fails the insert with "must be a string, got object"; a field with a default gets its default, and a required field set to `null` is refused with "cannot be null. Give it a value, or declare it .optional()". Validation errors now name the received type as `null` or `array` instead of `object`.
