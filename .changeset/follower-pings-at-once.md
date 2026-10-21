---
'@korajs/store': patch
---

A follower tab no longer declares a live leader tab absent without asking it. The liveness watchdog now pings the leader as soon as a request starts waiting without a recent sign of life, and on every quiet tick; before, a timer tick that fired a millisecond early skipped the only ping, so the next tick failed the request with a retriable `NoLeaderError` while a healthy leader was open.
