import { describe, expect, test } from 'vitest'
import type { Transaction, TransactionStatement } from '../types'
import { WriteBehindTransaction } from './write-behind'

/** A fake transaction recording every call, in order. */
function recorder(options: { batch?: boolean; failSql?: string } = {}) {
	const log: string[] = []
	const tx: Transaction = {
		execute: async (sql) => {
			log.push(`execute ${sql}`)
			if (sql === options.failSql) throw new Error(`boom ${sql}`)
		},
		query: async <T>(sql: string) => {
			log.push(`query ${sql}`)
			return [] as T[]
		},
	}
	if (options.batch) {
		tx.executeBatch = async (statements: readonly TransactionStatement[]) => {
			log.push(`batch ${statements.map((s) => s.sql).join(',')}`)
			if (statements.some((s) => s.sql === options.failSql)) {
				throw new Error(`boom ${options.failSql}`)
			}
		}
	}
	return { tx, log }
}

describe('WriteBehindTransaction', () => {
	test('buffers writes and sends them, in order, before a read', async () => {
		const { tx, log } = recorder({ batch: true })
		const wb = new WriteBehindTransaction(tx)
		await wb.execute('a')
		await wb.execute('b')
		expect(log).toEqual([])
		await wb.query('q')
		expect(log).toEqual(['batch a,b', 'query q'])
	})

	test('flush sends everything that is buffered and waits for it', async () => {
		const { tx, log } = recorder({ batch: true })
		const wb = new WriteBehindTransaction(tx)
		await wb.execute('a')
		await wb.flush()
		expect(log).toEqual(['batch a'])
		await wb.flush()
		expect(log).toEqual(['batch a'])
	})

	test('a full buffer is sent as one batch; batches stay in issue order', async () => {
		const { tx, log } = recorder({ batch: true })
		const wb = new WriteBehindTransaction(tx, 2)
		for (const sql of ['a', 'b', 'c', 'd', 'e']) await wb.execute(sql)
		await wb.flush()
		expect(log).toEqual(['batch a,b', 'batch c,d', 'batch e'])
	})

	test('without executeBatch the statements go one execute at a time, in order', async () => {
		const { tx, log } = recorder()
		const wb = new WriteBehindTransaction(tx, 2)
		for (const sql of ['a', 'b', 'c']) await wb.execute(sql)
		await wb.query('q')
		expect(log).toEqual(['execute a', 'execute b', 'execute c', 'query q'])
	})

	test('a failing statement rejects the flush, and nothing is sent after it', async () => {
		const { tx, log } = recorder({ failSql: 'b' })
		const wb = new WriteBehindTransaction(tx, 2)
		await wb.execute('a')
		await wb.execute('b') // fills the buffer: sent without waiting
		await expect(wb.execute('c').then(() => wb.execute('d'))).rejects.toThrow('boom b')
		await expect(wb.flush()).rejects.toThrow('boom b')
		await expect(wb.query('q')).rejects.toThrow('boom b')
		expect(log).toEqual(['execute a', 'execute b'])
	})

	test('a failure surfaces at the next read when the buffer was not full', async () => {
		const { tx } = recorder({ batch: true, failSql: 'a' })
		const wb = new WriteBehindTransaction(tx)
		await wb.execute('a')
		await expect(wb.query('q')).rejects.toThrow('boom a')
	})

	test('settled() waits for the batch in flight and never rejects', async () => {
		const { tx } = recorder({ batch: true, failSql: 'a' })
		const wb = new WriteBehindTransaction(tx, 1)
		await wb.execute('a')
		await expect(wb.settled()).resolves.toBeUndefined()
	})
})
