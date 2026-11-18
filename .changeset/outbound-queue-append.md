---
'@korajs/sync': patch
---

Queueing writes made offline no longer re-sorts the whole outbound queue for each one. 10,000 writes used to take about 14 seconds of main-thread time; now it takes milliseconds. A new operation is appended when that is exactly where a causal sort would put it: it comes after the last queued operation in timestamp order, and nothing queued depends on it. That is always the case for a fresh local write. Otherwise the queue is fully re-sorted as before, so the upload order is unchanged.
