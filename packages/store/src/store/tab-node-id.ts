import { generateUUIDv7 } from '@korajs/core'

export type StoreIsolation = 'shared' | 'per-tab'

function perTabStorageKey(dbName: string): string {
	return `kora-tab-node-${dbName}`
}

/**
 * Load a per-tab node id from sessionStorage (browser only).
 */
export function loadPerTabNodeId(dbName: string): string | null {
	if (typeof sessionStorage === 'undefined') {
		return null
	}
	return sessionStorage.getItem(perTabStorageKey(dbName))
}

/**
 * Persist a per-tab node id for this browser tab.
 */
export function savePerTabNodeId(dbName: string, nodeId: string): void {
	if (typeof sessionStorage === 'undefined') {
		return
	}
	sessionStorage.setItem(perTabStorageKey(dbName), nodeId)
}

/**
 * Resolve or create a node id for `per-tab` isolation.
 */
export function resolvePerTabNodeId(dbName: string): string {
	const existing = loadPerTabNodeId(dbName)
	if (existing) {
		return existing
	}
	const nodeId = generateUUIDv7()
	savePerTabNodeId(dbName, nodeId)
	return nodeId
}
