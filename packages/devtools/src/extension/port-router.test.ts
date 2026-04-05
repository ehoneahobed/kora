import { describe, expect, test, vi } from 'vitest'
import { PortRouter, type ExtensionPort } from './port-router'

function createPort(name: string, tabId?: number): {
	port: ExtensionPort
	emitMessage: (message: unknown) => void
	emitDisconnect: () => void
	postMessage: ReturnType<typeof vi.fn>
} {
	const messageListeners: Array<(message: unknown) => void> = []
	const disconnectListeners: Array<() => void> = []
	const postMessage = vi.fn()

	const port: ExtensionPort = {
		name,
		sender: tabId !== undefined ? { tab: { id: tabId } } : undefined,
		onMessage: {
			addListener(callback) {
				messageListeners.push(callback)
			},
		},
		onDisconnect: {
			addListener(callback) {
				disconnectListeners.push(callback)
			},
		},
		postMessage,
	}

	return {
		port,
		emitMessage(message: unknown) {
			for (const listener of messageListeners) {
				listener(message)
			}
		},
		emitDisconnect() {
			for (const listener of disconnectListeners) {
				listener()
			}
		},
		postMessage,
	}
}

describe('PortRouter', () => {
	test('routes content events to panel on matching tab', () => {
		const router = new PortRouter()
		const panel = createPort('kora-panel')
		const content = createPort('kora-content', 7)

		router.handleConnection(panel.port)
		router.handleConnection(content.port)

		panel.emitMessage({ type: 'panel-init', tabId: 7 })
		content.emitMessage({ type: 'kora-event', payload: { id: 1 } })

		expect(panel.postMessage).toHaveBeenCalledWith({ type: 'kora-event', payload: { id: 1 } })
	})

	test('stops routing after panel disconnect', () => {
		const router = new PortRouter()
		const panel = createPort('kora-panel')
		const content = createPort('kora-content', 7)

		router.handleConnection(panel.port)
		router.handleConnection(content.port)

		panel.emitMessage({ type: 'panel-init', tabId: 7 })
		panel.emitDisconnect()
		content.emitMessage({ type: 'kora-event', payload: { id: 2 } })

		expect(panel.postMessage).not.toHaveBeenCalled()
	})
})
