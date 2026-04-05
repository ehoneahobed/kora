import { PortRouter, type ExtensionPort } from './port-router'

interface RuntimeLike {
	onConnect?: {
		addListener(callback: (port: ExtensionPort) => void): void
	}
}

const runtime = (globalThis as { chrome?: { runtime?: RuntimeLike } }).chrome?.runtime

if (runtime?.onConnect) {
	const router = new PortRouter()
	runtime.onConnect.addListener((port) => {
		router.handleConnection(port)
	})
}
