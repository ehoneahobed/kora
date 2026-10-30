import { describe, expect, it } from 'vitest'
import type { AuditFs } from './audit-fs'
import {
	checkIsolationHeaders,
	checkRuntimeStorage,
	checkWorkerDelivery,
	resolveBuildDir,
	runProductionAudit,
} from './production-audit'

const ROOT = '/app'

/** An in-memory project: `files` maps a project-relative path to its text. */
function memoryFs(files: Record<string, string>): AuditFs {
	const absolute = new Map(Object.entries(files).map(([k, v]) => [`${ROOT}/${k}`, v]))
	return {
		async readText(path) {
			return absolute.get(path) ?? null
		},
		async walk(directory, skip) {
			const prefix = `${directory.replace(/\/$/, '')}/`
			const found: string[] = []
			for (const path of absolute.keys()) {
				if (!path.startsWith(prefix)) continue
				const relative = path.slice(prefix.length)
				if (
					relative
						.split('/')
						.slice(0, -1)
						.some((part) => skip.has(part))
				)
					continue
				found.push(relative)
			}
			return found.length > 0 ? found.sort() : null
		},
	}
}

const BUILT = {
	'dist/index.html': '<html></html>',
	'dist/assets/index-AbCdEf12.js': 'x',
	'dist/assets/kora-worker-ZyXwVu98.js': 'x',
	'dist/assets/sqlite3-QwErTy12.wasm': 'wasm',
	'dist/assets/sqlite3.wasm': 'wasm',
}

describe('resolveBuildDir', () => {
	it('reads build.outDir from the Vite config and defaults to dist', () => {
		expect(resolveBuildDir("export default { build: { outDir: './build-output/' } }")).toBe(
			'build-output',
		)
		expect(resolveBuildDir('export default {}')).toBe('dist')
		expect(resolveBuildDir("build: { outDir: '../elsewhere' }")).toBe('dist')
		expect(resolveBuildDir(null)).toBe('dist')
	})
})

describe('production-worker-delivery', () => {
	it('passes when the worker and the unhashed WASM are in the build output', async () => {
		const result = await checkWorkerDelivery(ROOT, memoryFs(BUILT))
		expect(result.id).toBe('production-worker-delivery')
		expect(result.status).toBe('pass')
		expect(result.message).toContain('1 worker script(s)')
	})

	it('skips, not fails, when nothing is built yet', async () => {
		const result = await checkWorkerDelivery(ROOT, memoryFs({ 'src/main.ts': 'export {}' }))
		expect(result.status).toBe('skip')
		expect(result.fix).toContain('build')
	})

	it('warns when only the hashed WASM was emitted', async () => {
		const { 'dist/assets/sqlite3.wasm': _removed, ...hashedOnly } = BUILT
		const result = await checkWorkerDelivery(ROOT, memoryFs(hashedOnly))
		expect(result.status).toBe('warn')
		expect(result.message).toContain('unhashed dist/assets/sqlite3.wasm')
	})

	it('warns when the worker script or the WASM binary is missing', async () => {
		const result = await checkWorkerDelivery(
			ROOT,
			memoryFs({ 'dist/index.html': 'x', 'dist/assets/index-AbCdEf12.js': 'x' }),
		)
		expect(result.status).toBe('warn')
		expect(result.message).toContain('no .wasm file')
		expect(result.message).toContain('no worker script')
	})

	it('warns about TypeScript left in the output', async () => {
		const result = await checkWorkerDelivery(
			ROOT,
			memoryFs({ ...BUILT, 'dist/assets/kora-worker.ts': 'x' }),
		)
		expect(result.status).toBe('warn')
		expect(result.message).toContain('TypeScript files in the output')
	})

	it('warns when a host rule serves .wasm with the wrong media type', async () => {
		const result = await checkWorkerDelivery(
			ROOT,
			memoryFs({
				...BUILT,
				_headers: '/*.wasm\n  Content-Type: application/octet-stream\n',
			}),
		)
		expect(result.status).toBe('warn')
		expect(result.message).toContain('_headers serves .wasm as application/octet-stream')
	})

	it('accepts a host rule that sets application/wasm', async () => {
		const result = await checkWorkerDelivery(
			ROOT,
			memoryFs({ ...BUILT, _headers: '/*.wasm\n  Content-Type: application/wasm\n' }),
		)
		expect(result.status).toBe('pass')
	})

	it('skips an app that forces an adapter without a worker', async () => {
		const result = await checkWorkerDelivery(
			ROOT,
			memoryFs({ 'src/main.ts': "createApp({ store: { adapter: 'indexeddb' } })" }),
		)
		expect(result.status).toBe('skip')
		expect(result.message).toContain('indexeddb')
	})

	it('follows build.outDir', async () => {
		const result = await checkWorkerDelivery(
			ROOT,
			memoryFs({
				'vite.config.ts': "export default { build: { outDir: 'public-build' } }",
				'public-build/assets/kora-worker-ZyXwVu98.js': 'x',
				'public-build/assets/sqlite3.wasm': 'wasm',
			}),
		)
		expect(result.status).toBe('pass')
		expect(result.message).toContain('public-build/')
	})
})

describe('production-isolation-headers', () => {
	it('does not require COOP/COEP for the default adapter', async () => {
		const result = await checkIsolationHeaders(ROOT, memoryFs({ 'src/main.ts': 'export {}' }))
		expect(result.id).toBe('production-isolation-headers')
		expect(result.status).toBe('pass')
		expect(result.message).toContain('not required')
		expect(result.message).toContain('opfs-sahpool')
	})

	it('stays a pass when the template credentialless headers are present', async () => {
		const result = await checkIsolationHeaders(
			ROOT,
			memoryFs({
				'vite.config.ts':
					"const p = process.env.KORA_COEP_POLICY || 'credentialless'; res.setHeader('Cross-Origin-Embedder-Policy', p)",
			}),
		)
		expect(result.status).toBe('pass')
		expect(result.message).toContain('vite.config.ts')
	})

	it('warns about require-corp that nothing needs', async () => {
		const result = await checkIsolationHeaders(
			ROOT,
			memoryFs({ _headers: '/*\n  Cross-Origin-Embedder-Policy: require-corp\n' }),
		)
		expect(result.status).toBe('warn')
		expect(result.message).toContain('does not need cross-origin isolation')
	})

	it('requires the headers when the app itself uses SharedArrayBuffer', async () => {
		const result = await checkIsolationHeaders(
			ROOT,
			memoryFs({ 'src/video.ts': 'const buf = new SharedArrayBuffer(8)' }),
		)
		expect(result.status).toBe('warn')
		expect(result.message).toContain('src/video.ts uses SharedArrayBuffer')
		expect(result.fix).toContain('Cross-Origin-Opener-Policy: same-origin')
	})

	it('is satisfied by createProductionServer or by host headers when they are needed', async () => {
		const served = await checkIsolationHeaders(
			ROOT,
			memoryFs({
				'src/video.ts': 'const b = new SharedArrayBuffer(8)',
				'server.ts': 'createProductionServer({ store })',
			}),
		)
		expect(served.status).toBe('pass')
		const hosted = await checkIsolationHeaders(
			ROOT,
			memoryFs({
				'src/video.ts': 'if (crossOriginIsolated) {}',
				_headers:
					'/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: credentialless\n',
			}),
		)
		expect(hosted.status).toBe('pass')
	})
})

describe('production-runtime-storage', () => {
	it('passes a default configuration and says OPFS is only known in the browser', async () => {
		const result = await checkRuntimeStorage(ROOT, memoryFs({ 'src/main.ts': 'createApp({})' }))
		expect(result.id).toBe('production-runtime-storage')
		expect(result.status).toBe('pass')
		expect(result.message).toContain('only known in the browser')
	})

	it('warns on allowNonDurable and a forced IndexedDB adapter', async () => {
		const result = await checkRuntimeStorage(
			ROOT,
			memoryFs({
				'src/main.ts': "createApp({ store: { adapter: 'indexeddb', allowNonDurable: true } })",
			}),
		)
		expect(result.status).toBe('warn')
		expect(result.message).toContain('allowNonDurable')
		expect(result.message).toContain('"indexeddb" adapter')
	})

	it('warns on an insecure non-local sync URL, not on localhost', async () => {
		const insecure = await checkRuntimeStorage(
			ROOT,
			memoryFs({ '.env.production': 'VITE_SYNC_URL=ws://sync.example.com/kora-sync\n' }),
		)
		expect(insecure.status).toBe('warn')
		expect(insecure.message).toContain('ws://sync.example.com')
		const local = await checkRuntimeStorage(
			ROOT,
			memoryFs({ '.env': 'VITE_SYNC_URL=ws://localhost:3001/kora-sync\n' }),
		)
		expect(local.status).toBe('pass')
		const secure = await checkRuntimeStorage(
			ROOT,
			memoryFs({ '.env.production': 'VITE_SYNC_URL=wss://sync.example.com/kora-sync\n' }),
		)
		expect(secure.status).toBe('pass')
	})
})

describe('runProductionAudit', () => {
	it('returns the three static checks with stable ids, each independent', async () => {
		const results = await runProductionAudit(ROOT, memoryFs(BUILT))
		expect(results.map((r) => r.id)).toEqual([
			'production-worker-delivery',
			'production-isolation-headers',
			'production-runtime-storage',
		])
		expect(results.every((r) => r.status === 'pass')).toBe(true)
	})

	it('turns an unreadable project into skips instead of failing the audit', async () => {
		const broken: AuditFs = {
			async readText() {
				return null
			},
			async walk() {
				throw new Error('disk gone')
			},
		}
		const results = await runProductionAudit(ROOT, broken)
		expect(results.map((r) => r.status)).toEqual(['skip', 'skip', 'skip'])
		expect(results[0]?.message).toContain('disk gone')
	})
})
