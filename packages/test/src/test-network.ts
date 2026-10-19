import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OperationTransform, SchemaDefinition } from '@korajs/core'
import { createServerTransportPair } from '@korajs/server/internal'
import type { ChaosConfig } from '@korajs/sync'
import { ChaosTransport } from '@korajs/sync'
import type { SyncTransport } from '@korajs/sync'
import type { TransportPair } from './protobuf-wire-transport'
import { TestDevice } from './test-device'
import { TestServer, type TestServerOptions } from './test-server'

/**
 * Options for creating a test network.
 */
export interface TestNetworkOptions {
	/** Number of devices to create. Defaults to 2. */
	devices?: number
	/** Custom device names. If not provided, uses 'device-0', 'device-1', etc. */
	deviceNames?: string[]
	/** Optional chaos transport settings applied to each device link. */
	chaos?: ChaosConfig
	/**
	 * Optional wrapper applied to each device's transport pair after the base
	 * (in-memory, optionally chaos-wrapped) pair is created. Use it to route
	 * messages through the protobuf wire codec
	 * ({@link wrapTransportPairWithProtobufWire}) or to inject a controllable
	 * server clock. Called once per device connection.
	 */
	wrapTransport?: (pair: TransportPair) => TransportPair
	/** Enable central blob storage on the server (persist + serve uploaded blob bytes). */
	blobStorage?: boolean
	/** Adjudicate untrusted client operations on the server before materialization. */
	validateOperation?: import('@korajs/server').OperationValidator
	/** Devices use the beta.12 pairwise pipeline (`experimental.legacyMerge`). */
	legacyMerge?: boolean
	/**
	 * The server's store (SQLite, Postgres). Defaults to a fresh memory store. The
	 * network closes it.
	 */
	serverStore?: import('@korajs/server').ServerStore
	/** Every device encrypts its sync traffic with this shared key material. */
	encryption?: import('./test-device').TestDeviceEncryption
	/** The sync server's encryption policy. */
	serverEncryption?: import('@korajs/server').KoraSyncServerConfig['encryption']
	/** Every device store's local `maxOperationBytes` (RT-86). */
	deviceMaxOperationBytes?: number
}

/**
 * A test network with a server and multiple devices.
 */
export interface TestNetwork {
	/** The test server */
	server: TestServer<import('@korajs/server').ServerStore>
	/** All devices in the network */
	devices: TestDevice[]
	/** Temporary directory for DB files */
	tmpDir: string
	/**
	 * Close all devices and the server, then remove the temporary directory. The
	 * directory is removed even when closing a device or the server fails (that error is
	 * rethrown). A network never closed is closed, and its directory removed, when the
	 * process is about to exit.
	 */
	close(): Promise<void>
}

/** Removes a directory (replaceable in tests, to simulate a platform that refuses). */
type DirectoryRemover = (dir: string) => void

const defaultRemover: DirectoryRemover = (dir) => rmSync(dir, { recursive: true, force: true })
let removeDirectory: DirectoryRemover = defaultRemover

/** Directories created and not yet removed (a failed removal keeps its path here). */
const pendingTempDirs = new Set<string>()
/** Networks not yet closed, by directory: what the exit fallback closes first. */
const openNetworks = new Map<string, () => Promise<void>>()
let hooksInstalled = false
let fallbackRan = false

/**
 * The fallback for networks a test never closed: on Windows a directory whose SQLite
 * files are still open cannot be removed, so the networks' devices and server are
 * closed first (`beforeExit`, which may still await), then their directories removed.
 * `exit` (synchronous, a last resort when `beforeExit` does not run, such as after
 * `process.exit()`) removes what is left and keeps any path it could not remove.
 */
function installExitHooks(): void {
	if (hooksInstalled) return
	hooksInstalled = true
	process.on('beforeExit', () => {
		// Runs again each time the event loop drains: only once with work to do.
		if (fallbackRan || (openNetworks.size === 0 && pendingTempDirs.size === 0)) return
		fallbackRan = true
		void closeOpenNetworks()
	})
	process.once('exit', () => {
		removePendingTempDirs()
	})
}

/**
 * Close every network not yet closed, then remove its directory (and retry every
 * directory a removal left). Exported for tests; the `beforeExit` hook runs it.
 *
 * @internal
 */
export async function closeOpenNetworks(): Promise<void> {
	for (const close of [...openNetworks.values()]) {
		try {
			await close()
		} catch (error) {
			console.warn('[@korajs/test] closing a network left open at exit failed:', error)
		}
	}
	removePendingTempDirs()
}

/**
 * Remove every directory still pending, synchronously; a path that cannot be removed
 * stays pending. Exported for tests; the `exit` hook runs it.
 *
 * @internal
 */
export function removePendingTempDirs(): void {
	for (const dir of [...pendingTempDirs]) tryRemoveTempDir(dir)
}

/**
 * The directories created and not yet removed. For tests.
 *
 * @internal
 */
export function pendingTempDirectories(): readonly string[] {
	return [...pendingTempDirs]
}

/**
 * Replace how directories are removed (null restores `rmSync`). For tests that simulate
 * a platform refusing to remove a directory whose files are open.
 *
 * @internal
 */
export function setTempDirRemover(remover: DirectoryRemover | null): void {
	removeDirectory = remover ?? defaultRemover
}

/** A temporary directory for a network's device databases, tracked until removed. */
function createNetworkTempDir(): string {
	installExitHooks()
	const dir = mkdtempSync(join(tmpdir(), 'kora-test-'))
	pendingTempDirs.add(dir)
	return dir
}

/** Remove a directory; on failure it stays pending (reported) and false is returned. */
function tryRemoveTempDir(dir: string): boolean {
	try {
		removeDirectory(dir)
		pendingTempDirs.delete(dir)
		return true
	} catch (error) {
		console.warn(`[@korajs/test] could not remove the temporary directory ${dir}:`, error)
		return false
	}
}

/**
 * Close what a network holds, then remove its directory: on `close()`, at the exit
 * fallback, or when creating the network failed part-way (then `failure` is the creation
 * error, rethrown by the caller, and a failure to close is only reported). Every device
 * and the server are closed even when one of them fails to; the first failure is
 * rethrown. Removal comes after closing (open database files block it on Windows) and
 * is retried once, after a moment, when it fails; a directory still not removed stays
 * pending for the exit fallback.
 */
async function closeNetwork(
	devices: readonly TestDevice[],
	server: TestServer<import('@korajs/server').ServerStore> | null,
	tmpDir: string,
	failure?: unknown,
): Promise<void> {
	openNetworks.delete(tmpDir)
	const errors: unknown[] = []
	for (const device of devices) {
		try {
			await device.close()
		} catch (error) {
			errors.push(error)
		}
	}
	if (server) {
		try {
			await server.close()
		} catch (error) {
			errors.push(error)
		}
	}
	if (!tryRemoveTempDir(tmpDir)) {
		// A handle can be released a moment after its close resolves (Windows).
		await new Promise((resolve) => setTimeout(resolve, 50))
		tryRemoveTempDir(tmpDir)
	}
	if (errors.length === 0) return
	if (failure === undefined) throw errors[0]
	console.warn('[@korajs/test] closing a network whose creation failed also failed:', errors[0])
}

/** `close()` of a created network: closes it once, and registers it until then. */
function trackNetwork(
	devices: readonly TestDevice[],
	server: TestServer<import('@korajs/server').ServerStore>,
	tmpDir: string,
): () => Promise<void> {
	let closing: Promise<void> | null = null
	const close = (): Promise<void> => {
		if (!closing) closing = closeNetwork(devices, server, tmpDir)
		return closing
	}
	openNetworks.set(tmpDir, close)
	return close
}

/**
 * Create a test network with a server and multiple virtual devices.
 *
 * Each device has its own local SQLite store and SyncEngine. Devices
 * communicate with the server via in-memory transports.
 *
 * @param schema - The schema all devices share
 * @param options - Network configuration
 * @returns A test network with server and devices ready for use
 *
 * @example
 * ```typescript
 * const network = await createTestNetwork(schema, { devices: 2 })
 * const [deviceA, deviceB] = network.devices
 *
 * await deviceA.collection('todos').insert({ title: 'Hello' })
 * await deviceA.sync()
 * await deviceB.sync()
 *
 * const todos = await deviceB.getState('todos')
 * expect(todos).toHaveLength(1)
 *
 * await network.close()
 * ```
 */
export async function createTestNetwork(
	schema: SchemaDefinition,
	options?: TestNetworkOptions,
): Promise<TestNetwork> {
	const deviceCount = options?.devices ?? 2
	const deviceNames =
		options?.deviceNames ?? Array.from({ length: deviceCount }, (_, i) => `device-${i}`)

	// Create temp directory for DB files
	const tmpDir = createNetworkTempDir()
	const devices: TestDevice[] = []
	let server: TestServer<import('@korajs/server').ServerStore> | null = null
	try {
		// Create server
		server = new TestServer<import('@korajs/server').ServerStore>(schema, {
			blobStorage: options?.blobStorage,
			validateOperation: options?.validateOperation,
			...(options?.serverStore ? { store: options.serverStore } : {}),
			...(options?.serverEncryption ? { encryption: options.serverEncryption } : {}),
		})
		await server.ready

		// Create devices
		for (const name of deviceNames) {
			const device = new TestDevice({
				name,
				schema,
				server,
				createTransportPair: () => {
					const pair = createServerTransportPair()
					const client = pair.client as unknown as SyncTransport
					const chaos = options?.chaos
					const base: TransportPair = {
						client: chaos ? new ChaosTransport(client, chaos) : client,
						serverTransport: pair.server,
					}
					return options?.wrapTransport ? options.wrapTransport(base) : base
				},
				tmpDir,
				...(options?.legacyMerge ? { legacyMerge: true } : {}),
				...(options?.encryption ? { encryption: options.encryption } : {}),
				...(options?.deviceMaxOperationBytes !== undefined
					? { maxOperationBytes: options.deviceMaxOperationBytes }
					: {}),
			})
			// Tracked before it opens, so one that fails part-way is closed too.
			devices.push(device)
			await device.open()
		}
	} catch (error) {
		await closeNetwork(devices, server, tmpDir, error)
		throw error
	}

	const created = server
	return {
		server: created,
		devices,
		tmpDir,
		close: trackNetwork(devices, created, tmpDir),
	}
}

/**
 * Per-device configuration when devices use different local schemas or sync settings.
 */
export interface MixedTestDeviceConfig {
	name: string
	schema: SchemaDefinition
	syncSchemaVersion?: number
	operationTransforms?: OperationTransform[]
}

/**
 * Create a test network where devices may use different schema versions and transforms.
 * The server uses `serverSchema` for materialization and handshake bounds.
 */
export async function createMixedTestNetwork(
	serverSchema: SchemaDefinition,
	serverOptions: TestServerOptions,
	deviceConfigs: MixedTestDeviceConfig[],
): Promise<TestNetwork> {
	const tmpDir = createNetworkTempDir()
	const devices: TestDevice[] = []
	let server: TestServer<import('@korajs/server').ServerStore> | null = null
	try {
		const mixedServer = new TestServer(serverSchema, serverOptions)
		server = mixedServer
		for (const config of deviceConfigs) {
			const device = new TestDevice({
				name: config.name,
				schema: config.schema,
				server: mixedServer,
				syncSchemaVersion: config.syncSchemaVersion,
				operationTransforms: config.operationTransforms,
				createTransportPair: () => {
					const pair = createServerTransportPair()
					return {
						client: pair.client as unknown as SyncTransport,
						serverTransport: pair.server,
					}
				},
				tmpDir,
			})
			devices.push(device)
			await device.open()
		}
	} catch (error) {
		await closeNetwork(devices, server, tmpDir, error)
		throw error
	}

	const created = server
	return {
		server: created,
		devices,
		tmpDir,
		close: trackNetwork(devices, created, tmpDir),
	}
}
