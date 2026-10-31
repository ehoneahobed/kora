import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { type JournalEntry, openWriteJournal, writeJournalName } from './write-journal'

function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
	return {
		session: 's1',
		owner: null,
		at: 1,
		collection: 'todos',
		kind: 'insert',
		args: [{ title: 'a' }],
		...overrides,
	}
}

let counter = 0
const freshName = (): string => `journal-test-${++counter}`

describe('write journal', () => {
	it('names the IndexedDB database after the local database', () => {
		expect(writeJournalName('app')).toBe('kora-write-journal:app')
	})

	it('lists entries oldest first with their sequence numbers', async () => {
		const journal = openWriteJournal(freshName())
		if (!journal) throw new Error('IndexedDB should be available in this test')
		const a = await journal.append(entry({ args: [{ title: 'a' }] }))
		const b = await journal.append(entry({ args: [{ title: 'b' }] }))
		expect(b).toBeGreaterThan(a)
		const listed = await journal.list()
		expect(listed.map((item) => item.seq)).toEqual([a, b])
		expect(listed[1]?.args).toEqual([{ title: 'b' }])
		journal.close()
	})

	it('survives a reopen (a closed tab leaves its entries behind)', async () => {
		const name = freshName()
		const first = openWriteJournal(name)
		if (!first) throw new Error('IndexedDB should be available in this test')
		await first.append(entry())
		first.close()
		const second = openWriteJournal(name)
		if (!second) throw new Error('IndexedDB should be available in this test')
		expect(await second.list()).toHaveLength(1)
		second.close()
	})

	it('removes an applied entry', async () => {
		const journal = openWriteJournal(freshName())
		if (!journal) throw new Error('IndexedDB should be available in this test')
		const seq = await journal.append(entry())
		await journal.remove(seq)
		expect(await journal.list()).toEqual([])
		journal.close()
	})

	it('keeps a failed entry for inspection with its message', async () => {
		const journal = openWriteJournal(freshName())
		if (!journal) throw new Error('IndexedDB should be available in this test')
		const seq = await journal.append(entry())
		await journal.markFailed(seq, 'collection removed')
		const [only] = await journal.list()
		expect(only?.failed).toBe('collection removed')
		journal.close()
	})

	it('keeps each database to its own journal', async () => {
		const a = openWriteJournal(freshName())
		const b = openWriteJournal(freshName())
		if (!a || !b) throw new Error('IndexedDB should be available in this test')
		await a.append(entry())
		expect(await b.list()).toEqual([])
		a.close()
		b.close()
	})
})
