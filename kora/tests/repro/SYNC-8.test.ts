/**
 * SYNC-8 repro: reconnect backoff never grows. engine.start() resolves as soon as the
 * handshake is SENT, so the ReconnectionManager counts every attempt as a success and
 * resets; the next disconnect starts a fresh manager run at attempt 0. A server that
 * accepts the connection and then drops the session (crash loop, overload, proxy
 * idle-kill) is hammered at the initial interval forever.
 * Asserts CORRECT behavior (exponential backoff across failed sessions).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import type { SyncMessage, SyncTransport } from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})

const connects: number[] = []
/** Accepts the connection, then the "server" drops the session on handshake. */
class DroppingTransport implements SyncTransport {
	private open = false
	private onCls: (r: string) => void = () => {}
	async connect(): Promise<void> {
		connects.push(Date.now())
		this.open = true
	}
	async disconnect(): Promise<void> {
		this.open = false
	}
	send(message: SyncMessage): void {
		if (!this.open) throw new Error('closed')
		if (message.type === 'handshake') {
			// Server drops the session shortly after accepting the handshake.
			setTimeout(() => {
				this.open = false
				this.onCls('server dropped session')
			}, 5)
		}
	}
	onMessage(): void {}
	onClose(h: (r: string) => void): void {
		this.onCls = h
	}
	onError(): void {}
	isConnected(): boolean {
		return this.open
	}
}

vi.mock('../../src/create-sync-transport', () => ({
	createSyncTransport: () => new DroppingTransport(),
}))

const { createApp } = await import('../../src/create-app')

describe('SYNC-8: reconnect backoff', () => {
	test('repeatedly failing sessions back off exponentially', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'sync8-'))
		const app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: join(dir, 'a.db') },
			// Small initial interval so the test is fast; max 10s.
			sync: { url: 'ws://x', reconnectInterval: 40, maxReconnectInterval: 10_000 },
		})
		await app.ready
		await app.sync?.connect().catch(() => {})
		await new Promise((r) => setTimeout(r, 2_000))
		const attempts = connects.length
		await app.close()
		rmSync(dir, { recursive: true, force: true })
		// Exponential backoff from 40ms (x2): ~40+80+160+320+640 => <= ~7 attempts in 2s.
		// Today the interval stays at ~40ms: dozens of attempts.
		expect(attempts, `connect attempts in 2s: ${attempts}`).toBeLessThanOrEqual(8)
	}, 10_000)
})
