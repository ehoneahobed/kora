import type { AuthSyncBinding } from '@korajs/core/bindings'
import type { ReadThroughError } from '@korajs/sync/read'

/** The credential provider the read-through client calls before each request. */
export type ReadThroughAuth = (options?: { forceRefresh?: boolean }) => Promise<{ token: string }>

/**
 * Builds the credential provider of the read-through client from a `sync.authClient`
 * binding, so apps that sign in through `@korajs/auth` answer their first screen from the
 * server like apps with a plain `sync.auth`.
 *
 * The read endpoint judges the bearer token alone, so a request without a signed-in user
 * would only be refused. The provider therefore stands aside (a non-retriable error, which
 * ends the read and lets the store answer when it opens) unless the binding reports a
 * signed-in session with a usable token. A session still being restored (`loading`) is a
 * retriable error: the client asks again after its backoff, by which time the session is
 * usually known. The binding's `auth` refreshes a token when asked with `forceRefresh`
 * (the client does so once after a 401).
 *
 * @param binding - The `sync.authClient` of the app
 * @param ErrorClass - The `ReadThroughError` class of `@korajs/sync/read` (passed in so
 *   this module stays free of a runtime import of the on-demand entry)
 * @returns The provider for `ReadThroughClient`'s `auth` option
 */
export function readThroughAuthFor(
	binding: AuthSyncBinding,
	ErrorClass: typeof ReadThroughError,
): ReadThroughAuth {
	return async (options) => {
		if (binding.resolveSyncState !== undefined) {
			const state = await binding.resolveSyncState()
			if (state.state === 'loading') {
				throw new ErrorClass(
					'The signed-in session is still being restored, so the read waits for it.',
					'READ_AUTH_LOADING',
					true,
				)
			}
			if (state.state !== 'authenticated') {
				throw new ErrorClass(
					'No user is signed in, so the first screen is answered by the local store.',
					'READ_NOT_SIGNED_IN',
					false,
				)
			}
		}
		const credential = await binding.auth(options)
		if (credential.token === '') {
			throw new ErrorClass(
				'The sign-in has no token yet, so the first screen is answered by the local store.',
				'READ_NO_CREDENTIAL',
				false,
			)
		}
		return credential
	}
}
