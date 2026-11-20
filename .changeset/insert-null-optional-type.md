---
"@korajs/core": patch
---

The insert type now allows `null` on an optional field with no default, matching the runtime (`insert({ categoryId: null })` compiles); a required or defaulted field still refuses it at compile time. Field builders carry whether `.default()` was called (a new trailing `FieldBuilder` type parameter, defaulting to `boolean`, so existing references keep compiling).
