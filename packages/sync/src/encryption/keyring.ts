import { SyncError } from '@korajs/core'
import type { CachedKeyring, KeyCache } from './key-cache'
import { MemoryKeyCache } from './key-cache'
import { DEFAULT_PBKDF2_ITERATIONS } from './key-derivation'
import type { WrappedDataKey, WrappedKeyRecord } from './key-record'
import { DEFAULT_KEYRING, KEY_RECORD_FORMAT, validateKeyRecord } from './key-record'
import {
	KEK_SALT_BYTES,
	KeyUnwrapError,
	deriveKeyEncryptionKey,
	fromBase64,
	generateDataKey,
	generateRecoveryKeyPair,
	newKeyId,
	randomBytes,
	toBase64,
	toNonExtractable,
	unwrapDataKey,
	unwrapWithRecovery,
	wrapDataKey,
	wrapForRecovery,
} from './keyring-crypto'
import type { EncryptorOptions } from './sync-encryptor'
import { SyncEncryptor } from './sync-encryptor'
import type { VersionedKey } from './types'

/** Lock state of an encryption keyring. */
export type EncryptionLockState = 'locked' | 'unlocking' | 'unlocked' | 'error'

/** Why a keyring is locked or in error. */
export type EncryptionStatusCode =
	| 'NO_PASSPHRASE'
	| 'AWAITING_SERVER'
	| 'LOCKED_BY_APP'
	| 'WRONG_PASSPHRASE'
	| 'PASSPHRASE_REQUIRED'
	| 'KEY_RECORD_INVALID'
	| 'KEY_RECORD_ROLLBACK'
	| 'KEY_SERVICE_FORBIDDEN'
	| 'KEY_SERVICE_UNSUPPORTED'
	| 'RECOVERY_FAILED'

/** Status of an encryption keyring, as `app.encryption.getStatus()` reports it. */
export interface EncryptionStatus {
	state: EncryptionLockState
	keyring: string
	/** Key version new operations are encrypted with, or null while locked. */
	keyVersion: number | null
	/** Key id of that version, or null while locked. */
	keyId: string | null
	/** Every key version this device can decrypt. */
	availableVersions: number[]
	/** Where unlocked keys are kept between starts. */
	cache: KeyCache['kind']
	/** Set while locked or in error. */
	code?: EncryptionStatusCode
	message?: string
}

/** The server's answer to a key-record fetch or write. */
export interface KeyServiceReply {
	/** 'conflict': the write lost a compare-and-set; `record` is the current one. */
	status: 'ok' | 'conflict'
	record: WrappedKeyRecord | null
}

/** How a keyring reaches the server's key service (the sync connection). */
export interface KeyServiceChannel {
	fetch(keyring: string): Promise<KeyServiceReply>
	put(keyring: string, record: WrappedKeyRecord, expectedRevision: number): Promise<KeyServiceReply>
}

/** Options of {@link EncryptionKeyring}. */
export interface EncryptionKeyringOptions {
	/** Keyring name (one per user by default). */
	keyring?: string
	/** Passphrase source; without one the keyring starts locked until `unlock()`. */
	passphrase?: string | (() => Promise<string>)
	/** Where unlocked keys are kept. Defaults to memory (the app picks IndexedDB in browsers). */
	cache?: KeyCache
	/**
	 * PBKDF2 iterations for new records, and the minimum accepted from the server
	 * (a server cannot downgrade the KDF). Defaults to 600,000. Lower only in tests.
	 */
	kdfIterations?: number
	/** Encryptor options (cleartext scope fields, plaintext migration window). */
	encryptor?: EncryptorOptions
}

/** Thrown by keyring management calls. `context.code` names the reason. */
export class EncryptionKeyError extends SyncError {
	constructor(message: string, context: Record<string, unknown> & { code: string }) {
		super(message, { ...context, errorType: 'ENCRYPTION_KEY_ERROR' })
		this.name = 'EncryptionKeyError'
	}

	/** The reason code (`context.code`), e.g. WRONG_PASSPHRASE. */
	get keyCode(): string {
		return String(this.context?.code ?? '')
	}
}

/** Failed unlocks before the client-side backoff starts. */
const FREE_UNLOCK_ATTEMPTS = 3
const MAX_UNLOCK_BACKOFF_MS = 60_000
/** Compare-and-set retries of one key-record write. */
const MAX_WRITE_ATTEMPTS = 3

/**
 * A device's view of one encryption keyring (ENC-1, decision D4b): the server-stored,
 * passphrase-wrapped data keys, opened locally.
 *
 * - **Shared key material.** Every device of a user opens the same record, so every
 *   device holds the same data keys and decrypts everything.
 * - **Offline.** Once unlocked, keys are cached (non-extractable) and the keyring needs
 *   no server; a cached record also lets `unlock()` work offline.
 * - **Locked is explicit.** Without a passphrase or cached keys the keyring is
 *   `locked`; sync does not run, local reads and writes do.
 * - **Rotation, passphrase change, recovery** write a new record revision with
 *   compare-and-set; history stays readable because versions are never dropped.
 */
export class EncryptionKeyring {
	readonly name: string
	private passphraseSource: string | (() => Promise<string>) | null
	private readonly cache: KeyCache
	private readonly kdfIterations: number
	private readonly encryptorOptions: EncryptorOptions
	private loadedPrincipal: string | null | undefined = undefined
	private record: WrappedKeyRecord | null = null
	private kek: CryptoKey | null = null
	/** Salt (base64) the KEK was derived with. */
	private kekSalt: string | null = null
	private readonly dataKeys = new Map<number, { keyId: string; key: CryptoKey }>()
	private encryptor: SyncEncryptor | null = null
	private status: EncryptionStatus
	private readonly listeners = new Set<(status: EncryptionStatus) => void>()
	private lockedByApp = false
	private pendingPassphrase: string | null = null
	/** A recovery requested while offline, run at the next handshake. */
	private pendingRecovery: { recoveryKey: string; newPassphrase: string } | null = null
	private failedUnlocks = 0
	private nextUnlockAt = 0
	private mutex: Promise<unknown> = Promise.resolve()

	constructor(options: EncryptionKeyringOptions = {}) {
		this.name = options.keyring ?? DEFAULT_KEYRING
		this.passphraseSource = options.passphrase ?? null
		this.cache = options.cache ?? new MemoryKeyCache()
		this.kdfIterations = options.kdfIterations ?? DEFAULT_PBKDF2_ITERATIONS
		if (!Number.isSafeInteger(this.kdfIterations) || this.kdfIterations < 1) {
			throw new EncryptionKeyError('encryption.kdfIterations must be a positive integer.', {
				code: 'INVALID_CONFIG',
			})
		}
		this.encryptorOptions = options.encryptor ?? {}
		this.status = this.makeStatus('locked', 'NO_PASSPHRASE', 'The keyring has not been opened.')
	}

	/** The encryptor of the unlocked keyring, or null while locked. */
	getEncryptor(): SyncEncryptor | null {
		return this.encryptor
	}

	/** Current status. */
	getStatus(): EncryptionStatus {
		return this.status
	}

	/** Subscribe to status changes. Returns an unsubscribe function. */
	onStatusChange(listener: (status: EncryptionStatus) => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	/**
	 * Whether sync may connect: the keyring is unlocked, or a passphrase is available to
	 * open (or create) the server record during the handshake.
	 */
	canConnect(): boolean {
		if (this.encryptor) return true
		if (this.pendingPassphrase !== null || this.pendingRecovery !== null) return true
		return !this.lockedByApp && this.passphraseSource !== null
	}

	/**
	 * Load the cached keyring of a principal (the signed-in user, or null). A principal
	 * change drops everything held for the previous one first, so one user's keys never
	 * encrypt another user's operations.
	 */
	load(principal: string | null): Promise<EncryptionStatus> {
		return this.exclusive(() => this.loadLocked(principal))
	}

	/**
	 * Open the keyring against the server's record during a sync handshake: fetch it,
	 * create it on a user's first device, adopt new versions, or detect a rollback.
	 *
	 * @returns 'ready' when unlocked, 'locked' when a passphrase is needed (or wrong)
	 * @throws When the key service fails (the session is retried later)
	 */
	synchronize(channel: KeyServiceChannel, principal: string | null): Promise<'ready' | 'locked'> {
		return this.exclusive(async () => {
			await this.loadLocked(principal)
			if (this.encryptor === null) this.setStatus(this.makeStatus('unlocking'))
			const recovery = this.pendingRecovery
			if (recovery !== null) {
				try {
					await this.recoverLocked(recovery.recoveryKey, recovery.newPassphrase, channel)
					return 'ready'
				} catch (error) {
					if (error instanceof EncryptionKeyError || error instanceof KeyUnwrapError) {
						this.lockWith('error', 'RECOVERY_FAILED', errorMessage(error))
						return 'locked'
					}
					throw error
				}
			}
			try {
				const reply = await channel.fetch(this.name)
				if (reply.record === null) {
					return await this.createOrRestoreLocked(channel)
				}
				return await this.adoptLocked(reply.record, null)
			} catch (error) {
				// Permanent refusals: retrying the session would not change them.
				if (
					error instanceof EncryptionKeyError &&
					(error.keyCode === 'KEY_SERVICE_FORBIDDEN' || error.keyCode === 'KEY_SERVICE_UNSUPPORTED')
				) {
					this.lockWith('error', error.keyCode, error.message)
					return 'locked'
				}
				if (this.encryptor === null) {
					this.setStatus(this.makeStatus('locked', 'AWAITING_SERVER', errorMessage(error)))
				}
				throw error
			}
		})
	}

	/**
	 * Adopt a record the server pushed (another device rotated keys or changed the
	 * passphrase).
	 *
	 * @returns 'ready' when still unlocked, 'locked' when the passphrase is needed
	 */
	adoptPushed(record: WrappedKeyRecord): Promise<'ready' | 'locked'> {
		return this.exclusive(() => this.adoptLocked(record, null))
	}

	/**
	 * Unlock with a passphrase. With a cached record this works offline; otherwise the
	 * passphrase is kept until the next handshake opens (or creates) the server record,
	 * and the returned promise settles then (pass `channel` when connected).
	 *
	 * Repeated wrong passphrases are slowed down on the device (backoff after three).
	 * This is a usability guard, not a security boundary: whoever holds the record can
	 * try passphrases offline, so passphrase strength and PBKDF2 are the protection.
	 *
	 * @throws {EncryptionKeyError} WRONG_PASSPHRASE, UNLOCK_THROTTLED
	 */
	unlock(passphrase: string, channel: KeyServiceChannel | null): Promise<EncryptionStatus> {
		return this.exclusive(async () => {
			const now = Date.now()
			if (now < this.nextUnlockAt) {
				throw new EncryptionKeyError(
					`Too many wrong passphrases on this device. Try again in ${Math.ceil((this.nextUnlockAt - now) / 1000)}s.`,
					{ code: 'UNLOCK_THROTTLED', retryAfterMs: this.nextUnlockAt - now },
				)
			}
			if (passphrase.length === 0) {
				throw new EncryptionKeyError('The passphrase must not be empty.', {
					code: 'EMPTY_PASSPHRASE',
				})
			}
			this.lockedByApp = false
			let record = this.record
			if (channel) {
				const reply = await channel.fetch(this.name)
				record = reply.record ?? record
				if (reply.record === null && this.record === null) {
					this.pendingPassphrase = passphrase
					const outcome = await this.createOrRestoreLocked(channel)
					if (outcome !== 'ready') throw this.statusError()
					return this.status
				}
			}
			if (record === null) {
				// No record known yet: open it at the next handshake.
				this.pendingPassphrase = passphrase
				this.setStatus(
					this.makeStatus(
						'locked',
						'AWAITING_SERVER',
						'The passphrase is kept until the sync server provides the key record.',
					),
				)
				return this.status
			}
			this.pendingPassphrase = passphrase
			const outcome = await this.adoptLocked(record, passphrase)
			if (outcome !== 'ready') {
				this.pendingPassphrase = null
				throw this.statusError()
			}
			return this.status
		})
	}

	/**
	 * Lock: forget the data keys and the KEK on this device (cache included). Sync stops
	 * until `unlock()`; local data stays readable (it is not encrypted at rest by this
	 * layer). The configured passphrase is not used again until `unlock()`.
	 */
	lock(): Promise<EncryptionStatus> {
		return this.exclusive(async () => {
			this.lockedByApp = true
			this.pendingPassphrase = null
			this.dropKeys()
			const record = this.record
			if (record) {
				await this.cache.save(this.cacheId(), { record, kek: null, keys: [] })
			} else {
				await this.cache.clear(this.cacheId())
			}
			this.lockWith('locked', 'LOCKED_BY_APP', 'Locked by the app. Call unlock(passphrase).')
			return this.status
		})
	}

	/**
	 * Rotate: create a new data key version. New operations use it; old versions stay
	 * in the record so history decrypts. Needs the server (compare-and-set).
	 */
	rotate(channel: KeyServiceChannel): Promise<EncryptionStatus> {
		return this.exclusive(async () => {
			const kek = this.requireKek('rotate the key')
			for (let attempt = 0; ; attempt++) {
				const record = this.requireRecord()
				const dataKey = await generateDataKey()
				const keyVersion = record.currentVersion + 1
				const keyId = newKeyId()
				const wrapped = await wrapDataKey(dataKey, kek, this.name, keyVersion, keyId)
				const next: WrappedKeyRecord = {
					...record,
					revision: record.revision + 1,
					currentVersion: keyVersion,
					keys: [...record.keys, wrapped],
					...(record.recovery
						? {
								recovery: {
									...record.recovery,
									keys: [
										...record.recovery.keys,
										await wrapForRecovery(
											dataKey,
											record.recovery.publicKey,
											this.name,
											keyVersion,
											keyId,
										),
									],
								},
							}
						: {}),
				}
				const reply = await channel.put(this.name, next, record.revision)
				if (reply.status === 'ok') {
					this.dataKeys.set(keyVersion, { keyId, key: await toNonExtractable(dataKey) })
					await this.commitLocked(next)
					return this.status
				}
				await this.adoptConflictLocked(reply, attempt)
			}
		})
	}

	/**
	 * Change the passphrase: re-wrap every data key version under a KEK derived from
	 * the new passphrase and a new salt. No operation is re-encrypted. Other devices
	 * keep working with their cached data keys; a device that later needs a key it
	 * does not hold asks for the new passphrase.
	 *
	 * @param newPassphrase - The new passphrase
	 * @param channel - The key service
	 * @param currentPassphrase - Optional: verified against the record first
	 */
	changePassphrase(
		newPassphrase: string,
		channel: KeyServiceChannel,
		currentPassphrase?: string,
	): Promise<EncryptionStatus> {
		return this.exclusive(async () => {
			if (newPassphrase.length === 0) {
				throw new EncryptionKeyError('The new passphrase must not be empty.', {
					code: 'EMPTY_PASSPHRASE',
				})
			}
			for (let attempt = 0; ; attempt++) {
				const record = this.requireRecord()
				const kek =
					currentPassphrase !== undefined
						? await this.kekFor(record, currentPassphrase)
						: this.requireKek('change the passphrase')
				const salt = randomBytes(KEK_SALT_BYTES)
				const newKek = await deriveKeyEncryptionKey(newPassphrase, salt, this.kdfIterations)
				const keys: WrappedDataKey[] = []
				for (const entry of record.keys) {
					const dataKey = await unwrapDataKey(entry, kek, this.name, true)
					keys.push(await wrapDataKey(dataKey, newKek, this.name, entry.keyVersion, entry.keyId))
				}
				const next: WrappedKeyRecord = {
					...record,
					revision: record.revision + 1,
					kdf: {
						name: 'PBKDF2',
						hash: 'SHA-256',
						iterations: this.kdfIterations,
						salt: toBase64(salt),
					},
					keys,
				}
				const reply = await channel.put(this.name, next, record.revision)
				if (reply.status === 'ok') {
					this.kek = newKek
					this.kekSalt = next.kdf.salt
					await this.commitLocked(next)
					return this.status
				}
				await this.adoptConflictLocked(reply, attempt)
			}
		})
	}

	/**
	 * Set up (or replace) the recovery key: every data key version is also wrapped to a
	 * new recovery public key, and the private half is returned ONCE. Store it offline;
	 * it recovers the data after a lost passphrase. Without it, a lost passphrase means
	 * the encrypted data is unrecoverable.
	 *
	 * @returns The recovery key (`kora-rk1-...`)
	 */
	enableRecovery(channel: KeyServiceChannel): Promise<string> {
		return this.exclusive(async () => {
			const kek = this.requireKek('set up a recovery key')
			for (let attempt = 0; ; attempt++) {
				const record = this.requireRecord()
				const { publicKey, recoveryKey } = await generateRecoveryKeyPair()
				const recoveryKeys = []
				for (const entry of record.keys) {
					const dataKey = await unwrapDataKey(entry, kek, this.name, true)
					recoveryKeys.push(
						await wrapForRecovery(dataKey, publicKey, this.name, entry.keyVersion, entry.keyId),
					)
				}
				const next: WrappedKeyRecord = {
					...record,
					revision: record.revision + 1,
					recovery: { alg: 'ECDH-P256+AES-GCM', publicKey, keys: recoveryKeys },
				}
				const reply = await channel.put(this.name, next, record.revision)
				if (reply.status === 'ok') {
					await this.commitLocked(next)
					return recoveryKey
				}
				await this.adoptConflictLocked(reply, attempt)
			}
		})
	}

	/**
	 * Recover after a lost passphrase: open every data key with the recovery key and
	 * re-wrap them under a new passphrase. Unlocks this device. Without a channel (sync
	 * not connected) the recovery runs at the next handshake.
	 */
	recover(
		recoveryKey: string,
		newPassphrase: string,
		channel: KeyServiceChannel | null,
	): Promise<EncryptionStatus> {
		return this.exclusive(async () => {
			if (newPassphrase.length === 0) {
				throw new EncryptionKeyError('The new passphrase must not be empty.', {
					code: 'EMPTY_PASSPHRASE',
				})
			}
			if (channel === null) {
				this.pendingRecovery = { recoveryKey, newPassphrase }
				this.setStatus(
					this.makeStatus(
						'locked',
						'AWAITING_SERVER',
						'Recovery runs when the sync server provides the key record.',
					),
				)
				return this.status
			}
			return this.recoverLocked(recoveryKey, newPassphrase, channel)
		})
	}

	private async recoverLocked(
		recoveryKey: string,
		newPassphrase: string,
		channel: KeyServiceChannel,
	): Promise<EncryptionStatus> {
		this.pendingRecovery = null
		for (let attempt = 0; ; attempt++) {
			const reply = await channel.fetch(this.name)
			const record = reply.record
			if (record === null || !validateKeyRecord(record, this.name).ok) {
				throw new EncryptionKeyError('The server has no key record to recover.', {
					code: 'KEY_RECORD_MISSING',
				})
			}
			const recovery = record.recovery
			if (!recovery) {
				throw new EncryptionKeyError(
					'This keyring has no recovery key. Without the passphrase its data cannot be decrypted.',
					{ code: 'NO_RECOVERY_KEY' },
				)
			}
			const salt = randomBytes(KEK_SALT_BYTES)
			const newKek = await deriveKeyEncryptionKey(newPassphrase, salt, this.kdfIterations)
			const keys: WrappedDataKey[] = []
			const opened = new Map<number, { keyId: string; key: CryptoKey }>()
			for (const entry of record.keys) {
				const wrap = recovery.keys.find(
					(candidate) =>
						candidate.keyVersion === entry.keyVersion && candidate.keyId === entry.keyId,
				)
				if (!wrap) {
					throw new EncryptionKeyError(
						`Key version ${entry.keyVersion} has no recovery wrap; it cannot be recovered.`,
						{ code: 'RECOVERY_INCOMPLETE', keyVersion: entry.keyVersion },
					)
				}
				const dataKey = await unwrapWithRecovery(wrap, recoveryKey, recovery.publicKey, this.name)
				keys.push(await wrapDataKey(dataKey, newKek, this.name, entry.keyVersion, entry.keyId))
				opened.set(entry.keyVersion, { keyId: entry.keyId, key: await toNonExtractable(dataKey) })
			}
			const next: WrappedKeyRecord = {
				...record,
				revision: record.revision + 1,
				kdf: {
					name: 'PBKDF2',
					hash: 'SHA-256',
					iterations: this.kdfIterations,
					salt: toBase64(salt),
				},
				keys,
			}
			const put = await channel.put(this.name, next, record.revision)
			if (put.status === 'ok') {
				this.lockedByApp = false
				this.kek = newKek
				this.kekSalt = next.kdf.salt
				for (const [version, key] of opened) this.dataKeys.set(version, key)
				await this.commitLocked(next)
				return this.status
			}
			if (attempt + 1 >= MAX_WRITE_ATTEMPTS) throw conflictError()
		}
	}

	// --- internals (all run under the mutex) ---

	private async loadLocked(principal: string | null): Promise<EncryptionStatus> {
		if (this.loadedPrincipal === principal) return this.status
		this.dropKeys()
		this.record = null
		// A passphrase given before the first load (unlock() at start-up) is kept; one given
		// for another principal is not.
		if (this.loadedPrincipal !== undefined) this.pendingPassphrase = null
		this.loadedPrincipal = principal
		let cached: CachedKeyring | null = null
		try {
			cached = await this.cache.load(this.cacheId())
		} catch {
			cached = null
		}
		if (cached && validateKeyRecord(cached.record, this.name).ok) {
			this.record = cached.record
			this.kek = cached.kek
			this.kekSalt = cached.kek ? cached.record.kdf.salt : null
			for (const entry of cached.keys) {
				this.dataKeys.set(entry.keyVersion, { keyId: entry.keyId, key: entry.key })
			}
			if (this.dataKeys.has(cached.record.currentVersion)) {
				this.rebuildEncryptor()
				this.setStatus(this.makeStatus('unlocked'))
				return this.status
			}
			this.dropKeys()
		}
		this.setStatus(
			this.makeStatus(
				'locked',
				this.lockedByApp ? 'LOCKED_BY_APP' : 'NO_PASSPHRASE',
				'Unlock with the encryption passphrase.',
			),
		)
		return this.status
	}

	/** No record on the server: restore the one this device knows, or create the first. */
	private async createOrRestoreLocked(channel: KeyServiceChannel): Promise<'ready' | 'locked'> {
		if (this.record !== null) {
			// The server lost the record (a restore without key records). Re-upload the copy
			// this device holds: the wraps are what they were, and no history is lost.
			const restored: WrappedKeyRecord = { ...this.record, revision: 1 }
			const reply = await channel.put(this.name, restored, 0)
			return this.adoptLocked(reply.status === 'ok' ? restored : reply.record, null)
		}
		const passphrase = await this.availablePassphrase()
		if (passphrase === null) {
			this.lockWith(
				'locked',
				'NO_PASSPHRASE',
				'No key record exists yet; unlock with a passphrase to create it.',
			)
			return 'locked'
		}
		const salt = randomBytes(KEK_SALT_BYTES)
		const kek = await deriveKeyEncryptionKey(passphrase, salt, this.kdfIterations)
		const dataKey = await generateDataKey()
		const keyId = newKeyId()
		const record: WrappedKeyRecord = {
			format: KEY_RECORD_FORMAT,
			keyring: this.name,
			revision: 1,
			currentVersion: 1,
			kdf: {
				name: 'PBKDF2',
				hash: 'SHA-256',
				iterations: this.kdfIterations,
				salt: toBase64(salt),
			},
			keys: [await wrapDataKey(dataKey, kek, this.name, 1, keyId)],
		}
		const reply = await channel.put(this.name, record, 0)
		if (reply.status === 'ok') {
			// Only the confirmed record is used: a key that lost the creation race would
			// fork the user's data into a key no other device has.
			this.kek = kek
			this.kekSalt = record.kdf.salt
			this.dataKeys.set(1, { keyId, key: await toNonExtractable(dataKey) })
			this.pendingPassphrase = null
			await this.commitLocked(record)
			return 'ready'
		}
		// Another device created the record first: open that one.
		return this.adoptLocked(reply.record, passphrase)
	}

	/** Accept a server record and open every version this device lacks. */
	private async adoptLocked(
		incoming: WrappedKeyRecord | null,
		passphrase: string | null,
	): Promise<'ready' | 'locked'> {
		if (incoming === null) {
			this.lockWith('error', 'KEY_RECORD_INVALID', 'The key service returned no record.')
			return 'locked'
		}
		const validation = validateKeyRecord(incoming, this.name)
		if (!validation.ok) {
			this.lockWith(
				'error',
				'KEY_RECORD_INVALID',
				`The server's key record is malformed (${validation.reason}).`,
			)
			return 'locked'
		}
		if (incoming.kdf.iterations < this.kdfIterations) {
			// A server must not be able to make devices derive a weaker KEK.
			this.lockWith(
				'error',
				'KEY_RECORD_INVALID',
				`The server's key record uses ${incoming.kdf.iterations} PBKDF2 iterations, below this app's minimum of ${this.kdfIterations}.`,
			)
			return 'locked'
		}
		if (this.record !== null) {
			// Rollback pin: a record must keep every version this device has accepted.
			const ids = new Map(incoming.keys.map((key) => [key.keyVersion, key.keyId]))
			for (const key of this.record.keys) {
				if (ids.get(key.keyVersion) !== key.keyId) {
					this.lockWith(
						'error',
						'KEY_RECORD_ROLLBACK',
						`The server's key record lacks key version ${key.keyVersion} (${key.keyId}), which this device accepted earlier. It was rolled back or replaced; sync is stopped so nothing is encrypted under a key other devices do not have.`,
					)
					return 'locked'
				}
			}
		}
		if (this.kekSalt !== null && this.kekSalt !== incoming.kdf.salt) {
			// The passphrase changed on another device: the cached KEK no longer opens wraps.
			this.kek = null
			this.kekSalt = null
		}
		const missing = incoming.keys.filter((key) => !this.dataKeys.has(key.keyVersion))
		const explicit = passphrase !== null
		let kek = this.kek
		if (explicit || (missing.length > 0 && kek === null)) {
			const source = passphrase ?? (await this.availablePassphrase())
			if (source === null) {
				this.lockWith(
					'locked',
					this.record === null ? 'NO_PASSPHRASE' : 'PASSPHRASE_REQUIRED',
					'Enter the encryption passphrase to open the key record.',
				)
				return 'locked'
			}
			try {
				kek = await this.kekFor(incoming, source)
			} catch (error) {
				if (error instanceof EncryptionKeyError && error.keyCode === 'WRONG_PASSPHRASE') {
					this.noteFailedUnlock()
					// A mistyped unlock() on an unlocked device changes nothing.
					if (explicit && this.encryptor !== null) throw error
					this.lockWith('error', 'WRONG_PASSPHRASE', error.message)
					return 'locked'
				}
				throw error
			}
		}
		if (missing.length > 0) {
			if (kek === null) {
				this.lockWith('locked', 'PASSPHRASE_REQUIRED', 'Enter the encryption passphrase.')
				return 'locked'
			}
			const opened = new Map<number, { keyId: string; key: CryptoKey }>()
			try {
				for (const entry of missing) {
					opened.set(entry.keyVersion, {
						keyId: entry.keyId,
						key: await unwrapDataKey(entry, kek, this.name),
					})
				}
			} catch (error) {
				if (error instanceof KeyUnwrapError) {
					this.noteFailedUnlock()
					this.lockWith('error', 'WRONG_PASSPHRASE', error.message)
					return 'locked'
				}
				throw error
			}
			for (const [version, key] of opened) this.dataKeys.set(version, key)
		}
		if (kek !== null) {
			this.kek = kek
			this.kekSalt = incoming.kdf.salt
		}
		this.failedUnlocks = 0
		this.nextUnlockAt = 0
		this.pendingPassphrase = null
		await this.commitLocked(incoming)
		return 'ready'
	}

	private async adoptConflictLocked(reply: KeyServiceReply, attempt: number): Promise<void> {
		if (attempt + 1 >= MAX_WRITE_ATTEMPTS) throw conflictError()
		const outcome = await this.adoptLocked(reply.record, null)
		if (outcome !== 'ready') throw this.statusError()
	}

	private async commitLocked(record: WrappedKeyRecord): Promise<void> {
		this.record = record
		this.rebuildEncryptor()
		this.setStatus(this.makeStatus('unlocked'))
		try {
			await this.cache.save(this.cacheId(), {
				record,
				kek: this.kek,
				keys: [...this.dataKeys].map(([keyVersion, entry]) => ({
					keyVersion,
					keyId: entry.keyId,
					key: entry.key,
				})),
			})
		} catch {
			// The cache is a convenience: the keyring works for this session without it.
		}
	}

	private rebuildEncryptor(): void {
		const versions: VersionedKey[] = [...this.dataKeys].map(([version, entry]) => ({
			version,
			key: entry.key,
			keyId: entry.keyId,
		}))
		if (versions.length === 0 || this.record === null) {
			this.encryptor = null
			return
		}
		this.encryptor = SyncEncryptor.fromKeys(versions, this.encryptorOptions)
	}

	private async kekFor(record: WrappedKeyRecord, passphrase: string): Promise<CryptoKey> {
		const kek = await deriveKeyEncryptionKey(
			passphrase,
			fromBase64(record.kdf.salt),
			record.kdf.iterations,
		)
		const current = record.keys.find((key) => key.keyVersion === record.currentVersion)
		if (current) {
			try {
				await unwrapDataKey(current, kek, this.name)
			} catch (error) {
				throw new EncryptionKeyError(error instanceof Error ? error.message : 'Wrong passphrase.', {
					code: 'WRONG_PASSPHRASE',
				})
			}
		}
		return kek
	}

	private async availablePassphrase(): Promise<string | null> {
		if (this.pendingPassphrase !== null) return this.pendingPassphrase
		if (this.lockedByApp || this.passphraseSource === null) return null
		const value =
			typeof this.passphraseSource === 'function'
				? await this.passphraseSource()
				: this.passphraseSource
		return value.length > 0 ? value : null
	}

	private requireKek(action: string): CryptoKey {
		if (this.kek === null || this.encryptor === null) {
			throw new EncryptionKeyError(
				`Unlock the keyring with the passphrase to ${action}: this device holds the data keys but not the passphrase key (it changed on another device, or the keyring is locked).`,
				{ code: 'PASSPHRASE_REQUIRED' },
			)
		}
		return this.kek
	}

	private requireRecord(): WrappedKeyRecord {
		if (this.record === null) {
			throw new EncryptionKeyError('The keyring has no record yet.', { code: 'KEY_RECORD_MISSING' })
		}
		return this.record
	}

	private noteFailedUnlock(): void {
		this.failedUnlocks++
		if (this.failedUnlocks > FREE_UNLOCK_ATTEMPTS) {
			const delay = Math.min(
				MAX_UNLOCK_BACKOFF_MS,
				1000 * 2 ** (this.failedUnlocks - FREE_UNLOCK_ATTEMPTS - 1),
			)
			this.nextUnlockAt = Date.now() + delay
		}
	}

	private dropKeys(): void {
		this.dataKeys.clear()
		this.kek = null
		this.kekSalt = null
		this.encryptor = null
	}

	private lockWith(state: 'locked' | 'error', code: EncryptionStatusCode, message: string): void {
		this.dropKeysIfUnusable(code)
		this.setStatus(this.makeStatus(state, code, message))
	}

	/** Errors about the record keep nothing usable; a wrong passphrase keeps held keys. */
	private dropKeysIfUnusable(code: EncryptionStatusCode): void {
		if (
			code === 'KEY_RECORD_ROLLBACK' ||
			code === 'KEY_RECORD_INVALID' ||
			code === 'LOCKED_BY_APP' ||
			code === 'KEY_SERVICE_FORBIDDEN' ||
			code === 'KEY_SERVICE_UNSUPPORTED' ||
			code === 'PASSPHRASE_REQUIRED' ||
			code === 'WRONG_PASSPHRASE'
		) {
			this.encryptor = null
		}
	}

	private statusError(): EncryptionKeyError {
		return new EncryptionKeyError(this.status.message ?? 'The keyring is locked.', {
			code: this.status.code ?? 'LOCKED',
		})
	}

	private cacheId(): string {
		return `${this.loadedPrincipal ?? ''}\u0000${this.name}`
	}

	private makeStatus(
		state: EncryptionLockState,
		code?: EncryptionStatusCode,
		message?: string,
	): EncryptionStatus {
		const unlocked = state === 'unlocked' && this.encryptor !== null
		const keyVersion = unlocked ? (this.encryptor?.getCurrentKeyVersion() ?? null) : null
		return {
			state,
			keyring: this.name,
			keyVersion,
			keyId: keyVersion !== null ? (this.dataKeys.get(keyVersion)?.keyId ?? null) : null,
			availableVersions: unlocked ? [...this.dataKeys.keys()].sort((a, b) => a - b) : [],
			cache: this.cache.kind,
			...(code ? { code } : {}),
			...(message ? { message } : {}),
		}
	}

	private setStatus(status: EncryptionStatus): void {
		const previous = this.status
		this.status = status
		if (
			previous?.state === status.state &&
			previous.code === status.code &&
			previous.keyVersion === status.keyVersion &&
			previous.availableVersions?.length === status.availableVersions.length
		) {
			return
		}
		for (const listener of this.listeners) {
			try {
				listener(status)
			} catch {
				// A listener error must not break the keyring.
			}
		}
	}

	private exclusive<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.mutex.then(fn, fn)
		this.mutex = run.catch(() => undefined)
		return run
	}
}

function conflictError(): EncryptionKeyError {
	return new EncryptionKeyError(
		'The key record kept changing on the server while this device updated it. Try again.',
		{ code: 'KEY_RECORD_CONFLICT' },
	)
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
