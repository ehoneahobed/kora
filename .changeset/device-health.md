---
"@korajs/sync": patch
"@korajs/server": patch
---

Devices report their own sync health to servers that record it, and operator insights show it. A device sends a `device-status` message (counts and a failure code only: delivery blocked, operations set aside, writes waiting to upload or held, local storage degraded) once per session and whenever one changes, only to a server that advertises `acceptsDeviceStatus`. The SQLite and Postgres stores record it (`recordDeviceHealth`, optional for custom stores), and `/__kora/insights` adds `stored.devices.health` (devices seen this week) and `stored.operations.quarantined` (rows the log-integrity scan set aside). Older devices and servers are unaffected. The insights endpoint is now documented in the production server guide.
