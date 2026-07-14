import { KoraProvider, useQuery } from 'korajs/react'
import { createQueryStore, useMutation } from 'korajs/svelte'
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
