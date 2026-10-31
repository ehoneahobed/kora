import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { scanDeliveryPosition, tally } from './delivery-progress-scan'

/**
 * Four review rounds found the same bug four times: a write of the delivery position after an
 * await, with no re-check that the position the batch was received at still exists. Two layers
 * keep it from coming back.
 *
 * 1. Structure (round 6). The position is not engine fields: it is `#private` state of
 *    `DeliveryPosition`, which no cast, bracket access, destructuring, `Reflect` or
 *    `Object.assign` of the engine can reach. It changes through method calls, and only
 *    `commitDeliveryProgress` holds the batch writer.
 * 2. This test, a syntax-tree scan (not lines, which the fifth review defeated with eight
 *    spellings, nor a list of spellings, which the sixth did with thirty-one): every call of a
 *    position mutator, every mention of a persistence method, every write of the state that
 *    decides what a batch counts for, every element access with a key the scan cannot read,
 *    every cast of the engine or its collaborators, every call to `Reflect` / `globalThis` /
 *    `Object.assign`, and every live-database mutation without a synchronous check before it
 *    is listed below with its owner and a site count. `packages/sync/src` is scanned whole,
 *    and the store and the kora package for the persistence names. A new site anywhere, in
 *    any spelling, fails here, and adding it to the table is a decision made in review.
 */
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..', '..')
const ENGINE = 'packages/sync/src/engine/sync-engine.ts'
const SOURCE = readFileSync(join(ROOT, ENGINE), 'utf8')

/** `rule @ file @ member` -> number of sites. */
const EXPECTED: Record<string, number> = {
	// ---- Position fields reappearing on the engine (it holds none: the state is private to DeliveryPosition)
	'assign:accessRulesKey @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.commitDeliveryProgress': 1,
	// ---- Writes of the state that decides what a batch counts for: owners of session, view, user and replica identity
	'state:connectionGeneration @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.startInternal': 1,
	'state:deliveryGeneration @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.dropStaging': 1,
	'state:deliveryGeneration @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.resetDeliveryForFullResync': 1,
	'state:offlineWatermarks @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.refreshOfflineMarks': 1,
	'state:principal @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.applyPrincipal': 1,
	'state:serverFrontier @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.handleHandshakeResponse': 1,
	'state:sessionEpoch @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.handleError': 1,
	'state:sessionEpoch @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.handleOutboundAckTimeout': 1,
	'state:sessionEpoch @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.handleTransportClose': 1,
	'state:sessionEpoch @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.handleTransportError': 1,
	'state:sessionEpoch @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.startInternal': 1,
	'state:sessionEpoch @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.stopInternal': 1,
	'state:sessionPrincipal @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.startInternal': 1,
	'state:staging @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.applyBatchIntoStaging': 3,
	'state:staging @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.beginStaging': 1,
	'state:staging @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.commitDeliveryProgress': 1,
	'state:staging @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.dropStaging': 1,
	// ---- Who changes the delivery position: owners (start, view switches, full resync, dropping a replica) and the single batch writer (advance, adoptKey, writer)
	'position:adoptKey @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.commitDeliveryProgress': 1,
	'position:adoptRulesKey @ packages/sync/src/engine/delivery-position.ts @ PositionWriter.adoptKey': 1,
	'position:adoptRulesKey @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.startInternal': 1,
	'position:advance @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.commitDeliveryProgress': 2,
	'position:forgetView @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.evictColdViewWatermarks': 1,
	'position:moveTo @ packages/sync/src/engine/delivery-position.ts @ PositionWriter.advance': 1,
	'position:moveTo @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.dropStaging': 1,
	'position:moveTo @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.handleHandshakeResponse': 1,
	'position:moveTo @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.resetDeliveryForFullResync': 1,
	'position:moveTo @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.restoreLivePosition': 1,
	'position:moveTo @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.startInternal': 2,
	'position:moveTo @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.switchDeliveryView': 1,
	'position:moveTo @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.switchDeliveryViewWithInheritance': 1,
	'position:preloadView @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.startInternal': 2,
	'position:recordView @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.setViewWatermark': 1,
	'position:writer @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.commitDeliveryProgress': 3,
	// ---- Durable writes of the position: owners, the single writer, and capability checks that only read the method
	'persist:persistDeliveryWatermark @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.handleHandshakeResponse': 1,
	'persist:persistDeliveryWatermark @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.resetDeliveryForFullResync': 1,
	'persist:persistDeliveryWatermark @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.switchDeliveryView': 1,
	'persist:persistDeliveryWatermark @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.switchDeliveryViewWithInheritance': 1,
	'persist:saveAccessRulesKey @ kora/src/store-sync-state.ts @ StoreSyncStatePersistence.saveAccessRulesKey': 1,
	'persist:saveAccessRulesKey @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.commitDeliveryProgress': 1,
	'persist:saveDeliveryWatermark @ kora/src/merge-aware-sync-store.ts @ MergeAwareSyncStore.applyDeliveryBatch': 1,
	'persist:saveDeliveryWatermark @ kora/src/store-sync-state.ts @ StoreSyncStatePersistence.saveDeliveryWatermark': 1,
	'persist:saveDeliveryWatermark @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.applyBatchInOneTransaction': 1,
	'persist:saveDeliveryWatermark @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.beginStaging': 1,
	'persist:saveDeliveryWatermark @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.buildOfflineCompletion': 1,
	'persist:saveDeliveryWatermark @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.canQuarantine': 1,
	'persist:saveDeliveryWatermark @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.commitDeliveryProgress': 3,
	'persist:saveDeliveryWatermark @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.persistDeliveryWatermark': 2,
	'persist:saveQuarantine-progress @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.applyBatchInOneTransaction': 1,
	'persist:saveQuarantine-progress @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.beginStaging': 1,
	'persist:saveQuarantine-progress @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.canQuarantine': 1,
	'persist:saveQuarantine-progress @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.commitDeliveryProgress': 3,
	'persist:sendDeliveryAck @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.commitDeliveryProgress': 1,
	'persist:setViewWatermark @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.commitDeliveryProgress': 2,
	'persist:setViewWatermark @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.handleHandshakeResponse': 1,
	'persist:setViewWatermark @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.resetDeliveryForFullResync': 1,
	'persist:setViewWatermark @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.switchDeliveryView': 1,
	'persist:setViewWatermark @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.switchDeliveryViewWithInheritance': 1,
	// ---- Who may import the position classes
	'import:position @ packages/sync/src/engine/sync-engine.ts @ <top level>': 1,
	// Free functions that write the position durably, in the store that owns them.
	'call:saveDeliveryWatermark @ packages/store/src/store/store.ts @ Store.saveDeliveryWatermark': 1,
	'call:saveUnappliedOperationsInTx @ packages/store/src/store/store.ts @ Store.applyRemoteBatchNow': 1,
	'call:saveUnappliedOperationsInTx @ packages/store/src/sync/sync-durability.ts @ function saveUnappliedOperations': 1,
	'import:saveDeliveryWatermark @ packages/store/src/store/store.ts @ <top level>': 1,
	'import:saveUnappliedOperationsInTx @ packages/store/src/store/store.ts @ <top level>': 1,
	// ---- Mutations of the live database with no synchronous position check before them in the same function. Why each is not a hole:
	//  * inside an apply transaction (applyBatchInOneTransaction: retractions, applyInbound; the batch's applyScopeRetraction in applyDeliveredRetraction): the single writer rolls the transaction back on a stale context
	//  * helpers whose callers check: SyncEngine.applyScopeRetraction (called by applyDeliveredRetraction after its check, and by the handshake narrowing), ensureOfflineUnit's openOfflineUnit (callers check; see the guarded call sites)
	//  * deferScopeRetraction in applyDeliveredRetraction: the store checks `isCurrent` synchronously before it records anything
	//  * the handshake and session start (handleHandshakeResponse, startInternal, resetDeliveryForFullResync, handleOperationBatch's reset): they own the position, they do not apply a batch received at one
	//  * acknowledgments, rejections and pushes (handleAcknowledgment, handleOperationRejected, pushOperation, recheckAccessNarrowing): they react to the outbound queue, not to a delivery batch
	'unguarded:applyDeliveredRetraction @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.applyBatchInOneTransaction': 1,
	'unguarded:applyInbound @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.applyBatchInOneTransaction': 1,
	'unguarded:applyScopeRetraction @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.applyDeliveredRetraction': 1,
	'unguarded:applyScopeRetraction @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.applyScopeRetraction': 2,
	'unguarded:applyScopeRetraction @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.handleHandshakeResponse': 1,
	'unguarded:clearOfflineMarks @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.clearOfflineMarks': 2,
	'unguarded:clearOfflineMarks @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.handleHandshakeResponse': 1,
	'unguarded:clearOfflineMarks @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.handleOperationBatch': 1,
	'unguarded:clearOfflineMarks @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.resetDeliveryForFullResync': 1,
	'unguarded:deferScopeRetraction @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.applyDeliveredRetraction': 1,
	'unguarded:openOfflineUnit @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.ensureOfflineUnit': 2,
	'unguarded:rebaseDeliveryRun @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.handleHandshakeResponse': 2,
	'unguarded:recheckAccessNarrowing @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.handleAcknowledgment': 1,
	'unguarded:recheckAccessNarrowing @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.handleOperationRejected': 1,
	'unguarded:recheckAccessNarrowing @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.pushOperation': 1,
	'unguarded:recheckAccessNarrowing @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.recheckAccessNarrowing': 2,
	'unguarded:recheckAccessNarrowing @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.startInternal': 1,
	// ---- Element access with a key the scan cannot read: data lookups, never the engine or its collaborators
	'dynamic-member-access @ packages/sync/src/engine/sync-engine.ts @ function awarenessStatesToWire': 2,
	'dynamic-member-access @ packages/sync/src/engine/sync-engine.ts @ function keyServiceReply': 1,
	'dynamic-member-access @ packages/sync/src/engine/sync-engine.ts @ function wireToAwarenessStates': 2,
	'dynamic-member-access @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.applyBatchInOneTransaction': 4,
	'dynamic-member-access @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.applyBatchPerOperation': 3,
	'dynamic-member-access @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.chooseSessionNode': 1,
	'dynamic-member-access @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.emitRewritten': 1,
	'dynamic-member-access @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.handleOperationBatch': 1,
	'dynamic-member-access @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.parkAdoption': 2,
	'dynamic-member-access @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.prepareOperationProbe': 2,
	'dynamic-member-access @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.recordOutOfUplinkScope': 3,
	'dynamic-member-access @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.recordUploadProgress': 1,
	'dynamic-member-access @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.recoverSequenceConflict': 1,
	'dynamic-member-access @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.settleQueuedNode': 2,
	'dynamic-member-access @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.transitionTo': 1,
	// ---- Callers of the full resync: all inside the message chain, or after awaiting it
	'serialized:resetDeliveryForFullResync @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.handleHandshakeResponse': 1,
	'serialized:resetDeliveryForFullResync @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.recoverFromClone': 1,
	'serialized:resetDeliveryForFullResync @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.recoverSequenceConflict': 1,
	'serialized:resetDeliveryForFullResync @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.startInternal': 1,
}

function walk(directory: string, out: string[] = []): string[] {
	for (const name of readdirSync(directory)) {
		const path = join(directory, name)
		if (statSync(path).isDirectory()) {
			if (name !== 'node_modules' && name !== 'dist' && name !== 'benchmarks') walk(path, out)
		} else if (path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.endsWith('.d.ts')) {
			out.push(path)
		}
	}
	return out
}

/** Which findings of a file count: the engine in full, the rest of the sync package by name, other packages by persistence name. */
function counts(file: string, rule: string): boolean {
	if (file === ENGINE) return true
	if (file.startsWith('packages/sync/src')) {
		return /^(persist|alias|position|import|call|state|assign|cache|serialized):/.test(rule)
	}
	return /^(persist|alias|import|call|position|serialized):/.test(rule)
}

function scanFile(file: string, source: string): ReturnType<typeof scanDeliveryPosition> {
	return scanDeliveryPosition(source, file).filter((site) => counts(file, site.rule))
}

const OTHERS = (() => {
	const sites: ReturnType<typeof scanDeliveryPosition> = []
	for (const directory of ['packages/sync/src', 'packages/store/src', 'kora/src']) {
		for (const path of walk(join(ROOT, directory))) {
			const file = relative(ROOT, path)
			// The scan and the position class are checked by their own tests and by the table.
			if (file === ENGINE || file.endsWith('delivery-progress-scan.ts')) continue
			sites.push(...scanFile(file, readFileSync(path, 'utf8')))
		}
	}
	return sites
})()

/** Everything the scan finds, with the engine's text replaced by `engineSource`. */
function repository(engineSource: string): Record<string, number> {
	return tally([...OTHERS, ...scanFile(ENGINE, engineSource)])
}

function sorted(table: Record<string, number>): Record<string, number> {
	return Object.fromEntries(Object.entries(table).sort(([a], [b]) => a.localeCompare(b)))
}

describe('the delivery position has one writer (syntax-tree rule)', () => {
	test('every writer, alias, mutation and caller is accounted for', () => {
		expect(repository(SOURCE)).toEqual(sorted(EXPECTED))
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
			'position.watermark !== context.watermark',
			'deliveryGeneration !== context.generation',
			'rulesKey',
		]) {
			expect(body, field).toContain(field)
		}
	})

	test('the full resync is documented as serialized with batch handling', () => {
		const at = SOURCE.indexOf('private async resetDeliveryForFullResync(')
		expect(SOURCE.slice(Math.max(0, at - 900), at)).toContain(
			'INVARIANT: this is serialized with batch handling',
		)
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

/** The scan of the repository differs from the real one (something was added, moved or removed). */
function detected(engineSource: string): boolean {
	return JSON.stringify(repository(engineSource)) !== JSON.stringify(repository(SOURCE))
}

/** A file other than the engine's, with `source`, is found to hold something unlisted. */
function detectedElsewhere(file: string, source: string): boolean {
	return scanFile(file, source).length > 0
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
		// ---- the thirty-one spellings of the sixth review, and the structural ones
		'computed key built from literals':
			"private evil(): void { (this as any)['delivery' + 'Watermark'] = 1 }",
		'key held in a constant':
			"private evil(): void { const K = 'deliveryWatermark'; (this as any)[K] = 1 }",
		'Reflect through an alias': 'private evil(): void { const R = Reflect; R.set(this, "x", 1) }',
		'Object through globalThis':
			'private evil(): void { globalThis.Object.assign(this, { x: 1 }) }',
		'Object assign by bracket': "private evil(): void { Object['assign'](this, { x: 1 }) }",
		'Object.assign destructured':
			'private evil(): void { const { assign } = Object; assign(this, { x: 1 }) }',
		'a member of syncState by a variable name':
			"private async evil(name: string): Promise<void> { await (this.syncState as any)[name]('', 1) }",
		'a split method name':
			"private evil(): void { (this as any)['setView' + 'Watermark']('x', 1) }",
		'a bound persistence method':
			'private async evil(progress: never): Promise<void> { const f = this.syncState!.saveQuarantine!.bind(this.syncState); await f([], progress) }',
		'an unlisted live-database mutator, unguarded':
			"private async evil(): Promise<void> { await this.store.applyScopeRetraction?.('c', 'r') }",
		'a store mutator reached through a deferral':
			"private async evil(): Promise<void> { await this.store.deferScopeRetraction?.('c', 'r') }",
		'a run rebase':
			'private async evil(): Promise<void> { await this.store.rebaseDeliveryRun?.(1) }',
		'a write of the replica': 'private evil(): void { this.staging = null }',
		'a write of the user': "private evil(): void { this.principal = 'x' }",
		'a bump of the drop counter': 'private evil(): void { this.deliveryGeneration++ }',
		'a write of the offline watermarks':
			'private evil(): void { this.offlineWatermarks = new Map() }',
		'a write of the server frontier': 'private evil(): void { this.serverFrontier = 1 }',
		'the owner API from a new member': 'private evil(): void { this.position.moveTo(3) }',
		'the writer from a new member': 'private evil(): void { this.position.writer.advance(3) }',
		'the writer held in a variable':
			'private evil(): void { const { writer } = this.position; void writer }',
		'the unit key without a check':
			'private async evil(m: never): Promise<void> { await this.ensureOfflineUnit(m) }',
		'a new full-resync caller':
			'private async evil(): Promise<void> { await this.resetDeliveryForFullResync() }',
		'destructuring assignment': 'private evil(): void { [this.deliveryWatermark] = [1] }',
		'object destructuring assignment':
			'private evil(): void { ({ w: this.deliveryWatermark } = { w: 1 }) }',
		'cast receiver':
			'private evil(): void { (this as { deliveryWatermark: number }).deliveryWatermark = 3 }',
		'dynamic member name':
			"private evil(): void { const key = 'deliveryWatermark'; this[key as never] = 1 }",
		'Object.assign': 'private evil(): void { Object.assign(this, { deliveryWatermark: 1 }) }',
		'Object.defineProperty':
			"private evil(): void { Object.defineProperty(this, 'x', { value: 1 }) }",
		'Object.setPrototypeOf': 'private evil(): void { Object.setPrototypeOf(this, null) }',
		'Object.defineProperties':
			'private evil(): void { Object.defineProperties(this, { x: { value: 1 } }) }',
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

describe('the rule sees an escape outside the engine file', () => {
	const elsewhere: Record<string, [string, string]> = {
		'a subclass changing the position': [
			'packages/sync/src/engine/evil.ts',
			"import { SyncEngine } from './sync-engine'\nexport class Evil extends SyncEngine { evil(): void { (this as never as { position: { moveTo(n: number): void } }).position.moveTo(1) } }",
		],
		'a prototype patch of a persistence writer': [
			'packages/sync/src/engine/evil.ts',
			'export function patch(engine: { prototype: Record<string, unknown> }): void { engine.prototype.setViewWatermark = (): void => undefined; void engine.prototype.persistDeliveryWatermark }',
		],
		'an import of the position class': [
			'packages/sync/src/engine/evil.ts',
			"import { DeliveryPosition } from './delivery-position'\nexport const p = new DeliveryPosition()",
		],
		'a helper writing the durable watermark': [
			'packages/sync/src/reactivity/evil.ts',
			"export async function w(s: { saveDeliveryWatermark(sig: string, n: number): Promise<void> }): Promise<void> { await s.saveDeliveryWatermark('', 9) }",
		],
		'a store method forwarding the key': [
			'packages/store/src/store/evil.ts',
			"export async function k(s: { saveAccessRulesKey(k: string): Promise<void> }): Promise<void> { await s.saveAccessRulesKey('x') }",
		],
		'a free persistence function imported into the sync package': [
			'packages/sync/src/engine/evil.ts',
			"import { saveUnappliedOperationsInTx } from '@korajs/store/internal'\nexport const x = saveUnappliedOperationsInTx",
		],
		'a free persistence function called under its own name': [
			'packages/store/src/sync/evil.ts',
			'declare function saveDeliveryWatermark(n: number): Promise<void>\nexport async function w(): Promise<void> { await saveDeliveryWatermark(1) }',
		],
		'a free persistence function imported with an alias': [
			'kora/src/evil.ts',
			"import { saveDeliveryWatermark as save } from '@korajs/store/internal'\nexport const x = save",
		],
		'a free persistence function stored in a variable': [
			'packages/store/src/sync/evil.ts',
			'declare function saveDeliveryWatermark(n: number): Promise<void>\nexport const f = saveDeliveryWatermark',
		],
		'a free persistence function returned': [
			'packages/store/src/sync/evil.ts',
			'declare function persistDeliveryWatermark(n: number): Promise<void>\nexport function g() { return persistDeliveryWatermark }',
		],
		'a free persistence function passed as an argument': [
			'packages/sync/src/engine/evil.ts',
			'declare function sendDeliveryAck(n: number): void\nexport const h = [1].map(sendDeliveryAck)',
		],
		'a kora adapter calling the position writer': [
			'kora/src/evil.ts',
			'export function a(w: { writer: { advance(n: number): void } }): void { w.writer.advance(1) }',
		],
	}
	for (const [name, [file, source]] of Object.entries(elsewhere)) {
		test(name, () => {
			expect(detectedElsewhere(file, source)).toBe(true)
		})
	}
})
