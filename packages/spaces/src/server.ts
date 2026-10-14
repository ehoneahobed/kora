// @korajs/spaces/server: the sharing routes and operator tools.
// Every export here is a public API commitment. Be explicit.

export { spacesRoutes } from './server/spaces-routes'
export type {
	BeforeInviteContext,
	BeforeInviteResult,
	InvitationDelivery,
	SpacesEvent,
	SpacesIdentity,
	SpacesLimits,
	SpacesRoutesOptions,
} from './server/spaces-routes'
export { transferSpace } from './server/transfer-space'
export type { TransferSpaceInput, TransferSpaceResult } from './server/transfer-space'
export { koraAuthIdentity } from './server/identity'
export type { KoraAuthIdentitySource, SpacesIdentityOptions } from './server/identity'
export { memoryLimiter } from './server/limiter'
export type { SpacesLimiter } from './server/limiter'
