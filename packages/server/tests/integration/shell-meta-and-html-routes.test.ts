/**
 * Shared links preview the page they point at (beta.15): `shellMeta` writes per-URL
 * title, description and Open Graph tags into the app shell, crawlers that ask for
 * `*\/*` get that shell instead of a 404, and custom routes may answer with HTML or
 * bytes instead of JSON.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { type ProductionServer, createProductionServer } from '../../src/server/production-server'
import { metaExcerpt } from '../../src/server/shell-meta'
import { MemoryServerStore } from '../../src/store/memory-server-store'

const schema = defineSchema({
	version: 1,
	collections: {
		forms: {
			fields: {
				title: t.string(),
				description: t.string().default(''),
				slug: t.string(),
				status: t.enum(['draft', 'published']).default('draft'),
			},
		},
	},
})

const SHELL = `<!doctype html><html><head>
<title>KoraForms</title>
<meta name="description" content="Build forms that work anywhere" />
<meta property="og:title" content="KoraForms" />
</head><body><div id="root"></div></body></html>`

function get(
	url: string,
	headers: Record<string, string>,
): Promise<{ status: number; body: string; type: string }> {
	return new Promise((done, fail) => {
		const req = request(url, { method: 'GET', headers }, (res) => {
			const chunks: Buffer[] = []
			res.on('data', (chunk: Buffer) => chunks.push(chunk))
			res.on('end', () =>
				done({
					status: res.statusCode ?? 0,
					body: Buffer.concat(chunks).toString('utf8'),
					type: String(res.headers['content-type'] ?? ''),
				}),
			)
		})
		req.on('error', fail)
		req.end()
	})
}

describe('shellMeta and HTML routes', () => {
	let dir: string
	let server: ProductionServer
	let base: string

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), 'kora-shell-meta-'))
		mkdirSync(join(dir, 'assets'))
		writeFileSync(join(dir, 'index.html'), SHELL)
		const store = new MemoryServerStore('server-1')
		await store.setSchema(schema)
		server = createProductionServer({
			store,
			port: 0,
			staticDir: dir,
			shellMeta: async ({ path, kora }) => {
				const slug = path.match(/^\/f\/([^/]+)/)?.[1]
				if (!slug) return null
				const [form] = await kora.query('forms', {
					where: { slug: decodeURIComponent(slug), status: 'published' },
				})
				if (!form) return null
				return {
					title: `${String(form.title)} | KoraForms`,
					description: metaExcerpt(String(form.description ?? '')),
					url: `https://forms.example${path}`,
				}
			},
			httpRoutes: [
				{
					path: '/embed',
					handle: async () => ({ status: 200, html: '<!doctype html><p>embed</p>' }),
				},
				{
					path: '/robots.txt',
					handle: async () => ({
						status: 200,
						raw: 'User-agent: *\nAllow: /\n',
						headers: { 'Content-Type': 'text/plain; charset=utf-8' },
					}),
				},
				{ path: '/api/ping', handle: async () => ({ status: 200, body: { ok: true } }) },
			],
		})
		base = await server.start()
		const kora = server.kora
		await kora.apply({
			collection: 'forms',
			type: 'insert',
			recordId: 'f1',
			data: {
				title: 'Pump 3 handover',
				description: `Check the seals before restart. ${'Long text. '.repeat(40)}`,
				slug: 'pump-3',
				status: 'published',
			},
		})
		await kora.apply({
			collection: 'forms',
			type: 'insert',
			recordId: 'f2',
			data: { title: 'Secret draft <b>', description: 'not yet', slug: 'draft-1', status: 'draft' },
		})
	})

	afterAll(async () => {
		await server.stop()
		rmSync(dir, { recursive: true, force: true })
	})

	test("a crawler asking for */* gets the published form's own title and description", async () => {
		const r = await get(`${base}/f/pump-3`, {
			'user-agent': 'facebookexternalhit/1.1',
			accept: '*/*',
		})
		expect(r.status).toBe(200)
		expect(r.type).toMatch(/text\/html/)
		expect(r.body).toContain('<title>Pump 3 handover | KoraForms</title>')
		expect(r.body).toContain('<meta property="og:title" content="Pump 3 handover | KoraForms" />')
		expect(r.body).toMatch(
			/<meta name="description" content="Check the seals before restart\.[^"]*…" \/>/,
		)
		expect(r.body).toContain('<link rel="canonical" href="https://forms.example/f/pump-3" />')
		expect(r.body).not.toContain('Build forms that work anywhere')
	})

	test('a draft (or unknown) form keeps the generic card: nothing unpublished leaks', async () => {
		for (const path of ['/f/draft-1', '/f/nope']) {
			const r = await get(`${base}${path}`, { accept: 'text/html' })
			expect(r.status).toBe(200)
			expect(r.body).toContain('<title>KoraForms</title>')
			expect(r.body).not.toContain('Secret draft')
		}
	})

	test("the app's own pages and the root get the shell with metadata applied per URL", async () => {
		const root = await get(`${base}/`, { accept: 'text/html' })
		expect(root.body).toContain('<title>KoraForms</title>')
		const results = await get(`${base}/f/pump-3/results`, { accept: 'text/html' })
		expect(results.body).toContain('<title>Pump 3 handover | KoraForms</title>')
	})

	test('custom routes answer HTML, raw bytes, or JSON', async () => {
		const html = await get(`${base}/embed`, { accept: '*/*' })
		expect(html.type).toBe('text/html; charset=utf-8')
		expect(html.body).toBe('<!doctype html><p>embed</p>')
		const robots = await get(`${base}/robots.txt`, { accept: '*/*' })
		expect(robots.type).toBe('text/plain; charset=utf-8')
		expect(robots.body).toBe('User-agent: *\nAllow: /\n')
		const json = await get(`${base}/api/ping`, { accept: '*/*' })
		expect(json.type).toMatch(/application\/json/)
		expect(JSON.parse(json.body)).toEqual({ ok: true })
	})

	test('a missing API path stays a 404 for non-browser clients', async () => {
		expect((await get(`${base}/api/typo`, { accept: '*/*' })).status).toBe(404)
	})
})
