// @korajs/auth/react — React-specific public API
// Every export here is a public API commitment. Be explicit.

// === Provider ===
export { AuthProvider } from './react/AuthProvider'
export type { AuthProviderProps } from './react/AuthProvider'

// === Hooks ===
export { useAuth, useCurrentUser, useAuthStatus } from './react/hooks'
export type { UseAuthResult, AuthStatus } from './react/hooks'

// === Context (for advanced use cases) ===
export { AuthContext } from './react/auth-context'
export type { AuthContextValue } from './react/auth-context'

// === Organization Hooks ===
export { OrgProvider } from './react/OrgProvider'
export type { OrgProviderProps } from './react/OrgProvider'
export { OrgContext, useOrg, useOrgMembers, usePermission, checkOrgPermission } from './react/org-hooks'
export type { OrgContextValue, UseOrgResult, UseOrgMembersResult } from './react/org-hooks'
