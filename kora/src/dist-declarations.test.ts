import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

/**
 * Each framework subpath's built declarations name only their own binding package. The others
 * are optional peer dependencies a React-only (or Vue-only, Svelte-only) app does not install,
 * so `import '@korajs/vue'` in react.d.ts is a missing module under TypeScript's
 * noUncheckedSideEffectImports with skipLibCheck off. Runs on the built package (CI builds
 * before testing).
 */
const FRAMEWORKS = ['react', 'vue', 'svelte'] as const
const dist = (file: string) => fileURLToPath(new URL(`../dist/${file}`, import.meta.url))

describe.skipIf(!existsSync(dist('react.d.ts')))('korajs framework declarations', () => {
	for (const framework of FRAMEWORKS) {
		for (const extension of ['d.ts', 'd.cts']) {
			test(`${framework}.${extension} references no other framework's package`, () => {
				const text = readFileSync(dist(`${framework}.${extension}`), 'utf8')
				const others = FRAMEWORKS.filter((other) => other !== framework).filter((other) =>
					new RegExp(`['"]@korajs/${other}['"]`).test(text),
				)
				expect(others).toEqual([])
			})
		}
	}
})
