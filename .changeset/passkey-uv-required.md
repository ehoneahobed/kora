---
'@korajs/auth': patch
---

`generateAuthenticationOptions` now asks for `userVerification: 'required'` by default, matching `verifyAuthenticationResponse`, which requires the User Verified flag by default. It used to ask for `'preferred'`, so a device that skipped verification was refused. A new `requireUserVerification` option keeps the two in step. Pass `false` to both to accept sign-ins without user verification.
