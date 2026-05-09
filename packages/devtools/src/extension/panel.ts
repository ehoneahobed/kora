import type { TimestampedEvent } from '../types'
import { renderDevtoolsPanel } from '../ui/panel'

// biome-ignore lint/suspicious/noExplicitAny: Chrome extension API global has no type definitions without @types/chrome
declare const chrome: any

const extensionRoot = document.getElementById('kora-devtools-root')
if (!extensionRoot) {
	throw new Error('Missing #kora-devtools-root element')
}

const events: TimestampedEvent[] = []

const runtime = chrome?.runtime
const devtools = chrome?.devtools

if (runtime && devtools) {
	const tabId = devtools.inspectedWindow.tabId
	const port = runtime.connect({ name: 'kora-panel' })
	port.postMessage({ type: 'panel-init', tabId })

	port.onMessage.addListener((message: { type?: string; payload?: TimestampedEvent }) => {
		if (!message || message.type !== 'kora-event' || !message.payload) return

		events.push(message.payload)
		renderDevtoolsPanel(extensionRoot, events)
	})
}

// Initial render
renderDevtoolsPanel(extensionRoot, events)
