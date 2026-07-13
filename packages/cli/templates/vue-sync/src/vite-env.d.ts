/// <reference types="vite/client" />

declare module '*.vue' {
	import type { DefineComponent } from 'vue'
	const component: DefineComponent<object, object, unknown>
	export default component
}

interface ImportMetaEnv {
	readonly VITE_SYNC_URL?: string
	readonly VITE_AUTH_URL?: string
}

interface ImportMeta {
	readonly env: ImportMetaEnv
}

declare module '*?worker&url' {
	const url: string
	export default url
}

declare module '*?url' {
	const url: string
	export default url
}
