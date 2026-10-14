import { KoraError } from '@korajs/core'
import { groupKey } from '@korajs/core/internal'
import type {
	AcceptInvitationResponse,
	CreateInvitationResponse,
	InvitationDescription,
	MemberChangeResponse,
	SpaceRef,
	SpacesErrorCode,
} from '../protocol'
import { SPACE_MEMBERS } from '../schema/spaces-collections'

/** The parts of a Kora app the client reads: the local members collection. */
export interface SpacesAppLike {
	collections: Readonly<
		Record<
			string,
			{
				where(conditions: Record<string, unknown>): {
					subscribe(callback: (rows: readonly Record<string, unknown>[]) => void): () => void
				}
			}
		>
	>
}

/** Options of {@link createSpaces}. */
export interface SpacesClientOptions {
	/** Where `spacesRoutes` is mounted (default `/api/spaces`). */
	basePath?: string
	/** The server origin, when the routes are not on the page's own origin (`https://api.example.com`). */
	baseUrl?: string
	/**
	 * Headers for every request, usually the signed-in user's bearer token:
	 * `headers: async () => ({ authorization: \`Bearer ${await getAccessToken()}\` })`.
	 */
	headers?: () => Promise<Record<string, string>> | Record<string, string>
	/** A fetch implementation (default: the global `fetch`). */
	fetch?: typeof fetch
}

/** A refusal from the spaces routes. `code` is stable; `message` is for people. */
export class SpacesError extends KoraError {
	constructor(
		readonly spacesCode: SpacesErrorCode | 'OFFLINE',
		message: string,
		readonly status: number,
	) {
		super(message, spacesCode, { status })
		this.name = 'SpacesError'
	}
}

/**
 * The server could not be reached. Sharing changes are server decisions, so nothing is
 * queued: try again when online.
 */
export class SpacesOfflineError extends SpacesError {
	constructor(cause: unknown) {
		super(
			'OFFLINE',
			'You are offline. Sharing changes need a connection; try again when you are back online.',
			0,
		)
		this.name = 'SpacesOfflineError'
		this.cause = cause
	}
}

/** Result of {@link SpacesClient.accept}. */
export interface AcceptResult extends AcceptInvitationResponse {
	/**
	 * True when the membership is on the server but has not reached this device yet
	 * (offline, or slower than `timeoutMs`). It arrives with the next sync.
	 */
	pending: boolean
}

/** The sharing actions, each one request to the server. */
export interface SpacesClient {
	/** Invite `email` to `space` (or re-send their pending invitation with a new link). */
	invite(space: SpaceRef, input: { email: string; role: string }): Promise<CreateInvitationResponse>
	/** Revoke a pending invitation. */
	revokeInvitation(invitationId: string): Promise<void>
	/** What the invitation behind `token` grants, for an accept page. */
	describe(token: string): Promise<InvitationDescription>
	/**
	 * Accept the invitation behind `token`. Resolves once this device has the new
	 * membership (so the space's data is on its way), or after `timeoutMs` (default 10 s)
	 * with `pending: true`.
	 */
	accept(token: string, options?: { timeoutMs?: number }): Promise<AcceptResult>
	/** Decline the invitation behind `token`. */
	decline(token: string): Promise<void>
	/** Change a member's role. Pass `from` (the role you saw) to refuse if it changed meanwhile. */
	changeRole(
		space: SpaceRef,
		userId: string,
		role: string,
		options?: { from?: string },
	): Promise<MemberChangeResponse>
	/** Remove a member. */
	remove(
		space: SpaceRef,
		userId: string,
		options?: { from?: string },
	): Promise<MemberChangeResponse>
	/** Leave a space (not the owner, who transfers it first). */
	leave(space: SpaceRef): Promise<MemberChangeResponse>
	/** Give the space to a member. You keep `previousOwner` (the manager role by default), or pass `'leave'`. */
	transfer(
		space: SpaceRef,
		toUserId: string,
		options?: { previousOwner?: string },
	): Promise<MemberChangeResponse>
}

const DEFAULT_ACCEPT_TIMEOUT_MS = 10_000

/**
 * The client of `spacesRoutes`.
 *
 * @param app - The Kora app (for `accept` to wait until the membership arrives)
 * @param options - Where the routes are and how to authenticate
 *
 * @example
 * ```typescript
 * const spaces = createSpaces(app, {
 *   headers: async () => ({ authorization: `Bearer ${await auth.getAccessToken()}` }),
 * })
 * await spaces.invite(['forms', formId], { email: 'bob@example.com', role: 'editor' })
 * ```
 */
export function createSpaces(app: SpacesAppLike, options: SpacesClientOptions = {}): SpacesClient {
	// One leading slash, no trailing one, so a relative `api/spaces` never resolves
	// against the current page.
	const path = `/${(options.basePath ?? '/api/spaces').replace(/^\/+|\/+$/g, '')}`
	const base = `${options.baseUrl?.replace(/\/+$/, '') ?? ''}${path}`

	const post = async <T>(path: string, body: unknown): Promise<T> => {
		const doFetch = options.fetch ?? globalThis.fetch
		let response: Response
		try {
			response = await doFetch(`${base}${path}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...(await options.headers?.()) },
				body: JSON.stringify(body),
				credentials: 'same-origin',
				referrerPolicy: 'no-referrer',
			})
		} catch (error) {
			throw new SpacesOfflineError(error)
		}
		let parsed: unknown = null
		try {
			parsed = await response.json()
		} catch {
			parsed = null
		}
		if (response.ok && (parsed === null || typeof parsed !== 'object')) {
			// A success that is not our JSON (a captive portal, a proxy page): not the server.
			throw new SpacesOfflineError(new Error(`Unexpected response from ${path}`))
		}
		if (!response.ok) {
			const error = (parsed as { error?: { code?: string; message?: string } } | null)?.error
			if (!error?.code) {
				// Not our routes answering (a proxy, a captive portal): treat as unreachable.
				throw new SpacesOfflineError(new Error(`HTTP ${response.status}`))
			}
			throw new SpacesError(
				error.code as SpacesErrorCode,
				error.message ?? error.code,
				response.status,
			)
		}
		return parsed as T
	}

	/**
	 * Resolve true once the caller's own membership row of `space`, with the accepted role,
	 * is on this device (a row left from an earlier membership whose removal has not synced
	 * yet does not count unless it already holds that role).
	 */
	const waitForMembership = (
		space: SpaceRef,
		userId: string,
		role: string,
		timeoutMs: number,
	): Promise<boolean> =>
		new Promise((resolve) => {
			const collection = app.collections[SPACE_MEMBERS]
			if (!collection) {
				resolve(false)
				return
			}
			let settled = false
			let unsubscribe: (() => void) | null = null
			const finish = (arrived: boolean): void => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				queueMicrotask(() => unsubscribe?.())
				resolve(arrived)
			}
			const timer = setTimeout(() => finish(false), timeoutMs)
			unsubscribe = collection
				.where({ group: groupKey(space[0], space[1]), userId })
				.subscribe((rows) => {
					if (rows.some((row) => row.role === role)) finish(true)
				})
			if (settled) unsubscribe()
		})

	return {
		invite: (space, input) =>
			post('/invitations/create', { space, email: input.email, role: input.role }),
		async revokeInvitation(invitationId) {
			await post('/invitations/revoke', { invitationId })
		},
		describe: (token) => post('/invitations/describe', { token }),
		async accept(token, acceptOptions) {
			const accepted = await post<AcceptInvitationResponse>('/invitations/accept', { token })
			const arrived = await waitForMembership(
				accepted.space,
				accepted.userId,
				accepted.role,
				acceptOptions?.timeoutMs ?? DEFAULT_ACCEPT_TIMEOUT_MS,
			)
			return { ...accepted, pending: !arrived }
		},
		async decline(token) {
			await post('/invitations/decline', { token })
		},
		changeRole: (space, userId, role, changeOptions) =>
			post('/members/role', {
				space,
				userId,
				role,
				...(changeOptions?.from ? { from: changeOptions.from } : {}),
			}),
		remove: (space, userId, removeOptions) =>
			post('/members/remove', {
				space,
				userId,
				...(removeOptions?.from ? { from: removeOptions.from } : {}),
			}),
		leave: (space) => post('/leave', { space }),
		transfer: (space, toUserId, transferOptions) =>
			post('/transfer', {
				space,
				toUserId,
				...(transferOptions?.previousOwner ? { previousOwner: transferOptions.previousOwner } : {}),
			}),
	}
}
