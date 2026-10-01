import type { CollectionDefinition, SecretKeyProvider } from '@korajs/core'
import { transformSecretFieldsForWrite } from '@korajs/core'

/**
 * Convert the values a local write is about to persist into their at-rest form.
 *
 * Every local write path (single-record insert/update and the buffered
 * `TransactionContext` used by `app.transaction` / `app.mutation`) MUST route
 * its data through this helper BEFORE the operation is built, so plaintext
 * secrets never reach the operation log, the materialized row, or the wire.
 * Keeping one helper means a new write path cannot forget the transform
 * without also bypassing this function (STORE-4).
 *
 * @param data - Validated (and atomic-op-resolved) field values for the write
 * @param definition - The collection definition, used to find secret fields
 * @param secretKeyProvider - Key provider for `t.secret()` encrypted fields
 * @returns A copy of `data` with secret fields hashed or encrypted
 */
export function toAtRestWriteData(
	data: Record<string, unknown>,
	definition: CollectionDefinition,
	secretKeyProvider: SecretKeyProvider | undefined,
): Promise<Record<string, unknown>> {
	return transformSecretFieldsForWrite(data, definition, secretKeyProvider)
}
