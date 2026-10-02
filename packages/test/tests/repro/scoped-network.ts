import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SchemaDefinition } from '@korajs/core'
import { KoraSyncServer, MemoryServerStore } from '@korajs/server'
import type { KoraSyncServerConfig, ServerTransport } from '@korajs/server'
import { createServerTransportPair } from '@korajs/server/internal'
import type { SyncMessage, SyncTransport } from '@korajs/sync'
import { TestDevice } from '../../src/test-device'
import type { TestServer } from '../../src/test-server'

/** One device in a {@link scopedNetwork}: its unique name and the user it signs in as. */
export interface NetworkDeviceSpec {
	name: string
	/** Auth token presented at handshake (the auth provider maps it to a principal). */
	token: string
	scopeExit?: 'retain' | 'retract'
}

/**
 * Shared harness for the red-team repros that need real client devices: a real
 * KoraSyncServer over a MemoryServerStore, TestDevices on in-memory transports, and a
 * handshake wrapper that presents each device's token. Devices are created lazily
 * with {@link ScopedNetwork.device} so a "fresh device" can join late.
 */
export interface ScopedNetwork {
	store: MemoryServerStore
	server: KoraSyncServer
	device: (spec: NetworkDeviceSpec) => Promise<TestDevice>
	/** Optional hook to rewrite or drop server->client messages for one device. */
	intercept: Map<string, (message: SyncMessage, transport: ServerTransport) => boolean>
	close: () => Promise<void>
}

export async function scopedNetwork(
	schema: SchemaDefinition,
	config: Omit<KoraSyncServerConfig, 'store'>,
	store: MemoryServerStore = new MemoryServerStore(),
): Promise<ScopedNetwork> {
	await store.setSchema(schema)
	const server = new KoraSyncServer({
		store,
		relayRetransmitIntervalMs: 0,
		deliveryPollIntervalMs: 0,
		...config,
	})
	const tmp = mkdtempSync(join(tmpdir(), 'kora-net-'))
	const devices: TestDevice[] = []
	const intercept = new Map<string, (message: SyncMessage, transport: ServerTransport) => boolean>()
	const device = async (spec: NetworkDeviceSpec): Promise<TestDevice> => {
		const fakeServer = {
			handleConnection(transport: ServerTransport): string {
				const wrapped: ServerTransport = {
					send: (m: SyncMessage) => {
						const hook = intercept.get(spec.name)
						if (hook && !hook(m, transport)) return
						transport.send(m)
					},
					onMessage: (h) =>
						transport.onMessage((m: SyncMessage) =>
							h(m.type === 'handshake' ? ({ ...m, authToken: spec.token } as SyncMessage) : m),
						),
					onClose: (h) => transport.onClose(h),
					onError: (h) => transport.onError(h),
					isConnected: () => transport.isConnected(),
					close: (c, r) => transport.close(c, r),
				}
				return server.handleConnection(wrapped)
			},
		} as unknown as TestServer
		const d = new TestDevice({
			name: spec.name,
			schema,
			server: fakeServer,
			tmpDir: tmp,
			...(spec.scopeExit ? { scopeExit: spec.scopeExit } : {}),
			createTransportPair: () => {
				const pair = createServerTransportPair()
				return { client: pair.client as unknown as SyncTransport, serverTransport: pair.server }
			},
		})
		await d.open()
		devices.push(d)
		return d
	}
	return {
		store,
		server,
		device,
		intercept,
		close: async () => {
			for (const d of devices) await d.close()
			await server.stop()
			rmSync(tmp, { recursive: true, force: true })
		},
	}
}

/** Run a few sync rounds over the given devices so relays and acks settle. */
export async function settle(devices: TestDevice[], rounds = 3): Promise<void> {
	for (let i = 0; i < rounds; i++) for (const d of devices) await d.sync()
}
