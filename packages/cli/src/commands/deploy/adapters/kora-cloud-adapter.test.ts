import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { KoraCloudClient } from '../../../cloud/cloud-client'
import type { PromptClient } from '../../../prompts/prompt-client'
import type { Logger } from '../../../utils/logger'
import type { ProjectConfig } from './adapter'
import { KoraCloudAdapter } from './kora-cloud-adapter'

function recordingLogger(lines: string[]): Logger {
	const push = (message: string) => {
		lines.push(message)
	}
	return {
		info: push,
		success: push,
		warn: push,
		error: push,
		step: push,
		blank: () => undefined,
		banner: () => undefined,
	}
}

const prompts: PromptClient = {
	text: async () => '',
	select: async () => '__new__' as never,
	confirm: async () => true,
}

/** A Kora Cloud that builds, then reports the deployment's stages over two polls. */
function fakeCloud(outcome: 'ready' | 'build_failed') {
	const uploads: Array<{ path: string; bytes: number }> = []
	let polls = 0
	const fetchImpl = (async (url: string, init?: RequestInit) => {
		const { pathname, search } = new URL(url)
		const method = init?.method ?? 'GET'
		if (pathname === '/v1/organizations')
			return Response.json({ items: [{ id: 'org_1', name: 'Acme', role: 'owner' }] })
		if (pathname === '/v1/projects' && method === 'GET') return Response.json({ items: [] })
		if (pathname === '/v1/projects' && method === 'POST')
			return Response.json(
				{ id: 'prj_1', organizationId: 'org_1', name: 'my-app', slug: 'my-app', publicUrl: null },
				{ status: 201 },
			)
		if (pathname === '/v1/projects/prj_1/cli-deployments') {
			uploads.push({ path: `${pathname}${search}`, bytes: (init?.body as Uint8Array).byteLength })
			return Response.json({ id: 'cld_1' }, { status: 202 })
		}
		if (pathname === '/v1/cli-deployments/cld_1') {
			polls += 1
			if (outcome === 'build_failed')
				return Response.json({
					id: 'cld_1',
					status: polls > 1 ? 'rejected' : 'building',
					building: true,
					rejection:
						polls > 1 ? { code: 'build_failed', message: 'The image could not be built.' } : null,
					deployment: null,
					project: { id: 'prj_1', name: 'my-app', slug: 'my-app' },
					publicUrl: null,
					consoleUrl: null,
				})
			return Response.json({
				id: 'cld_1',
				status: polls > 1 ? 'deployed' : 'building',
				building: true,
				rejection: null,
				deployment:
					polls > 1
						? { id: 'dpl_1', status: polls > 2 ? 'ready' : 'running', stage: 'verifying' }
						: null,
				project: { id: 'prj_1', name: 'my-app', slug: 'my-app' },
				publicUrl: 'https://my-app.onkora.app',
				consoleUrl: 'https://console.example/projects/prj_1/deployments/dpl_1',
				missingSettings: [
					{ name: 'RESEND_API_KEY', description: 'Sends invitation emails.', secret: true },
				],
			})
		}
		if (pathname === '/v1/cli-deployments/cld_1/log')
			return Response.json({ available: true, text: 'step 1\nERR! missing lockfile entry\n' })
		if (pathname === '/v1/deployments/dpl_1/events')
			return Response.json({
				items:
					Number(new URL(url).searchParams.get('after')) > 0
						? []
						: [
								{ sequence: 1, stage: 'provisioning', status: 'started', code: 'x', message: '' },
								{ sequence: 2, stage: 'verifying', status: 'started', code: 'y', message: '' },
							],
			})
		return Response.json(
			{ error: { code: 'route_not_found', message: `no ${method} ${pathname}` } },
			{ status: 404 },
		)
	}) as typeof fetch
	return { fetchImpl, uploads }
}

const config = (projectRoot: string): ProjectConfig => ({
	projectRoot,
	appName: 'my-app',
	region: null,
	environment: 'production',
	confirm: false,
})

test('the first deploy creates and links the project, uploads the source, and follows it to ready', async () => {
	const root = await mkdtemp(join(tmpdir(), 'kora-cloud-'))
	const cloud = fakeCloud('ready')
	const lines: string[] = []
	const adapter = new KoraCloudAdapter({
		client: async () => new KoraCloudClient('https://api.example', 'kcli_x', cloud.fetchImpl),
		prompts,
		logger: recordingLogger(lines),
		interactive: false,
		sleep: async () => undefined,
		pack: async () => ({
			archive: new Uint8Array(10),
			root: '.',
			gitCommit: 'a'.repeat(40),
			files: 3,
			skipped: [],
		}),
	})
	adapter.setContext({ projectRoot: root, appName: 'my-app', region: null })
	await adapter.provision(config(root))
	expect(JSON.parse(await readFile(join(root, '.kora/cloud.json'), 'utf8'))).toEqual({
		organizationId: 'org_1',
		projectId: 'prj_1',
	})
	const result = await adapter.deploy(await adapter.build(config(root)))
	expect(cloud.uploads).toEqual([
		{ path: `/v1/projects/prj_1/cli-deployments?root=.&gitCommit=${'a'.repeat(40)}`, bytes: 10 },
	])
	expect(result).toEqual({
		deploymentId: 'dpl_1',
		liveUrl: 'https://my-app.onkora.app',
		syncUrl: 'wss://my-app.onkora.app/kora-sync',
	})
	expect(lines).toContain('Provisioning environment...')
	expect(lines).toContain('Verifying the app...')
	expect(lines).toContain('RESEND_API_KEY (secret): Sends invitation emails.')
	expect(lines).toContain(
		'Set it at https://console.example/projects/prj_1/settings, then deploy again.',
	)
	// Linked now: the next deploy asks nothing and creates nothing.
	await adapter.provision(config(root)).catch(() => undefined)
})

test('a failed build prints the end of its log and says why', async () => {
	const root = await mkdtemp(join(tmpdir(), 'kora-cloud-'))
	const cloud = fakeCloud('build_failed')
	const lines: string[] = []
	const adapter = new KoraCloudAdapter({
		client: async () => new KoraCloudClient('https://api.example', 'kcli_x', cloud.fetchImpl),
		prompts,
		logger: recordingLogger(lines),
		interactive: false,
		sleep: async () => undefined,
		pack: async () => ({
			archive: new Uint8Array(10),
			root: '.',
			gitCommit: null,
			files: 1,
			skipped: [],
		}),
	})
	adapter.setContext({ projectRoot: root, appName: 'my-app', region: null })
	await adapter.provision(config(root))
	await expect(adapter.deploy(await adapter.build(config(root)))).rejects.toThrow(
		'The image could not be built.',
	)
	expect(lines).toContain('ERR! missing lockfile entry')
})

test('without a sign-in, deploying says to run kora login', async () => {
	const unauthorized = (async () =>
		Response.json(
			{ error: { code: 'authentication_required', message: 'x' } },
			{ status: 401 },
		)) as typeof fetch
	const adapter = new KoraCloudAdapter({
		client: async () => new KoraCloudClient('https://api.example', 'kcli_old', unauthorized),
		prompts,
		logger: recordingLogger([]),
		interactive: false,
	})
	await expect(adapter.provision(config('/tmp'))).rejects.toThrow(/kora login/)
})
