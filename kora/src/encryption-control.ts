import type { KoraEventEmitter } from '@korajs/core'
import type { EncryptionStatus, KeyServiceChannel } from '@korajs/sync'
import {
	DEFAULT_KEYRING,
	EncryptionKeyError,
	EncryptionKeyring,
	createKeyCache,
} from '@korajs/sync'
import { ServerRenderingAppError } from './ssr'
import type { SyncRuntimeState } from './sync-lifecycle'
import type { EncryptionControl, KoraConfig } from './types'

/**
 * Create the end-to-end encryption keyring of an app (ENC-1), or null when encryption
 * is not enabled. Its status is mirrored to the app's events as `encryption:status`.
 */
export function createAppKeyring(
	config: KoraConfig,
	emitter: KoraEventEmitter,
): EncryptionKeyring | null {
	const encryption = config.sync?.encryption
	if (!config.sync || encryption?.enabled !== true) return null
	const keyring = new EncryptionKeyring({
		...(encryption.keyring !== undefined ? { keyring: encryption.keyring } : {}),
		...(encryption.key !== undefined ? { passphrase: encryption.key } : {}),
		...(encryption.kdfIterations !== undefined ? { kdfIterations: encryption.kdfIterations } : {}),
		cache: createKeyCache(
			encryption.keyCache ?? 'auto',
			`kora-keyring:${config.store?.name ?? 'kora-db'}`,
		),
		encryptor: {
			...(encryption.cleartextFields ? { cleartextFields: encryption.cleartextFields } : {}),
			...(encryption.allowPlaintextMigration ? { allowPlaintextMigration: true } : {}),
		},
	})
	keyring.onStatusChange((status) => {
		emitter.emit({
			type: 'encryption:status',
			status: {
				state: status.state,
				keyring: status.keyring,
				keyVersion: status.keyVersion,
				...(status.code ? { code: status.code } : {}),
				...(status.message ? { message: status.message } : {}),
			},
		})
	})
	return keyring
}

/** Options of {@link createEncryptionControl}. */
export interface CreateEncryptionControlOptions {
	keyring: EncryptionKeyring | null
	ready: Promise<void>
	state: SyncRuntimeState
}

/**
 * Builds the developer-facing `app.encryption` surface: lock state, unlock, lock, key
 * rotation, passphrase change and recovery. Null when encryption is not enabled.
 */
export function createEncryptionControl(
	options: CreateEncryptionControlOptions,
): EncryptionControl | null {
	const { keyring, ready, state } = options
	if (!keyring) return null

	/** Resume sync after the keyring may have become usable. */
	const resumeSync = async (): Promise<void> => {
		const engine = state.syncEngine
		if (!engine || state.intentionalDisconnect) return
		if (engine.isEncryptionLocked() || engine.getState() === 'disconnected') {
			state.reconnectionManager?.reset()
			await engine.retryNow().catch(() => {
				// Surfaces through sync events; the reconnection loop retries.
			})
		}
	}

	const requireChannel = async (action: string): Promise<KeyServiceChannel> => {
		await ready
		const channel = state.syncEngine?.getKeyServiceChannel() ?? null
		if (!channel) {
			throw new EncryptionKeyError(
				`Connect sync to ${action}: key management writes the key record on the sync server.`,
				{ code: 'KEY_SERVICE_OFFLINE' },
			)
		}
		return channel
	}

	return {
		getStatus(): EncryptionStatus {
			return keyring.getStatus()
		},
		onStatusChange(listener: (status: EncryptionStatus) => void): () => void {
			return keyring.onStatusChange(listener)
		},
		async unlock(passphrase: string): Promise<EncryptionStatus> {
			await ready
			const channel = state.syncEngine?.getKeyServiceChannel() ?? null
			const status = await keyring.unlock(passphrase, channel)
			await resumeSync()
			return status
		},
		async lock(): Promise<EncryptionStatus> {
			await ready
			const status = await keyring.lock()
			// End the live session: nothing may be sent or applied without keys.
			if (state.syncEngine && state.syncEngine.getState() !== 'disconnected') {
				await state.syncEngine.stop()
			}
			return status
		},
		async rotateKey(): Promise<EncryptionStatus> {
			return keyring.rotate(await requireChannel('rotate the encryption key'))
		},
		async changePassphrase(
			newPassphrase: string,
			changeOptions?: { currentPassphrase?: string },
		): Promise<EncryptionStatus> {
			return keyring.changePassphrase(
				newPassphrase,
				await requireChannel('change the encryption passphrase'),
				changeOptions?.currentPassphrase,
			)
		},
		async enableRecovery(): Promise<string> {
			return keyring.enableRecovery(await requireChannel('set up a recovery key'))
		},
		async recover(recoveryKey: string, newPassphrase: string): Promise<EncryptionStatus> {
			await ready
			// Not connected (a locked keyring keeps sync off): the recovery runs at the
			// next handshake, which resumeSync starts.
			const status = await keyring.recover(
				recoveryKey,
				newPassphrase,
				state.syncEngine?.getKeyServiceChannel() ?? null,
			)
			await resumeSync()
			return status
		},
	}
}

/**
 * `app.encryption` of an inert server-render app (DX-6) whose config enables encryption.
 * No keyring exists (nothing is derived, cached or fetched in the server process), but
 * the surface keeps its client shape so components render the same branch on both
 * sides: the status is `locked`, listeners never fire, and every action rejects with the
 * app's `ready` error (`SSR_INERT_APP`). Null when encryption is not enabled.
 */
export function createInertEncryptionControl(
	config: KoraConfig,
	ready: Promise<void>,
): EncryptionControl | null {
	const encryption = config.sync?.encryption
	if (!config.sync || encryption?.enabled !== true) return null
	const keyringName = encryption.keyring ?? DEFAULT_KEYRING
	const status = (): EncryptionStatus => ({
		state: 'locked',
		keyring: keyringName,
		keyVersion: null,
		keyId: null,
		availableVersions: [],
		cache: 'none',
		message: 'Server render: encryption is available in the browser only.',
	})
	const refuse = async <T>(): Promise<T> => {
		// An inert app's ready always rejects with ServerRenderingAppError (SSR_INERT_APP).
		await ready
		throw new ServerRenderingAppError()
	}
	return {
		getStatus: status,
		onStatusChange: () => () => {},
		unlock: () => refuse(),
		lock: () => refuse(),
		rotateKey: () => refuse(),
		changePassphrase: () => refuse(),
		enableRecovery: () => refuse(),
		recover: () => refuse(),
	}
}
