import { KoraError, SchemaValidationError } from '@korajs/core'
import { detectAdapterType } from './adapter-resolver'
import type { KoraConfig } from './types'

/**
 * Fail fast on invalid createApp configuration before opening storage or sync.
 */
export function validateCreateAppConfig(config: KoraConfig): void {
	if (!config.schema) {
		throw new SchemaValidationError('createApp requires a schema.', {
			fix: 'Pass schema: defineSchema({ version: 1, collections: { ... } })',
		})
	}

	if (config.schema.version < 1) {
		throw new SchemaValidationError('Schema version must be at least 1.', {
			version: config.schema.version,
		})
	}

	const collectionNames = Object.keys(config.schema.collections)
	if (collectionNames.length === 0) {
		throw new SchemaValidationError('Schema must define at least one collection.', {
			fix: 'Add entries under collections in defineSchema().',
		})
	}

	if (config.sync) {
		validateSyncUrl(config.sync.url, config.sync.transport ?? 'websocket')
	}

	const adapter = config.store?.adapter ?? detectAdapterType()
	const isBrowser =
		typeof globalThis !== 'undefined' &&
		typeof (globalThis as Record<string, unknown>).window !== 'undefined'

	if (
		isBrowser &&
		(adapter === 'sqlite-wasm' || adapter === 'indexeddb') &&
		!config.store?.workerUrl
	) {
		throw new KoraError(
			'Browser storage requires store.workerUrl pointing to the SQLite WASM worker script.',
			'MISSING_WORKER_URL',
			{
				adapter,
				fix: 'Add store: { workerUrl: "/sqlite-wasm-worker.js" } (see create-kora-app templates).',
			},
		)
	}
}

function validateSyncUrl(url: string, transport: 'websocket' | 'http'): void {
	if (!url || url.trim().length === 0) {
		throw new KoraError('sync.url is required when sync is configured.', 'INVALID_SYNC_URL', {
			fix: 'Pass sync: { url: "wss://your-server/kora" }.',
		})
	}

	try {
		const parsed = new URL(url)
		if (transport === 'http') {
			if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
				throw new Error('bad protocol')
			}
		} else if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
			throw new Error('bad protocol')
		}
	} catch {
		throw new KoraError(
			`Invalid sync URL "${url}" for transport "${transport}".`,
			'INVALID_SYNC_URL',
			{
				url,
				transport,
				fix:
					transport === 'http'
						? 'Use an absolute http:// or https:// URL.'
						: 'Use an absolute ws:// or wss:// URL.',
			},
		)
	}
}
