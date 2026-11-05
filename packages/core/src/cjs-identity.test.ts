import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const built = existsSync(join(DIST, 'lite.cjs')) && existsSync(join(DIST, 'index.cjs'))

describe.skipIf(!built)('CommonJS entries share one copy of each class (needs a build)', () => {
	test('every error class and defineSchema exported by both lite and full are the same value', () => {
		const require = createRequire(import.meta.url)
		const lite = require(join(DIST, 'lite.cjs')) as Record<string, unknown>
		const full = require(join(DIST, 'index.cjs')) as Record<string, unknown>
		const shared = Object.keys(lite).filter((name) => name in full)
		const classes = shared.filter((name) => typeof lite[name] === 'function')
		// The check is not vacuous: the errors and the schema builder are among them.
		expect(classes).toEqual(
			expect.arrayContaining(['KoraError', 'AppNotReadyError', 'defineSchema']),
		)
		const different = classes.filter((name) => lite[name] !== full[name])
		expect(different).toEqual([])
		expect(new (lite.SchemaValidationError as new (m: string) => Error)('x')).toBeInstanceOf(
			full.KoraError as new () => Error,
		)
	})
})
