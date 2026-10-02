import type { KoraEventEmitter, Operation } from '@korajs/core'
import type { Store } from '@korajs/store'

const MESSAGE_TYPE = 'kora-local-operation'

interface LocalOperationMessage {
	type: typeof MESSAGE_TYPE
	originId: string
	operation: Operation
}

/**
 * Keeps same-origin app instances backed by the same local database reactive.
 *
 * The storage leader/follower path makes all tabs read and write one durable
 * database. A write committed in tab A, however, only invalidates tab A's in-memory
 * subscriptions unless the other tabs are told that a committed operation exists.
 * This bus carries that notification for local writes (`operation:created`) AND
 * for remote operations applied by sync (`operation:applied`): a tab that is not
 * syncing still sees what the syncing tab received (STORE-10). Receivers do not
 * reapply the operation; they only ask their Store to advance in-memory
 * watermarks and refetch affected queries.
 */
export function wireLocalOperationBus(
	dbName: string,
	store: Store,
	emitter: KoraEventEmitter,
): () => void {
	if (typeof BroadcastChannel === 'undefined') {
		return () => {}
	}

	const originId = createOriginId()
	const channel = new BroadcastChannel(`kora-local-ops-${dbName}`)

	const onMessage = (event: MessageEvent<LocalOperationMessage>): void => {
		const message = event.data
		if (
			message?.type !== MESSAGE_TYPE ||
			message.originId === originId ||
			!isOperationLike(message.operation)
		) {
			return
		}
		store.notifyExternalOperation(message.operation)
	}

	channel.addEventListener('message', onMessage)
	const broadcast = (operation: Operation): void => {
		const message: LocalOperationMessage = { type: MESSAGE_TYPE, originId, operation }
		channel.postMessage(message)
	}
	const unsubscribeCreated = emitter.on('operation:created', (event) => broadcast(event.operation))
	const unsubscribeApplied = emitter.on('operation:applied', (event) => broadcast(event.operation))

	return () => {
		unsubscribeCreated()
		unsubscribeApplied()
		channel.removeEventListener('message', onMessage)
		channel.close()
	}
}

function createOriginId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID()
	}
	return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function isOperationLike(value: unknown): value is Operation {
	if (!value || typeof value !== 'object') {
		return false
	}
	const candidate = value as Partial<Operation>
	return (
		typeof candidate.id === 'string' &&
		typeof candidate.collection === 'string' &&
		typeof candidate.recordId === 'string' &&
		typeof candidate.nodeId === 'string' &&
		typeof candidate.sequenceNumber === 'number'
	)
}
