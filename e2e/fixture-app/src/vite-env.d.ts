/// <reference types="vite/client" />

declare module '*?worker&url' {
	const url: string
	export default url
}

declare module '*?sharedworker&url' {
	const url: string
	export default url
}

interface Window {
	__KORA_E2E_READY__?: boolean
}
