import { KoraError } from '@korajs/core'
import { randomUUID } from 'node:crypto'

/**
 * A user as visible to the application layer.
 * Does not include sensitive fields like password hash or salt.
 */
export interface AuthUser {
	/** Unique user identifier (UUID v7 or crypto.randomUUID) */
	id: string
	/** User's email address */
	email: string
	/** User's display name */
	name: string
	/** Whether the user's email has been verified */
	emailVerified: boolean
	/** Timestamp when the user was created (milliseconds since epoch) */
	createdAt: number
}

/**
 * Internal user record that includes credentials.
 * Extends AuthUser with password hash and salt for verification.
 */
export interface StoredUser extends AuthUser {
	/** Hex-encoded PBKDF2 derived key */
	passwordHash: string
	/** Hex-encoded random salt used during hashing */
	salt: string
}

/**
 * A device registered to a user.
 */
export interface AuthDevice {
	/** Unique device identifier */
	id: string
	/** ID of the user who owns this device */
	userId: string
	/** Base64url-encoded public key (or thumbprint) for the device */
	publicKey: string
	/** Human-readable device name */
	name: string
	/** Whether the device has been revoked */
	revoked: boolean
	/** Timestamp when the device was first registered (milliseconds since epoch) */
	createdAt: number
	/** Timestamp when the device was last seen (milliseconds since epoch) */
	lastSeenAt: number
}

/**
 * Thrown when a user account already exists with the given email.
 */
export class DuplicateEmailError extends KoraError {
	constructor() {
		super(
			'A user with this email already exists.',
			'DUPLICATE_EMAIL',
		)
		this.name = 'DuplicateEmailError'
	}
}

/**
 * Generic interface for user and device persistence.
 *
 * Implement this interface to provide database-backed user storage for
 * the built-in auth provider. All methods are async to support both
 * synchronous (in-memory, SQLite) and asynchronous (PostgreSQL) backends.
 *
 * Built-in implementations:
 * - {@link InMemoryUserStore} — development and testing (no persistence)
 * - `SqliteUserStore` — SQLite via better-sqlite3 (from `@korajs/auth/server`)
 * - `PostgresUserStore` — PostgreSQL via postgres-js (from `@korajs/auth/server`)
 *
 * @example
 * ```typescript
 * import { BuiltInAuthRoutes, SqliteUserStore } from '@korajs/auth/server'
 *
 * const userStore = await createSqliteUserStore({ filename: './auth.db' })
 * const routes = new BuiltInAuthRoutes({ userStore, tokenManager })
 * ```
 */
export interface UserStore {
	/** Create a new user account. Throws DuplicateEmailError if email exists. */
	createUser(params: {
		email: string
		passwordHash: string
		salt: string
		name: string
	}): Promise<AuthUser>

	/** Find a user by email address (case-insensitive). */
	findByEmail(email: string): Promise<StoredUser | null>

	/** Find a user by ID. */
	findById(id: string): Promise<StoredUser | null>

	/** Register a device for a user. Idempotent if device already exists and is not revoked. */
	registerDevice(params: {
		id: string
		userId: string
		publicKey: string
		name: string
	}): Promise<AuthDevice>

	/** Find a device by its ID. */
	findDevice(deviceId: string): Promise<AuthDevice | null>

	/** List all devices registered for a user (includes revoked). */
	listDevices(userId: string): Promise<AuthDevice[]>

	/** Soft-revoke a device. No-op if device does not exist. */
	revokeDevice(deviceId: string): Promise<void>

	/** Set a user's email verification status. */
	setEmailVerified(userId: string, verified: boolean): Promise<void>

	/** Update a user's password hash and salt. */
	updatePassword(userId: string, passwordHash: string, salt: string): Promise<void>

	/** List all users. For admin/development use. */
	listAll(): Promise<StoredUser[]>

	/** Update a stored user record. */
	update(user: StoredUser): Promise<void>

	/** Delete a user and all associated devices. */
	delete(userId: string): Promise<void>

	/** Update the last-seen timestamp for a device. No-op if device does not exist. */
	touchDevice(deviceId: string): Promise<void>
}

/**
 * In-memory user and device store for the built-in auth provider.
 *
 * This is a simple implementation suitable for development and testing.
 * Production applications should use {@link SqliteUserStore} or
 * {@link PostgresUserStore} for persistent storage.
 *
 * @example
 * ```typescript
 * const store = new InMemoryUserStore()
 * const user = await store.createUser({
 *   email: 'alice@example.com',
 *   passwordHash: 'abc123...',
 *   salt: 'def456...',
 *   name: 'Alice',
 * })
 * ```
 */
export class InMemoryUserStore implements UserStore {
	/** Users indexed by ID */
	private readonly usersById = new Map<string, StoredUser>()

	/** Users indexed by email (lowercase) for fast lookup */
	private readonly usersByEmail = new Map<string, StoredUser>()

	/** Devices indexed by device ID */
	private readonly devicesById = new Map<string, AuthDevice>()

	/** Device IDs indexed by user ID for fast listing */
	private readonly devicesByUserId = new Map<string, Set<string>>()

	/**
	 * Create a new user account.
	 *
	 * @param params - User creation parameters
	 * @param params.email - The user's email address (must be unique, case-insensitive)
	 * @param params.passwordHash - Hex-encoded PBKDF2 derived key
	 * @param params.salt - Hex-encoded salt used during hashing
	 * @param params.name - The user's display name
	 * @returns The created user (without sensitive credential fields)
	 * @throws {DuplicateEmailError} If a user with the same email already exists
	 */
	async createUser(params: {
		email: string
		passwordHash: string
		salt: string
		name: string
	}): Promise<AuthUser> {
		const normalizedEmail = params.email.toLowerCase()

		if (this.usersByEmail.has(normalizedEmail)) {
			throw new DuplicateEmailError()
		}

		const now = Date.now()
		const id = randomUUID()

		const storedUser: StoredUser = {
			id,
			email: normalizedEmail,
			name: params.name,
			emailVerified: false,
			createdAt: now,
			passwordHash: params.passwordHash,
			salt: params.salt,
		}

		this.usersById.set(id, storedUser)
		this.usersByEmail.set(normalizedEmail, storedUser)

		return toAuthUser(storedUser)
	}

	/**
	 * Find a user by email address.
	 *
	 * @param email - The email to search for (case-insensitive)
	 * @returns The stored user record including credentials, or null if not found
	 */
	async findByEmail(email: string): Promise<StoredUser | null> {
		return this.usersByEmail.get(email.toLowerCase()) ?? null
	}

	/**
	 * Find a user by ID.
	 *
	 * @param id - The user ID to search for
	 * @returns The stored user record including credentials, or null if not found
	 */
	async findById(id: string): Promise<StoredUser | null> {
		return this.usersById.get(id) ?? null
	}

	/**
	 * Register a device for a user.
	 *
	 * If a device with the same ID already exists and is not revoked, it is
	 * returned as-is (idempotent registration). If it was previously revoked,
	 * it is re-activated with updated details.
	 *
	 * @param params - Device registration parameters
	 * @param params.id - Unique device identifier
	 * @param params.userId - ID of the user who owns the device
	 * @param params.publicKey - Base64url-encoded device public key or thumbprint
	 * @param params.name - Human-readable device name
	 * @returns The registered device record
	 */
	async registerDevice(params: {
		id: string
		userId: string
		publicKey: string
		name: string
	}): Promise<AuthDevice> {
		const existing = this.devicesById.get(params.id)
		if (existing !== undefined && !existing.revoked) {
			return existing
		}

		const now = Date.now()
		const device: AuthDevice = {
			id: params.id,
			userId: params.userId,
			publicKey: params.publicKey,
			name: params.name,
			revoked: false,
			createdAt: now,
			lastSeenAt: now,
		}

		this.devicesById.set(params.id, device)

		let userDevices = this.devicesByUserId.get(params.userId)
		if (userDevices === undefined) {
			userDevices = new Set()
			this.devicesByUserId.set(params.userId, userDevices)
		}
		userDevices.add(params.id)

		return device
	}

	/**
	 * Find a device by its ID.
	 *
	 * @param deviceId - The device ID to search for
	 * @returns The device record, or null if not found
	 */
	async findDevice(deviceId: string): Promise<AuthDevice | null> {
		return this.devicesById.get(deviceId) ?? null
	}

	/**
	 * List all devices registered for a user.
	 *
	 * @param userId - The user ID whose devices to list
	 * @returns Array of device records (includes revoked devices)
	 */
	async listDevices(userId: string): Promise<AuthDevice[]> {
		const deviceIds = this.devicesByUserId.get(userId)
		if (deviceIds === undefined) {
			return []
		}

		const devices: AuthDevice[] = []
		for (const deviceId of deviceIds) {
			const device = this.devicesById.get(deviceId)
			if (device !== undefined) {
				devices.push(device)
			}
		}

		return devices
	}

	/**
	 * Revoke a device, preventing it from being used for authentication.
	 *
	 * This is a soft revoke — the device record remains but is marked as revoked.
	 * If the device does not exist, this is a no-op.
	 *
	 * @param deviceId - The ID of the device to revoke
	 */
	async revokeDevice(deviceId: string): Promise<void> {
		const device = this.devicesById.get(deviceId)
		if (device !== undefined) {
			device.revoked = true
		}
	}

	/**
	 * Set a user's email verification status.
	 *
	 * @param userId - The user whose email to verify
	 * @param verified - Whether the email is verified
	 */
	async setEmailVerified(userId: string, verified: boolean): Promise<void> {
		const user = this.usersById.get(userId)
		if (!user) return

		const updated: StoredUser = { ...user, emailVerified: verified }
		this.usersById.set(userId, updated)
		this.usersByEmail.set(user.email, updated)
	}

	/**
	 * Update a user's password hash and salt.
	 *
	 * @param userId - The user whose password to update
	 * @param passwordHash - New hex-encoded PBKDF2 derived key
	 * @param salt - New hex-encoded salt
	 */
	async updatePassword(userId: string, passwordHash: string, salt: string): Promise<void> {
		const user = this.usersById.get(userId)
		if (!user) return

		const updated: StoredUser = { ...user, passwordHash, salt }
		this.usersById.set(userId, updated)
		this.usersByEmail.set(user.email, updated)
	}

	/**
	 * List all users. For admin/development use.
	 */
	async listAll(): Promise<StoredUser[]> {
		return [...this.usersById.values()]
	}

	/**
	 * Update a stored user record.
	 */
	async update(user: StoredUser): Promise<void> {
		const existing = this.usersById.get(user.id)
		if (!existing) return

		// If email changed, update the email index
		if (existing.email !== user.email) {
			this.usersByEmail.delete(existing.email)
			this.usersByEmail.set(user.email, user)
		} else {
			this.usersByEmail.set(user.email, user)
		}
		this.usersById.set(user.id, user)
	}

	/**
	 * Delete a user and all associated devices.
	 */
	async delete(userId: string): Promise<void> {
		const user = this.usersById.get(userId)
		if (!user) return

		this.usersById.delete(userId)
		this.usersByEmail.delete(user.email)

		// Clean up devices
		const deviceIds = this.devicesByUserId.get(userId)
		if (deviceIds) {
			for (const deviceId of deviceIds) {
				this.devicesById.delete(deviceId)
			}
			this.devicesByUserId.delete(userId)
		}
	}

	/**
	 * Update the last-seen timestamp for a device.
	 *
	 * Called when a device authenticates or syncs to track activity.
	 * If the device does not exist, this is a no-op.
	 *
	 * @param deviceId - The ID of the device to update
	 */
	async touchDevice(deviceId: string): Promise<void> {
		const device = this.devicesById.get(deviceId)
		if (device !== undefined) {
			device.lastSeenAt = Date.now()
		}
	}
}

/**
 * Strip sensitive fields from a StoredUser to produce an AuthUser.
 * Ensures password hash and salt are never leaked to the application layer.
 */
function toAuthUser(stored: StoredUser): AuthUser {
	return {
		id: stored.id,
		email: stored.email,
		name: stored.name,
		emailVerified: stored.emailVerified,
		createdAt: stored.createdAt,
	}
}
