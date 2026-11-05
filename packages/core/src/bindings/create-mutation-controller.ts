import type { KoraEventEmitter } from '../events/events'
import { runAllowingPreReadyWrites } from '../writes/pre-ready-writes'
import { runWithWriteObserver } from '../writes/write-observer'
import type { MutationRejection, UseMutationOptions } from './types'
import { type WriteRejectionEvent, subscribeWriteRejections } from './write-rejections'

/**
 * How many writes one mutation controller keeps watching for a refusal. A write is
 * forgotten once the server stored all of it or refused it; writes that never sync (a
 * local-only collection, a device that stays offline) are evicted oldest first past
 * this bound. An evicted write's refusal is still reported by the app-level
 * `sync:operation-rejected` event and kept in `app.sync.getRejectedOperations()`.
 */
export const MAX_TRACKED_WRITES = 500

export interface MutationControllerState {
	isLoading: boolean
	error: Error | null
	/** The most recent server refusal of a write made through this controller, or null. */
	rejected: MutationRejection | null
}

export interface MutationController<TData, TArgs extends unknown[], TContext = void> {
	getSnapshot(): MutationControllerState
	subscribe(listener: () => void): () => void
	mutate(...args: TArgs): void
	mutateAsync(...args: TArgs): Promise<TData>
	reset(): void
	destroy(): void
}

export interface CreateMutationControllerOptions<TData, TArgs extends unknown[], TContext = void> {
	mutationFn: (...args: TArgs) => Promise<TData>
	options?: UseMutationOptions<TData, TArgs, TContext>
	/** Reads latest options on each mutation (for framework hooks with ref-backed options). */
	resolveOptions?: () => UseMutationOptions<TData, TArgs, TContext> | undefined
	onStateChange?: (state: MutationControllerState) => void
	/**
	 * The app's event emitter. With it, the controller remembers the operations each call
	 * committed and reports a permanent server refusal of one (`rejected`, `onRejected`).
	 * Without it (no app, a bare store) refusals are not tracked.
	 */
	events?: KoraEventEmitter | null
}

/** One call's committed operations, watched until the server stored or refused them. */
interface TrackedWrite {
	operationIds: string[]
	/** Ids not yet stored on the server. */
	pending: Set<string>
	args: unknown[]
}

/**
 * Framework-agnostic mutation runner with optimistic lifecycle hooks and server
 * rejection tracking.
 */
export function createMutationController<TData, TArgs extends unknown[], TContext = void>(
	options: CreateMutationControllerOptions<TData, TArgs, TContext>,
): MutationController<TData, TArgs, TContext> {
	let snapshot: MutationControllerState = { isLoading: false, error: null, rejected: null }
	const listeners = new Set<() => void>()
	let disposed = false
	let inFlight = 0
	const events = options.events ?? null

	// Insertion-ordered, so the oldest write is evicted first.
	const writes = new Set<TrackedWrite>()
	const writeByOperation = new Map<string, TrackedWrite>()

	const notify = (): void => {
		for (const listener of listeners) {
			listener()
		}
		options.onStateChange?.(snapshot)
	}

	const setSnapshot = (next: MutationControllerState): void => {
		snapshot = next
		notify()
	}

	const getSnapshot = (): MutationControllerState => snapshot

	const subscribe = (listener: () => void): (() => void) => {
		listeners.add(listener)
		return () => {
			listeners.delete(listener)
		}
	}

	const forget = (write: TrackedWrite): void => {
		writes.delete(write)
		for (const id of write.operationIds) {
			if (writeByOperation.get(id) === write) writeByOperation.delete(id)
		}
	}

	const track = (operationIds: readonly string[], args: unknown[]): void => {
		if (disposed || operationIds.length === 0) return
		const write: TrackedWrite = {
			operationIds: [...operationIds],
			pending: new Set(operationIds),
			args,
		}
		writes.add(write)
		for (const id of operationIds) writeByOperation.set(id, write)
		while (writes.size > MAX_TRACKED_WRITES) {
			const oldest = writes.values().next().value
			if (oldest === undefined) break
			forget(oldest)
		}
	}

	const onRejection = (event: WriteRejectionEvent): void => {
		const write = writeByOperation.get(event.operationId)
		if (!write || disposed) return
		// One report per write: a refusal of its other operations is the same write failing.
		forget(write)
		const rejection: MutationRejection<TArgs> = {
			code: event.code,
			message: event.message,
			collection: event.collection,
			recordId: event.recordId,
			operationId: event.operationId,
			operationIds: write.operationIds,
			reverted: event.reverted,
			args: write.args as TArgs,
		}
		setSnapshot({ ...snapshot, rejected: rejection as MutationRejection })
		const opts = options.resolveOptions?.() ?? options.options
		try {
			opts?.onRejected?.(rejection)
		} catch (error) {
			// The app's callback threw: report it without breaking sync event delivery.
			queueMicrotask(() => {
				throw error
			})
		}
	}

	const onAcknowledged = (operationIds: readonly string[]): void => {
		for (const id of operationIds) {
			const write = writeByOperation.get(id)
			if (!write) continue
			writeByOperation.delete(id)
			write.pending.delete(id)
			if (write.pending.size === 0) forget(write)
		}
	}

	const onRewritten = (idMapping: Record<string, string>): void => {
		for (const [oldId, newId] of Object.entries(idMapping)) {
			const write = writeByOperation.get(oldId)
			if (!write) continue
			writeByOperation.delete(oldId)
			writeByOperation.set(newId, write)
			if (write.pending.delete(oldId)) write.pending.add(newId)
			write.operationIds = write.operationIds.map((id) => (id === oldId ? newId : id))
		}
	}

	const unsubscribeEvents: Array<() => void> = events
		? [
				subscribeWriteRejections(events, onRejection),
				events.on('sync:operations-acknowledged', (event) => onAcknowledged(event.operationIds)),
				events.on('sync:operations-rewritten', (event) => onRewritten(event.idMapping)),
			]
		: []

	const reset = (): void => {
		if (disposed) return
		setSnapshot({ isLoading: false, error: null, rejected: null })
	}

	const runMutation = (args: TArgs): Promise<TData> => {
		// Called through a binding, a collection write made before `app.ready` is queued
		// (journaled, then applied when the store opens) instead of throwing.
		if (!events) return runAllowingPreReadyWrites(() => options.mutationFn(...args))
		let write: TrackedWrite | null = null
		// Several writes of one call (two inserts, an insert after a transaction) are one
		// mutation: later ones join the write the call already has.
		// The writes the function starts synchronously (a collection method, a transaction)
		// report their committed operation ids here, before the ids reach sync.
		return runWithWriteObserver(
			{
				onOperations: (operations) => {
					const ids = operations.map((op) => op.id)
					if (write === null || !writes.has(write)) {
						track(ids, args)
						write = writeByOperation.get(ids[0] ?? '') ?? null
						return
					}
					for (const id of ids) {
						write.operationIds.push(id)
						write.pending.add(id)
						writeByOperation.set(id, write)
					}
				},
			},
			() => runAllowingPreReadyWrites(() => options.mutationFn(...args)),
		)
	}

	const mutateAsync = async (...args: TArgs): Promise<TData> => {
		if (disposed) {
			throw new Error('Mutation controller is destroyed')
		}

		const opts = options.resolveOptions?.() ?? options.options
		let context: TContext | undefined

		inFlight++
		setSnapshot({ ...snapshot, isLoading: true, error: null })

		try {
			if (opts?.onMutate) {
				context = await opts.onMutate(...args)
			}

			const result = await runMutation(args)
			inFlight = Math.max(0, inFlight - 1)
			setSnapshot({ ...snapshot, isLoading: inFlight > 0, error: null })
			opts?.onSuccess?.(result, ...args)
			opts?.onSettled?.(result, null, ...args)
			return result
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err))

			if (context !== undefined && opts?.onRollback) {
				await opts.onRollback(context, ...args)
			}

			inFlight = Math.max(0, inFlight - 1)
			setSnapshot({ ...snapshot, isLoading: inFlight > 0, error })
			opts?.onError?.(error, ...args)
			opts?.onSettled?.(undefined, error, ...args)
			throw error
		}
	}

	const mutate = (...args: TArgs): void => {
		void mutateAsync(...args).catch(() => {})
	}

	const destroy = (): void => {
		disposed = true
		listeners.clear()
		// Nothing is reported to an unmounted hook; the app-level `sync:operation-rejected`
		// event and the durable rejected list still report the refusal.
		for (const off of unsubscribeEvents.splice(0)) off()
		writes.clear()
		writeByOperation.clear()
	}

	return {
		getSnapshot,
		subscribe,
		mutate,
		mutateAsync,
		reset,
		destroy,
	}
}
