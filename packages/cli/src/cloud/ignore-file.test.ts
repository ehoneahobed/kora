import { describe, expect, test } from 'vitest'
import { compileIgnore } from './ignore-file'

describe('compileIgnore', () => {
	const ignored = compileIgnore(`# design sources the app doesn't ship
design/
*.psd
/recordings
docs/**/*.mov
!design/keep.svg
`)

	test('a folder pattern takes everything under it, at any depth unless anchored', () => {
		expect(ignored('design/logo.png')).toBe(true)
		expect(ignored('apps/web/design/a.png')).toBe(true)
		expect(ignored('designer.ts')).toBe(false)
	})

	test('file globs match at any depth, anchored ones only at the root', () => {
		expect(ignored('art/cover.psd')).toBe(true)
		expect(ignored('recordings/demo.mp4')).toBe(true)
		expect(ignored('src/recordings/x.ts')).toBe(false)
		expect(ignored('docs/a/b/talk.mov')).toBe(true)
		expect(ignored('docs/talk.mov')).toBe(true)
	})

	test('the last matching line wins, so ! brings a path back', () => {
		expect(ignored('design/keep.svg')).toBe(false)
		expect(ignored('src/server.ts')).toBe(false)
	})
})
