import { SyncError } from '@korajs/core'
import type { CachedKeyring, KeyCache } from './key-cache'
import { MemoryKeyCache } from './key-cache'
import { DEFAULT_PBKDF2_ITERATIONS } from './key-derivation'
import type { WrappedDataKey, WrappedKeyRecord } from './key-record'
import {
	DEFAULT_KEYRING,
	KEY_RECORD_FORMAT,
	canonicalJson,
	isKeyId,
	isMasterId,
	validateKeyRecord,
} from './key-record'
import type { MasterKeys } from './keyring-crypto'
import {
	KEK_SALT_BYTES,
	KeyUnwrapError,
	bytesEqual,
	createRecoveryKeyPair,
	deriveKeyEncryptionKey,
	formatRecoveryKey,
	fromBase64,
	generateDataKey,
	generateMasterKey,
	importMasterKey,
	newKeyId,
	newRingId,
	parseRecoveryKey,
	randomBytes,
	recoveryAnchor,
	sealRecord,
	toBase64,
	toNonExtractable,
	unwrapDataKey,
	unwrapMasterKey,
	unwrapMasterWithRecovery,
	verifyRecordMac,
	wrapDataKey,
	wrapMasterForRecovery,
	wrapMasterKey,
} from './keyring-crypto'
import type { EncryptorOptions } from './sync-encryptor'
import { SyncEncryptor } from './sync-encryptor'
import type { VersionedKey } from './types'

/** Lock state of an encryption keyring. */
export type EncryptionLockState = 'locked' | 'unlocking' | 'unlocked' | 'error'

/** Why a keyring is locked or in error (or, while unlocked, what needs attention). */
export type EncryptionStatusCode =
	| 'NO_PASSPHRASE'
	| 'AWAITING_SERVER'
	| 'LOCKED_BY_APP'
	| 'WRONG_PASSPHRASE'
	| 'PASSPHRASE_REQUIRED'
	| 'KEY_RECORD_INVALID'
	| 'KEY_RECORD_ROLLBACK'
	| 'KEY_RECORD_MISSING'
	| 'KEY_RING_FORK'
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
	/**
	 * Set while locked or in error. While `unlocked`, `PASSPHRASE_REQUIRED` means the
	 * passphrase changed on another device: this device keeps working with the keys it
	 * holds, and needs the current passphrase for key management.
	 */
	code?: EncryptionStatusCode
	message?: string
}

/** The server's answer to a key-record fetch or write. */
export interface KeyServiceReply {
	/** 'conflict': the write lost a compare-and-set; `record` is the current one. */
	status: 'ok' | 'conflict'
	record: WrappedKeyRecord | null
	/**
	 * With no record: key ids the server's stored operations of this owner are encrypted
	 * with (a sample). Non-empty means encrypted history exists, so the record was lost
	 * and a device that holds the ring must re-upload it; nobody may start a new ring.
	 */
	knownKeyIds?: string[]
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
/** Compare-and-set retries of one key-record write (and nested adopt/merge rounds). */
const MAX_WRITE_ATTEMPTS = 4

/** A record this device authenticated: the master keys that verify it, and its KEK if known. */
interface OpenedRing {
	master: MasterKeys
	/** The KEK of the record's own salt, when this device derived (or holds) it. */
	kek: CryptoKey | null
}

/**
 * A device's view of one encryption keyring (ENC-1, decision D4b; record format 2): the
 * server-stored, passphrase-wrapped ring, opened and authenticated locally.
 *
 * - **Shared key material.** Every device of a user opens the same record, so every
 *   device holds the same data keys and decrypts everything.
 * - **Authenticated record.** The record carries an HMAC under a key derived from the
 *   ring's master key; a device acts only on records it verified (RT-95). The server
 *   can store, withhold or replay records, nothing more.
 * - **Forward only.** A device pins the ring id and highest revision it accepted and
 *   refuses a lower revision (`KEY_RECORD_ROLLBACK`, RT-96), keeping its keys and
 *   re-uploading its newer record when connected.
 * - **Writes re-read.** Every compare-and-set retry adopts the server's current record
 *   first and wraps under that record's master key only (RT-97).
 * - **Lost records.** A device holding the ring re-uploads it unchanged; a new device
 *   that finds no record but encrypted history waits (`KEY_RECORD_MISSING`); two rings
 *   that exist anyway are merged by the first device holding both (RT-104).
 * - **Offline.** Once unlocked, keys are cached (non-extractable) and the keyring needs
 *   no server; a cached record also lets `unlock()` work offline.
 */
export class EncryptionKeyring {
	readonly name: string
	private passphraseSource: string | (() => Promise<string>) | null
	private readonly cache: KeyCache
	private readonly kdfIterations: number
	private readonly encryptorOptions: EncryptorOptions
	private loadedPrincipal: string | null | undefined = undefined
	/** The last record this device authenticated and accepted: the pin. */
	private record: WrappedKeyRecord | null = null
	/** Keys derived from the pinned record's master key. */
	private master: MasterKeys | null = null
	private kek: CryptoKey | null = null
	/** Salt (base64) the KEK was derived with. */
	private kekSalt: string | null = null
	/** Held data keys by key id. Invariant: every held key id is in `record`. */
	private readonly dataKeys = new Map<string, CryptoKey>()
	/**
	 * Ids of master keys a passphrase change retired, from every record this device
	 * authenticated (persisted with the cache): a record authenticated only by one of
	 * them is refused (RT-107).
	 */
	private readonly retiredMasters = new Set<string>()
	private encryptor: SyncEncryptor | null = null
	private status: EncryptionStatus
	private readonly listeners = new Set<(status: EncryptionStatus) => void>()
	private lockedByApp = false
	private pendingPassphrase: string | null = null
	/** A recovery requested while offline, run at the next handshake. */
	private pendingRecovery: { recoveryKey: string; newPassphrase: string } | null = null
	/** The configured passphrase that failed for a salt (not retried for that salt). */
	private failedSource: { salt: string; passphrase: string } | null = null
	/** The current lock is a server-side condition a later session can clear (no user action). */
	private retryable = false
	/** startNewKeyring() was called: a missing record with encrypted history may be replaced. */
	private allowNewRing = false
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

	/** Whether this device holds the data key with this key id. */
	holdsKeyId(keyId: string): boolean {
		return this.dataKeys.has(keyId)
	}

	/**
	 * Whether the current lock is a server-side condition (a rolled-back, missing,
	 * malformed or forked record) that a later sync session can clear without the user:
	 * sync should reconnect with backoff rather than wait for `unlock()`.
	 */
	isRetryableLock(): boolean {
		return this.retryable && this.status.state !== 'unlocked'
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
	 * create it on a user's first device, adopt a newer revision, re-upload a lost or
	 * rolled-back one, or merge a forked ring.
	 *
	 * @returns 'ready' when unlocked, 'locked' when a passphrase is needed (or wrong), or
	 *   when the server's record must change first ({@link isRetryableLock})
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
					return await this.createOrRestoreLocked(channel, reply.knownKeyIds ?? [])
				}
				return await this.adoptLocked(reply.record, null, channel)
			} catch (error) {
				// Permanent refusals: retrying the session would not change them.
				if (
					error instanceof EncryptionKeyError &&
					(error.keyCode === 'KEY_SERVICE_FORBIDDEN' || error.keyCode === 'KEY_SERVICE_UNSUPPORTED')
				) {
					this.lockWith('error', error.keyCode, error.message)
					return 'locked'
				}
				if (this.encryptor === null && this.status.state === 'unlocking') {
					this.setStatus(this.makeStatus('locked', 'AWAITING_SERVER', errorMessage(error)))
				}
				throw error
			}
		})
	}

	/**
	 * Adopt a record the server pushed (another device rotated keys, changed the
	 * passphrase or set up recovery). Without a connection to write to, a rollback or a
	 * fork is reported and resolved at the next handshake.
	 *
	 * @returns 'ready' when still unlocked, 'locked' when the passphrase is needed or the
	 *   record was refused
	 */
	adoptPushed(record: WrappedKeyRecord): Promise<'ready' | 'locked'> {
		return this.exclusive(() => this.adoptLocked(record, null, null))
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
	 * @throws {EncryptionKeyError} WRONG_PASSPHRASE, UNLOCK_THROTTLED, KEY_RECORD_MISSING
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
				if (reply.record === null) {
					// Kept for the next handshake when the record is missing (KEY_RECORD_MISSING).
					this.pendingPassphrase = passphrase
					const outcome = await this.createOrRestoreLocked(channel, reply.knownKeyIds ?? [])
					if (outcome !== 'ready') throw this.statusError()
					return this.status
				}
				record = reply.record
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
			const outcome = await this.adoptLocked(record, passphrase, channel)
			if (outcome !== 'ready') {
				this.pendingPassphrase = null
				throw this.statusError()
			}
			return this.status
		})
	}

	/**
	 * Lock: forget the data keys, the master keys and the KEK on this device (cache
	 * included). Sync stops until `unlock()`; local data stays readable (it is not
	 * encrypted at rest by this layer). The pinned record is kept (it is the rollback
	 * floor). The configured passphrase is not used again until `unlock()`.
	 */
	lock(): Promise<EncryptionStatus> {
		return this.exclusive(async () => {
			this.lockedByApp = true
			this.pendingPassphrase = null
			this.dropKeys()
			const record = this.record
			if (record) {
				await this.cache.save(this.cacheId(), {
					record,
					kek: null,
					master: null,
					keys: [],
					retiredMasters: [...this.retiredMasters],
				})
			} else {
				await this.cache.clear(this.cacheId())
			}
			this.lockWith('locked', 'LOCKED_BY_APP', 'Locked by the app. Call unlock(passphrase).')
			return this.status
		})
	}

	/**
	 * Rotate: create a new data key version. New operations use it; old versions stay
	 * in the record so history decrypts. Needs the server (compare-and-set). Each retry
	 * adopts the server's current record first and wraps under ITS master key only.
	 */
	rotate(channel: KeyServiceChannel): Promise<EncryptionStatus> {
		return this.exclusive(async () => {
			for (let attempt = 0; ; attempt++) {
				const record = this.requireRecord()
				const master = this.requireMaster('rotate the key')
				const dataKey = await generateDataKey()
				const keyVersion = record.currentVersion + 1
				const keyId = newKeyId()
				const next = await sealRecord(
					{
						...record,
						revision: record.revision + 1,
						currentVersion: keyVersion,
						keys: [
							...record.keys,
							await wrapDataKey(dataKey, master.wrapKey, this.name, keyVersion, keyId),
						],
					},
					master.macKey,
				)
				const reply = await channel.put(this.name, next, record.revision)
				if (reply.status === 'ok') {
					this.dataKeys.set(keyId, await toNonExtractable(dataKey))
					await this.commitLocked(next)
					return this.status
				}
				await this.followConflictLocked(reply, attempt, null, channel)
			}
		})
	}

	/**
	 * Change the passphrase: a NEW master key, sealed under a KEK derived from the new
	 * passphrase and a new salt, re-wraps every data key version (and the recovery wrap,
	 * if any). No operation is re-encrypted. The record lists the old master key as
	 * retired (`retiredMasters`): a device that authenticated this record (or a later
	 * one) refuses every record authenticated only by the old master key, however it is
	 * opened. Other devices keep working with their cached data keys (status
	 * `PASSPHRASE_REQUIRED` while unlocked); they need the new passphrase for a key they
	 * do not hold and for key management.
	 *
	 * **A passphrase change alone does not contain a leaked passphrase.** The ring is a
	 * shared secret: a device that still holds only the OLD master key cannot tell a
	 * record the server forged under it (with a data key of the attacker's) from a
	 * genuine one, and the server decides which records it forwards. After a suspected
	 * leak: change the passphrase, `rotate()`, call `enableRecovery()` again (a recovery
	 * key made before the change can be steered to a ring the old passphrase built) and
	 * re-unlock EVERY other device with the new passphrase (`lock()`, then
	 * `unlock(newPassphrase)`, and update any configured `key`). A device that is not
	 * re-unlocked, or an old recovery key that is still used, remains exposed.
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
				const master =
					currentPassphrase !== undefined
						? (await this.openWithPassphrase(record, currentPassphrase)).master
						: this.requireMaster('change the passphrase')
				const raw = generateMasterKey()
				const salt = randomBytes(KEK_SALT_BYTES)
				let next: WrappedKeyRecord
				let newMaster: MasterKeys
				let newKek: CryptoKey
				try {
					newMaster = await importMasterKey(raw)
					newKek = await deriveKeyEncryptionKey(newPassphrase, salt, this.kdfIterations)
					const keys: WrappedDataKey[] = []
					for (const entry of record.keys) {
						const dataKey = await unwrapDataKey(entry, master.wrapKey, this.name, true)
						keys.push(
							await wrapDataKey(
								dataKey,
								newMaster.wrapKey,
								this.name,
								entry.keyVersion,
								entry.keyId,
							),
						)
					}
					const { recovery: previousRecovery, ...rest } = record
					next = await sealRecord(
						{
							...rest,
							revision: record.revision + 1,
							kdf: {
								name: 'PBKDF2',
								hash: 'SHA-256',
								iterations: this.kdfIterations,
								salt: toBase64(salt),
							},
							master: await wrapMasterKey(raw, newKek, this.name, record.ringId),
							keys,
							// Authenticated under the NEW master: a device that accepts this record
							// never again accepts one authenticated only by the old one (RT-107).
							retiredMasters: [...new Set([...(record.retiredMasters ?? []), master.id])],
							// The recovery public key was authenticated with the record; the new
							// master key is wrapped to it, so the recovery key keeps working.
							...(previousRecovery
								? {
										recovery: await wrapMasterForRecovery(
											raw,
											previousRecovery.publicKey,
											this.name,
											record.ringId,
										),
									}
								: {}),
						},
						newMaster.macKey,
					)
				} finally {
					raw.fill(0)
				}
				const reply = await channel.put(this.name, next, record.revision)
				if (reply.status === 'ok') {
					this.master = newMaster
					this.kek = newKek
					this.kekSalt = next.kdf.salt
					this.failedSource = null
					await this.commitLocked(next)
					return this.status
				}
				await this.followConflictLocked(reply, attempt, currentPassphrase ?? null, channel)
			}
		})
	}

	/**
	 * Set up (or replace) the recovery key: the ring's master key is also wrapped to a
	 * new recovery public key, and the private half is returned ONCE. Store it offline;
	 * it recovers the data after a lost passphrase. Without it, a lost passphrase means
	 * the encrypted data is unrecoverable. Needs the passphrase key of the CURRENT
	 * record (the recovery block is authenticated with the record, so only a holder of
	 * the master key can add or replace it).
	 *
	 * The same write adds a new data key version (a rotation) that anchors the recovery
	 * key to this ring: `recover()` accepts only a ring holding that key, which no older
	 * passphrase ever opened (RT-107). After a suspected passphrase leak, call this again
	 * once the passphrase was changed, and destroy the previous recovery key.
	 *
	 * @returns The recovery key (`kora-rk3-<key>.<anchor>`)
	 */
	enableRecovery(channel: KeyServiceChannel): Promise<string> {
		return this.exclusive(async () => {
			for (let attempt = 0; ; attempt++) {
				const record = this.requireRecord()
				const master = this.requireMaster('set up a recovery key')
				const kek = this.requireKek(record, 'set up a recovery key')
				const raw = await unwrapMasterKey(record.master, kek, this.name, record.ringId).catch(
					(error: unknown) => {
						throw new EncryptionKeyError(
							'This device cannot open the current key record with its passphrase key. Unlock with the current passphrase, then try again.',
							{ code: 'PASSPHRASE_REQUIRED', cause: errorMessage(error) },
						)
					},
				)
				// The anchor key: a new data key version created in this write under the
				// current master key only. No earlier passphrase or master key ever opened it,
				// so nobody holding an older (leaked) passphrase can build a ring the recovery
				// key accepts (RT-107). It also becomes the key new operations use.
				const anchorKey = await generateDataKey()
				const keyVersion = record.currentVersion + 1
				const keyId = newKeyId()
				let next: WrappedKeyRecord
				let recoveryKey: string
				try {
					const { publicKey, d } = await createRecoveryKeyPair()
					recoveryKey = formatRecoveryKey(
						d,
						await recoveryAnchor(anchorKey, this.name, record.ringId, keyId, publicKey),
					)
					next = await sealRecord(
						{
							...record,
							revision: record.revision + 1,
							currentVersion: keyVersion,
							keys: [
								...record.keys,
								await wrapDataKey(anchorKey, master.wrapKey, this.name, keyVersion, keyId),
							],
							recovery: await wrapMasterForRecovery(raw, publicKey, this.name, record.ringId),
						},
						master.macKey,
					)
				} finally {
					raw.fill(0)
				}
				const reply = await channel.put(this.name, next, record.revision)
				if (reply.status === 'ok') {
					this.dataKeys.set(keyId, await toNonExtractable(anchorKey))
					await this.commitLocked(next)
					return recoveryKey
				}
				await this.followConflictLocked(reply, attempt, null, channel)
			}
		})
	}

	/**
	 * Recover after a lost passphrase: open the ring's master key with the recovery key,
	 * verify the whole record with it, and seal the master key under a new passphrase.
	 * Unlocks this device. Without a channel (sync not connected) the recovery runs at
	 * the next handshake. Devices that hold the ring keep working without a prompt (the
	 * master key is unchanged).
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

	/**
	 * Last resort after the server lost the key record and no device that holds the ring
	 * will come back (`KEY_RECORD_MISSING`): allow this device to create a new ring.
	 * Operations encrypted under the lost ring stay unreadable on this device. If a device
	 * holding the old ring reconnects later, it merges both rings and the history becomes
	 * readable again. Without a channel (sync is not connected: a missing record ends the
	 * session) the ring is created at the next handshake.
	 *
	 * @throws {EncryptionKeyError} KEY_RECORD_EXISTS when the server has a record (unlock it)
	 */
	startNewKeyring(channel: KeyServiceChannel | null): Promise<EncryptionStatus> {
		return this.exclusive(async () => {
			this.allowNewRing = true
			if (channel === null) {
				this.retryable = false
				this.setStatus(
					this.makeStatus(
						'locked',
						'AWAITING_SERVER',
						'A new keyring is created when the sync server is reached (unless it holds a record).',
					),
				)
				return this.status
			}
			const reply = await channel.fetch(this.name)
			if (reply.record !== null) {
				this.allowNewRing = false
				throw new EncryptionKeyError(
					'The sync server holds a key record for this keyring: unlock it with the passphrase instead.',
					{ code: 'KEY_RECORD_EXISTS' },
				)
			}
			const outcome = await this.createOrRestoreLocked(channel, reply.knownKeyIds ?? [])
			if (outcome !== 'ready') throw this.statusError()
			return this.status
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
			const pinned = this.record
			if (pinned && pinned.ringId === record.ringId && record.revision < pinned.revision) {
				throw new EncryptionKeyError(
					`The server served revision ${record.revision} of the key record, older than revision ${pinned.revision} this device accepted. Recovery is refused on a rolled-back record.`,
					{ code: 'KEY_RECORD_ROLLBACK' },
				)
			}
			const raw = await unwrapMasterWithRecovery(recovery, recoveryKey, this.name, record.ringId)
			const salt = randomBytes(KEK_SALT_BYTES)
			let master: MasterKeys
			let newKek: CryptoKey
			let masterWrap: WrappedKeyRecord['master']
			try {
				master = await importMasterKey(raw)
				if (!(await verifyRecordMac(record, master.macKey))) {
					throw new EncryptionKeyError(
						'The key record does not authenticate under the recovered master key: it was modified by someone without the keys. Recovery is refused.',
						{ code: 'KEY_RECORD_INVALID' },
					)
				}
				if (this.isRetiredMaster(record, master)) {
					throw new EncryptionKeyError(
						'The key record is authenticated by a master key a passphrase change retired. Recovery is refused.',
						{ code: 'KEY_RECORD_INVALID' },
					)
				}
				// The recovery PUBLIC key is no secret: anyone can wrap a master key of their own
				// to it and seal a record under that master. Only the user's own ring holds the
				// anchor key created with the recovery key, which no older passphrase opened.
				if (
					!(await this.holdsAnchor(
						record,
						master,
						recovery.publicKey,
						parseRecoveryKey(recoveryKey).anchor,
					))
				) {
					throw new EncryptionKeyError(
						'The key record opens with this recovery key but is not the keyring the recovery key was made for: it lacks the data key the recovery key is anchored to (the server substituted another keyring). Recovery is refused.',
						{ code: 'KEY_RECORD_INVALID' },
					)
				}
				newKek = await deriveKeyEncryptionKey(newPassphrase, salt, this.kdfIterations)
				masterWrap = await wrapMasterKey(raw, newKek, this.name, record.ringId)
			} finally {
				raw.fill(0)
			}
			const opened = await this.openDataKeys(record, master)
			const absorbed = await this.absorbHeldKeys(record, master)
			const next = await sealRecord(
				{
					...record,
					revision: this.nextRevision(record),
					kdf: {
						name: 'PBKDF2',
						hash: 'SHA-256',
						iterations: this.kdfIterations,
						salt: toBase64(salt),
					},
					master: masterWrap,
					keys: [...record.keys, ...absorbed],
					currentVersion: record.currentVersion + absorbed.length,
				},
				master.macKey,
			)
			const put = await channel.put(this.name, next, record.revision)
			if (put.status === 'ok') {
				this.lockedByApp = false
				this.master = master
				this.kek = newKek
				this.kekSalt = next.kdf.salt
				for (const [keyId, key] of opened) this.dataKeys.set(keyId, key)
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
		this.retiredMasters.clear()
		this.failedSource = null
		this.allowNewRing = false
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
			const record = cached.record
			this.record = record
			for (const id of [...(cached.retiredMasters ?? []), ...(record.retiredMasters ?? [])]) {
				if (isMasterId(id)) this.retiredMasters.add(id)
			}
			const known = new Set(record.keys.map((key) => key.keyId))
			for (const entry of cached.keys) {
				if (known.has(entry.keyId)) this.dataKeys.set(entry.keyId, entry.key)
			}
			const current = record.keys.find((key) => key.keyVersion === record.currentVersion)
			// A release-candidate cache keeps master keys without an id: unlock again.
			if (
				cached.master &&
				typeof cached.master.id === 'string' &&
				current &&
				this.dataKeys.has(current.keyId)
			) {
				this.master = cached.master
				this.kek = cached.kek
				this.kekSalt = cached.kek ? record.kdf.salt : null
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

	/**
	 * No record on the server. A device that holds a ring re-uploads it unchanged (same
	 * revision and MAC, so every device's pin still accepts it). A device without one
	 * creates the first ring, unless the server reports encrypted history: then the
	 * record was lost, and it waits for a device that holds the ring.
	 */
	private async createOrRestoreLocked(
		channel: KeyServiceChannel,
		knownKeyIds: string[],
	): Promise<'ready' | 'locked'> {
		if (this.record !== null) {
			const restored = this.record
			const reply = await channel.put(this.name, restored, 0)
			return this.adoptLocked(reply.status === 'ok' ? restored : reply.record, null, channel)
		}
		const history = knownKeyIds.filter((keyId) => isKeyId(keyId))
		if (history.length > 0 && !this.allowNewRing) {
			this.holdFor(
				'locked',
				'KEY_RECORD_MISSING',
				`The sync server has no key record for keyring "${this.name}", but it stores operations encrypted with it: the record was lost (for example a server restored without its key table). Waiting for a device that holds the keyring to reconnect and re-upload it. If no such device exists, startNewKeyring() starts a new keyring; the old history then stays unreadable.`,
			)
			return 'locked'
		}
		return this.createRingLocked(channel)
	}

	/** Create a brand-new ring (the user's first device). */
	private async createRingLocked(channel: KeyServiceChannel): Promise<'ready' | 'locked'> {
		const passphrase = await this.availablePassphrase()
		if (passphrase === null) {
			this.lockWith(
				'locked',
				'NO_PASSPHRASE',
				'No key record exists yet; unlock with a passphrase to create it.',
			)
			return 'locked'
		}
		const ringId = newRingId()
		const salt = randomBytes(KEK_SALT_BYTES)
		const kek = await deriveKeyEncryptionKey(passphrase, salt, this.kdfIterations)
		const raw = generateMasterKey()
		let master: MasterKeys
		let masterWrap: WrappedKeyRecord['master']
		try {
			master = await importMasterKey(raw)
			masterWrap = await wrapMasterKey(raw, kek, this.name, ringId)
		} finally {
			raw.fill(0)
		}
		const dataKey = await generateDataKey()
		const keyId = newKeyId()
		const record = await sealRecord(
			{
				format: KEY_RECORD_FORMAT,
				keyring: this.name,
				ringId,
				revision: 1,
				currentVersion: 1,
				kdf: {
					name: 'PBKDF2',
					hash: 'SHA-256',
					iterations: this.kdfIterations,
					salt: toBase64(salt),
				},
				master: masterWrap,
				keys: [await wrapDataKey(dataKey, master.wrapKey, this.name, 1, keyId)],
			},
			master.macKey,
		)
		const reply = await channel.put(this.name, record, 0)
		if (reply.status === 'ok') {
			// Only the confirmed record is used: a key that lost the creation race would
			// fork the user's data into a key no other device has.
			this.allowNewRing = false
			this.master = master
			this.kek = kek
			this.kekSalt = record.kdf.salt
			this.dataKeys.set(keyId, await toNonExtractable(dataKey))
			this.pendingPassphrase = null
			await this.commitLocked(record)
			return 'ready'
		}
		if (reply.record === null) {
			throw new EncryptionKeyError('The key service refused the first record without a reason.', {
				code: 'KEY_RECORD_CONFLICT',
			})
		}
		// Another device created the record first: open that one.
		return this.adoptLocked(reply.record, passphrase, channel)
	}

	/**
	 * Accept a server record, after authenticating it.
	 *
	 * - Lower revision of the pinned ring: refused (rollback); re-upload the pin.
	 * - Authenticated by the held master key, or by the passphrase (explicit, else the
	 *   configured one): forward when it keeps every key this device holds, else merge.
	 * - Not authenticated: nothing is adopted. A device that holds every key of a newer
	 *   revision of its ring keeps working (the passphrase changed elsewhere); otherwise
	 *   it needs the passphrase.
	 */
	private async adoptLocked(
		incoming: WrappedKeyRecord | null,
		passphrase: string | null,
		channel: KeyServiceChannel | null,
		depth = 0,
	): Promise<'ready' | 'locked'> {
		if (incoming === null) {
			return this.refuseRecord('KEY_RECORD_INVALID', 'The key service returned no record.')
		}
		const validation = validateKeyRecord(incoming, this.name)
		if (!validation.ok) {
			return this.refuseRecord(
				'KEY_RECORD_INVALID',
				`The server's key record is malformed (${validation.reason}).`,
			)
		}
		if (incoming.kdf.iterations < this.kdfIterations) {
			// A server must not be able to make devices derive a weaker KEK.
			return this.refuseRecord(
				'KEY_RECORD_INVALID',
				`The server's key record uses ${incoming.kdf.iterations} PBKDF2 iterations, below this app's minimum of ${this.kdfIterations}.`,
			)
		}
		const pinned = this.record
		const explicit = passphrase !== null
		if (pinned !== null && incoming.ringId === pinned.ringId) {
			if (incoming.revision < pinned.revision) {
				return this.rollbackLocked(incoming, passphrase, channel, depth)
			}
			if (
				!explicit &&
				incoming.revision === pinned.revision &&
				canonicalJson(incoming) === canonicalJson(pinned) &&
				this.master !== null &&
				this.encryptor !== null
			) {
				if (this.status.state !== 'unlocked' || this.status.code !== undefined) {
					this.retryable = false
					this.setStatus(this.makeStatus('unlocked'))
				}
				return 'ready'
			}
		}

		let opened = await this.authenticateHeld(incoming)
		let sourceFailed = false
		if (opened === null || explicit) {
			const source = passphrase ?? (await this.sourcePassphraseFor(incoming))
			if (source !== null) {
				try {
					opened = await this.openWithPassphrase(incoming, source)
				} catch (error) {
					if (!(error instanceof EncryptionKeyError)) throw error
					if (error.keyCode === 'KEY_RECORD_INVALID') {
						return this.refuseRecord('KEY_RECORD_INVALID', error.message)
					}
					if (explicit) {
						this.noteFailedUnlock()
						// A mistyped unlock() on an unlocked device changes nothing.
						if (this.encryptor !== null) throw error
						this.lockWith('error', 'WRONG_PASSPHRASE', error.message)
						return 'locked'
					}
					this.failedSource = { salt: incoming.kdf.salt, passphrase: source }
					sourceFailed = true
				}
			} else if (this.failedSource?.salt === incoming.kdf.salt) {
				sourceFailed = true
			}
		}
		if (opened === null) return this.unverifiableLocked(incoming, sourceFailed)
		if (this.isRetiredMaster(incoming, opened.master)) return this.refuseRetired()
		return this.acceptLocked(incoming, opened, passphrase, channel, depth)
	}

	/** An authenticated record: move forward to it, or merge it with the held ring. */
	private async acceptLocked(
		incoming: WrappedKeyRecord,
		opened: OpenedRing,
		passphrase: string | null,
		channel: KeyServiceChannel | null,
		depth: number,
	): Promise<'ready' | 'locked'> {
		const incomingIds = new Set(incoming.keys.map((key) => key.keyId))
		const uncovered = [...this.dataKeys.keys()].some((keyId) => !incomingIds.has(keyId))
		if (uncovered) {
			// Another ring (the server lost the record and a device created a new one), or a
			// diverged revision: it lacks keys this device holds. Merge, never drop them.
			if (channel === null) {
				this.holdFor(
					'error',
					'KEY_RING_FORK',
					'The server holds a key ring that lacks keys this device holds. Both rings are merged at the next sync session.',
				)
				return 'locked'
			}
			return this.mergeLocked(incoming, opened, passphrase, channel, depth)
		}
		let keys: Map<string, CryptoKey>
		try {
			keys = await this.openDataKeys(incoming, opened.master)
		} catch (error) {
			return this.refuseRecord(
				'KEY_RECORD_INVALID',
				`An authenticated key record holds a data-key wrap its master key does not open (${errorMessage(error)}).`,
			)
		}
		for (const [keyId, key] of keys) this.dataKeys.set(keyId, key)
		this.master = opened.master
		if (opened.kek !== null) {
			this.kek = opened.kek
			this.kekSalt = incoming.kdf.salt
		} else if (this.kekSalt !== incoming.kdf.salt) {
			this.kek = null
			this.kekSalt = null
		}
		if (passphrase !== null) {
			this.failedUnlocks = 0
			this.nextUnlockAt = 0
		}
		this.pendingPassphrase = null
		await this.commitLocked(incoming)
		return 'ready'
	}

	/** A lower revision of the pinned ring: refuse it, keep the keys, re-upload the pin. */
	private async rollbackLocked(
		incoming: WrappedKeyRecord,
		passphrase: string | null,
		channel: KeyServiceChannel | null,
		depth: number,
	): Promise<'ready' | 'locked'> {
		const pinned = this.record as WrappedKeyRecord
		this.holdFor(
			'error',
			'KEY_RECORD_ROLLBACK',
			`The server served revision ${incoming.revision} of the key record, older than revision ${pinned.revision} this device accepted (a rollback, or a server restored from an old backup). It is refused; this device keeps its keys${channel ? ' and re-uploads its newer record' : ' and re-uploads its newer record at the next sync session'}.`,
		)
		if (channel === null || depth >= MAX_WRITE_ATTEMPTS) return 'locked'
		const pinnedVersions = new Map(pinned.keys.map((key) => [key.keyVersion, key.keyId]))
		const subset = incoming.keys.every((key) => pinnedVersions.get(key.keyVersion) === key.keyId)
		if (subset) {
			// The pin keeps everything the older revision has: put it back as it is.
			const reply = await channel.put(this.name, pinned, incoming.revision)
			return this.adoptLocked(
				reply.status === 'ok' ? pinned : reply.record,
				passphrase,
				channel,
				depth + 1,
			)
		}
		// The older revision has keys this device lacks (the ring diverged after a
		// restore): merge both into a revision above either, once it is authenticated.
		let opened = await this.authenticateHeld(incoming)
		if (opened === null) {
			const source = passphrase ?? (await this.sourcePassphraseFor(incoming))
			if (source !== null) {
				opened = await this.openWithPassphrase(incoming, source).catch(() => null)
			}
		}
		if (opened === null) return 'locked'
		if (this.isRetiredMaster(incoming, opened.master)) return this.refuseRetired()
		return this.mergeLocked(incoming, opened, passphrase, channel, depth)
	}

	/**
	 * A record authenticated only by a master key a passphrase change retired: whoever
	 * wrote it knew an OLD passphrase (or master key), not the current one (RT-107).
	 */
	private refuseRetired(): 'locked' {
		return this.refuseRecord(
			'KEY_RECORD_INVALID',
			"The server's key record is authenticated only by a master key that a passphrase change retired: it was written with an old passphrase. It is refused; this device keeps its keys.",
		)
	}

	/** A record this device cannot authenticate: adopt nothing. */
	private unverifiableLocked(
		incoming: WrappedKeyRecord,
		sourceFailed: boolean,
	): 'ready' | 'locked' {
		const pinned = this.record
		if (
			pinned !== null &&
			this.encryptor !== null &&
			incoming.ringId === pinned.ringId &&
			incoming.revision === pinned.revision
		) {
			// Another body under the revision this device accepted, and it does not
			// authenticate: tampered. The held keys are unaffected.
			return this.refuseRecord(
				'KEY_RECORD_INVALID',
				`The server's key record differs from revision ${pinned.revision} this device accepted and does not authenticate. It is refused.`,
			)
		}
		if (
			pinned !== null &&
			this.encryptor !== null &&
			incoming.ringId === pinned.ringId &&
			incoming.revision > pinned.revision &&
			incoming.keys.every((key) => this.dataKeys.has(key.keyId))
		) {
			// The passphrase changed on another device (new master key), or the server forged
			// a record: either way nothing in it is used. The held keys are the ring's keys.
			this.retryable = false
			this.setStatus(
				this.makeStatus(
					'unlocked',
					'PASSPHRASE_REQUIRED',
					'The key record changed on another device (passphrase change). This device keeps using the keys it holds; enter the current passphrase to rotate keys, change the passphrase or set up recovery here.',
				),
			)
			return 'ready'
		}
		if (sourceFailed) {
			this.lockWith(
				'error',
				'WRONG_PASSPHRASE',
				`The configured passphrase does not open keyring "${this.name}". Check the passphrase.`,
			)
			return 'locked'
		}
		if (pinned !== null && incoming.ringId !== pinned.ringId) {
			this.lockWith(
				'locked',
				'KEY_RING_FORK',
				'The server holds another key ring for this keyring (it lost the record and another device created a new one). Enter the passphrase: both rings are merged and every operation stays readable.',
			)
			return 'locked'
		}
		this.lockWith(
			'locked',
			pinned === null ? 'NO_PASSPHRASE' : 'PASSPHRASE_REQUIRED',
			'Enter the encryption passphrase to open the key record.',
		)
		return 'locked'
	}

	/**
	 * Merge the held ring into `base` (the server's current record, which survives: the
	 * server only accepts append-only successors of what it stores). Keys this device
	 * holds that `base` lacks are appended as new versions; operations keep naming them
	 * by key id. The result has a higher revision than both and is written with
	 * compare-and-set; a lost race adopts (or merges) the winner.
	 */
	private async mergeLocked(
		base: WrappedKeyRecord,
		opened: OpenedRing,
		passphrase: string | null,
		channel: KeyServiceChannel,
		depth: number,
	): Promise<'ready' | 'locked'> {
		if (depth >= MAX_WRITE_ATTEMPTS) throw conflictError()
		const absorbed = await this.absorbHeldKeys(base, opened.master)
		const keys = await this.openDataKeys(base, opened.master)
		const merged = await sealRecord(
			{
				...base,
				revision: this.nextRevision(base),
				keys: [...base.keys, ...absorbed],
				currentVersion: base.currentVersion + absorbed.length,
			},
			opened.master.macKey,
		)
		const reply = await channel.put(this.name, merged, base.revision)
		if (reply.status !== 'ok') return this.adoptLocked(reply.record, passphrase, channel, depth + 1)
		for (const [keyId, key] of keys) this.dataKeys.set(keyId, key)
		this.master = opened.master
		if (opened.kek !== null) {
			this.kek = opened.kek
			this.kekSalt = merged.kdf.salt
		} else if (this.kekSalt !== merged.kdf.salt) {
			this.kek = null
			this.kekSalt = null
		}
		this.pendingPassphrase = null
		await this.commitLocked(merged)
		return 'ready'
	}

	/**
	 * Re-wrap the held data keys `base` lacks under `target` (appended after base's
	 * highest version). They are extracted from the pinned record with the held master.
	 */
	private async absorbHeldKeys(
		base: WrappedKeyRecord,
		target: MasterKeys,
	): Promise<WrappedDataKey[]> {
		const baseIds = new Set(base.keys.map((key) => key.keyId))
		const pinned = this.record
		const missing = (pinned?.keys ?? []).filter(
			(key) => this.dataKeys.has(key.keyId) && !baseIds.has(key.keyId),
		)
		if (missing.length === 0) return []
		const held = this.master
		if (pinned === null || held === null) {
			throw new EncryptionKeyError(
				'This device holds keys of another ring but not its master key; unlock it with the passphrase first.',
				{ code: 'KEY_RING_FORK' },
			)
		}
		const out: WrappedDataKey[] = []
		let version = base.currentVersion
		for (const entry of [...missing].sort((a, b) => a.keyVersion - b.keyVersion)) {
			const dataKey = await unwrapDataKey(entry, held.wrapKey, this.name, true)
			version++
			out.push(await wrapDataKey(dataKey, target.wrapKey, this.name, version, entry.keyId))
		}
		return out
	}

	/** Open every data key of `record` this device does not hold yet. */
	private async openDataKeys(
		record: WrappedKeyRecord,
		master: MasterKeys,
	): Promise<Map<string, CryptoKey>> {
		const opened = new Map<string, CryptoKey>()
		for (const entry of record.keys) {
			if (this.dataKeys.has(entry.keyId)) continue
			opened.set(entry.keyId, await unwrapDataKey(entry, master.wrapKey, this.name))
		}
		return opened
	}

	/**
	 * Whether `record` holds the anchor key of a recovery key: data keys are never removed
	 * or re-keyed (a passphrase change, recovery or merge re-wraps them under the same key
	 * id), so the anchor stays valid for the ring.
	 */
	private async holdsAnchor(
		record: WrappedKeyRecord,
		master: MasterKeys,
		publicKey: { x: string; y: string },
		anchor: Uint8Array,
	): Promise<boolean> {
		for (const entry of record.keys) {
			let dataKey: CryptoKey
			try {
				dataKey = await unwrapDataKey(entry, master.wrapKey, this.name, true)
			} catch {
				continue
			}
			const tag = await recoveryAnchor(dataKey, this.name, record.ringId, entry.keyId, publicKey)
			if (bytesEqual(tag, anchor)) return true
		}
		return false
	}

	/**
	 * Whether `master` (which authenticated `record`) is a master key a passphrase change
	 * retired: listed in `record` itself or in any record this device authenticated.
	 */
	private isRetiredMaster(record: WrappedKeyRecord, master: MasterKeys): boolean {
		return this.retiredMasters.has(master.id) || (record.retiredMasters ?? []).includes(master.id)
	}

	/** The next revision after `base`, above the pinned one when it is the same ring. */
	private nextRevision(base: WrappedKeyRecord): number {
		const pinned = this.record
		const floor = pinned !== null && pinned.ringId === base.ringId ? pinned.revision : 0
		return Math.max(base.revision, floor) + 1
	}

	/** Authenticate a record with the held master key (no passphrase needed). */
	private async authenticateHeld(record: WrappedKeyRecord): Promise<OpenedRing | null> {
		if (this.master === null) return null
		if (!(await verifyRecordMac(record, this.master.macKey))) return null
		return {
			master: this.master,
			kek: this.kek !== null && this.kekSalt === record.kdf.salt ? this.kek : null,
		}
	}

	/**
	 * Open and authenticate a record with a passphrase.
	 *
	 * @throws {EncryptionKeyError} WRONG_PASSPHRASE, or KEY_RECORD_INVALID when the master
	 *   key opens but the record does not authenticate under it (tampered)
	 */
	private async openWithPassphrase(
		record: WrappedKeyRecord,
		passphrase: string,
	): Promise<OpenedRing> {
		const kek = await deriveKeyEncryptionKey(
			passphrase,
			fromBase64(record.kdf.salt),
			record.kdf.iterations,
		)
		let raw: Uint8Array
		try {
			raw = await unwrapMasterKey(record.master, kek, this.name, record.ringId)
		} catch (error) {
			throw new EncryptionKeyError(errorMessage(error), { code: 'WRONG_PASSPHRASE' })
		}
		let master: MasterKeys
		try {
			master = await importMasterKey(raw)
		} finally {
			raw.fill(0)
		}
		if (!(await verifyRecordMac(record, master.macKey))) {
			throw new EncryptionKeyError(
				"The server's key record does not authenticate under its master key: it was modified by someone without the keys (wraps swapped, a recovery key or version injected). It is refused.",
				{ code: 'KEY_RECORD_INVALID' },
			)
		}
		return { master, kek }
	}

	/** The configured or pending passphrase, unless it already failed for this salt. */
	private async sourcePassphraseFor(record: WrappedKeyRecord): Promise<string | null> {
		const source = await this.availablePassphrase()
		if (source === null) return null
		const failed = this.failedSource
		if (failed !== null && failed.salt === record.kdf.salt && failed.passphrase === source) {
			return null
		}
		return source
	}

	private async followConflictLocked(
		reply: KeyServiceReply,
		attempt: number,
		passphrase: string | null,
		channel: KeyServiceChannel,
	): Promise<void> {
		if (attempt + 1 >= MAX_WRITE_ATTEMPTS) throw conflictError()
		const current = reply.record
		if (current === null) {
			throw new EncryptionKeyError(
				'The sync server lost the key record during the write. Reconnect: a device holding it re-uploads it.',
				{ code: 'KEY_RECORD_MISSING' },
			)
		}
		const outcome = await this.adoptLocked(current, passphrase, channel)
		if (outcome !== 'ready') throw this.statusError()
		const pinned = this.record
		if (
			pinned === null ||
			(pinned.ringId === current.ringId && pinned.revision < current.revision)
		) {
			// Nothing in the newer record could be authenticated: never write over it with
			// keys of an older master key.
			throw new EncryptionKeyError(
				'The key record changed on another device (its passphrase changed) and this device cannot authenticate the new one. Unlock with the current passphrase, then try again.',
				{ code: 'PASSPHRASE_REQUIRED' },
			)
		}
	}

	private async commitLocked(record: WrappedKeyRecord): Promise<void> {
		const known = new Set(record.keys.map((key) => key.keyId))
		for (const keyId of this.dataKeys.keys()) {
			if (!known.has(keyId)) {
				// Every path that adopts a record first absorbs the held keys it lacks.
				throw new EncryptionKeyError(
					`Internal error: key ${keyId} would be dropped by revision ${record.revision}.`,
					{ code: 'KEY_RECORD_INVARIANT' },
				)
			}
		}
		this.record = record
		for (const id of record.retiredMasters ?? []) this.retiredMasters.add(id)
		this.retryable = false
		this.rebuildEncryptor()
		this.setStatus(this.makeStatus('unlocked'))
		try {
			await this.cache.save(this.cacheId(), {
				record,
				retiredMasters: [...this.retiredMasters],
				kek: this.kek,
				master: this.master,
				keys: record.keys.flatMap((entry) => {
					const key = this.dataKeys.get(entry.keyId)
					return key ? [{ keyVersion: entry.keyVersion, keyId: entry.keyId, key }] : []
				}),
			})
		} catch {
			// The cache is a convenience: the keyring works for this session without it.
		}
	}

	private rebuildEncryptor(): void {
		const record = this.record
		const versions: VersionedKey[] = []
		for (const entry of record?.keys ?? []) {
			const key = this.dataKeys.get(entry.keyId)
			if (key) versions.push({ version: entry.keyVersion, key, keyId: entry.keyId })
		}
		if (versions.length === 0 || record === null || this.master === null) {
			this.encryptor = null
			return
		}
		this.encryptor = SyncEncryptor.fromKeys(versions, this.encryptorOptions)
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

	private requireMaster(action: string): MasterKeys {
		if (this.master === null || this.encryptor === null) {
			throw new EncryptionKeyError(`Unlock the keyring with the passphrase to ${action}.`, {
				code: 'PASSPHRASE_REQUIRED',
			})
		}
		return this.master
	}

	/** The KEK of `record`'s own salt (never one derived for another record's salt). */
	private requireKek(record: WrappedKeyRecord, action: string): CryptoKey {
		if (this.kek === null || this.kekSalt !== record.kdf.salt || this.encryptor === null) {
			throw new EncryptionKeyError(
				`Unlock the keyring with the passphrase to ${action}: this device holds the data keys but not the key of the current passphrase (it changed on another device, or the keyring is locked).`,
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
		this.master = null
		this.kek = null
		this.kekSalt = null
		this.encryptor = null
	}

	/** A record refused for what the server sent: the held keys stay, nothing is adopted. */
	private refuseRecord(code: EncryptionStatusCode, message: string): 'locked' {
		this.holdFor('error', code, message)
		return 'locked'
	}

	/** A server-side condition: keys kept, a later session (or a push) can clear it. */
	private holdFor(state: 'locked' | 'error', code: EncryptionStatusCode, message: string): void {
		this.retryable = true
		this.setStatus(this.makeStatus(state, code, message))
	}

	private lockWith(state: 'locked' | 'error', code: EncryptionStatusCode, message: string): void {
		this.retryable = false
		this.dropKeysIfUnusable(code)
		this.setStatus(this.makeStatus(state, code, message))
	}

	/** Locks that need the user stop encrypting; records refused keep held keys. */
	private dropKeysIfUnusable(code: EncryptionStatusCode): void {
		if (
			code === 'LOCKED_BY_APP' ||
			code === 'KEY_SERVICE_FORBIDDEN' ||
			code === 'KEY_SERVICE_UNSUPPORTED' ||
			code === 'PASSPHRASE_REQUIRED' ||
			code === 'WRONG_PASSPHRASE' ||
			code === 'KEY_RING_FORK'
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
		const record = this.record
		const held = (record?.keys ?? []).filter((key) => this.dataKeys.has(key.keyId))
		return {
			state,
			keyring: this.name,
			keyVersion,
			keyId:
				keyVersion !== null
					? (held.find((key) => key.keyVersion === keyVersion)?.keyId ?? null)
					: null,
			availableVersions: unlocked ? held.map((key) => key.keyVersion).sort((a, b) => a - b) : [],
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
			previous.keyId === status.keyId &&
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
