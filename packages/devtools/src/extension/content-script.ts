import type { TimestampedEvent } from '../types'

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const chrome: any
/* eslint-enable @typescript-eslint/no-explicit-any */

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
