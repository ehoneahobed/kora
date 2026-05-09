import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SchemaDefinition } from '@korajs/core'
import { createServerTransportPair } from '@korajs/server/internal'
import type { SyncTransport } from '@korajs/sync'
import { TestDevice } from './test-device'
import { TestServer } from './test-server'

/**
 * Options for creating a test network.
 */
export interface TestNetworkOptions {
	/** Number of devices to create. Defaults to 2. */
	devices?: number
	/** Custom device names. If not provided, uses 'device-0', 'device-1', etc. */
	deviceNames?: string[]
}

/**
 * A test network with a server and multiple devices.
 */
export interface TestNetwork {
	/** The test server */
	server: TestServer
	/** All devices in the network */
	devices: TestDevice[]
	/** Temporary directory for DB files */
	tmpDir: string
	/** Close all devices and the server, clean up temp files */
	close(): Promise<void>
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
	const tmpDir = mkdtempSync(join(tmpdir(), 'kora-test-'))

	// Create server
	const server = new TestServer(schema)

	// Create devices
	const devices: TestDevice[] = []
	for (const name of deviceNames) {
		const device = new TestDevice({
			name,
			schema,
			server,
			createTransportPair: () => {
				const pair = createServerTransportPair()
				return {
					client: pair.client as unknown as SyncTransport,
					serverTransport: pair.server,
				}
			},
			tmpDir,
		})
		await device.open()
		devices.push(device)
	}

	return {
		server,
		devices,
		tmpDir,
		async close(): Promise<void> {
			for (const device of devices) {
				await device.close()
			}
			await server.close()
			// Clean up temp DB files
			try {
				const { rmSync } = await import('node:fs')
				rmSync(tmpDir, { recursive: true, force: true })
			} catch {
				// Ignore cleanup errors
			}
		},
	}
}
