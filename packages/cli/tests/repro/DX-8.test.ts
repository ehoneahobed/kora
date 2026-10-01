import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createDeployAdapter } from '../../src/commands/deploy/adapters/factory'
import { StubDeployAdapter } from '../../src/commands/deploy/adapters/stub-adapter'

/**
 * DX-8: `kora deploy` interactive prompt must only offer platforms that work
 * (or label them "coming soon" like Kora Cloud). Render and "Docker
 * (self-hosted)" are offered unlabelled but resolve to StubDeployAdapter,
 * which throws "Deploy adapter ... is not implemented yet." on install().
 */
const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(resolve(here, '../../src/commands/deploy/deploy-command.ts'), 'utf8')
const offered = [...src.matchAll(/label:\s*'([^']+)',\s*value:\s*'([^']+)'/g)].map((m) => ({
	label: m[1] as string,
	value: m[2] as string,
}))

describe('DX-8 deploy prompt offers only implemented platforms', () => {
	it('parsed the prompt options', () => {
		expect(offered.map((o) => o.value)).toEqual(
			expect.arrayContaining(['fly', 'railway', 'render', 'docker']),
		)
	})
	for (const value of ['render', 'docker']) {
		it(`"${value}" is either implemented or labelled coming soon`, async () => {
			const option = offered.find((o) => o.value === value)
			const adapter = createDeployAdapter(value as never)
			const isStub = adapter instanceof StubDeployAdapter
			const labelledSoon = /coming soon/i.test(option?.label ?? '')
			expect({ value, isStub, labelledSoon }).not.toMatchObject({ isStub: true, labelledSoon: false })
			if (isStub) await expect(adapter.install()).rejects.toThrow(/not implemented/)
		})
	}
})
