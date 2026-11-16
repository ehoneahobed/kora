---
"@korajs/cli": patch
---

Desktop (tauri-react) template release workflow: the tag is now the version. Before building, the workflow writes it into `package.json`, `tauri.conf.json` and `Cargo.toml` and refuses a tag that isn't a version. Without this, every release stayed at the scaffolded version and installed apps never saw one as newer. A release started by hand also used the selected branch name for its tag and release name; it now uses the tag typed in.
