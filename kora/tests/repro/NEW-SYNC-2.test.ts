/**
 * NEW-SYNC-2 repro: lost reconnect wakeup. If a session drops while the
 * ReconnectionManager is still inside `await onReconnect()` (start() has sent the
 * handshake but not yet returned to the manager), the resulting 'sync:disconnected' is
 * ignored because isRunning() is still true; onReconnect then returns true and the
 * manager exits. Nothing ever reconnects: the app stays offline until a manual
 * connect() or a browser 'online' event. Asserts CORRECT behavior.
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
			// Server drops the session immediately (e.g. restarting) for the first 3 tries.
			if (connects.length <= 3) {
				queueMicrotask(() => {
					this.open = false
					this.onCls('server dropped session')
				})
			}
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

describe('NEW-SYNC-2: reconnect loop loses a disconnect that races start()', () => {
	test('keeps retrying until the server accepts a session', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'newsync2-'))
		const app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: join(dir, 'a.db') },
			sync: { url: 'ws://x', reconnectInterval: 20 },
		})
		await app.ready
		await app.sync?.connect().catch(() => {})
		await new Promise((r) => setTimeout(r, 1_500))
		const attempts = connects.length
		await app.close()
		rmSync(dir, { recursive: true, force: true })
		// Correct: >= 4 attempts (3 dropped + 1 that stays up). Today: stuck after 2.
		expect(attempts, `attempts: ${attempts}`).toBeGreaterThanOrEqual(4)
	}, 10_000)
})
