---
'@korajs/server': patch
---

`createProductionServer` no longer serves operational endpoints without a token in production
(F5). With `NODE_ENV=production`, a group whose token is unset (`/__kora` dashboard and status,
metrics, backup export and import) answers `403 OPERATIONAL_ENDPOINT_DISABLED`;
`operationalAuth.allowPublic: true` restores the old behaviour on purpose. Every start logs
`server.operational_endpoints_unprotected` when a group has no token.
