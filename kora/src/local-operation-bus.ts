import type { KoraEventEmitter, Operation } from '@korajs/core'
import type { RecordsChange, Store } from '@korajs/store'

const MESSAGE_TYPE = 'kora-local-operation'
const CHANGE_MESSAGE_TYPE = 'kora-records-changed'

interface LocalOperationMessage {
	type: typeof MESSAGE_TYPE
	originId: string
	operation: Operation
}

interface RecordsChangedMessage {
	type: typeof CHANGE_MESSAGE_TYPE
	originId: string
	collection: string
	ids: string[] | null
}

/**
 * Keeps same-origin app instances backed by the same local database reactive.
 *
 * The storage leader/follower path makes all tabs read and write one durable
 * database. A change committed in tab A, however, only invalidates tab A's in-memory
 * subscriptions unless the other tabs are told about it.
 *
 * Every broadcast comes from ONE source (RT-98): the Store's committed-change funnel
 * (`store.onRecordsChanged`), which every subscription invalidation the Store makes
 * passes through. Local writes and remote applies (STORE-10) travel as their operation
 * (receivers also advance in-memory watermarks); changes made without an operation
 * (re-folds after a terminal rejection, scope retraction and narrowing, provisional
 * cascade settling, authority re-folds, rematerialization, backup restore, held or
 * discarded writes) travel as "records changed (collection, ids)". No invalidation
 * path can refresh this tab without refreshing the others. Receivers never reapply
 * anything; they only re-run their affected live queries.
 */
export function wireLocalOperationBus(
	dbName: string,
	store: Store,
	_emitter: KoraEventEmitter,
): () => void {
	if (typeof BroadcastChannel === 'undefined') {
		return () => {}
	}

	const originId = createOriginId()
	const channel = new BroadcastChannel(`kora-local-ops-${dbName}`)

	const onMessage = (event: MessageEvent<LocalOperationMessage | RecordsChangedMessage>): void => {
		const message = event.data
		if (!message || message.originId === originId) return
		if (message.type === CHANGE_MESSAGE_TYPE) {
			if (typeof message.collection === 'string') store.notifyExternalChange(message.collection)
			return
		}
		if (message.type !== MESSAGE_TYPE || !isOperationLike(message.operation)) return
		store.notifyExternalOperation(message.operation)
	}

	channel.addEventListener('message', onMessage)
	const unsubscribeChanges = store.onRecordsChanged((change: RecordsChange) => {
		if (change.operation) {
			const message: LocalOperationMessage = {
				type: MESSAGE_TYPE,
				originId,
				operation: change.operation,
			}
			channel.postMessage(message)
			return
		}
		const message: RecordsChangedMessage = {
			type: CHANGE_MESSAGE_TYPE,
			originId,
			collection: change.collection,
			ids: change.ids ? [...change.ids] : null,
		}
		channel.postMessage(message)
	})

	return () => {
		unsubscribeChanges()
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
