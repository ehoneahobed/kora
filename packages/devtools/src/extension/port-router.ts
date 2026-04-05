export interface ExtensionPort {
	name: string
	onMessage: {
		addListener(callback: (message: unknown) => void): void
	}
	onDisconnect: {
		addListener(callback: () => void): void
	}
	postMessage(message: unknown): void
	sender?: { tab?: { id?: number } }
}

interface PanelClient {
	port: ExtensionPort
	tabId: number
}

/**
 * Routes content-script events to the matching DevTools panel by tab.
 */
export class PortRouter {
	private readonly panelClients = new Map<number, PanelClient>()
	private readonly contentClients = new Map<number, ExtensionPort>()

	handleConnection(port: ExtensionPort): void {
		if (port.name === 'kora-panel') {
			this.attachPanel(port)
			return
		}

		if (port.name === 'kora-content') {
			this.attachContent(port)
		}
	}

	private attachPanel(port: ExtensionPort): void {
		port.onMessage.addListener((message) => {
			if (!isPanelInitMessage(message)) return

			this.panelClients.set(message.tabId, { tabId: message.tabId, port })
		})

		port.onDisconnect.addListener(() => {
			for (const [tabId, client] of this.panelClients) {
				if (client.port === port) {
					this.panelClients.delete(tabId)
				}
			}
		})
	}

	private attachContent(port: ExtensionPort): void {
		const tabId = port.sender?.tab?.id
		if (typeof tabId !== 'number') {
			return
		}

		this.contentClients.set(tabId, port)

		port.onMessage.addListener((message) => {
			if (!isContentEventMessage(message)) return

			const panel = this.panelClients.get(tabId)
			if (!panel) return

			panel.port.postMessage({ type: 'kora-event', payload: message.payload })
		})

		port.onDisconnect.addListener(() => {
			this.contentClients.delete(tabId)
		})
	}
}

function isPanelInitMessage(value: unknown): value is { type: 'panel-init'; tabId: number } {
	if (typeof value !== 'object' || value === null) return false
	const record = value as Record<string, unknown>
	return record.type === 'panel-init' && typeof record.tabId === 'number'
}

function isContentEventMessage(value: unknown): value is { type: 'kora-event'; payload: unknown } {
	if (typeof value !== 'object' || value === null) return false
	const record = value as Record<string, unknown>
	return record.type === 'kora-event' && 'payload' in record
}
