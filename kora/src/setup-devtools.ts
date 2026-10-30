import type { KoraEvent } from '@korajs/core'
import type { SimpleEventEmitter } from '@korajs/core/internal'
import type { KoraConfig } from './types'

export interface DevtoolsSetup {
	/** Detaches DevTools (and its overlay) whenever it has loaded, or cancels its loading. */
	destroy: (() => void) | null
}

/**
 * Events held while the DevTools chunk loads. A page that enables DevTools emits a few
 * dozen events before the chunk is fetched; the cap only bounds a pathological load.
 */
const EARLY_EVENT_CAP = 2_000

/**
 * Enables DevTools instrumentation and optionally mounts the browser overlay.
 *
 * `@korajs/devtools` (the instrumenter, its Preact UI and htm) is loaded with a dynamic
 * `import()` only when `config.devtools` is on, so it is never part of the critical-path
 * JavaScript of an app that leaves DevTools off (production builds: `devtools:
 * import.meta.env.DEV`). Until the chunk arrives the events are held and then replayed into
 * the instrumenter in order, so a late load shows the same history as an early one.
 */
export function setupDevtools(config: KoraConfig, emitter: SimpleEventEmitter): DevtoolsSetup {
	if (!config.devtools) {
		return { destroy: null }
	}

	const held: Array<{ event: KoraEvent; receivedAt: number }> = []
	const stopHolding = emitter.onAny((event) => {
		if (held.length < EARLY_EVENT_CAP) held.push({ event, receivedAt: Date.now() })
	})

	let destroyed = false
	let detach: (() => void) | null = null

	void import('@korajs/devtools')
		.then(({ Instrumenter }) => {
			if (destroyed) return
			const browser = typeof globalThis !== 'undefined' && 'window' in globalThis
			const instrumenter = new Instrumenter(emitter, { bridgeEnabled: browser })
			// Synchronous with the line above: no event can fall between the replay and the
			// instrumenter's own listeners.
			instrumenter.replay(held)
			held.length = 0
			stopHolding()

			let destroyOverlay: (() => void) | null = null
			detach = () => {
				destroyOverlay?.()
				instrumenter.destroy()
			}
			if (browser) {
				void import('@korajs/devtools/overlay')
					.then(({ mountKoraDevtoolsOverlay }) => {
						if (destroyed) return
						destroyOverlay = mountKoraDevtoolsOverlay(instrumenter)
					})
					.catch(() => {
						// Overlay is optional; extension bridge still works.
					})
			}
		})
		.catch(() => {
			// DevTools is a development aid: a chunk that cannot load (offline dev server) must
			// never affect the app.
			stopHolding()
			held.length = 0
		})

	return {
		destroy: () => {
			destroyed = true
			stopHolding()
			held.length = 0
			detach?.()
			detach = null
		},
	}
}
