---
'@korajs/server': patch
---

`createProductionServer` now checks `maxRequestBodyBytes`, `maxConcurrentRequestBodies` and `maxBackupBytes` when the server is created. A value that isn't a positive whole number throws `InvalidServerConfigError` (`INVALID_SERVER_CONFIG`). Before, `NaN` turned the limit off and `0` refused every request it covered.
