import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SchemaDefinition } from '@korajs/core'
import { KoraSyncServer, MemoryServerStore, PostgresServerStore } from '@korajs/server'
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

let pgNetworks = 0

/**
 * The store a network runs on when the test passes none: a MemoryServerStore, or,
 * with KORA_REPRO_STORE=postgres and KORA_PG_TEST_URL set, a PostgresServerStore in a
 * fresh schema, so the same repros exercise the Postgres code paths end to end.
 * `postgres` and `drizzle-orm` are resolved through @korajs/server's dependencies.
 * (Typed as the memory store for the tests' convenience; both implement ServerStore.)
 */
async function defaultNetworkStore(): Promise<MemoryServerStore> {
	const url = process.env.KORA_PG_TEST_URL
	if (process.env.KORA_REPRO_STORE !== 'postgres' || !url) {
		return new MemoryServerStore()
	}
	const serverRequire = createRequire(
		new URL('../../../server/package.json', import.meta.url).pathname,
	)
	const load = async (specifier: string): Promise<unknown> =>
		import(pathToFileURL(serverRequire.resolve(specifier)).href)
	const postgres = ((await load('postgres')) as { default: PostgresFactory }).default
	const { drizzle } = (await load('drizzle-orm/postgres-js')) as {
		drizzle: (client: unknown) => ConstructorParameters<typeof PostgresServerStore>[0]
	}
	pgNetworks += 1
	const schemaName = `kora_net_${process.pid}_${pgNetworks}`
	const admin = postgres(url, { max: 1 })
	await admin.unsafe(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
	await admin.unsafe(`CREATE SCHEMA ${schemaName}`)
	await admin.end()
	const client = postgres(url, { max: 4, idle_timeout: 1, connection: { search_path: schemaName } })
	return new PostgresServerStore(drizzle(client), 'server-pg') as unknown as MemoryServerStore
}

type PostgresFactory = (
	url: string,
	options: Record<string, unknown>,
) => { unsafe: (query: string) => Promise<unknown>; end: () => Promise<void> }

export async function scopedNetwork(
	schema: SchemaDefinition,
	config: Omit<KoraSyncServerConfig, 'store'>,
	storeArg?: MemoryServerStore,
): Promise<ScopedNetwork> {
	const store = storeArg ?? (await defaultNetworkStore())
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
