import { KoraError } from '@korajs/core'
import type { KoraConfig } from './types'

/**
 * Thrown (as the rejection of `app.ready` and of every call that awaits it) by an app
 * that `createApp` left inert because it was created during server rendering.
 */
export class ServerRenderingAppError extends KoraError {
	constructor() {
		super(
			'This Kora app was created during server rendering (no `window`), so it has no local database. ' +
				'Kora data lives on the device: read and write it from client components.',
			'SSR_INERT_APP',
			{
				fix:
					"Mark the component that calls createApp/useQuery with 'use client' and render <KoraProvider app={app}> there; " +
					'on the server it renders its fallback. In a Node.js program (not a server render) pass ssr: false ' +
					"or store: { adapter: 'better-sqlite3' } to open a database.",
			},
		)
		this.name = 'ServerRenderingAppError'
	}
}

/**
 * Whether `createApp` must stay inert (open no storage adapter, start no sync) because
 * it runs during a server render (DX-6): Next.js and Remix evaluate client modules on
 * the server too, and a module-scope `createApp` would otherwise open a native SQLite
 * database in the server process for every module instance.
 *
 * - `ssr: false`: never inert (a Node.js program that wants a real database).
 * - `ssr: true`: inert whenever there is no `window`.
 * - unset: inert when there is no `window` and no worker scope, unless the app names
 *   the Node.js adapter explicitly (`store.adapter: 'better-sqlite3'`), which only a
 *   Node.js program does.
 *
 * @param config - The createApp configuration
 * @param scope - The global scope to inspect (tests pass a fake)
 * @returns True when the app must not open storage
 */
export function isServerRenderingInert(
	config: Pick<KoraConfig, 'ssr' | 'store'>,
	scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
): boolean {
	if (config.ssr === false) return false
	const hasWindow = typeof scope.window !== 'undefined'
	if (hasWindow) return false
	if (config.ssr === true) return true
	// Web and shared workers have no window but are clients, not server renders.
	const inWorker =
		typeof scope.WorkerGlobalScope !== 'undefined' && typeof scope.importScripts === 'function'
	if (inWorker) return false
	return config.store?.adapter !== 'better-sqlite3'
}
