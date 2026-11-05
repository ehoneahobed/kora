import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineSchema, t } from '@korajs/core'
import { build } from 'esbuild'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { CONFIG_VALIDATOR_SLOT, type ConfigValidatorSlot } from './config-validator-slot'
import { createApp } from './create-app'
import type { KoraApp, KoraConfig } from './types'

const SRC = dirname(fileURLToPath(import.meta.url))
const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})
const memory = { adapter: 'better-sqlite3', name: ':memory:' } as const

describe('config validation, development build (the validator is registered)', () => {
	test('an invalid option throws at createApp, naming the option and the fix', () => {
		expect(() =>
			createApp({ schema, store: memory, sync: { url: 'http://not-a-socket' } } as KoraConfig),
		).toThrowError(/Invalid sync URL/)
	})

	test('a missing schema throws at createApp', () => {
		expect(() => createApp({ store: memory } as unknown as KoraConfig)).toThrowError(
			/requires a schema/,
		)
	})
})

describe('config validation, production build (nothing registered; the runtime validates)', () => {
	const slot = globalThis as ConfigValidatorSlot
	const registered = slot[CONFIG_VALIDATOR_SLOT]
	let app: KoraApp | null = null
	beforeEach(() => {
		Reflect.deleteProperty(slot, CONFIG_VALIDATOR_SLOT)
	})
	afterEach(async () => {
		slot[CONFIG_VALIDATOR_SLOT] = registered
		await app?.close().catch(() => {})
		app = null
	})

	test('an invalid option does not throw at createApp: ready rejects with the same error and its fix', async () => {
		app = createApp({ schema, store: memory, sync: { url: 'http://not-a-socket' } } as KoraConfig)
		await expect(app.ready).rejects.toMatchObject({
			code: 'INVALID_SYNC_URL',
			context: { fix: expect.stringContaining('ws://') },
		})
	})

	test('a missing schema rejects ready with SchemaValidationError, not a TypeError', async () => {
		app = createApp({ store: memory } as unknown as KoraConfig)
		await expect(app.ready).rejects.toMatchObject({ name: 'SchemaValidationError' })
	})
})

describe('the validation is not in the production first-paint bundle', () => {
	/** Bundles the package entry for a mode and returns the text of the files loaded statically. */
	async function staticBundleText(nodeEnv: string): Promise<string> {
		const result = await build({
			entryPoints: [join(SRC, 'index.ts')],
			bundle: true,
			splitting: true,
			format: 'esm',
			outdir: '/virtual',
			write: false,
			platform: 'browser',
			packages: 'external',
			logLevel: 'silent',
			define: { 'process.env.NODE_ENV': JSON.stringify(nodeEnv) },
		})
		const files = new Map(result.outputFiles.map((f) => [f.path, f.text]))
		const entry = [...files.keys()].find((p) => p.endsWith('/index.js'))
		const seen = new Set<string>()
		const visit = (path: string): void => {
			if (seen.has(path)) return
			seen.add(path)
			const text = files.get(path) ?? ''
			// Static imports only: `from "./chunk-X.js"` (a dynamic import() is written differently).
			for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)[^'"]*from\s*"(\.[^"]+)"/g)) {
				visit(join(dirname(path), m[1] ?? ''))
			}
		}
		if (entry) visit(entry)
		return [...seen].map((p) => files.get(p) ?? '').join('\n')
	}

	test('production: the sync URL check is absent; development: present (positive control)', async () => {
		const production = await staticBundleText('production')
		const development = await staticBundleText('development')
		expect(development).toContain('sync.url is required when sync is configured')
		expect(production).not.toContain('sync.url is required when sync is configured')
		// The reading of the entry is real: createApp itself is in the production bundle.
		expect(production).toContain('createApp')
		expect(readFileSync(join(SRC, 'create-app.ts'), 'utf8')).not.toMatch(
			/from '\.\/validate-config'/,
		)
	})
})
