import { afterEach, describe, expect, test, vi } from 'vitest'
import { InMemoryWebhookStore, WebhookManager } from './webhooks'

/**
 * Webhook delivery reaches only public addresses: NAT64 (64:ff9b::/96) and IPv4-compatible
 * (::/96) IPv6 addresses embed an IPv4 address and are private when it is, and the request
 * goes to the address that was checked, never to a second DNS answer (rebinding).
 */
afterEach(() => {
	vi.restoreAllMocks()
	vi.useRealTimers()
})

async function settle(run: Promise<unknown>): Promise<void> {
	vi.useFakeTimers({ toFake: ['setTimeout'] })
	let done = false
	void run.finally(() => {
		done = true
	})
	while (!done) {
		await new Promise<void>((resolve) => setImmediate(resolve))
		vi.runOnlyPendingTimers()
	}
	vi.useRealTimers()
}

describe('webhook targets embedding a private IPv4 address', () => {
	test.each([
		'https://[64:ff9b::7f00:1]/hook',
		'https://[64:ff9b::a00:5]/hook',
		'https://[::7f00:1]/hook',
		'https://[::a9fe:a9fe]/hook',
	])('register refuses %s', async (url) => {
		const manager = new WebhookManager({ store: new InMemoryWebhookStore() })
		await expect(manager.register({ url, events: ['user.created'] })).rejects.toThrow()
	})

	test('a public NAT64 address (embedding a public IPv4) is allowed', async () => {
		const manager = new WebhookManager({ store: new InMemoryWebhookStore() })
		await expect(
			manager.register({ url: 'https://[64:ff9b::5db8:d822]/hook', events: ['user.created'] }),
		).resolves.toBeDefined()
	})

	test('a name resolving to a NAT64 loopback is refused at delivery', async () => {
		const transport = vi.fn(async () => ({ status: 200 }))
		const manager = new WebhookManager({
			store: new InMemoryWebhookStore(),
			resolveHost: async () => ['64:ff9b::7f00:1'],
			transport,
		})
		await manager.register({ url: 'https://hooks.example/hook', events: ['user.created'] })
		await settle(manager.dispatch('user.created', { userId: 'u1' }))
		expect(transport).not.toHaveBeenCalled()
	})
})

describe('webhook delivery is pinned to the checked address', () => {
	test('a resolver that answers loopback the second time cannot redirect the request', async () => {
		// Never reach the network, whichever path delivery takes.
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response(null, { status: 200 }))
		const answers = [['93.184.216.34'], ['127.0.0.1']]
		const resolveHost = vi.fn(async () => answers.shift() ?? ['127.0.0.1'])
		const transport = vi.fn(async (_request: { address: string }) => ({ status: 200 }))
		const manager = new WebhookManager({
			store: new InMemoryWebhookStore(),
			resolveHost,
			transport,
		})
		await manager.register({ url: 'https://hooks.example/hook', events: ['user.created'] })
		await settle(manager.dispatch('user.created', { userId: 'u1' }))
		expect(transport).toHaveBeenCalledTimes(1)
		expect(transport.mock.calls[0]?.[0]).toMatchObject({
			url: 'https://hooks.example/hook',
			address: '93.184.216.34',
		})
		expect(resolveHost).toHaveBeenCalledTimes(1)
		expect(fetchSpy).not.toHaveBeenCalled()
	})
})
