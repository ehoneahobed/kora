import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
	InMemoryWebhookStore,
	WebhookEndpointNotFoundError,
	WebhookManager,
	verifyWebhookSignature,
} from './webhooks'
import type { WebhookPayload } from './webhooks'

describe('WebhookManager', () => {
	let manager: WebhookManager
	let store: InMemoryWebhookStore
	let mockFetch: ReturnType<typeof vi.fn>

	beforeEach(() => {
		store = new InMemoryWebhookStore()
		mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })
		manager = new WebhookManager({
			store,
			fetch: mockFetch as unknown as typeof fetch,
		})
	})

	// --- register ---

	describe('register', () => {
		test('creates a new endpoint', async () => {
			const endpoint = await manager.register({
				url: 'https://example.com/webhook',
				events: ['user.created', 'user.signin'],
			})

			expect(endpoint.id).toBeTruthy()
			expect(endpoint.url).toBe('https://example.com/webhook')
			expect(endpoint.events).toEqual(['user.created', 'user.signin'])
			expect(endpoint.secret).toMatch(/^whsec_/)
			expect(endpoint.active).toBe(true)
		})

		test('generates unique secrets', async () => {
			const ep1 = await manager.register({ url: 'https://a.com', events: ['user.created'] })
			const ep2 = await manager.register({ url: 'https://b.com', events: ['user.created'] })
			expect(ep1.secret).not.toBe(ep2.secret)
		})
	})

	// --- update ---

	describe('update', () => {
		test('updates endpoint URL', async () => {
			const ep = await manager.register({ url: 'https://old.com', events: ['user.created'] })
			const updated = await manager.update(ep.id, { url: 'https://new.com' })
			expect(updated.url).toBe('https://new.com')
		})

		test('updates endpoint events', async () => {
			const ep = await manager.register({ url: 'https://a.com', events: ['user.created'] })
			const updated = await manager.update(ep.id, { events: ['user.created', 'user.deleted'] })
			expect(updated.events).toEqual(['user.created', 'user.deleted'])
		})

		test('deactivates endpoint', async () => {
			const ep = await manager.register({ url: 'https://a.com', events: ['user.created'] })
			const updated = await manager.update(ep.id, { active: false })
			expect(updated.active).toBe(false)
		})

		test('throws for non-existent endpoint', async () => {
			await expect(manager.update('nonexistent', { url: 'x' })).rejects.toThrow(
				WebhookEndpointNotFoundError,
			)
		})
	})

	// --- remove ---

	describe('remove', () => {
		test('deletes an endpoint', async () => {
			const ep = await manager.register({ url: 'https://a.com', events: ['user.created'] })
			await manager.remove(ep.id)
			await expect(manager.get(ep.id)).rejects.toThrow(WebhookEndpointNotFoundError)
		})
	})

	// --- list ---

	describe('list', () => {
		test('returns all endpoints', async () => {
			await manager.register({ url: 'https://a.com', events: ['user.created'] })
			await manager.register({ url: 'https://b.com', events: ['user.signin'] })

			const endpoints = await manager.list()
			expect(endpoints).toHaveLength(2)
		})
	})

	// --- dispatch ---

	describe('dispatch', () => {
		test('sends event to matching endpoints', async () => {
			await manager.register({ url: 'https://a.com', events: ['user.created'] })
			await manager.register({ url: 'https://b.com', events: ['user.signin'] })

			await manager.dispatch('user.created', { userId: 'u1' })

			expect(mockFetch).toHaveBeenCalledTimes(1)
			const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit]
			expect(url).toBe('https://a.com')
			expect(options.method).toBe('POST')
			expect(options.headers).toHaveProperty('X-Webhook-Signature')
			expect(options.headers).toHaveProperty('X-Webhook-Event', 'user.created')

			const body = JSON.parse(options.body as string) as WebhookPayload
			expect(body.event).toBe('user.created')
			expect(body.data).toEqual({ userId: 'u1' })
		})

		test('sends to multiple matching endpoints', async () => {
			await manager.register({ url: 'https://a.com', events: ['user.created'] })
			await manager.register({ url: 'https://b.com', events: ['user.created'] })

			await manager.dispatch('user.created', { userId: 'u1' })
			expect(mockFetch).toHaveBeenCalledTimes(2)
		})

		test('skips inactive endpoints', async () => {
			const ep = await manager.register({ url: 'https://a.com', events: ['user.created'] })
			await manager.update(ep.id, { active: false })

			await manager.dispatch('user.created', { userId: 'u1' })
			expect(mockFetch).not.toHaveBeenCalled()
		})

		test('skips non-matching events', async () => {
			await manager.register({ url: 'https://a.com', events: ['user.signin'] })

			await manager.dispatch('user.created', { userId: 'u1' })
			expect(mockFetch).not.toHaveBeenCalled()
		})

		test('records successful delivery', async () => {
			const ep = await manager.register({ url: 'https://a.com', events: ['user.created'] })
			await manager.dispatch('user.created', { userId: 'u1' })

			const deliveries = await manager.getDeliveries(ep.id)
			expect(deliveries).toHaveLength(1)
			expect(deliveries[0]?.success).toBe(true)
			expect(deliveries[0]?.responseStatus).toBe(200)
			expect(deliveries[0]?.attempts).toBe(1)
		})

		test('retries on failure and records delivery', async () => {
			mockFetch
				.mockResolvedValueOnce({ ok: false, status: 500 })
				.mockResolvedValueOnce({ ok: false, status: 500 })
				.mockResolvedValueOnce({ ok: false, status: 500 })

			const ep = await manager.register({ url: 'https://a.com', events: ['user.created'] })
			await manager.dispatch('user.created', { userId: 'u1' })

			const deliveries = await manager.getDeliveries(ep.id)
			expect(deliveries).toHaveLength(1)
			expect(deliveries[0]?.success).toBe(false)
			expect(deliveries[0]?.attempts).toBe(3)
			expect(deliveries[0]?.error).toContain('500')
		}, 40000)

		test('retries on network error', async () => {
			mockFetch
				.mockRejectedValueOnce(new Error('connection refused'))
				.mockResolvedValueOnce({ ok: true, status: 200 })

			const ep = await manager.register({ url: 'https://a.com', events: ['user.created'] })
			await manager.dispatch('user.created', { userId: 'u1' })

			const deliveries = await manager.getDeliveries(ep.id)
			expect(deliveries).toHaveLength(1)
			expect(deliveries[0]?.success).toBe(true)
			expect(deliveries[0]?.attempts).toBe(2)
		}, 10000)

		test('includes signature header', async () => {
			await manager.register({ url: 'https://a.com', events: ['user.created'] })
			await manager.dispatch('user.created', { userId: 'u1' })

			const [, options] = mockFetch.mock.calls[0] as [string, RequestInit]
			const headers = options.headers as Record<string, string>
			expect(headers['X-Webhook-Signature']).toMatch(/^sha256=[a-f0-9]+$/)
		})

		test('does nothing when no endpoints match', async () => {
			await manager.dispatch('user.created', { userId: 'u1' })
			expect(mockFetch).not.toHaveBeenCalled()
		})
	})
})

// --- Signature verification ---

describe('verifyWebhookSignature', () => {
	test('verifies valid signature', async () => {
		const payload = JSON.stringify({ event: 'user.created', data: { userId: 'u1' } })
		const secret = 'whsec_test-secret'

		// Sign the payload
		const encoder = new TextEncoder()
		const key = await globalThis.crypto.subtle.importKey(
			'raw',
			encoder.encode(secret),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign'],
		)
		const sig = await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(payload))
		const bytes = new Uint8Array(sig)
		let hex = ''
		for (let i = 0; i < bytes.length; i++) {
			hex += bytes[i]?.toString(16).padStart(2, '0')
		}
		const signature = `sha256=${hex}`

		expect(await verifyWebhookSignature(payload, signature, secret)).toBe(true)
	})

	test('rejects invalid signature', async () => {
		const payload = '{"test":true}'
		const secret = 'whsec_test'

		expect(await verifyWebhookSignature(payload, 'sha256=invalid', secret)).toBe(false)
	})

	test('rejects tampered payload', async () => {
		const secret = 'whsec_test'
		const originalPayload = '{"event":"user.created"}'

		const encoder = new TextEncoder()
		const key = await globalThis.crypto.subtle.importKey(
			'raw',
			encoder.encode(secret),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign'],
		)
		const sig = await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(originalPayload))
		const bytes = new Uint8Array(sig)
		let hex = ''
		for (let i = 0; i < bytes.length; i++) {
			hex += bytes[i]?.toString(16).padStart(2, '0')
		}
		const signature = `sha256=${hex}`

		// Try verifying with tampered payload
		expect(await verifyWebhookSignature('{"event":"user.deleted"}', signature, secret)).toBe(false)
	})
})

// --- InMemoryWebhookStore ---

describe('InMemoryWebhookStore', () => {
	let store: InMemoryWebhookStore

	beforeEach(() => {
		store = new InMemoryWebhookStore()
	})

	test('saves and retrieves endpoint', async () => {
		const endpoint = {
			id: 'ep-1',
			url: 'https://a.com',
			events: ['user.created' as const],
			secret: 'whsec_test',
			active: true,
			createdAt: Date.now(),
		}
		await store.saveEndpoint(endpoint)
		const retrieved = await store.getEndpoint('ep-1')
		expect(retrieved).toEqual(endpoint)
	})

	test('returns null for unknown endpoint', async () => {
		expect(await store.getEndpoint('unknown')).toBeNull()
	})

	test('deletes endpoint', async () => {
		await store.saveEndpoint({
			id: 'ep-1',
			url: 'https://a.com',
			events: ['user.created'],
			secret: 's',
			active: true,
			createdAt: Date.now(),
		})
		await store.deleteEndpoint('ep-1')
		expect(await store.getEndpoint('ep-1')).toBeNull()
	})

	test('lists all endpoints', async () => {
		await store.saveEndpoint({
			id: '1',
			url: 'a',
			events: [],
			secret: 's',
			active: true,
			createdAt: 0,
		})
		await store.saveEndpoint({
			id: '2',
			url: 'b',
			events: [],
			secret: 's',
			active: true,
			createdAt: 0,
		})
		const all = await store.listEndpoints()
		expect(all).toHaveLength(2)
	})

	test('saves and lists deliveries', async () => {
		await store.saveDelivery({
			id: 'd1',
			endpointId: 'ep-1',
			event: 'user.created',
			payload: '{}',
			responseStatus: 200,
			success: true,
			error: null,
			attempts: 1,
			createdAt: 1000,
			lastAttemptAt: 1000,
		})
		await store.saveDelivery({
			id: 'd2',
			endpointId: 'ep-1',
			event: 'user.signin',
			payload: '{}',
			responseStatus: 200,
			success: true,
			error: null,
			attempts: 1,
			createdAt: 2000,
			lastAttemptAt: 2000,
		})

		const deliveries = await store.listDeliveries('ep-1')
		expect(deliveries).toHaveLength(2)
		// Should be newest first
		expect(deliveries[0]?.createdAt).toBe(2000)
	})

	test('updates existing delivery on save', async () => {
		await store.saveDelivery({
			id: 'd1',
			endpointId: 'ep-1',
			event: 'user.created',
			payload: '{}',
			responseStatus: null,
			success: false,
			error: 'timeout',
			attempts: 1,
			createdAt: 1000,
			lastAttemptAt: 1000,
		})

		await store.saveDelivery({
			id: 'd1', // same ID
			endpointId: 'ep-1',
			event: 'user.created',
			payload: '{}',
			responseStatus: 200,
			success: true,
			error: null,
			attempts: 2,
			createdAt: 1000,
			lastAttemptAt: 2000,
		})

		const deliveries = await store.listDeliveries('ep-1')
		expect(deliveries).toHaveLength(1)
		expect(deliveries[0]?.success).toBe(true)
		expect(deliveries[0]?.attempts).toBe(2)
	})

	test('returns copies not references', async () => {
		const ep = {
			id: '1',
			url: 'a',
			events: [] as string[],
			secret: 's',
			active: true,
			createdAt: 0,
		}
		await store.saveEndpoint(ep as import('./webhooks').WebhookEndpoint)
		const retrieved = await store.getEndpoint('1')
		;(retrieved as NonNullable<typeof retrieved>).url = 'mutated'
		const again = await store.getEndpoint('1')
		expect(again?.url).toBe('a')
	})
})
