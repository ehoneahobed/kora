import type { Operation } from '@korajs/core'
import type { AuthContext } from '../types'

/**
 * Where a committed batch came from.
 *
 * - `sync`: a device's upload over WebSocket or HTTP long-polling, together with the
 *   referential side effects (cascade, set-null) and cross-record corrections the server
 *   derived from it.
 * - `server`: a server-authored write: `server.kora` (`apply`, `applyConditional`,
 *   `transaction`), `server.access`, the `@korajs/spaces` routes, a validator writing
 *   through `context.kora`, `applyLocalOperation` or `relayServerOperations`.
 */
export type CommittedOperationsSource = 'sync' | 'server'

/** What the server knows about a committed batch besides its operations. */
export interface OperationsCommittedContext {
	/** Where the batch came from. */
	readonly source: CommittedOperationsSource
	/**
	 * The committing sync session's auth context (`source: 'sync'`); `null` for a
	 * server-authored write.
	 */
	readonly auth: AuthContext | null
	/** The committing sync session's id (`source: 'sync'`); `null` otherwise. */
	readonly sessionId: string | null
}

/**
 * Called once per batch of operations after they are durably committed on this server
 * instance (see `KoraSyncServerConfig.onOperationsCommitted`). Each handler gets its own
 * deep, frozen copy of the operations (in commit order, exactly as stored) and of the
 * context, including `auth`: changing them is refused and never reaches the session. The server does not await the result: a thrown
 * error or a rejected promise is logged, counted and emitted, and never affects the
 * commit, the acknowledgment or the fan-out.
 */
export type OperationsCommittedHandler = (
	operations: readonly Operation[],
	context: OperationsCommittedContext,
) => void | Promise<void>

/** A handler that threw or rejected, as reported to {@link CommitHookFailureReporter}. */
export interface CommitHookFailure {
	readonly error: unknown
	readonly operations: readonly Operation[]
	readonly context: OperationsCommittedContext
}

/** Receives every handler failure (the server logs it and emits an event). */
export type CommitHookFailureReporter = (failure: CommitHookFailure) => void

/**
 * Holds the registered {@link OperationsCommittedHandler}s and calls them for each
 * committed batch, isolating the commit path from them.
 */
export class OperationsCommittedHooks {
	private readonly handlers = new Set<OperationsCommittedHandler>()

	constructor(private readonly reportFailure: CommitHookFailureReporter) {}

	/**
	 * Register a handler.
	 *
	 * @returns A function that removes it again
	 */
	add(handler: OperationsCommittedHandler): () => void {
		// A wrapper per registration, so the same function registered twice runs twice and
		// each unsubscribe removes exactly its own registration.
		const entry: OperationsCommittedHandler = (operations, context) => handler(operations, context)
		this.handlers.add(entry)
		return () => {
			this.handlers.delete(entry)
		}
	}

	/** True when at least one handler is registered. */
	hasHandlers(): boolean {
		return this.handlers.size > 0
	}

	/**
	 * Call every handler with a batch that has committed. Never throws and never waits
	 * for a handler: the commit already happened, and nothing a handler does may undo or
	 * delay it.
	 *
	 * @param operations - The committed operations, in commit order
	 * @param context - Where they came from
	 */
	dispatch(operations: readonly Operation[], context: OperationsCommittedContext): void {
		if (operations.length === 0 || this.handlers.size === 0) return
		for (const handler of [...this.handlers]) {
			// Each handler gets its own deep, frozen copy of the operations and the context:
			// the operations are still being relayed to sessions (asynchronously) and are
			// immutable, and `context.auth` is the committing session's live credential, whose
			// scopes, grants and metadata decide its later reads and writes. Nothing a handler
			// does to what it was given may reach either, or the next handler.
			let batch: readonly Operation[] = operations
			let handlerContext: OperationsCommittedContext = context
			try {
				batch = deepFreeze(cloneData([...operations]))
				handlerContext = deepFreeze({
					source: context.source,
					sessionId: context.sessionId,
					auth: context.auth === null ? null : cloneData(context.auth),
				})
				const outcome = handler(batch, handlerContext)
				// Inside the try: reading `then` on a hostile object may throw, and a thenable
				// is adopted through Promise.resolve so a `then` that throws becomes a
				// rejection here, never an exception in the write path.
				if (isPromiseLike(outcome)) {
					Promise.resolve(outcome).catch((error: unknown) =>
						this.report({ error, operations: batch, context: handlerContext }),
					)
				}
			} catch (error) {
				this.report({ error, operations: batch, context: handlerContext })
			}
		}
	}

	private report(failure: CommitHookFailure): void {
		try {
			this.reportFailure(failure)
		} catch (reportError) {
			// The reporter is the server's own logger and emitter. A failing logger must not
			// turn a hook failure into a failed commit path, and the failure must still be
			// visible somewhere: standard error is the last place left.
			console.error('[kora] onOperationsCommitted failed and could not be reported', {
				error: describeError(failure.error),
				reportError: describeError(reportError),
			})
		}
	}
}

/**
 * A deep copy of plain data. `structuredClone` when it can (dates, maps, typed arrays,
 * cycles); otherwise (a function somewhere in `AuthContext.metadata`, say) a copy of
 * the own enumerable data with functions and symbols left out, so the copy never
 * shares a mutable object with the original.
 */
function cloneData<T>(value: T): T {
	try {
		return structuredClone(value)
	} catch {
		return plainCopy(value, new WeakMap()) as T
	}
}

function plainCopy(value: unknown, seen: WeakMap<object, unknown>): unknown {
	if (typeof value === 'function' || typeof value === 'symbol') return undefined
	if (value === null || typeof value !== 'object') return value
	const known = seen.get(value)
	if (known !== undefined) return known
	if (Array.isArray(value)) {
		const out: unknown[] = []
		seen.set(value, out)
		for (const item of value) out.push(plainCopy(item, seen))
		return out
	}
	const out: Record<string, unknown> = {}
	seen.set(value, out)
	for (const [key, member] of Object.entries(value)) {
		const copied = plainCopy(member, seen)
		if (copied !== undefined) out[key] = copied
	}
	return out
}

/**
 * Freeze an object and everything it holds. Typed arrays and buffers cannot be frozen
 * and are left as they are (each handler's copy is its own, so they share nothing).
 */
function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
	if (value === null || typeof value !== 'object') return value
	if (seen.has(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value
	seen.add(value)
	for (const member of Object.values(value)) deepFreeze(member, seen)
	return Object.freeze(value)
}

/** A thrown value as a message, for logs and events. */
export function describeError(error: unknown): string {
	try {
		return error instanceof Error ? error.message : String(error)
	} catch {
		// A thrown object whose toString throws (or a revoked proxy) still gets reported.
		return 'An error that cannot be converted to a string was thrown.'
	}
}

function isPromiseLike(value: unknown): value is PromiseLike<void> {
	return (
		value !== null &&
		(typeof value === 'object' || typeof value === 'function') &&
		typeof (value as { then?: unknown }).then === 'function'
	)
}
