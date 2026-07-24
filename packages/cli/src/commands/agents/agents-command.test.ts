import { describe, expect, test } from 'vitest'
import { agentsCommand } from './agents-command'
import {
	AGENTS_FRAMEWORKS,
	type AgentsFramework,
	detectFrameworkFromManifest,
	generateAgentsMd,
	isAgentsFramework,
} from './agents-md-content'

describe('agentsCommand', () => {
	test('is registered with expected meta and args', () => {
		expect(agentsCommand.meta?.name).toBe('agents-md')
		expect(agentsCommand.args?.force?.default).toBe(false)
		expect(agentsCommand.args?.framework?.type).toBe('string')
	})
})

describe('isAgentsFramework', () => {
	test('accepts supported frameworks and rejects others', () => {
		for (const framework of AGENTS_FRAMEWORKS) {
			expect(isAgentsFramework(framework)).toBe(true)
		}
		expect(isAgentsFramework('angular')).toBe(false)
		expect(isAgentsFramework('')).toBe(false)
	})
})

describe('detectFrameworkFromManifest', () => {
	test('detects each framework from dependencies', () => {
		expect(detectFrameworkFromManifest({ dependencies: { '@korajs/react': '^1.0.0' } })).toBe(
			'react',
		)
		expect(detectFrameworkFromManifest({ dependencies: { '@korajs/vue': '^1.0.0' } })).toBe('vue')
		expect(detectFrameworkFromManifest({ devDependencies: { '@korajs/svelte': '^1.0.0' } })).toBe(
			'svelte',
		)
	})

	test('returns null when no binding package is present', () => {
		expect(detectFrameworkFromManifest({ dependencies: { react: '^18.0.0' } })).toBe(null)
		expect(detectFrameworkFromManifest(null)).toBe(null)
		expect(detectFrameworkFromManifest('not-an-object')).toBe(null)
	})
})

describe('generateAgentsMd', () => {
	const frameworks: AgentsFramework[] = ['react', 'vue', 'svelte']

	test('produces the shared guardrails for every framework', () => {
		for (const framework of frameworks) {
			const doc = generateAgentsMd(framework)
			expect(doc.startsWith('# AGENTS.md')).toBe(true)
			expect(doc).toContain('Never fetch application data over HTTP')
			expect(doc).toContain('Do not add a state library')
			expect(doc).toContain('https://korajs.dev/llms.txt')
			// Corrected mutation API from the docs audit must be reflected.
			expect(doc).toContain('addTodo.mutate(')
			expect(doc).toContain('status.status')
			expect(doc.endsWith('\n')).toBe(true)
		}
	})

	test('emits the matching bindings section and package per framework', () => {
		expect(generateAgentsMd('react')).toContain("from '@korajs/react'")
		expect(generateAgentsMd('react')).toContain('## React bindings')
		expect(generateAgentsMd('vue')).toContain("from '@korajs/vue'")
		expect(generateAgentsMd('vue')).toContain('## Vue bindings')
		expect(generateAgentsMd('svelte')).toContain("from '@korajs/svelte'")
		expect(generateAgentsMd('svelte')).toContain('## Svelte bindings')
	})

	test('never contains an em dash', () => {
		for (const framework of frameworks) {
			expect(generateAgentsMd(framework).includes('—')).toBe(false)
		}
	})
})
