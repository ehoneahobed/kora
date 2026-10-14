import type { AccessApi, ProductionHttpRouteContext } from '@korajs/server'
import type { SpaceRef, SpacesErrorCode } from '../protocol'
import type { Sharing } from '../schema/spaces-collections'
import { decideTransfer, runDecision } from './decisions'

/** Input of {@link transferSpace}. */
export interface TransferSpaceInput {
	sharing: Sharing
	space: SpaceRef
	toUserId: string
	/** The previous owner's role afterwards, or `leave`. Defaults to the manager role. */
	previousOwner?: string
}

/** Result of {@link transferSpace}. */
export type TransferSpaceResult =
	| { ok: true; previousOwnerId: string | null; invitationsRevoked: number }
	| { ok: false; code: SpacesErrorCode; message: string }

/**
 * Transfer a space from a script or an operator tool (for example when the owner's account
 * is gone): the same transaction as the transfer route, without the owner's consent and
 * without requiring the new owner to be a member. Use it instead of
 * `server.access.transfer`, which knows nothing of the kit's rows: this one also removes
 * the new owner's membership row, gives the previous owner `previousOwner` and revokes the
 * space's pending invitations.
 *
 * @param server - Anything with `kora` and `access` (a production server, or `{ kora: syncServer.getKoraContext(), access: syncServer.access }`)
 * @param input - The sharing configuration, the space and the new owner
 *
 * @example
 * ```typescript
 * await transferSpace(server, { sharing, space: ['forms', formId], toUserId: adminId })
 * ```
 */
export async function transferSpace(
	server: { kora: ProductionHttpRouteContext; access: AccessApi },
	input: TransferSpaceInput,
): Promise<TransferSpaceResult> {
	if (
		typeof input.toUserId !== 'string' ||
		input.toUserId.length === 0 ||
		!Object.prototype.hasOwnProperty.call(input.sharing.groups, input.space[0]) ||
		typeof input.space[1] !== 'string' ||
		input.space[1].length === 0
	) {
		return {
			ok: false,
			code: 'INVALID_REQUEST',
			message: 'Name a space of a shared collection and a user.',
		}
	}
	const result = await runDecision(server.kora, server.access, input.sharing, Date.now, (context) =>
		decideTransfer(context, {
			actorId: null,
			space: input.space,
			toUserId: input.toUserId,
			...(input.previousOwner ? { previousOwner: input.previousOwner } : {}),
			requireMember: false,
		}),
	)
	if (!result.ok) return { ok: false, code: result.code, message: result.message }
	return {
		ok: true,
		previousOwnerId: result.outcome.previousOwnerId,
		invitationsRevoked: result.outcome.invitationsRevoked,
	}
}
