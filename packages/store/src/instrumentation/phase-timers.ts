/**
 * Internal write-to-UI phase timers (instant-UI stage S0).
 *
 * Measures where the latency between `await collection.insert(...)` and a reactive
 * subscriber callback goes. This is a measurement aid for benchmarks and the
 * design doc `docs/design/instant-ui-updates.md`; it is NOT public API and is only
 * reachable through `@korajs/store/internal`.
 *
 * Cost when nothing is installed: one module-level null check per hook. Timers only
 * observe: no hook changes ordering, awaits or results of the write or read path.
 */

/** The kind of local write a record belongs to. */
export type PhaseWriteKind = 'insert' | 'update' | 'delete'

/**
 * Phases, in the order a write-to-callback travels through them.
 *
 * Write side (main thread view of `runLocalWrite`):
 * - `prepare`: validation, defaults, id generation before the transaction opens.
 * - `txOpen`: from calling `adapter.transaction` until the body starts (adapter mutex wait plus BEGIN round trip).
 * - `sequence`: sequence reservation inside the body (a subset of `body`).
 * - `body`: the transaction body (sequence reservation, operation build, buffered statements).
 * - `commit`: from the body returning until `adapter.transaction` resolves (flush of buffered statements plus COMMIT).
 * - `publish`: synchronous post-commit work (causal heads, observer, `subscriptionManager.notify`, `operation:created`).
 *
 * Read side (subscription manager, summed over every affected subscription):
 * - `flushDelay`: from `notify` to the start of the flush microtask.
 * - `findAffected`: choosing the affected subscriptions.
 * - `reread`: `executeFn` (adapter mutex wait plus the SELECT plus row decoding).
 * - `diffNotify`: result equality check plus the subscriber callback itself.
 */
export type PhaseName =
	| 'prepare'
	| 'txOpen'
	| 'sequence'
	| 'body'
	| 'commit'
	| 'publish'
	| 'flushDelay'
	| 'findAffected'
	| 'reread'
	| 'diffNotify'

/** All phase names, in travel order. */
export const PHASE_NAMES: readonly PhaseName[] = [
	'prepare',
	'txOpen',
	'sequence',
	'body',
	'commit',
	'publish',
	'flushDelay',
	'findAffected',
	'reread',
	'diffNotify',
]

/** Timings of one write and the subscription re-runs it caused. */
export interface PhaseRecord {
	readonly kind: PhaseWriteKind
	/** Milliseconds per phase (summed when a phase ran more than once). */
	readonly phases: Record<PhaseName, number>
	/** Number of subscription re-runs. */
	rereads: number
	/** Number of subscriber callbacks actually invoked. */
	callbacks: number
	/** `performance.now()` when the write was started. */
	readonly startedAt: number
	/** `performance.now()` of the first subscriber callback after the commit, or null. */
	firstCallbackAt: number | null
	/** `performance.now()` when `publish` ended (the notify moment). */
	publishedAt: number | null
}

function emptyPhases(): Record<PhaseName, number> {
	return {
		prepare: 0,
		txOpen: 0,
		sequence: 0,
		body: 0,
		commit: 0,
		publish: 0,
		flushDelay: 0,
		findAffected: 0,
		reread: 0,
		diffNotify: 0,
	}
}

/**
 * Collects {@link PhaseRecord}s. One record is open at a time (writes in a
 * measurement are sequential); read-side phases are attributed to it.
 */
export class PhaseTimers {
	private current: PhaseRecord | null = null
	private readonly finished: PhaseRecord[] = []

	/** Start a record for a write; closes the previous open record. */
	begin(kind: PhaseWriteKind): void {
		this.close()
		this.current = {
			kind,
			phases: emptyPhases(),
			rereads: 0,
			callbacks: 0,
			startedAt: performance.now(),
			firstCallbackAt: null,
			publishedAt: null,
		}
	}

	/** Add elapsed milliseconds to a phase of the open record. */
	add(phase: PhaseName, ms: number): void {
		if (this.current) this.current.phases[phase] += ms
	}

	/** Note that one subscription re-run finished. */
	noteReread(): void {
		if (this.current) this.current.rereads++
	}

	/** Note the moment the post-commit publish ended. */
	notePublished(at: number): void {
		if (this.current && this.current.publishedAt === null) this.current.publishedAt = at
	}

	/** Note a subscriber callback invocation. */
	noteCallback(at: number): void {
		const record = this.current
		if (!record) return
		record.callbacks++
		// With instant updates the first callback is the prediction, which runs BEFORE the
		// commit publish; requiring `publishedAt` here timed the post-commit re-run instead
		// and hid exactly the latency the feature removes (S4 finding).
		if (record.firstCallbackAt === null) record.firstCallbackAt = at
	}

	/** The open record, if any. */
	peek(): PhaseRecord | null {
		return this.current
	}

	/** Close the open record and return every finished record, clearing the buffer. */
	take(): PhaseRecord[] {
		this.close()
		return this.finished.splice(0, this.finished.length)
	}

	private close(): void {
		if (this.current) this.finished.push(this.current)
		this.current = null
	}
}

let active: PhaseTimers | null = null

/** Install (or with null, remove) the process-wide timers. Internal. */
export function installPhaseTimers(timers: PhaseTimers | null): void {
	active = timers
}

/** The installed timers, or null (the normal case). */
export function activePhaseTimers(): PhaseTimers | null {
	return active
}

/** Median and 95th percentile of a sample (nearest rank). */
export function summarizeSamples(samples: readonly number[]): { p50: number; p95: number } {
	if (samples.length === 0) return { p50: 0, p95: 0 }
	const sorted = [...samples].sort((a, b) => a - b)
	const at = (p: number): number =>
		sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0
	return { p50: at(0.5), p95: at(0.95) }
}

/** Per-phase p50 and p95 over a list of records. */
export function summarizePhases(
	records: readonly PhaseRecord[],
): Record<PhaseName, { p50: number; p95: number }> {
	const out = {} as Record<PhaseName, { p50: number; p95: number }>
	for (const name of PHASE_NAMES) {
		out[name] = summarizeSamples(records.map((record) => record.phases[name]))
	}
	return out
}
