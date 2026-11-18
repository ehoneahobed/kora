import { execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createTempDir } from '../../tests/fixtures/test-helpers'
import { getTemplatePath, scaffoldTemplate } from '../commands/create/template-engine'

/**
 * A new app writes secrets (.env with KORA_AUTH_SECRET) and databases (.kora/*.db): every
 * template must start with a .gitignore that keeps them out of git.
 */
const temps: Array<{ cleanup: () => Promise<void> }> = []
afterEach(async () => {
	for (const temp of temps.splice(0)) await temp.cleanup()
})

const templates = (
	await readdir(join(getTemplatePath('react-basic'), '..'), { withFileTypes: true })
)
	.filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
	.map((entry) => entry.name)

describe('every template ships a .gitignore', () => {
	test('there are templates to check', () => {
		expect(templates.length).toBeGreaterThan(10)
	})

	test.each(templates)(
		'%s keeps secrets, databases and build output out of git',
		async (template) => {
			const temp = await createTempDir()
			temps.push(temp)
			const dir = join(temp.path, 'app')
			await scaffoldTemplate(template as never, dir, {
				projectName: 'app',
				packageManager: 'pnpm',
				koraVersion: '1.0.0-beta.15',
			})
			const ignore = await readFile(join(dir, '.gitignore'), 'utf8')
			for (const line of ['node_modules', 'dist', '.env', '!.env.example', '.kora/', '*.db']) {
				expect(ignore.split('\n'), line).toContain(line)
			}
			if (template.startsWith('tauri')) expect(ignore.split('\n')).toContain('src-tauri/target')

			// What git sees in a fresh repository.
			await writeFile(join(dir, '.env'), 'KORA_AUTH_SECRET=secret\n')
			await writeFile(join(dir, '.env.local'), 'X=1\n')
			await writeFile(join(dir, '.env.example'), 'KORA_AUTH_SECRET=\n')
			await mkdir(join(dir, '.kora'), { recursive: true })
			await writeFile(join(dir, '.kora', 'server.db'), '')
			await writeFile(join(dir, 'local.db'), '')
			execFileSync('git', ['init', '-q'], { cwd: dir })
			const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
				cwd: dir,
				encoding: 'utf8',
			})
			const untracked = status.split('\n').map((line) => line.slice(3))
			for (const hidden of ['.env', '.env.local', '.kora/server.db', 'local.db']) {
				expect(untracked, hidden).not.toContain(hidden)
			}
			expect(untracked).toContain('.env.example')
		},
	)
})
