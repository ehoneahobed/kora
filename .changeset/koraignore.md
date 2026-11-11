---
"@korajs/cli": minor
---

`kora deploy --platform kora-cloud` honours a `.koraignore` (`.gitignore` syntax) at the repository root, or in the project's folder in a monorepo, for files the repository keeps but the app doesn't need, such as design sources and recordings.
