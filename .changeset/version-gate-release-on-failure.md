---
'@korajs/store': patch
---

A version-gate open that fails after taking its tab lock, for example because a Web Locks query rejected, now releases the lock and stops its timers and channel. It used to keep the lock, so a tab running a newer build could wait forever on a tab that never opened its storage. The failure is also no longer cached, so opening again works. Supersession and closing behave as before.
