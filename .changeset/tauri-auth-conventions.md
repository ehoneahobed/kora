---
'@korajs/tauri': patch
'@korajs/auth': patch
---

`TauriAdapterError`, `TauriStoreNotOpenError`, `TauriDatabaseInUseError` and `AuthProviderError` now extend `KoraError`, keeping their names and fields. `TauriDatabaseInUseError` gains the code `TAURI_DATABASE_IN_USE`, and `AuthProviderError` the code `AUTH_PROVIDER_ERROR`. `AuthEvent`'s `user` is now the client's `AuthUser`, the type `AuthClient.currentUser` returns, instead of a stale duplicate. `@korajs/tauri` now ships a README.
