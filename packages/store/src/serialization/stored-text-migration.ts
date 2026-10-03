import { quoteIdent } from '@korajs/core'
import type { SchemaDefinition } from '@korajs/core'
import type { StorageAdapter } from '../types'
import { isRawTextKind } from './serializer'

/** `_kora_meta` key: raw-string columns hold the stored-text codec's form (RT-65). */
export const STORED_TEXT_CODEC_META_KEY = 'stored_text_codec'

/** Version of the codec the rows are written with. */
const STORED_TEXT_CODEC_VERSION = '1'

/**
 * Once per database: re-encode the U+FFFF of rows written before the stored-text codec
 * (RT-65) so the decoder returns them unchanged. A row written before the codec holds
 * the raw string; the only code unit whose meaning changes under the decoder is the
 * escape introducer U+FFFF (`U+FFFF` -> `U+FFFF F`). NUL needs no rewrite (better-sqlite3
 * stored it as is), and a lone surrogate a pre-codec row held was already replaced by
 * U+FFFD when it was bound, so nothing is left to recover.
 *
 * Every collection table of the schema that exists is rewritten, for the columns of its
 * raw-string fields that exist. One transaction; the meta key makes it idempotent.
 *
 * @param adapter - An open storage adapter
 * @param schema - The schema whose collection tables to migrate
 */
export async function ensureStoredTextCodec(
	adapter: StorageAdapter,
	schema: SchemaDefinition,
): Promise<void> {
	const rows = await adapter.query<{ value: string }>(
		'SELECT value FROM _kora_meta WHERE key = ?',
		[STORED_TEXT_CODEC_META_KEY],
	)
	if (rows[0]?.value === STORED_TEXT_CODEC_VERSION) return
	await adapter.transaction(async (tx) => {
		for (const [name, collection] of Object.entries(schema.collections)) {
			const columns = new Set(
				(await tx.query<{ name: string }>(`PRAGMA table_info(${quoteIdent(name)})`)).map(
					(column) => column.name,
				),
			)
			if (columns.size === 0) continue
			for (const [field, descriptor] of Object.entries(collection.fields)) {
				if (!isRawTextKind(descriptor.kind) || !columns.has(field)) continue
				const column = quoteIdent(field)
				await tx.execute(
					`UPDATE ${quoteIdent(name)} SET ${column} = replace(${column}, char(65535), char(65535) || 'F') WHERE instr(${column}, char(65535)) > 0`,
				)
			}
		}
		await tx.execute('INSERT OR REPLACE INTO _kora_meta (key, value) VALUES (?, ?)', [
			STORED_TEXT_CODEC_META_KEY,
			STORED_TEXT_CODEC_VERSION,
		])
	})
}
