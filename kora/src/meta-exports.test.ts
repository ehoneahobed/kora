import * as react from '@korajs/react'
import * as svelte from '@korajs/svelte'
import * as vue from '@korajs/vue'
import * as korajsReact from 'korajs/react'
import { KoraProvider, useQuery } from 'korajs/react'
import * as korajsSvelte from 'korajs/svelte'
import { createQueryStore, useMutation } from 'korajs/svelte'
import * as korajsVue from 'korajs/vue'
import { KoraProvider as VueKoraProvider, useQuery as useVueQuery } from 'korajs/vue'
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
