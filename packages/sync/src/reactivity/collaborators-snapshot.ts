import type { AwarenessManager } from '../awareness/awareness-manager'
import type { AwarenessState } from '../awareness/types'

const EMPTY_COLLABORATORS: AwarenessState[] = []

function awarenessStatesEqual(left: AwarenessState[], right: AwarenessState[]): boolean {
	if (left.length !== right.length) {
		return false
	}

	for (let index = 0; index < left.length; index++) {
		const a = left[index]
		const b = right[index]
		if (!a || !b) {
			return false
		}
		if (a.user.name !== b.user.name || a.user.color !== b.user.color) {
			return false
		}
		const aCursor = a.cursor
		const bCursor = b.cursor
		if (aCursor === undefined && bCursor === undefined) {
			continue
		}
		if (!aCursor || !bCursor) {
			return false
		}
		if (
			aCursor.collection !== bCursor.collection ||
			aCursor.recordId !== bCursor.recordId ||
			aCursor.field !== bCursor.field ||
			aCursor.anchor !== bCursor.anchor ||
			aCursor.head !== bCursor.head
		) {
			return false
		}
	}

	return true
}

/**
 * Returns remote collaborators' awareness states (excludes the local client).
 */
export function getRemoteAwarenessStates(awareness: AwarenessManager): AwarenessState[] {
	const localClientId = awareness.clientId
	const remoteStates: AwarenessState[] = []

	for (const [clientId, state] of awareness.getStates()) {
		if (clientId === localClientId) continue
		remoteStates.push(state)
	}

	return remoteStates
}

/**
 * Subscribes to awareness changes and invokes `listener` only when the remote
 * collaborator set changes.
 */
export function subscribeRemoteAwarenessStates(
	awareness: AwarenessManager,
	listener: (states: AwarenessState[]) => void,
): () => void {
	let snapshot = EMPTY_COLLABORATORS

	const emitIfChanged = (): void => {
		const next = getRemoteAwarenessStates(awareness)
		if (awarenessStatesEqual(snapshot, next)) {
			return
		}
		snapshot = next
		listener(snapshot)
	}

	emitIfChanged()
	return awareness.on('change', emitIfChanged)
}
