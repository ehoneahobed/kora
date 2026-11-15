import { describe, expect, test } from 'vitest'
import {
	TauriDatabaseInUseError,
	deleteTauriDatabase,
	inspectTauriDatabase,
	readTauriDatabase,
} from './database-files'
import type { InvokeFn } from './tauri-sqlite-adapter'

function recordingInvoke(answer: (cmd: string, args?: Record<string, unknown>) => unknown) {
	const calls: Array<[string, Record<string, unknown> | undefined]> = []
	const invoke = (async (cmd: string, args?: Record<string, unknown>) => {
		calls.push([cmd, args])
		return answer(cmd, args)
	}) as InvokeFn
	return { invoke, calls }
}

describe('Tauri database files', () => {
	test('inspect asks the plugin about the path', async () => {
		const { invoke, calls } = recordingInvoke(() => ({ open: false, exists: true }))
		await expect(inspectTauriDatabase('kora-db.db', invoke)).resolves.toEqual({
			open: false,
			exists: true,
		})
		expect(calls).toEqual([['plugin:kora-sqlite|inspect', { path: 'kora-db.db' }]])
	})

	test('read opens without schema statements and closes even when reading fails', async () => {
		const { invoke, calls } = recordingInvoke((cmd) =>
			cmd.endsWith('query') ? [{ n: 1 }] : undefined,
		)
		await expect(
			readTauriDatabase(
				'kora-db.db',
				async (db) => (await db.query<{ n: number }>('SELECT 1 AS n'))[0]?.n,
				invoke,
			),
		).resolves.toBe(1)
		await expect(
			readTauriDatabase(
				'kora-db.db',
				async () => {
					throw new Error('boom')
				},
				invoke,
			),
		).rejects.toThrow('boom')
		expect(calls.map(([cmd]) => cmd)).toEqual([
			'plugin:kora-sqlite|open',
			'plugin:kora-sqlite|query',
			'plugin:kora-sqlite|close',
			'plugin:kora-sqlite|open',
			'plugin:kora-sqlite|close',
		])
		expect(calls[0]?.[1]).toEqual({ path: 'kora-db.db', statements: [] })
	})

	test("delete returns the plugin's answer and maps its in-use refusal", async () => {
		const ok = recordingInvoke(() => true)
		await expect(deleteTauriDatabase('kora-db.db', ok.invoke)).resolves.toBe(true)
		const inUse = recordingInvoke(() => {
			// Tauri rejects with the serialized error string.
			throw 'STORAGE_IN_USE: database kora-db.db is open; close it before deleting it'
		})
		await expect(deleteTauriDatabase('kora-db.db', inUse.invoke)).rejects.toBeInstanceOf(
			TauriDatabaseInUseError,
		)
		const other = recordingInvoke(() => {
			throw 'IO error: permission denied'
		})
		await expect(deleteTauriDatabase('kora-db.db', other.invoke)).rejects.toBe(
			'IO error: permission denied',
		)
	})
})
