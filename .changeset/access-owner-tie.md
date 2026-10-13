---
"@korajs/server": patch
---

`access.roleOf` and `tx.roleOf`: when a user holds the same role through a group record's owner field and a membership row, the owner field is reported (`source: 'owner'`), so a leftover membership row with the owner role never hides who owns the group.
