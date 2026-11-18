---
'@korajs/devtools': patch
---

The in-page DevTools overlay redraws only when events arrive. It used to copy and redraw the whole event buffer every 300 ms while open. Mounting it again (on HMR, or for a second app) now tears down the previous overlay, where it used to leave its hint, key listener and timer behind. `EventBuffer` gains `version`.
