---
'@korajs/server': patch
---

The `maxYjsUpdateBytes` limit on live rich-text updates (added in this release) now counts decoded bytes exactly. Base64 padding used to be counted as payload, so an update of exactly the limit could be refused, and the refusal reported a size up to two bytes too large.
