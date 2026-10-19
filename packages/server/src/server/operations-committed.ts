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
 * A deep copy of `value`. `structuredClone` when the whole value can be cloned; otherwise
 * (a function somewhere in `AuthContext.metadata`, say) the same copy made branch by
 * branch, so only what cannot be cloned is lost:
 *
 * - functions, symbols and uncloneable platform objects (a `WeakMap`, a `Promise`) are
 *   dropped: left out of an object, a `Map` or a `Set`, and `undefined` in an array (which
 *   keeps its positions);
 * - plain objects, arrays, `Map`s and `Set`s are copied member by member, keeping shared
 *   references and cycles;
 * - a class instance becomes a plain object of its own enumerable data, as
 *   `structuredClone` makes it;
 * - every other value `structuredClone` accepts (a `Date`, a `RegExp`, a typed array, an
 *   `Error`) is cloned as it is.
 *
 * The copy never shares a mutable object with the original.
 */
function cloneData<T>(value: T): T {
	try {
		return structuredClone(value)
	} catch {
		const copied = copyBranch(value, new Map())
		return (copied === DROPPED ? undefined : copied) as T
	}
}

/** A member {@link copyBranch} leaves out: it cannot be cloned. */
const DROPPED: unique symbol = Symbol('dropped')

function copyBranch(value: unknown, seen: Map<object, unknown>): unknown {
	if (typeof value === 'function' || typeof value === 'symbol') return DROPPED
	if (value === null || typeof value !== 'object') return value
	if (seen.has(value)) return seen.get(value)
	if (Array.isArray(value)) {
		const out: unknown[] = []
		seen.set(value, out)
		for (const item of value) {
			const copied = copyBranch(item, seen)
			out.push(copied === DROPPED ? undefined : copied)
		}
		return out
	}
	if (value instanceof Map) {
		const out = new Map<unknown, unknown>()
		seen.set(value, out)
		for (const [key, member] of value) {
			const copiedKey = copyBranch(key, seen)
			const copiedMember = copyBranch(member, seen)
			if (copiedKey !== DROPPED && copiedMember !== DROPPED) out.set(copiedKey, copiedMember)
		}
		return out
	}
	if (value instanceof Set) {
		const out = new Set<unknown>()
		seen.set(value, out)
		for (const member of value) {
			const copied = copyBranch(member, seen)
			if (copied !== DROPPED) out.add(copied)
		}
		return out
	}
	// A plain object or a class instance (`structuredClone` keeps a class instance's own
	// enumerable data and not its prototype): copied member by member.
	if (Object.prototype.toString.call(value) === '[object Object]') {
		const out: Record<string, unknown> = {}
		seen.set(value, out)
		for (const [key, member] of Object.entries(value)) {
			const copied = copyBranch(member, seen)
			// Defined, not assigned: assigning an own `__proto__` key (as `JSON.parse` makes)
			// would run the prototype setter and turn its data into inherited fields.
			if (copied !== DROPPED) {
				Object.defineProperty(out, key, {
					value: copied,
					enumerable: true,
					writable: true,
					configurable: true,
				})
			}
		}
		return out
	}
	// Any other built-in: cloned whole, or dropped when it cannot be cloned at all.
	try {
		const copied: unknown = structuredClone(value)
		seen.set(value, copied)
		return copied
	} catch {
		return DROPPED
	}
}

/**
 * Freeze an object and everything it holds, the keys and values of a `Map` and the
 * members of a `Set` included. Typed arrays and buffers cannot be frozen, and a frozen
 * `Map`, `Set` or `Date` can still be changed through its methods: each handler's copy is
 * its own, so such a change reaches nothing else.
 */
function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
	if (value === null || typeof value !== 'object') return value
	if (seen.has(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value
	seen.add(value)
	if (value instanceof Map) {
		for (const [key, member] of value) {
			deepFreeze(key, seen)
			deepFreeze(member, seen)
		}
	} else if (value instanceof Set) {
		for (const member of value) deepFreeze(member, seen)
	}
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
