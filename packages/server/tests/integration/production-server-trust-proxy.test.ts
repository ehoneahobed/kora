import { describe, expect, test } from 'vitest'
import { createProductionServer } from '../../src/server/production-server'
import { MemoryServerStore } from '../../src/store/memory-server-store'

async function whoami(trustProxy: number | string[] | undefined, port: number): Promise<string> {
	const server = createProductionServer({
		store: new MemoryServerStore('server-1'),
		port,
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
	await server.start()
	try {
		const res = await fetch(`http://localhost:${port}/whoami`, {
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
		const ip = await whoami(undefined, 39_421)
		expect(ip).not.toBe('203.0.113.77')
		expect(ip).not.toBe('spoofed')
	})

	test('trustProxy: 1 takes the entry appended by the one trusted proxy', async () => {
		expect(await whoami(1, 39_422)).toBe('203.0.113.77')
	})

	test('trustProxy as a CIDR list trusts loopback peers only', async () => {
		expect(await whoami(['127.0.0.0/8', '::1'], 39_423)).toBe('203.0.113.77')
		expect(await whoami(['10.0.0.0/8'], 39_424)).not.toBe('203.0.113.77')
	})
})
