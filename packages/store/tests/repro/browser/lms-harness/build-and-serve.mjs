import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
// Bundles the harness (Kora dist + @sqlite.org/sqlite-wasm) and serves it with COOP/COEP.
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const storeRoot = path.resolve(here, '../../../..')
const repoRoot = path.resolve(storeRoot, '../..')
// esbuild is a dependency of the root tsup devDependency; resolve it from there rather than
// hard-coding a .pnpm store path, so the harness survives lockfile updates.
const require = createRequire(createRequire(path.join(repoRoot, 'package.json')).resolve('tsup'))
const esbuild = require('esbuild')

export async function buildAndServe(outDir) {
	await mkdir(outDir, { recursive: true })
	const common = {
		bundle: true,
		format: 'esm',
		target: 'es2022',
		logLevel: 'error',
		absWorkingDir: here,
		nodePaths: [path.join(storeRoot, 'node_modules')],
	}
	await esbuild.build({
		...common,
		entryPoints: [path.join(here, 'page-entry.js')],
		outfile: path.join(outDir, 'page.js'),
	})
	await esbuild.build({
		...common,
		entryPoints: [path.join(here, 'kora-worker-entry.js')],
		outfile: path.join(outDir, 'kora-worker.js'),
	})
	await esbuild.build({
		...common,
		entryPoints: [path.join(here, 'raw-worker-entry.js')],
		outfile: path.join(outDir, 'raw-worker.js'),
	})
	await copyFile(
		path.join(storeRoot, 'node_modules/@sqlite.org/sqlite-wasm/sqlite-wasm/jswasm/sqlite3.wasm'),
		path.join(outDir, 'sqlite3.wasm'),
	)
	await writeFile(
		path.join(outDir, 'index.html'),
		'<!doctype html><meta charset=utf-8><title>lms-repro</title><script type=module src=/page.js></script>',
	)
	const types = { '.js': 'text/javascript', '.html': 'text/html', '.wasm': 'application/wasm' }
	const server = createServer(async (req, res) => {
		const p = path.join(
			outDir,
			new URL(req.url, 'http://x').pathname.replace(/^\/$/, '/index.html'),
		)
		try {
			const body = await readFile(p)
			res.writeHead(200, {
				'content-type': types[path.extname(p)] ?? 'application/octet-stream',
				'cross-origin-opener-policy': 'same-origin',
				'cross-origin-embedder-policy': 'require-corp',
			})
			res.end(body)
		} catch {
			res.writeHead(404)
			res.end()
		}
	})
	await new Promise((r) => server.listen(0, '127.0.0.1', r))
	return { server, url: `http://127.0.0.1:${server.address().port}/` }
}
