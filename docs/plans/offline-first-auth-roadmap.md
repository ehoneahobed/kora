# Offline-First Auth Roadmap

This plan defines what is left for `@korajs/auth` to rival products like NextAuth and BetterAuth while being better suited for offline-first web, desktop, and future mobile applications.

## Current Baseline

Kora auth already includes:

- Email/password auth
- JWT access, refresh, and device credential tokens
- Refresh-token rotation and revocation support
- Device identity and device-bound sync authentication
- Secure token storage hooks for browser, desktop, and mobile environments
- Passkey/WebAuthn primitives
- TOTP MFA and recovery codes
- Organizations, memberships, invitations, RBAC, and sync scope resolution
- External auth adapters
- Audit logs and webhooks
- OAuth provider configuration, OAuth authorization-code flow, OAuth server routes, and linked identities

The foundation is strong. The remaining work is about production durability, simple DX, offline-first policy, and polished end-to-end flows.

## 1. Production Stores For Every Auth Primitive

In-memory stores are useful for development and tests, but production apps need durable stores by default.

Build first-class SQLite, PostgreSQL, and where appropriate Redis-backed stores for:

- OAuth state
- Linked OAuth identities
- Sessions
- TOTP/MFA secrets and recovery codes
- Password reset tokens
- Email verification tokens
- Audit logs
- Webhook delivery attempts
- Rate limiting state

Recommended priority:

1. OAuth state and linked identities - implemented with SQLite and PostgreSQL stores
2. Password reset and email verification
3. Sessions and MFA
4. Audit logs, webhooks, and rate limiting

Target DX:

```ts
const auth = createKoraAuthServer({
  jwtSecret: process.env.KORA_AUTH_SECRET!,
  stores: await createAuthStores({
    sqlite: './auth.db',
  }),
})
```

Or:

```ts
const auth = createKoraAuthServer({
  jwtSecret: process.env.KORA_AUTH_SECRET!,
  stores: await createAuthStores({
    postgres: process.env.DATABASE_URL!,
    redis: process.env.REDIS_URL,
  }),
})
```

## 2. Client OAuth DX

OAuth server routes are now wired, but users should not have to manually call `/auth/oauth/:provider`.

Add client helpers - implemented for the framework-agnostic and React clients:

```ts
await auth.signInWithOAuth('google')
await auth.linkOAuth('github')
await auth.unlinkOAuth('google')
await auth.listLinkedAccounts()
```

For desktop and mobile:

```ts
await auth.signInWithOAuth('google', {
  redirectStrategy: 'loopback',
})
```

Supported redirect strategies should include:

- Browser redirect for web apps
- Loopback callback for desktop apps
- Custom URL scheme for desktop and mobile apps
- Hosted sign-in handoff for apps that cannot receive local callbacks

This is one of Kora auth's biggest chances to surpass web-first auth libraries, because desktop and mobile OAuth can become a first-class path rather than a workaround.

## 3. Offline-First Session Policy

Offline-first auth needs a clear policy model for what can happen without network access.

Support policy controls for:

- Maximum time a device can remain signed in while offline
- Local unlock requirements after inactivity
- Whether reconnect requires remote revalidation
- What happens when a device was revoked while offline
- How MFA behaves while offline
- How org, role, and permission changes are enforced after reconnect
- How stale-but-usable auth state is represented in the client

Target API:

```ts
const auth = createKoraAuthServer({
  jwtSecret: process.env.KORA_AUTH_SECRET!,
  offline: {
    maxOfflineDays: 30,
    requireUnlockAfter: '15 minutes',
    revalidateOnReconnect: true,
    revokeDeviceOnTokenReuse: true,
  },
})
```

Client state should distinguish:

- Authenticated and online-validated
- Authenticated from trusted offline state
- Locked pending local unlock
- Stale and requiring reconnect
- Revoked after reconnect

This is the core differentiator from web-first auth systems.

## 4. Passwordless And Email Flows

Modern auth requires more than password sign-in.

Add route and client support for:

- Magic links
- Email OTP
- Passwordless sign-in
- Email verification routes
- Password reset routes
- Password change routes

Some managers already exist, but they should be part of the one-call `createKoraAuthServer()` route surface and `createKoraAuth()` client surface.

Target DX:

```ts
await auth.sendMagicLink({ email })
await auth.signInWithEmailCode({ email, code })
await auth.requestPasswordReset({ email })
await auth.resetPassword({ token, password })
await auth.verifyEmail({ token })
```

## 5. Provider Ecosystem

Expand provider support beyond the current built-ins.

Add polished providers for:

- Apple
- Google
- GitHub with proper verified email handling
- GitLab
- Discord
- Slack
- Microsoft/Azure refinements
- Generic OIDC discovery

Target OIDC API:

```ts
oidcProvider({
  issuer: 'https://accounts.example.com',
  clientId,
  clientSecret,
})
```

Provider implementation should include:

- Correct scopes
- Correct profile normalization
- Email verification semantics
- Provider-specific edge cases
- Desktop/mobile PKCE recommendations
- Documentation for provider console setup

## 6. Auth Hooks And Lifecycle Callbacks

Kora auth needs customization points without requiring users to fork route handlers.

Add callbacks such as:

```ts
const auth = createKoraAuthServer({
  callbacks: {
    beforeSignIn,
    afterSignIn,
    createUser,
    linkAccount,
    issueTokens,
    resolveSyncScopes,
  },
})
```

Important use cases:

- Assign a user to a store, branch, or location after sign-in
- Add custom profile fields during user creation
- Deny sign-in based on tenant, org, location, or device policy
- Customize sync scopes from auth context
- Add audit metadata
- Integrate billing, licensing, or invitation acceptance

This matters heavily for POS, field-service, inventory, and business desktop apps.

## 7. Session And Cookie Mode For Web

Offline-first apps need bearer tokens for sync, desktop, and mobile. Web apps also expect secure cookie mode.

Support both:

- Bearer token mode for desktop, mobile, and sync
- HTTP-only secure cookie mode for web
- CSRF protection when cookie mode is enabled
- Same auth server supporting both modes

Target API:

```ts
const auth = createKoraAuthServer({
  jwtSecret: process.env.KORA_AUTH_SECRET!,
  web: {
    cookies: true,
    csrf: true,
  },
})
```

The documentation should clearly explain when to use cookies, bearer tokens, or both.

## 8. Device Management As A First-Class Product Surface

Device identity is one of Kora auth's strategic advantages.

Add first-class APIs and docs for:

- Named trusted devices
- Device approval flows
- Remote device revoke
- Lost-device recovery
- Offline grace windows
- Device fingerprint metadata
- Device last-seen tracking
- Admin device audit trails
- UI-ready active device lists

Target client APIs:

```ts
await auth.listDevices()
await auth.renameDevice(deviceId, 'Front Register')
await auth.revokeDevice(deviceId)
await auth.approveDevice(deviceId)
```

Target admin APIs:

```ts
await adminAuth.listUserDevices(userId)
await adminAuth.revokeUserDevice(userId, deviceId)
await adminAuth.requireDeviceReauth(userId, deviceId)
```

## 9. Templates And CLI Integration

The framework promise is a fully functional offline-first app in less than 10 minutes. Auth must be scaffolded, not manually assembled.

The app generator should ask:

```txt
Use auth? yes
Providers? email/password, Google, passkeys
Storage? SQLite local + remote Postgres
Desktop OAuth? loopback/custom scheme
MFA? optional/required/none
Organizations? yes/no
```

Then generate:

- Server auth configuration
- Durable auth stores
- Environment variable examples
- OAuth provider placeholders
- Client auth setup
- Sync auth wiring
- Protected routes/components
- Desktop secure storage setup where applicable
- Working reset/verification/OAuth examples when selected

The generated app should be structurally consistent with the Kora documentation and not require users to understand every auth primitive on day one.

## 10. Security Hardening Pass

Before calling Kora auth world-class, run a focused security pass.

Required work:

- Threat model docs
- Token reuse detection docs and tests
- OAuth account-linking abuse tests
- CSRF tests for cookie mode
- Persistent rate limiting
- Brute-force lockout policy
- MFA recovery-code route wiring
- Audit coverage for every sensitive action
- Security checklist in docs
- Recommended production deployment guide

Sensitive actions that should be audited:

- Sign-in
- Sign-out
- Failed sign-in
- Password change
- Password reset request
- Password reset completion
- Email verification
- MFA enable/disable
- Recovery-code usage
- OAuth account link/unlink
- Device registration
- Device revoke
- Role or membership change
- Admin impersonation, if added

## Recommended Execution Order

The next best step is not another broad feature. The highest-leverage sequence is:

1. Add durable auth stores for OAuth state and linked identities. - implemented
2. Add client OAuth helpers. - implemented
3. Add desktop/mobile OAuth recipes into scaffolded apps.
4. Add password reset and email verification routes to `createKoraAuthServer`.
5. Add offline session policy as a first-class API.
6. Add durable stores for sessions, MFA, audit logs, webhooks, and rate limiting.
7. Add cookie mode and CSRF support for web apps.
8. Expand provider ecosystem.
9. Add lifecycle callbacks.
10. Run the full security hardening pass.

## North Star

Kora auth should not become a generic clone of web-first auth systems.

The goal is:

> The simplest production-grade auth system for offline-first apps across web, desktop, and mobile.

That means Kora auth should be:

- Easier to start than Clerk, NextAuth, or BetterAuth
- More production-ready for desktop and mobile than web-first auth libraries
- Built around trusted devices and offline policy
- Integrated with sync authorization from the beginning
- Durable by default in real apps
- Flexible without requiring users to assemble low-level primitives manually
