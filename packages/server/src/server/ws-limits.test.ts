import { describe, expect, test } from 'vitest'
import { MemoryServerStore } from '../store/memory-server-store'
import { DEFAULT_MAX_MESSAGE_BYTES, KoraSyncServer, type WsServerLike } from './kora-sync-server'

function captureOptions(): {
	impl: new (options: Record<string, unknown>) => WsServerLike
	seen: Array<Record<string, unknown>>
} {
	const seen: Array<Record<string, unknown>> = []
	const impl = function FakeWsServer(options: Record<string, unknown>): WsServerLike {
		seen.push(options)
		return { on() {}, close: (cb) => cb?.(), address: () => ({ port: 1 }) }
	} as unknown as new (
		options: Record<string, unknown>,
	) => WsServerLike
	return { impl, seen }
}

describe('KoraSyncServer WebSocket limits (SEC-5)', () => {
	test('sets maxPayload to 32 MiB by default', async () => {
		const { impl, seen } = captureOptions()
		const server = new KoraSyncServer({ store: new MemoryServerStore('s'), port: 1 })
		await server.start(impl)
		expect(seen[0]?.maxPayload).toBe(DEFAULT_MAX_MESSAGE_BYTES)
		expect(DEFAULT_MAX_MESSAGE_BYTES).toBe(32 * 1024 * 1024)
		await server.stop()
	})

	test('honours maxMessageBytes', async () => {
		const { impl, seen } = captureOptions()
		const server = new KoraSyncServer({
			store: new MemoryServerStore('s'),
			port: 1,
			maxMessageBytes: 4096,
		})
		await server.start(impl)
		expect(seen[0]?.maxPayload).toBe(4096)
		await server.stop()
	})
})
