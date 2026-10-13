// @korajs/spaces: sharing for Kora.js apps. The schema fragment and the wire types;
// the server routes, client and React hooks are in /server, /client and /react.
// Every export here is a public API commitment. Be explicit.

export {
	SPACE_INVITATIONS,
	SPACE_INVITATION_SECRETS,
	SPACE_MEMBERS,
	SpacesConfigError,
	spacesCollections,
} from './schema/spaces-collections'
export type {
	Sharing,
	SpacesCollectionsInput,
	SpacesConfig,
	SpacesGroupConfig,
} from './schema/spaces-collections'
export { SPACES_ERROR_CODES } from './protocol'
export type {
	AcceptInvitationResponse,
	CreateInvitationResponse,
	InvitationDescription,
	InvitationSummary,
	MemberChangeResponse,
	SpaceRef,
	SpacesErrorCode,
} from './protocol'
