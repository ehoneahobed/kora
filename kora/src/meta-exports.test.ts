import { fileURLToPath } from 'node:url'
import * as react from '@korajs/react'
import * as svelte from '@korajs/svelte'
import * as vue from '@korajs/vue'
import * as korajsReact from 'korajs/react'
import { KoraProvider, useQuery } from 'korajs/react'
import * as korajsSvelte from 'korajs/svelte'
import { createQueryStore, useMutation } from 'korajs/svelte'
import * as korajsVue from 'korajs/vue'
import { KoraProvider as VueKoraProvider, useQuery as useVueQuery } from 'korajs/vue'
import ts from 'typescript'
import { describe, expect, test } from 'vitest'

describe('korajs framework subpath re-exports', () => {
	test('korajs/react re-exports React bindings', () => {
		expect(KoraProvider).toBeTypeOf('function')
		expect(useQuery).toBeTypeOf('function')
	})

	test('korajs/vue re-exports Vue bindings', () => {
		expect(VueKoraProvider).toBeTypeOf('object')
		expect(useVueQuery).toBeTypeOf('function')
	})

	test('korajs/svelte re-exports Svelte bindings', () => {
		expect(createQueryStore).toBeTypeOf('function')
		expect(useMutation).toBeTypeOf('function')
	})
})

// Every runtime export of a binding package is reachable from its `korajs/*` subpath, so an
// app never needs a second dependency for an API the docs describe.

describe('korajs framework subpaths re-export everything their binding package exports', () => {
	const pairs: Array<[string, object, object]> = [
		['korajs/react', react, korajsReact],
		['korajs/vue', vue, korajsVue],
		['korajs/svelte', svelte, korajsSvelte],
	]
	test.each(pairs)('%s', (_subpath, binding, meta) => {
		const missing = Object.keys(binding).filter((name) => !(name in meta))
		expect(missing).toEqual([])
	})
})

/** Every export name (values and types) of a TypeScript entry file. */
function exportNames(file: string): string[] {
	const program = ts.createProgram([file], {
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		target: ts.ScriptTarget.ES2022,
		skipLibCheck: true,
		noEmit: true,
	})
	const source = program.getSourceFile(file)
	const checker = program.getTypeChecker()
	const moduleSymbol = source ? checker.getSymbolAtLocation(source) : undefined
	if (!moduleSymbol) throw new Error(`no module at ${file}`)
	return checker
		.getExportsOfModule(moduleSymbol)
		.map((symbol) => symbol.name)
		.sort()
}

describe('korajs framework subpaths list every value and type of their binding package', () => {
	const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))
	test.each(['react', 'vue', 'svelte'])(
		'korajs/%s',
		(framework) => {
			const binding = exportNames(here(`../../packages/${framework}/src/index.ts`))
			const meta = new Set(exportNames(here(`./${framework}.ts`)))
			expect(binding.length).toBeGreaterThan(10)
			expect(binding.filter((name) => !meta.has(name))).toEqual([])
		},
		60_000,
	)
})
