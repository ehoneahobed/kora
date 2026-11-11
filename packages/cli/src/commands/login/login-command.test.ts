import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { KoraCloudClient } from '../../cloud/cloud-client'
import { readCredentials } from '../../cloud/credentials'
import type { Logger } from '../../utils/logger'
import { runLogin, runLogout } from './login-command'

const quiet: Logger = {
	info: () => undefined,
	success: () => undefined,
	warn: () => undefined,
	error: () => undefined,
	step: () => undefined,
	blank: () => undefined,
	banner: () => undefined,
}

function fakeCloud(approveAfter: number) {
	let polls = 0
	const requests: string[] = []
	const fetchImpl = (async (url: string, init?: RequestInit) => {
		const path = new URL(url).pathname
		requests.push(`${init?.method ?? 'GET'} ${path}`)
		if (path === '/v1/cli/login')
			return Response.json(
				{
					loginId: 'l1',
					pollSecret: 's',
					userCode: 'BCDF-GHJK',
					verificationUrl: 'https://console.example/cli/authorize?code=BCDF-GHJK',
					expiresIn: 600,
					interval: 3,
				},
				{ status: 201 },
			)
		if (path === '/v1/cli/login/poll') {
			polls += 1
			return polls >= approveAfter
				? Response.json({ status: 'approved', token: 'kcli_new', email: 'dev@example.com' })
				: Response.json({ status: 'pending' }, { status: 202 })
		}
		if (path === '/v1/cli/token') return new Response(null, { status: 204 })
		return Response.json({ error: { code: 'route_not_found', message: 'no' } }, { status: 404 })
	}) as typeof fetch
	return { fetchImpl, requests, polls: () => polls }
}

test('kora login shows a code, opens the console, and saves the token once it is approved', async () => {
	const env = { XDG_CONFIG_HOME: await mkdtemp(join(tmpdir(), 'kora-login-')) }
	const cloud = fakeCloud(3)
	const opened: string[] = []
	let clock = 0
	const result = await runLogin({
		env,
		logger: quiet,
		client: new KoraCloudClient('https://api.koracloud.app', null, cloud.fetchImpl),
		openBrowser: (url) => opened.push(url),
		sleep: async (ms) => {
			clock += ms
		},
		now: () => clock,
	})
	expect(result.email).toBe('dev@example.com')
	expect(opened).toEqual(['https://console.example/cli/authorize?code=BCDF-GHJK'])
	expect(cloud.polls()).toBe(3)
	expect((await readCredentials(env))?.token).toBe('kcli_new')
})

test('kora login gives up when the code expires, and kora logout ends the sign-in', async () => {
	const env = { XDG_CONFIG_HOME: await mkdtemp(join(tmpdir(), 'kora-login-')) }
	const never = fakeCloud(Number.POSITIVE_INFINITY)
	let clock = 0
	await expect(
		runLogin({
			env,
			logger: quiet,
			client: new KoraCloudClient('https://api.koracloud.app', null, never.fetchImpl),
			openBrowser: () => undefined,
			sleep: async (ms) => {
				clock += ms
			},
			now: () => clock,
		}),
	).rejects.toThrow(/expired/)

	const cloud = fakeCloud(1)
	await runLogin({
		env,
		logger: quiet,
		client: new KoraCloudClient('https://api.koracloud.app', null, cloud.fetchImpl),
		openBrowser: () => undefined,
		sleep: async () => undefined,
	})
	await runLogout({
		env,
		logger: quiet,
		client: new KoraCloudClient('https://api.koracloud.app', 'kcli_new', cloud.fetchImpl),
	})
	expect(cloud.requests).toContain('DELETE /v1/cli/token')
	expect(await readCredentials(env)).toBeNull()
})
