/**
 * Kora CLI/runtime configuration shape loaded from `kora.config.*`.
 */
export interface KoraUserConfig {
	/** Path to the schema file. Defaults to auto-detection in CLI. */
	schema?: string
	dev?: {
		/** Vite development server port. */
		port?: number
		sync?:
			| boolean
			| {
				/** Enable or disable sync server startup in `kora dev`. */
				enabled?: boolean
				/** Sync server port (also exposed as PORT/KORA_SYNC_PORT env). */
				port?: number
				/** Sync server store backend for managed mode (without server.ts). */
				store?:
					| 'memory'
					| 'sqlite'
					| 'postgres'
					| {
						type: 'memory'
					}
					| {
						type: 'sqlite'
						filename?: string
					}
					| {
						type: 'postgres'
						connectionString: string
					}
			}
		watch?:
			| boolean
			| {
				/** Enable or disable schema watching. */
				enabled?: boolean
				/** Debounce duration for schema regeneration. */
				debounceMs?: number
			}
	}
}

/**
 * Defines a typed Kora config.
 */
export function defineConfig(config: KoraUserConfig): KoraUserConfig {
	return config
}
