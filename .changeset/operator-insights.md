---
'@korajs/server': minor
---

Add `/__kora/insights`: device, sync, and operation statistics for operators, with no record values, user ids, or real device ids. Devices are remembered across restarts, including ones that only read. Set `operationalAuth.insightsToken` or `KORA_INSIGHTS_TOKEN` for a token that opens this endpoint and nothing else.
