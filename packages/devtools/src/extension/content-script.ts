import type { TimestampedEvent } from '../types'

// biome-ignore lint/suspicious/noExplicitAny: Chrome extension API global has no type definitions without @types/chrome
declare const chrome: any

const runtime = chrome?.runtime

if (runtime) {
	const port = runtime.connect({ name: 'kora-content' })

	window.addEventListener('message', (event: MessageEvent) => {
		const data = event.data as { source?: string; payload?: TimestampedEvent } | undefined
		if (!data || data.source !== 'kora-devtools' || !data.payload) {
			return
		}

		port.postMessage({
			type: 'kora-event',
			payload: data.payload,
		})
	})
}
