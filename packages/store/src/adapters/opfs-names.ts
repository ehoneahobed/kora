/**
 * Names shared by the main thread and the SQLite worker for OPFS pools, Web Locks
 * and database files. Pure functions, so ownership rules are testable in Node.
 *
 * Ownership model (W8a, NEW-STORE-5): one OPFS SyncAccessHandle pool per
 * database. The tab leader lock (`kora-leader-<db>`) already guarantees one
 * leader tab per database, so a pool per database means two different databases
 * on one origin (per-user databases, two Kora apps) never contend for one pool.
 */

/** Pool name every database used before W8a (beta.12 and earlier): one per origin. */
export const LEGACY_OPFS_POOL_NAME = 'kora-opfs'

/** Prefix of the per-database pool names. */
export const OPFS_POOL_PREFIX = 'kora-opfs-'

/**
 * Longest readable database slug kept in a pool name. Pool names become OPFS
 * directory names (`.<pool>`) and VFS names, so they stay short and portable.
 */
const MAX_POOL_SLUG_LENGTH = 48

/**
 * 32-bit FNV-1a hash as 8 hex digits. Used only to keep pool names unique when
 * a database name had to be sanitized or truncated; not a security primitive.
 */
export function fnv1a32Hex(value: string): string {
	let hash = 0x811c9dc5
	for (let i = 0; i < value.length; i += 1) {
		hash ^= value.charCodeAt(i)
		hash = Math.imul(hash, 0x01000193)
	}
	return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * The OPFS SAH pool that owns `dbName`. Database names that are already safe
 * map to `kora-opfs-<dbName>`; anything sanitized or truncated gets a hash suffix
 * so two distinct names can never share a pool.
 *
 * @example opfsPoolNameFor('school__user_alice') === 'kora-opfs-school__user_alice'
 */
export function opfsPoolNameFor(dbName: string): string {
	const sanitized = dbName.replace(/[^a-zA-Z0-9_-]/g, '_')
	const slug = sanitized.slice(0, MAX_POOL_SLUG_LENGTH)
	if (slug === dbName) {
		return `${OPFS_POOL_PREFIX}${slug}`
	}
	return `${OPFS_POOL_PREFIX}${slug}-${fnv1a32Hex(dbName)}`
}

/** OPFS directory sqlite-wasm uses for a pool (its default is `.` + pool name). */
export function opfsPoolDirectory(poolName: string): string {
	return `.${poolName}`
}

/**
 * Web Lock held by the worker that owns a pool, for the pool's entire life. A
 * new owner (a promoted tab, a reopened database) waits on it instead of racing
 * the previous worker for the file handles.
 */
export function opfsPoolLockName(poolName: string): string {
	return `kora-opfs-pool:${poolName}`
}

/** Tab leader lock for a database (one leader tab per database per origin). */
export function leaderLockName(dbName: string): string {
	return `kora-leader-${dbName}`
}

/** BroadcastChannel carrying follower RPC, heartbeats and pings for a database. */
export function storageChannelName(dbName: string): string {
	return `kora-storage-${dbName}`
}

/** File name of a database inside its pool (unchanged from beta.12 for migration). */
export function opfsDatabaseFilename(dbName: string): string {
	const base = dbName.replace(/[^a-zA-Z0-9._-]/g, '_')
	return base.endsWith('.db') ? base : `${base}.db`
}

/** Absolute path under which the SAH pool tracks a database file. */
export function opfsPoolPath(dbName: string): string {
	return `/${opfsDatabaseFilename(dbName)}`
}
