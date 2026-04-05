import type { TimestampedEvent } from '../types'

interface RuntimePort {
	postMessage(message: unknown): void
}

interface RuntimeLike {
	connect(info: { name: string }): RuntimePort
}

const runtime = (globalThis as { chrome?: { runtime?: RuntimeLike } }).chrome?.runtime

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
