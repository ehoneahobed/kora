import { PortRouter, type ExtensionPort } from './port-router'

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const chrome: any
/* eslint-enable @typescript-eslint/no-explicit-any */

const runtime = chrome?.runtime

if (runtime?.onConnect) {
	const router = new PortRouter()
	runtime.onConnect.addListener((port: ExtensionPort) => {
		router.handleConnection(port)
	})
}
