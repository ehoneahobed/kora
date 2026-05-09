import { type ExtensionPort, PortRouter } from './port-router'

// biome-ignore lint/suspicious/noExplicitAny: Chrome extension API global has no type definitions without @types/chrome
declare const chrome: any

const runtime = chrome?.runtime

if (runtime?.onConnect) {
	const router = new PortRouter()
	runtime.onConnect.addListener((port: ExtensionPort) => {
		router.handleConnection(port)
	})
}
