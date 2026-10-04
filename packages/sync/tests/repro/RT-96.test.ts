/**
 * RT-96 repro (final RC red team, ENC-1): a device accepts an OLDER revision of its key
 * record. The rollback pin only checks that every key version it holds is still present;
 * it never compares `revision`, and nothing authenticates the record as a whole. After a
 * passphrase change (typically because the old passphrase leaked), a server that kept the
 * old revision serves or pushes it again. The device adopts it, drops its key-encryption
 * key (salt changed), and the new passphrase no longer opens anything: `unlock(new)` fails
 * WRONG_PASSPHRASE, `unlock(old)` succeeds, and the next `rotate()` wraps the new data key
 * under the OLD, leaked passphrase. Whoever holds the old passphrase and the server's copy
 * reads every operation sealed under that version. The same rollback strips a recovery key
 * the user just set up, or restores a revoked one.
 *
 * Asserts CORRECT behaviour: a record whose revision is lower than one the device has
 * accepted is refused (KEY_RECORD_ROLLBACK), and a rotation never wraps under the old
 * passphrase.
 */
import { describe, expect, test } from 'vitest'
import { MemoryKeyCache } from '../../src/encryption/key-cache'
import type { WrappedKeyRecord } from '../../src/encryption/key-record'
import type { KeyServiceChannel, KeyServiceReply } from '../../src/encryption/keyring'
import { EncryptionKeyring } from '../../src/encryption/keyring'
import {
	deriveKeyEncryptionKey,
	fromBase64,
	unwrapDataKey,
} from '../../src/encryption/keyring-crypto'

const ITERATIONS = 1000

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T
}

class KeyServer {
	record: WrappedKeyRecord | null = null
	channel(): KeyServiceChannel {
		return {
			fetch: async () => ({ status: 'ok', record: clone(this.record) }),
			put: async (_keyring, record, expectedRevision): Promise<KeyServiceReply> => {
				if ((this.record?.revision ?? 0) !== expectedRevision) {
					return { status: 'conflict', record: clone(this.record) }
				}
				this.record = clone(record)
				return { status: 'ok', record: clone(record) }
			},
		}
	}
}

describe('RT-96: a device accepts a rolled-back key record revision', () => {
	test('an older revision (pre passphrase change) is refused', async () => {
		const server = new KeyServer()
		const device = new EncryptionKeyring({
			passphrase: 'leaked passphrase',
			kdfIterations: ITERATIONS,
			cache: new MemoryKeyCache(),
		})
		expect(await device.synchronize(server.channel(), 'alice')).toBe('ready')
		const oldRevision = clone(server.record as WrappedKeyRecord)

		await device.changePassphrase('new passphrase', server.channel())
		expect((server.record as WrappedKeyRecord).revision).toBe(oldRevision.revision + 1)

		// The server serves the old revision again.
		server.record = clone(oldRevision)
		const outcome = await device.adoptPushed(clone(oldRevision))
		expect(outcome).toBe('locked')
		expect(device.getStatus().code).toBe('KEY_RECORD_ROLLBACK')
	})

	test('after the rollback no new data key is ever wrapped under the old passphrase', async () => {
		const server = new KeyServer()
		const device = new EncryptionKeyring({
			passphrase: 'leaked passphrase',
			kdfIterations: ITERATIONS,
			cache: new MemoryKeyCache(),
		})
		await device.synchronize(server.channel(), 'alice')
		const oldRevision = clone(server.record as WrappedKeyRecord)
		await device.changePassphrase('new passphrase', server.channel())

		server.record = clone(oldRevision)
		await device.adoptPushed(clone(oldRevision))

		// The user tries the new passphrase, then (after WRONG_PASSPHRASE) the old one, and
		// rotates. Each step may throw; what matters is what ends up on the server.
		await device.unlock('new passphrase', server.channel()).catch(() => undefined)
		await device.unlock('leaked passphrase', server.channel()).catch(() => undefined)
		await device.rotate(server.channel()).catch(() => undefined)

		const record = server.record as WrappedKeyRecord
		const newest = record.keys.find((k) => k.keyVersion === record.currentVersion)
		const attackerKek = await deriveKeyEncryptionKey(
			'leaked passphrase',
			fromBase64(record.kdf.salt),
			record.kdf.iterations,
		)
		const opened =
			record.currentVersion > 1 && newest
				? await unwrapDataKey(newest, attackerKek, record.keyring).then(
						() => true,
						() => false,
					)
				: false
		expect(opened).toBe(false)
	})
})
