import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { isLeftOut, packSource, tarHeader } from './source-archive'

async function files(root: string, entries: Record<string, string>): Promise<void> {
	for (const [path, content] of Object.entries(entries)) {
		await mkdir(join(root, path, '..'), { recursive: true })
		await writeFile(join(root, path), content)
	}
}

function git(cwd: string, ...args: string[]): void {
	execFileSync(
		'git',
		['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
		{ cwd, stdio: 'ignore' },
	)
}

async function unpack(archive: Uint8Array): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'kora-unpack-'))
	await writeFile(join(directory, 'source.tgz'), archive)
	execFileSync('tar', ['-xzf', 'source.tgz'], { cwd: directory })
	return join(directory, 'source')
}

describe('packSource', () => {
	test('packs what git would commit, never dependencies or env files, with the clean commit', async () => {
		const root = await mkdtemp(join(tmpdir(), 'kora-pack-'))
		await files(root, {
			'package.json': '{"name":"app"}',
			'server.ts': 'export {}',
			'.gitignore': 'dist\n',
			'dist/out.js': 'built',
			'node_modules/x/index.js': 'dep',
			'.env': 'SECRET=1',
			'.env.example': 'SECRET=',
		})
		git(root, 'init', '-q')
		git(root, 'add', '.')
		git(root, 'commit', '-q', '-m', 'init')
		const packed = await packSource(root)
		expect(packed.root).toBe('.')
		expect(packed.gitCommit).toMatch(/^[a-f0-9]{40}$/)
		const out = await unpack(packed.archive)
		expect(await readFile(join(out, 'server.ts'), 'utf8')).toBe('export {}')
		expect(await readFile(join(out, '.env.example'), 'utf8')).toBe('SECRET=')
		await expect(readFile(join(out, '.env'), 'utf8')).rejects.toThrow()
		await expect(readFile(join(out, 'dist/out.js'), 'utf8')).rejects.toThrow()
		await expect(readFile(join(out, 'node_modules/x/index.js'), 'utf8')).rejects.toThrow()
	})

	test('uploads the whole repository for a project inside a monorepo, and no commit when it has changes', async () => {
		const root = await mkdtemp(join(tmpdir(), 'kora-mono-'))
		await files(root, {
			'pnpm-lock.yaml': '',
			'apps/web/package.json': '{}',
			'packages/shared/index.ts': '',
		})
		git(root, 'init', '-q')
		git(root, 'add', '.')
		git(root, 'commit', '-q', '-m', 'init')
		await writeFile(join(root, 'apps/web/new.ts'), 'untracked')
		const packed = await packSource(join(root, 'apps/web'))
		expect(packed.root).toBe('apps/web')
		expect(packed.gitCommit).toBeNull()
		const out = await unpack(packed.archive)
		expect(await readFile(join(out, 'pnpm-lock.yaml'), 'utf8')).toBe('')
		expect(await readFile(join(out, 'apps/web/new.ts'), 'utf8')).toBe('untracked')
	})

	test('outside git, build output is left out too', async () => {
		const root = await mkdtemp(join(tmpdir(), 'kora-nogit-'))
		await files(root, { 'package.json': '{}', 'dist/a.js': '', 'app.log': '' })
		const packed = await packSource(root)
		expect(packed.gitCommit).toBeNull()
		expect(packed.files).toBe(1)
	})
})

describe('tarHeader and isLeftOut', () => {
	test('long paths use the prefix field, and paths that fit nowhere are reported', () => {
		const long = `source/${'a'.repeat(90)}/${'b'.repeat(60)}.ts`
		expect(
			tarHeader(long, 0o644, 1)
				?.subarray(345, 345 + 97)
				.toString(),
		).toBe(`source/${'a'.repeat(90)}`)
		expect(tarHeader(`source/${'c'.repeat(300)}`, 0o644, 1)).toBeNull()
	})

	test('secrets and dependencies are never uploaded', () => {
		expect(isLeftOut('.env', true)).toBe(true)
		expect(isLeftOut('apps/web/.env.production', true)).toBe(true)
		expect(isLeftOut('.env.example', true)).toBe(false)
		expect(isLeftOut('packages/a/node_modules/b.js', true)).toBe(true)
		expect(isLeftOut('dist/a.js', true)).toBe(false)
		expect(isLeftOut('dist/a.js', false)).toBe(true)
	})
})

describe('.koraignore', () => {
	test('leaves out what it lists, from the repository root and from a project folder', async () => {
		const root = await mkdtemp(join(tmpdir(), 'kora-ignore-'))
		await files(root, {
			'.koraignore': 'design/\n',
			'design/logo.psd': 'big',
			'pnpm-lock.yaml': '',
			'apps/web/package.json': '{}',
			'apps/web/.koraignore': '*.mov\n',
			'apps/web/demo.mov': 'video',
			'apps/web/server.ts': '',
			'packages/shared/demo.mov': 'kept: outside the project folder',
		})
		git(root, 'init', '-q')
		git(root, 'add', '.')
		git(root, 'commit', '-q', '-m', 'init')
		const out = await unpack((await packSource(join(root, 'apps/web'))).archive)
		await expect(readFile(join(out, 'design/logo.psd'), 'utf8')).rejects.toThrow()
		await expect(readFile(join(out, 'apps/web/demo.mov'), 'utf8')).rejects.toThrow()
		expect(await readFile(join(out, 'apps/web/server.ts'), 'utf8')).toBe('')
		expect(await readFile(join(out, 'packages/shared/demo.mov'), 'utf8')).toBe(
			'kept: outside the project folder',
		)
	})
})
