import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const built = existsSync(join(DIST, 'lite.cjs')) && existsSync(join(DIST, 'index.cjs'))

describe.skipIf(!built)('CommonJS entries share one copy of each class (needs a build)', () => {
	test('everything the lite and the full entry both export is the same value, errors included', () => {
		const require = createRequire(import.meta.url)
		const lite = require(join(DIST, 'lite.cjs')) as Record<string, unknown>
		const full = require(join(DIST, 'index.cjs')) as Record<string, unknown>
		const classes = Object.keys(lite).filter(
			(name) => name in full && typeof lite[name] === 'function',
		)
		expect(classes.filter((name) => lite[name] !== full[name])).toEqual([])
		const core = require('@korajs/core') as Record<string, unknown>
		// What the store throws is a KoraError of the one copy of @korajs/core.
		const StoreNotOpen = full.StoreNotOpenError as new (m: string) => Error
		expect(new StoreNotOpen('x')).toBeInstanceOf(core.KoraError as new () => Error)
	})
})
