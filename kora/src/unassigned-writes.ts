import { SyncError } from '@korajs/core'
import type { KoraEventEmitter } from '@korajs/core'
import type { HeldNodeInfo } from '@korajs/sync'
import type { KoraConfig } from './types'

/** What the policy needs from the sync engine. */
export interface UnassignedWritesEngine {
	getHeldNodes(): Promise<HeldNodeInfo[]>
	assignHeld(nodeId: string): Promise<void>
	reconnect(): Promise<void>
}

/** Held-node errors that only mean "nothing to assign now" (signed out, already bound). */
const NOT_ASSIGNABLE = new Set(['HELD_ASSIGN_NO_USER', 'HELD_NODE_NOT_ASSIGNABLE'])

/**
 * `sync.unassignedWrites: 'assign-to-first-user'` (RT-50 opt-out). Writes made on a
 * database that never synced, before the app knew who was signed in, are held as
 * `unassigned` by default (`'hold'`). With this policy they are assigned to the first
 * user the sync server ACCEPTS a session for (on `sync:connected`), and upload on the
 * next session. Writes held for another user (`other-user`) are never touched, and a
 * user the server refuses never gets a session, so never gets them.
 *
 * @param getEngine - The app's current sync engine (null after close)
 * @param isIntentionallyOffline - True while the app disconnected sync on purpose
 * @returns Unsubscribe function (a no-op with the default `'hold'`)
 */
export function wireUnassignedWritesPolicy(
	config: KoraConfig,
	emitter: KoraEventEmitter,
	getEngine: () => UnassignedWritesEngine | null,
	isIntentionallyOffline: () => boolean,
): () => void {
	if (config.sync?.unassignedWrites !== 'assign-to-first-user') return () => {}
	let running: Promise<void> | null = null
	return emitter.on('sync:connected', () => {
		if (running) return
		running = assignUnassigned(getEngine, isIntentionallyOffline).finally(() => {
			running = null
		})
	})
}

async function assignUnassigned(
	getEngine: () => UnassignedWritesEngine | null,
	isIntentionallyOffline: () => boolean,
): Promise<void> {
	const engine = getEngine()
	if (!engine) return
	let assigned = 0
	try {
		for (const node of await engine.getHeldNodes()) {
			if (node.reason !== 'unassigned') continue
			try {
				await engine.assignHeld(node.nodeId)
				assigned++
			} catch (error) {
				const code = error instanceof SyncError ? error.context?.code : undefined
				if (typeof code === 'string' && NOT_ASSIGNABLE.has(code)) continue
				throw error
			}
		}
		// The assigned writes upload on a session as their node: start one now.
		if (assigned > 0 && getEngine() === engine && !isIntentionallyOffline()) {
			await engine.reconnect()
		}
	} catch (error) {
		// Never silent: the writes stay held (status.heldNodes) and the next accepted
		// session tries again.
		console.warn('[kora] Could not assign unassigned held writes to the signed-in user:', error)
	}
}
