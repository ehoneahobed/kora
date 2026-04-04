import type { KoraSyncServerConfig } from '../types'
import { KoraSyncServer } from './kora-sync-server'

/**
 * Factory function to create a KoraSyncServer.
 *
 * @param config - Server configuration
 * @returns A new KoraSyncServer instance
 *
 * @example
 * ```typescript
 * const server = createKoraServer({
 *   store: new MemoryServerStore(),
 *   port: 3000,
 * })
 * await server.start()
 * ```
 */
export function createKoraServer(config: KoraSyncServerConfig): KoraSyncServer {
	return new KoraSyncServer(config)
}
