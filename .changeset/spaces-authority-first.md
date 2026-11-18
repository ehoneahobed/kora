---
'@korajs/spaces': minor
---

Spaces no longer tell someone who can't manage a space whether it exists or who is in it. Inviting, changing a role, removing a member and transferring now check the caller's authority before anything else. Everyone without it gets `FORBIDDEN`, whether the space is missing, live or deleted, and whatever the target. Before, they could get `SPACE_NOT_SYNCED`, `SPACE_NOT_FOUND`, `NOT_A_MEMBER`, `ROLE_CHANGED` or `CANNOT_CHANGE_OWNER`.

**Behaviour change:** the creator of a space created offline that hasn't reached the server yet now gets `FORBIDDEN` instead of `SPACE_NOT_SYNCED` when inviting, because the server can't tell them apart from a stranger. The message says to retry once the space has synced. A manager of a deleted space still gets `SPACE_NOT_FOUND`.
