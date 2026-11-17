import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

/**
 * Tauri 2 runs a plain `#[tauri::command]` on the main thread, so a slow query or keychain
 * call freezes the window. Every command of the plugin must run on the async runtime.
 */
describe('the Rust plugin commands', () => {
	test('every command runs off the main thread (#[tauri::command(async)])', () => {
		const dir = join(__dirname, '../plugin/src')
		const blocking: string[] = []
		let commands = 0
		for (const file of readdirSync(dir).filter((name) => name.endsWith('.rs'))) {
			const source = readFileSync(join(dir, file), 'utf8')
			for (const match of source.matchAll(
				/#\[tauri::command(\([^)]*\))?\]\s*pub (async )?fn (\w+)/g,
			)) {
				commands += 1
				const attribute = match[1] ?? ''
				if (!match[2] && !attribute.includes('async')) blocking.push(`${file}: ${match[3]}`)
			}
		}
		expect(commands).toBeGreaterThan(5)
		expect(blocking).toEqual([])
	})
})
