// @korajs/spaces/client: the sharing actions, one request each.
// Every export here is a public API commitment. Be explicit.

export { createSpaces, SpacesError, SpacesOfflineError } from './client/spaces-client'
export type {
	AcceptResult,
	SpacesAppLike,
	SpacesClient,
	SpacesClientOptions,
} from './client/spaces-client'
