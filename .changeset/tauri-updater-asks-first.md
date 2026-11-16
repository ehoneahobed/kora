---
"@korajs/cli": patch
---

Desktop (tauri-react) template: updates are offered, not forced. The startup check used to download and install any update without asking, and said nothing when it couldn't check. `checkForUpdate()` now reports what it found (up to date, a newer version, or why it couldn't check), and a new `<UpdateBanner />` offers a newer version with Install and Later. The release workflow now turns on `createUpdaterArtifacts` for its builds only, so releases include signed update files and `latest.json` while local builds still work without the signing key. The README explains that apps download updates without signing in, so the release must be public, or published elsewhere and the endpoint pointed there.
