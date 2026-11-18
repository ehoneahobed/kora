---
'@korajs/cli': patch
---

A `tauri-react` app now gets its own identity when scaffolded. `productName` is the project name, and `identifier` is `com.<project-name>`, sanitised to a valid reverse-DNS id. Every app used to be `com.kora.app` with the name `kora-app`. Tauri keys an app's data folder on its identifier, so all those apps opened the same database and overwrote each other's data.

`kora doctor` now warns about an app still on `com.kora.app`. The Tauri guide explains that the identifier decides where data lives and must not change after release.
