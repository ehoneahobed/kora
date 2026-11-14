---
"@korajs/core": patch
---

An insert now accepts `null` for an optional field with no default and leaves it empty, as an update already did (where `null` clears the field). A form's "None" choice (`categoryId: null`) no longer fails the insert with "must be a string, got object". A required field, or one with a default, still refuses `null` (RT-101), now with a message that says why: "cannot be null. Give it a value, or declare it .optional()" or "cannot be null: it has a default. Leave it out to get the default". Validation errors name the received type as `null` or `array` instead of `object`.
