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
