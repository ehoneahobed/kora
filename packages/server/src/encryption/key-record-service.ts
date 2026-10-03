import { generateUUIDv7 } from '@korajs/core'
import type {
	EncryptionKeyPutMessage,
	EncryptionKeyRequestMessage,
	EncryptionKeyResponseMessage,
	WrappedKeyRecord,
} from '@korajs/sync'
import {
	MAX_KEY_RECORD_BYTES,
	isKeyRecordSuccessor,
	isValidKeyringName,
	validateKeyRecord,
} from '@korajs/sync'
import type { ServerStore } from '../store/server-store'

/**
 * Owner of the shared keyring of a server without authentication. Every client of
 * such a server shares one data space, so it shares one keyring too.
 */
export const ANONYMOUS_KEY_OWNER = '*'

/** Storage owner key of an authenticated user. */
export function userKeyOwner(userId: string): string {
	return `u:${userId}`
}

/** Outcome of one key-service message. */
export interface KeyServiceOutcome {
	response: EncryptionKeyResponseMessage
	/** The record written, when the message was a successful write (to push to siblings). */
	written: WrappedKeyRecord | null
}

/**
 * The sync server's key service (ENC-1, decision D4b). Stores each owner's wrapped key
 * record and serves it back. It never sees a passphrase or a data key: a record is
 * salt, KDF parameters, AES-GCM-wrapped data keys, key ids and versions.
 *
 * Rules it enforces:
 * - **Owner from the session only.** The owner is the session's authenticated
 *   principal (or the shared anonymous owner on a server without auth); a message
 *   cannot name a user, so no session reads or writes another user's record.
 * - **Compare-and-set.** A write names the revision it replaces; a concurrent write
 *   loses with `conflict` and the current record, so two devices that both create a
 *   first key converge on one.
 * - **History is append-only.** A write must keep every key version (same key id), so
 *   no device can make old operations unreadable for the others.
 *
 * It cannot check that wraps open (only the passphrase holder can), so a principal can
 * still overwrite its own record with garbage wraps of the same key ids; devices that
 * cached the keys keep working and refuse records missing versions they hold.
 */
export class EncryptionKeyService {
	constructor(private readonly store: ServerStore) {}

	/** Whether the store can persist key records (all built-in stores can). */
	isSupported(): boolean {
		return (
			typeof this.store.getEncryptionKeyRecord === 'function' &&
			typeof this.store.putEncryptionKeyRecord === 'function'
		)
	}

	/**
	 * Answer one key-service message for `owner`.
	 *
	 * @param owner - The session's owner key, or null when the session may not hold keys
	 * @param message - A request or a write
	 */
	async handle(
		owner: string | null,
		message: EncryptionKeyRequestMessage | EncryptionKeyPutMessage,
	): Promise<KeyServiceOutcome> {
		const reply = (
			status: EncryptionKeyResponseMessage['status'],
			record: WrappedKeyRecord | null,
			text?: string,
		): KeyServiceOutcome => ({
			response: {
				type: 'encryption-key-response',
				messageId: generateUUIDv7(),
				requestId: message.requestId,
				keyring: message.keyring,
				status,
				record,
				...(text ? { message: text } : {}),
			},
			written: null,
		})
		if (!isValidKeyringName(message.keyring)) {
			return reply('invalid', null, 'Keyring names are 1-128 characters of [A-Za-z0-9._:-].')
		}
		if (owner === null) {
			return reply(
				'forbidden',
				null,
				'Encryption keys belong to a signed-in user: an anonymous session cannot read or write them.',
			)
		}
		const getRecord = this.store.getEncryptionKeyRecord?.bind(this.store)
		const putRecord = this.store.putEncryptionKeyRecord?.bind(this.store)
		if (!getRecord || !putRecord) {
			return reply(
				'unsupported',
				null,
				'This server store cannot persist encryption key records. Use a built-in store (memory, SQLite, Postgres) or implement getEncryptionKeyRecord/putEncryptionKeyRecord.',
			)
		}
		const current = await this.read(owner, message.keyring)
		if (message.type === 'encryption-key-request') {
			return reply('ok', current)
		}

		const json = JSON.stringify(message.record)
		if (json.length > MAX_KEY_RECORD_BYTES) {
			return reply('invalid', current, `A key record is limited to ${MAX_KEY_RECORD_BYTES} bytes.`)
		}
		const validation = validateKeyRecord(message.record, message.keyring)
		if (!validation.ok) {
			return reply('invalid', current, `Malformed key record: ${validation.reason}.`)
		}
		if (!Number.isSafeInteger(message.expectedRevision) || message.expectedRevision < 0) {
			return reply('invalid', current, 'expectedRevision must be a non-negative integer.')
		}
		if ((current?.revision ?? 0) !== message.expectedRevision) {
			return reply('conflict', current)
		}
		const successor = isKeyRecordSuccessor(current, message.record)
		if (!successor.ok) {
			return reply('invalid', current, `Refused key record: ${successor.reason}.`)
		}
		const stored = await putRecord(
			owner,
			message.keyring,
			json,
			message.record.revision,
			message.expectedRevision,
		)
		if (!stored) {
			// Lost a race with another write between the read and the compare-and-set.
			return reply('conflict', await this.read(owner, message.keyring))
		}
		const accepted = JSON.parse(json) as WrappedKeyRecord
		return { ...reply('ok', accepted), written: accepted }
	}

	private async read(owner: string, keyring: string): Promise<WrappedKeyRecord | null> {
		const json = await this.store.getEncryptionKeyRecord?.(owner, keyring)
		if (json === null || json === undefined) return null
		try {
			return JSON.parse(json) as WrappedKeyRecord
		} catch {
			return null
		}
	}
}
