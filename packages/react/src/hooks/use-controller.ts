import { useEffect, useReducer, useRef } from 'react'

/**
 * Manages the lifecycle of an external controller in a StrictMode-safe way.
 *
 * React 18+ StrictMode mounts, unmounts, and remounts components in development.
 * The previous pattern (create in `useMemo`, destroy in effect cleanup) permanently
 * destroyed the memoized controller on the simulated unmount, leaving every
 * subsequent interaction against a disposed controller.
 *
 * This hook instead keeps the controller in a ref and recreates it lazily
 * whenever it has been destroyed, so the effect cleanup / re-run cycle is safe.
 *
 * Returns a getter so subscribe/getSnapshot closures always reach a live controller.
 */
export function useController<C>(
	create: () => C,
	destroy: (controller: C) => void,
	deps: readonly unknown[],
): () => C {
	const controllerRef = useRef<C | null>(null)
	const createRef = useRef(create)
	createRef.current = create

	const [, forceRender] = useReducer((count: number) => count + 1, 0)

	const getController = useRef((): C => {
		if (controllerRef.current === null) {
			controllerRef.current = createRef.current()
		}
		return controllerRef.current
	}).current

	// biome-ignore lint/correctness/useExhaustiveDependencies: deps are the caller's create() inputs
	useEffect(() => {
		if (controllerRef.current === null) {
			controllerRef.current = createRef.current()
			// A destroyed controller was recreated (StrictMode remount or deps
			// change): re-render so useSyncExternalStore rebinds to the new one.
			forceRender()
		}
		return () => {
			const controller = controllerRef.current
			controllerRef.current = null
			if (controller !== null) {
				destroy(controller)
			}
		}
	}, deps)

	return getController
}
