---
'@korajs/sync': patch
---

Other people's presence is cleared when the sync session ends, through a closed or failed connection, and a change fires. It used to stay shown for as long as the device was offline. Your own presence stays, and when you reconnect the server's catch-up shows the others again.
