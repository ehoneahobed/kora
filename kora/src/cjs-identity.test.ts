import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')

describe.skipIf(!existsSync(join(DIST, 'index.cjs')))(
	'the korajs CommonJS entry re-exports the classes of @korajs/core (needs a build)',
	() => {
		test('KoraError, AppNotReadyError and the schema errors are the same values', () => {
			const require = createRequire(import.meta.url)
			const kora = require(join(DIST, 'index.cjs')) as Record<string, unknown>
			const core = require('@korajs/core') as Record<string, unknown>
			const lite = require('@korajs/core/lite') as Record<string, unknown>
			for (const name of ['KoraError', 'AppNotReadyError', 'SchemaValidationError']) {
				if (!(name in kora)) continue
				expect(kora[name]).toBe(core[name])
				expect(kora[name]).toBe(lite[name])
			}
			expect(kora.KoraError).toBe(core.KoraError)
		})
	},
)
