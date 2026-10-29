import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PlannedChange } from './plan'

// writeFile fails for one named file, to prove the ones already written are restored.
const failOn = vi.hoisted(() => ({ suffix: '' }))

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>()
	return {
		...actual,
		writeFile: (async (path: string, ...rest: unknown[]) => {
			if (failOn.suffix !== '' && String(path).endsWith(failOn.suffix)) {
				throw new Error('ENOSPC: no space left on device')
			}
			return (actual.writeFile as (...args: unknown[]) => Promise<void>)(path, ...rest)
		}) as typeof actual.writeFile,
	}
})

const { applyUpgradeChanges } = await import('./apply')

function change(file: string): PlannedChange {
	return {
		specifier: {
			format: 'package-json',
			file,
			section: 'dependencies',
			path: ['dependencies'],
			name: 'korajs',
			spec: '^1.0.0-beta.14',
		},
		style: 'caret',
		from: '^1.0.0-beta.14',
		to: '^1.0.0-beta.15',
	}
}

describe('applyUpgradeChanges rollback', () => {
	let dir = ''
	afterEach(async () => {
		failOn.suffix = ''
		if (dir) await rm(dir, { recursive: true, force: true })
	})

	it('restores files already written when a later write fails', async () => {
		dir = await mkdtemp(join(tmpdir(), 'kora-rollback-'))
		const text = '{"dependencies": {"korajs": "^1.0.0-beta.14"}}\n'
		const first = join(dir, 'a-package.json')
		const second = join(dir, 'b-package.json')
		await writeFile(first, text)
		await writeFile(second, text)
		failOn.suffix = 'b-package.json'

		await expect(applyUpgradeChanges([change(first), change(second)])).rejects.toMatchObject({
			code: 'UPGRADE_WRITE_FAILED',
			message: expect.stringContaining('restored'),
		})
		expect(await readFile(first, 'utf-8')).toBe(text)
		expect(await readFile(second, 'utf-8')).toBe(text)
	})
})
