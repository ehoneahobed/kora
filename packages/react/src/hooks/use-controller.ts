import { useEffect, useReducer, useRef } from 'react'

/**
 * How long a controller created during a render may wait for its component to commit
 * before it is destroyed as an orphan. Reaping one that does commit later is safe (the
 * commit recreates it), so this only bounds how long a discarded render's controller
 * lives, never correctness.
 */
const ORPHAN_REAP_MS = 1000

interface ControllerEntry<C> {
	controller: C
	/** Set by the commit-phase effect: this component owns the controller. */
	claimed: boolean
	/** Destroyed as an orphan before any commit claimed it. */
	reaped: boolean
}

/**
 * A controller owned by a component, as returned by {@link useController}.
 */
export interface ControllerHandle<C> {
	/**
	 * Returns the live controller, creating it if needed. Its identity never changes, so
	 * callbacks built on it (mutate, undo, ...) can be memoized forever.
	 */
	get: () => C
	/**
	 * Returns the live controller, or null before the component committed. Never creates
	 * one, so render paths that must not subscribe anything (a server render, a render
	 * React may discard) read through it.
	 */
	peek: () => C | null
	/**
	 * Increments every time the controller is replaced (deps change, or the StrictMode
	 * remount recreated it). Key `useSyncExternalStore`'s `subscribe` on it so React
	 * resubscribes to the new controller, and only then (DX-5).
	 */
	version: number
}

/**
 * Manages the lifecycle of an external controller in a StrictMode-safe way.
 *
 * React 18+ StrictMode mounts, unmounts, and remounts components in development, and
 * concurrent rendering may discard a render before it commits. The controller lives in
 * a ref, is (re)created by the commit-phase effect, and is destroyed by its cleanup. A
 * controller created lazily during a render that never commits (the discarded first
 * pass of a StrictMode mount, an interrupted transition) is destroyed as an orphan, so
 * its subscriptions do not leak.
 */
export function useController<C>(
	create: () => C,
	destroy: (controller: C) => void,
	deps: readonly unknown[],
): ControllerHandle<C> {
	const entryRef = useRef<ControllerEntry<C> | null>(null)
	const createRef = useRef(create)
	createRef.current = create
	const destroyRef = useRef(destroy)
	destroyRef.current = destroy

	const [version, bumpVersion] = useReducer((count: number) => count + 1, 0)

	const handle = useRef<Omit<ControllerHandle<C>, 'version'>>({
		get: (): C => {
			const current = entryRef.current
			if (current !== null && !current.reaped) {
				return current.controller
			}
			const entry: ControllerEntry<C> = {
				controller: createRef.current(),
				claimed: false,
				reaped: false,
			}
			entryRef.current = entry
			setTimeout(() => {
				if (!entry.claimed && !entry.reaped) {
					entry.reaped = true
					destroyRef.current(entry.controller)
				}
			}, ORPHAN_REAP_MS)
			return entry.controller
		},
		peek: (): C | null => {
			const current = entryRef.current
			return current?.claimed && !current.reaped ? current.controller : null
		},
	}).current

	// Re-runs when the caller's create() inputs (deps) change.
	useEffect(() => {
		const current = entryRef.current
		if (current !== null && !current.reaped && !current.claimed) {
			// Created by this component's committed render: take ownership.
			current.claimed = true
		} else if (current === null || current.reaped) {
			entryRef.current = { controller: createRef.current(), claimed: true, reaped: false }
			// A destroyed controller was recreated (StrictMode remount, deps change, or a
			// late commit after an orphan reap): re-render so bindings rebind to it.
			bumpVersion()
		}
		return () => {
			const entry = entryRef.current
			entryRef.current = null
			if (entry !== null && !entry.reaped) {
				entry.reaped = true
				destroyRef.current(entry.controller)
			}
		}
	}, deps)

	return { get: handle.get, peek: handle.peek, version }
}
