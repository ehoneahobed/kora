import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { scanDeliveryPosition, tally } from './delivery-progress-scan'

/**
 * Four review rounds found the same bug four times: a write of the delivery position (the
 * watermark, the per-view cache, the access-rules key, the acknowledgment) after an await,
 * with no re-check that the position the batch was received at still exists. The structural
 * fix is that exactly one method, `commitDeliveryProgress`, writes any of them for a batch,
 * and it re-validates the batch's context synchronously before it writes.
 *
 * This test keeps it that way by reading the syntax tree of the engine (not its lines, which
 * the fifth review defeated with eight spellings): every assignment of a protected field,
 * every mention of a persistence method, every write of the view cache and every mutation of
 * the live database on a delivered batch is listed below with the member that owns it and
 * how many sites it has. A new site anywhere, in any spelling, fails here, and adding it to
 * the table is a design decision made in review. Counts (not only names) keep a method that
 * is allowed one write from gaining a second.
 */
const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'sync-engine.ts'), 'utf8')

/** `rule @ member` -> number of sites, with why each owner may have them. */
const EXPECTED: Record<string, number> = {
	// ---- the in-memory position
	// the batch paths: merge, publish (two sites each time a context is rebased)
	'assign:deliveryWatermark @ SyncEngine.commitDeliveryProgress': 2,
	'assign:accessRulesKey @ SyncEngine.commitDeliveryProgress': 2,
	// loaded from the durable cache at start (watermark: the stream's and the view's), key loaded
	'assign:deliveryWatermark @ SyncEngine.startInternal': 2,
	'assign:accessRulesKey @ SyncEngine.startInternal': 1,
	// the view changed or reset: the position of the new view, not a batch's
	'assign:deliveryWatermark @ SyncEngine.switchDeliveryView': 1,
	'assign:deliveryWatermark @ SyncEngine.switchDeliveryViewWithInheritance': 1,
	'assign:deliveryWatermark @ SyncEngine.resetDeliveryForFullResync': 1,
	'assign:deliveryWatermark @ SyncEngine.handleHandshakeResponse': 1,
	// the replica was dropped or unmergeable: back on the durable watermark
	'assign:deliveryWatermark @ SyncEngine.dropStaging': 1,
	'assign:deliveryWatermark @ SyncEngine.restoreLivePosition': 1,

	// ---- the per-view cache
	'cache:set @ SyncEngine.setViewWatermark': 1,
	'cache:delete @ SyncEngine.setViewWatermark': 1,
	'cache:delete @ SyncEngine.evictColdViewWatermarks': 1,
	'cache:set @ SyncEngine.startInternal': 2,
	'persist:setViewWatermark @ SyncEngine.commitDeliveryProgress': 2,
	'persist:setViewWatermark @ SyncEngine.switchDeliveryView': 1,
	'persist:setViewWatermark @ SyncEngine.switchDeliveryViewWithInheritance': 1,
	'persist:setViewWatermark @ SyncEngine.resetDeliveryForFullResync': 1,
	'persist:setViewWatermark @ SyncEngine.handleHandshakeResponse': 1,

	// ---- the durable watermark
	'persist:persistDeliveryWatermark @ SyncEngine.switchDeliveryView': 1,
	'persist:persistDeliveryWatermark @ SyncEngine.switchDeliveryViewWithInheritance': 1,
	'persist:persistDeliveryWatermark @ SyncEngine.resetDeliveryForFullResync': 1,
	'persist:persistDeliveryWatermark @ SyncEngine.handleHandshakeResponse': 1,
	// the helper itself: the declaration's own capability check and its write
	'persist:saveDeliveryWatermark @ SyncEngine.persistDeliveryWatermark': 2,
	// the writer: the in-transaction write, the write, the write-segment restore, the check
	'persist:saveDeliveryWatermark @ SyncEngine.commitDeliveryProgress': 5,
	// capability checks that decide whether a path may run at all (reads of the method, no calls)
	'persist:saveDeliveryWatermark @ SyncEngine.applyBatchInOneTransaction': 1,
	'persist:saveDeliveryWatermark @ SyncEngine.beginStaging': 1,
	'persist:saveDeliveryWatermark @ SyncEngine.buildOfflineCompletion': 1,
	'persist:saveDeliveryWatermark @ SyncEngine.canQuarantine': 1,

	// ---- the quarantine rows that carry a position (second argument), the key, the ack
	'persist:saveQuarantine-progress @ SyncEngine.commitDeliveryProgress': 2,
	'persist:saveAccessRulesKey @ SyncEngine.commitDeliveryProgress': 1,
	'persist:saveAccessRulesKey @ SyncEngine.restoreAccessRulesKey': 1,
	'persist:sendDeliveryAck @ SyncEngine.commitDeliveryProgress': 1,

	// ---- live-database mutations of a delivered batch that need no guard of their own: the
	// retractions of a batch applied in one transaction run inside the apply transaction, which
	// the single writer rolls back when the position moved (StaleDeliveryBatch).
	'unguarded:applyDeliveredRetraction @ SyncEngine.applyBatchInOneTransaction': 1,
}

describe('the delivery position has one writer (syntax-tree rule)', () => {
	test('every writer, alias and live-database mutation is accounted for', () => {
		expect(tally(scanDeliveryPosition(SOURCE))).toEqual(
			Object.fromEntries(Object.entries(EXPECTED).sort(([a], [b]) => a.localeCompare(b))),
		)
	})

	test('the writer exists and validates the context before any write', () => {
		const start = SOURCE.indexOf('private async commitDeliveryProgress(')
		expect(start).toBeGreaterThan(0)
		const body = SOURCE.slice(start, SOURCE.indexOf('\n\t}\n', start))
		expect(body).toContain('deliveryContextChanged')
	})

	test('deliveryContextChanged compares every field of the context', () => {
		const start = SOURCE.indexOf('private deliveryContextChanged(')
		const body = SOURCE.slice(start, SOURCE.indexOf('\n\t}\n', start))
		for (const field of [
			'sessionEpoch !== context.epoch',
			'connectionGeneration !== context.connection',
			'deliverySignature() !== context.signature',
			'principal !== context.principal',
			'context.staging',
			'deliveryWatermark !== context.watermark',
			'deliveryGeneration !== context.generation',
			'accessRulesKey',
		]) {
			expect(body, field).toContain(field)
		}
	})
})

/** Replaces `from` (which must occur exactly once) with `to`. */
function replaceOnce(source: string, from: string, to: string): string {
	expect(source.split(from).length - 1, `anchor: ${from.slice(0, 60)}`).toBe(1)
	return source.replace(from, to)
}

/** Adds `members` as new members of the SyncEngine class, right before `positionMoved`. */
function withMembers(members: string): string {
	return replaceOnce(SOURCE, '\tprivate positionMoved(', `${members}\n\tprivate positionMoved(`)
}

/** The scan of `source` differs from the real engine's (something was added, moved or removed). */
function detected(source: string): boolean {
	return (
		JSON.stringify(tally(scanDeliveryPosition(source))) !==
		JSON.stringify(tally(scanDeliveryPosition(SOURCE)))
	)
}

describe('the rule sees every spelling of an escape (the eight the fifth review used, and more)', () => {
	const escapes: Record<string, string> = {
		'bracket access': "private evil(): void { this['deliveryWatermark'] = 5 }",
		'template-literal bracket access': 'private evil(): void { this[`deliveryWatermark`] = 5 }',
		'compound assignment': 'private evil(): void { this.deliveryWatermark += 1 }',
		increment: 'private evil(): void { this.deliveryWatermark++ }',
		'optional call':
			"private async evil(): Promise<void> { await this.syncState?.saveDeliveryWatermark?.('', 1) }",
		'destructured alias':
			"private async evil(): Promise<void> { const { saveDeliveryWatermark: save } = this.syncState ?? {}; await save?.('', 1) }",
		'generic method name':
			'private async evil<T>(value: T): Promise<T> { this.deliveryWatermark = 1; return value }',
		'arrow-property method': 'private evil = (): void => { this.deliveryWatermark = 1 }',
		'variable second argument':
			'private async evil(progress: never): Promise<void> { await this.syncState?.saveQuarantine?.([], progress) }',
		'spread arguments':
			'private async evil(args: never[]): Promise<void> { await this.syncState?.saveQuarantine?.(...args) }',
		'const self = this': 'private evil(): void { const self = this; self.deliveryWatermark = 1 }',
		'assignment alias of this':
			'private evil(): void { let self: unknown; self = this; void self }',
		'bracket access on a cast receiver':
			"private evil(): void { (this as unknown as { deliveryWatermark: number })['deliveryWatermark'] = 3 }",
		'template-literal access on a cast receiver':
			'private evil(): void { (this as unknown as { deliveryWatermark: number })[`deliveryWatermark`] = 3 }',
		'bracket access to a persistence method':
			"private async evil(): Promise<void> { await (this.syncState as { saveDeliveryWatermark?: (s: string, w: number) => Promise<void> })['saveDeliveryWatermark']?.('', 1) }",
		'an alias of this that touches nothing yet':
			'private evil(): unknown { const self = this; return self }',
		'Reflect.set': "private evil(): void { Reflect.set(this, 'deliveryWatermark', 1) }",
		'destructuring assignment': 'private evil(): void { [this.deliveryWatermark] = [1] }',
		'object destructuring assignment':
			'private evil(): void { ({ w: this.deliveryWatermark } = { w: 1 }) }',
		'cast receiver':
			'private evil(): void { (this as { deliveryWatermark: number }).deliveryWatermark = 3 }',
		'dynamic member name':
			"private evil(): void { const key = 'deliveryWatermark'; this[key as never] = 1 }",
		'Object.assign': 'private evil(): void { Object.assign(this, { deliveryWatermark: 1 }) }',
		'a view cache write': "private evil(): void { this.deliverySignatureWatermarks.set('x', 9) }",
		'the cache setter': "private evil(): void { this.setViewWatermark('x', 9) }",
		'the key save':
			"private async evil(): Promise<void> { await this.syncState?.saveAccessRulesKey?.('k') }",
		'a bare acknowledgment': 'private evil(): void { this.sendDeliveryAck(1, 1) }',
		'a stored reference':
			'private evil(): unknown { return this.syncState?.saveDeliveryWatermark }',
		'a narrowing without a guard':
			"private async evil(): Promise<void> { await this.store.applyCollectionNarrowing?.('c', {}, new Set()) }",
		'a retraction without a guard':
			'private async evil(m: never): Promise<void> { await this.applyDeliveredRetraction(m, 1) }',
	}
	for (const [name, member] of Object.entries(escapes)) {
		test(`a new member: ${name}`, () => {
			expect(detected(withMembers(`\t${member}\n`))).toBe(true)
		})
	}

	test('a second write inside a method that is allowed one (the whole-method hole)', () => {
		for (const method of ['startInternal', 'handleHandshakeResponse', 'commitDeliveryProgress']) {
			const pattern = new RegExp(`\\t(?:private )?(?:async )?${method}\\([^)]*\\)[^{]*\\{\\n`)
			const match = pattern.exec(SOURCE)
			expect(match, method).not.toBeNull()
			const at = (match?.index ?? 0) + (match?.[0].length ?? 0)
			const mutated = `${SOURCE.slice(0, at)}\t\tthis['deliveryWatermark'] += 1\n${SOURCE.slice(at)}`
			expect(detected(mutated), method).toBe(true)
		}
	})
})

describe('the rule sees a guard removed from the live-database mutations of a stale batch', () => {
	test('the unit key before the per-operation path', () => {
		const mutated = replaceOnce(
			SOURCE,
			'\t\t\tif (moved()) return stale()\n\t\t\tawait this.ensureOfflineUnit(msg)',
			'\t\t\tawait this.ensureOfflineUnit(msg)',
		)
		expect(detected(mutated)).toBe(true)
	})

	test('the narrowing loop', () => {
		const mutated = replaceOnce(
			SOURCE,
			'\t\t\tif (moved()) return stale()\n\t\t\ttry {\n\t\t\t\tif (!this.store.applyCollectionNarrowing)',
			'\t\t\ttry {\n\t\t\t\tif (!this.store.applyCollectionNarrowing)',
		)
		expect(detected(mutated)).toBe(true)
	})

	test('a retraction of the per-operation path', () => {
		const mutated = replaceOnce(
			SOURCE,
			'\t\t\t\tif (moved()) return false\n\t\t\t\tconst at = isDeliveryBatch',
			'\t\t\t\tconst at = isDeliveryBatch',
		)
		expect(detected(mutated)).toBe(true)
	})

	test('an await between the check and the mutation', () => {
		const mutated = replaceOnce(
			SOURCE,
			'\t\t\tif (moved()) return stale()\n\t\t\tawait this.ensureOfflineUnit(msg)',
			'\t\t\tif (moved()) return stale()\n\t\t\tawait Promise.resolve()\n\t\t\tawait this.ensureOfflineUnit(msg)',
		)
		expect(detected(mutated)).toBe(true)
	})

	test('a check before the loop does not cover the iterations after an await', () => {
		const mutated = replaceOnce(
			SOURCE,
			'\t\t\tif (moved()) return stale()\n\t\t\ttry {\n\t\t\t\tif (!this.store.applyCollectionNarrowing)',
			'\t\t\ttry {\n\t\t\t\tif (!this.store.applyCollectionNarrowing)',
		).replace(
			'\t\tfor (const [collection, scope] of Object.entries(msg.accessNarrowing ?? {})) {',
			'\t\tif (moved()) return stale()\n\t\tfor (const [collection, scope] of Object.entries(msg.accessNarrowing ?? {})) {',
		)
		expect(detected(mutated)).toBe(true)
	})
})
