import { describe, expect, test } from 'vitest'
import { createProductionServer } from '../../src/server/production-server'
import { MemoryServerStore } from '../../src/store/memory-server-store'

async function whoami(trustProxy: number | string[] | undefined): Promise<string> {
	const server = createProductionServer({
		store: new MemoryServerStore('server-1'),
		port: 0,
		...(trustProxy !== undefined ? { trustProxy } : {}),
		httpRoutes: [
			{
				path: '/whoami',
				async handle(request) {
					return { status: 200, body: { ip: request.ip } }
				},
			},
		],
	})
	const base = await server.start()
	try {
		const res = await fetch(`${base}/whoami`, {
			headers: { 'X-Forwarded-For': 'spoofed, 203.0.113.77' },
		})
		const body = (await res.json()) as { ip?: string }
		return body.ip ?? ''
	} finally {
		await server.stop()
	}
}

describe('createProductionServer trustProxy (SEC-9a)', () => {
	test('default: request.ip is the socket address, X-Forwarded-For is ignored', async () => {
		const ip = await whoami(undefined)
		expect(ip).not.toBe('203.0.113.77')
		expect(ip).not.toBe('spoofed')
	})

	test('trustProxy: 1 takes the entry appended by the one trusted proxy', async () => {
		expect(await whoami(1)).toBe('203.0.113.77')
	})

	test('trustProxy as a CIDR list trusts loopback peers only', async () => {
		expect(await whoami(['127.0.0.0/8', '::1'])).toBe('203.0.113.77')
		expect(await whoami(['10.0.0.0/8'])).not.toBe('203.0.113.77')
	})
})
