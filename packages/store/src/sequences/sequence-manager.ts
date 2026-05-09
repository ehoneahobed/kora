import type { SequenceConfig } from '@korajs/core'
import { defaultSequenceFormat, formatSequenceValue } from '@korajs/core'
import type { StorageAdapter } from '../types'

interface SequenceRow {
	counter: number
}

/**
 * Manages offline-safe sequences backed by a `_kora_sequences` table.
 *
 * Each sequence counter is scoped by (name, scope, nodeId), ensuring
 * that different devices never collide. The counter is atomically
 * incremented within a database transaction.
 *
 * @example
 * ```typescript
 * const mgr = new SequenceManager(adapter, 'node-abc')
 *
 * const receipt = await mgr.next('receipt', {
 *   scope: 'store-1',
 *   format: 'S-{date}-{node4}-{seq}',
 * })
 * // → "S-20260508-node-0001"
 * ```
 */
export class SequenceManager {
	private readonly adapter: StorageAdapter
	private readonly nodeId: string

	constructor(adapter: StorageAdapter, nodeId: string) {
		this.adapter = adapter
		this.nodeId = nodeId
	}

	/**
	 * Get the next value in a sequence, atomically incrementing the counter.
	 *
	 * @param name - The sequence name (e.g., 'receipt', 'invoice')
	 * @param config - Optional configuration for scope, format, and starting value
	 * @returns The formatted sequence value
	 */
	async next(name: string, config?: SequenceConfig): Promise<string> {
		const scope = config?.scope ?? ''
		const startAt = config?.startAt ?? 1
		const format = config?.format ?? defaultSequenceFormat(name)

		let counter = 0

		await this.adapter.transaction(async (tx) => {
			// Try to read the current counter
			const rows = await tx.query<SequenceRow>(
				'SELECT counter FROM _kora_sequences WHERE name = ? AND scope = ? AND node_id = ?',
				[name, scope, this.nodeId],
			)

			if (rows.length > 0) {
				const row = rows[0] as SequenceRow
				counter = row.counter + 1
				await tx.execute(
					'UPDATE _kora_sequences SET counter = ? WHERE name = ? AND scope = ? AND node_id = ?',
					[counter, name, scope, this.nodeId],
				)
			} else {
				// First use — initialize with startAt
				counter = startAt
				await tx.execute(
					'INSERT INTO _kora_sequences (name, scope, node_id, counter) VALUES (?, ?, ?, ?)',
					[name, scope, this.nodeId, counter],
				)
			}
		})

		return formatSequenceValue(format, counter, this.nodeId)
	}

	/**
	 * Get the current counter value without incrementing.
	 *
	 * @param name - The sequence name
	 * @param config - Optional scope
	 * @returns The current counter value, or 0 if the sequence has never been used
	 */
	async current(name: string, config?: { scope?: string }): Promise<number> {
		const scope = config?.scope ?? ''

		const rows = await this.adapter.query<SequenceRow>(
			'SELECT counter FROM _kora_sequences WHERE name = ? AND scope = ? AND node_id = ?',
			[name, scope, this.nodeId],
		)

		if (rows.length > 0) {
			return (rows[0] as SequenceRow).counter
		}
		return 0
	}

	/**
	 * Reset a sequence counter.
	 *
	 * @param name - The sequence name
	 * @param config - Optional scope and target value
	 */
	async reset(name: string, config?: { scope?: string; to?: number }): Promise<void> {
		const scope = config?.scope ?? ''
		const to = config?.to ?? 0

		await this.adapter.execute(
			'DELETE FROM _kora_sequences WHERE name = ? AND scope = ? AND node_id = ?',
			[name, scope, this.nodeId],
		)

		if (to > 0) {
			await this.adapter.execute(
				'INSERT INTO _kora_sequences (name, scope, node_id, counter) VALUES (?, ?, ?, ?)',
				[name, scope, this.nodeId, to],
			)
		}
	}
}
