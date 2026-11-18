import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createTempDir } from '../../tests/fixtures/test-helpers'
import { scaffoldTemplate } from '../commands/create/template-engine'

/**
 * Tauri keys an app's data directory on its identifier: every app scaffolded with the same
 * one opens the same database file, so two Kora desktop apps on one machine would read,
 * migrate and overwrite each other's data.
 */
const VALID_IDENTIFIER = /^[a-zA-Z][a-zA-Z0-9-]*(\.[a-zA-Z][a-zA-Z0-9-]*)+$/

const temps: Array<{ cleanup: () => Promise<void> }> = []
afterEach(async () => {
	for (const temp of temps.splice(0)) await temp.cleanup()
})

async function scaffoldTauri(projectName: string) {
	const temp = await createTempDir()
	temps.push(temp)
	const dir = join(temp.path, projectName)
	await scaffoldTemplate('tauri-react', dir, {
		projectName,
		packageManager: 'pnpm',
		koraVersion: '1.0.0-beta.15',
	})
	return JSON.parse(await readFile(join(dir, 'src-tauri', 'tauri.conf.json'), 'utf8')) as {
		productName: string
		identifier: string
	}
}

describe('a scaffolded Tauri app has its own identity', () => {
	test('its identifier and product name come from the app name', async () => {
		const notes = await scaffoldTauri('my-notes')
		const board = await scaffoldTauri('team-board')
		expect(notes.productName).toBe('my-notes')
		expect(notes.identifier).not.toBe('com.kora.app')
		expect(notes.identifier).toMatch(VALID_IDENTIFIER)
		expect(notes.identifier).toContain('my-notes')
		expect(board.identifier).not.toBe(notes.identifier)
	})
})
