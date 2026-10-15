---
'@korajs/auth': minor
---

Password reset and change in `createKoraAuthServer`: `passwordReset: { url, send }` serves `POST /auth/password/forgot` and `/auth/password/reset`, and `POST /auth/password/change` is always served. A reset link is single-use, hashed at rest, kept in the user store's database, valid for an hour and only while the account keeps the address; asking for one answers the same for every address; resetting ends every session of the account. Changing a password keeps the calling device signed in with new tokens and ends every other session. The client gains `requestPasswordReset`, `resetPassword` and `changePassword` (also on `useAuth()` in React, Vue and Svelte).

Breaking: `PasswordResetManager` is now `new PasswordResetManager(userStore, { url, send, ... })` with `request`, `reset` and `change`; its tokens are stored hashed. The previous options (`onResetRequested`, `exposeTokenForDevelopment`, `maxRequestsPerEmail`) and the `PasswordResetError`, `ResetTokenExpiredError`, `ResetTokenNotFoundError` and `ResetRateLimitedError` classes are removed.

Also: `UserStore.update()` now writes the profile only (email, name, emailVerified), so an update made from an earlier copy cannot undo a password change; passwords change through `updatePassword` and the new `updatePasswordIf` (required by password reset; the built-in stores have it). Requests to `handleRequest` may carry `waitUntil`, for serverless hosts, so emails sent after the response still go out.

Additive: `RateLimiter.consume` (atomic check-and-count; `InMemoryRateLimiter` has it and sign-in uses it), `MfaVerifier.removeForUser` (`TotpManager` has it), `IssueTokenOptions.issuedAtMs`, and `TokenManager`/`BuiltInAuthRoutes.revokeAllForUser(userId, at?)` returning the cut-off. Sessions completed at MFA verification are dated from the first factor, so a revocation after it covers them; a revocation also cancels a pending MFA sign-in.
