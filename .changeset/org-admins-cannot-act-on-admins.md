---
'@korajs/auth': patch
---

An org admin can no longer demote or remove another admin. `updateMemberRole` and `removeMember` now return `403` when anyone but the owner targets an admin, matching the existing rule that only the owner adds or promotes admins. Leaving an org yourself is still allowed.
