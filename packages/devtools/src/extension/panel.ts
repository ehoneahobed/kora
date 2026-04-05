import type { TimestampedEvent } from '../types'
import { renderDevtoolsPanel } from '../ui/panel'

interface RuntimePort {
	onMessage: {
		addListener(callback: (message: unknown) => void): void
	}
	postMessage(message: unknown): void
}

interface RuntimeLike {
	connect(info: { name: string }): RuntimePort
}

interface DevtoolsLike {
	inspectedWindow: { tabId: number }
}

const extensionRoot = document.getElementById('kora-devtools-root')
if (!extensionRoot) {
	throw new Error('Missing #kora-devtools-root element')
}

const runtime = (globalThis as { chrome?: { runtime?: RuntimeLike } }).chrome?.runtime
const devtools = (globalThis as { chrome?: { devtools?: DevtoolsLike } }).chrome?.devtools

const events: TimestampedEvent[] = []

if (runtime && devtools) {
	const port = runtime.connect({ name: 'kora-panel' })
	port.postMessage({ type: 'panel-init', tabId: devtools.inspectedWindow.tabId })

	port.onMessage.addListener((message) => {
		const typed = message as { type?: string; payload?: TimestampedEvent } | undefined
		if (!typed || typed.type !== 'kora-event' || !typed.payload) return

		events.push(typed.payload)
		renderDevtoolsPanel(extensionRoot, events)
	})
}

renderDevtoolsPanel(extensionRoot, events)
