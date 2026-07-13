import type { KoraEventEmitter } from '@korajs/core'
import { Instrumenter } from '@korajs/devtools'
import type { KoraConfig } from './types'

export interface DevtoolsSetup {
	instrumenter: Instrumenter | null
	destroyOverlay: (() => void) | null
}

/**
 * Enables DevTools instrumentation and optionally mounts the browser overlay.
 */
export function setupDevtools(config: KoraConfig, emitter: KoraEventEmitter): DevtoolsSetup {
	if (!config.devtools) {
		return { instrumenter: null, destroyOverlay: null }
	}

	const instrumenter = new Instrumenter(emitter, {
		bridgeEnabled: typeof globalThis !== 'undefined' && 'window' in globalThis,
	})

	let destroyOverlay: (() => void) | null = null

	if (typeof globalThis !== 'undefined' && 'window' in globalThis) {
		void import('@korajs/devtools/overlay')
			.then(({ mountKoraDevtoolsOverlay }) => {
				destroyOverlay = mountKoraDevtoolsOverlay(instrumenter)
			})
			.catch(() => {
				// Overlay is optional; extension bridge still works.
			})
	}

	return { instrumenter, destroyOverlay: () => destroyOverlay?.() }
}
