import type { RichTextSyncEngine } from './types'

/**
 * Narrows a sync engine reference to the richtext controller surface.
 * SyncEngine satisfies this interface at runtime; types live in different packages.
 */
export function asRichTextSyncEngine(engine: unknown): RichTextSyncEngine | null {
	if (engine == null) {
		return null
	}
	return engine as RichTextSyncEngine
}
