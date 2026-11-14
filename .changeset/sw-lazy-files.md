---
"@korajs/cli": minor
---

`koraServiceWorker({ lazy: ['/guide/img'] })`: built files under these path prefixes are left out of the precache and cached the first time they are fetched, then served from the cache offline too. For large files most visits never need (a help guide's pictures), so a first visit downloads only the app shell. A change to a lazy file still makes a new version.
