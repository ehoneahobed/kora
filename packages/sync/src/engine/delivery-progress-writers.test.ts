import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

/**
 * Four review rounds found the same bug four times: a write of the delivery position (the
 * watermark, the per-view cache, the access-rules key, the acknowledgment) after an await,
 * with no re-check that the position the batch was received at still exists. The structural
 * fix is that exactly one method, `commitDeliveryProgress`, writes any of them for a batch,
 * and it re-validates the batch's context synchronously before it writes. This test keeps it
 * that way: it reads the engine source and fails when any other method writes the position.
 * Adding a method to an allowlist is a design decision, made here, in review.
 */
const SOURCE = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), 'sync-engine.ts'),
	'utf8',
).split('\n')

const METHOD = /^\t(?:private |public |protected |static )?(?:async )?([A-Za-z_]\w*)\(/
const NOT_METHODS = new Set(['if', 'for', 'while', 'switch', 'return', 'catch', 'function'])

/** Every line matching `pattern`, with the class method that contains it. */
function writers(pattern: RegExp): Array<{ method: string; line: number; text: string }> {
	const found: Array<{ method: string; line: number; text: string }> = []
	let current = '<top level>'
	for (const [index, text] of SOURCE.entries()) {
		const declared = METHOD.exec(text)
		if (declared?.[1] && !NOT_METHODS.has(declared[1])) current = declared[1]
		if (/^(?:class|interface|type|function|const|export) /.test(text)) current = '<top level>'
		if (pattern.test(text) && !text.trim().startsWith('*') && !text.trim().startsWith('//')) {
			found.push({ method: current, line: index + 1, text: text.trim() })
		}
	}
	return found
}

function methodsWriting(pattern: RegExp): string[] {
	return [...new Set(writers(pattern).map((entry) => entry.method))].sort()
}

describe('the delivery position has one writer', () => {
	test('the in-memory watermark is assigned only by the position owners', () => {
		expect(methodsWriting(/this\.deliveryWatermark\s*=[^=]/)).toEqual(
			[
				// start: loaded from the durable cache
				'startInternal',
				// the view changed: the position of the new view, not a batch's
				'switchDeliveryView',
				'switchDeliveryViewWithInheritance',
				'resetDeliveryForFullResync',
				'handleHandshakeResponse',
				// the replica was dropped or unmergeable: back on the durable watermark
				'dropStaging',
				'restoreLivePosition',
				// the batch paths
				'commitDeliveryProgress',
			].sort(),
		)
	})

	test('the per-view watermark cache is written only by the position owners', () => {
		expect(methodsWriting(/setViewWatermark\(/)).toEqual(
			[
				'setViewWatermark',
				'switchDeliveryView',
				'switchDeliveryViewWithInheritance',
				'resetDeliveryForFullResync',
				'handleHandshakeResponse',
				'commitDeliveryProgress',
			].sort(),
		)
	})

	test('the access-rules key is saved and assigned only by start and the single writer', () => {
		expect(methodsWriting(/saveAccessRulesKey/)).toEqual(['commitDeliveryProgress'])
		expect(methodsWriting(/this\.accessRulesKey\s*=[^=]/)).toEqual(
			['startInternal', 'commitDeliveryProgress'].sort(),
		)
	})

	test('a delivery batch is acknowledged only by the single writer', () => {
		expect(methodsWriting(/this\.sendDeliveryAck\(/)).toEqual(['commitDeliveryProgress'])
		// The only other acknowledgment on the wire confirms the node token of the handshake.
		expect(methodsWriting(/type: 'acknowledgment'/)).toEqual(
			['commitDeliveryProgress', 'handleHandshakeResponse', 'sendDeliveryAck'].sort(),
		)
	})

	test('the durable watermark of a batch is written only by the single writer', () => {
		const direct = writers(/\.saveDeliveryWatermark\(|persistDeliveryWatermark\(/)
		const methods = [...new Set(direct.map((entry) => entry.method))].sort()
		expect(methods).toEqual(
			[
				'commitDeliveryProgress',
				// view switches and the full resync write a position that is not a batch's
				'switchDeliveryView',
				'switchDeliveryViewWithInheritance',
				'resetDeliveryForFullResync',
				'handleHandshakeResponse',
				'persistDeliveryWatermark',
			].sort(),
		)
	})

	test('quarantine rows carrying a position are written only by the single writer', () => {
		expect(methodsWriting(/saveQuarantine\(\w[\w.]*,\s*\{|syncState\.saveQuarantine\(/)).toEqual([
			'commitDeliveryProgress',
		])
	})

	test('the writer exists and validates the context before any write', () => {
		const text = SOURCE.join('\n')
		const start = text.indexOf('private async commitDeliveryProgress(')
		expect(start).toBeGreaterThan(0)
		const body = text.slice(start, text.indexOf('\n\t}\n', start))
		expect(body).toContain('deliveryContextChanged')
	})

	test('deliveryContextChanged compares every field of the context', () => {
		const text = SOURCE.join('\n')
		const start = text.indexOf('private deliveryContextChanged(')
		const body = text.slice(start, text.indexOf('\n\t}\n', start))
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
