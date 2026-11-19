---
"korajs": patch
---

On a slow device the first screen's read now leaves before the answers chunk starts downloading, instead of racing it on a second connection: the chunk waits up to 300 ms (was 50 ms) for the first query to be sent.
