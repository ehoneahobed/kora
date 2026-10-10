/**
 * Regression tests from the independent review of access step 5 (re-scope units):
 * expiry, re-grant, own group creation, history retractions, lost batches, boolean
 * where branches, deletes, and a poll refresh racing a unit. Shared fixtures in
 * shared.ts. Each runs on the memory store, or on Postgres with KORA_REPRO_STORE=postgres.
 */
import { defineSchema, member, memberOfKey, owner, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { TokenAuthProvider } from '../../../src/auth/token-auth'

export const schema = defineSchema({
	version: 1,
	access: {
		memberships: 'members',
		roles: ['view', 'edit', 'manage'],
		groups: { documents: { owner: 'ownerId', role: 'manage' } },
	},
	collections: {
		members: {
			fields: {
				userId: t.string(),
				group: t.string(),
				role: t.string(),
				expiresAt: t.timestamp().optional(),
			},
			access: { read: memberOfKey('group', 'manage') },
		},
		documents: {
			fields: { title: t.string(), ownerId: t.string().stamp('userId') },
			access: {
				read: member('id'),
				create: owner('ownerId'),
				update: member('id', 'edit'),
				delete: member('id', 'manage'),
			},
		},
		comments: {
			fields: { documentId: t.string(), body: t.string(), authorId: t.string().stamp('userId') },
			access: {
				read: member('documentId', 'view', { group: 'documents' }),
				create: member('documentId', 'view', { group: 'documents' }),
				update: member('documentId', 'edit', { group: 'documents' }),
				delete: member('documentId', 'edit', { group: 'documents' }),
			},
		},
	},
})

export const auth = new TokenAuthProvider({
	validate: async (token) => (['ann', 'bob'].includes(token) ? { userId: token } : null),
})

export const FRESH = {
	supportsScopeDisjunction: true,
	lastDeliverySequence: 0,
} as Partial<SyncMessage>

type Item = { kind: 'op' | 'retract'; key: string; nodeId?: string; data?: unknown; id?: string }
/** Every delivered item, in order (retractions of a batch first, as the client applies them). */
export function items(messages: SyncMessage[]): Item[] {
	const out: Item[] = []
	for (const m of messages) {
		if (m.type !== 'operation-batch') continue
		for (const r of (m as { retractions?: Array<{ collection: string; recordId: string }> })
			.retractions ?? [])
			out.push({ kind: 'retract', key: `${r.collection}/${r.recordId}` })
		for (const op of m.operations as Array<{
			id: string
			collection: string
			recordId: string
			nodeId: string
			data: unknown
		}>)
			out.push({
				kind: 'op',
				key: `${op.collection}/${op.recordId}`,
				nodeId: op.nodeId,
				data: op.data,
				id: op.id,
			})
	}
	return out
}
export function watermarkOf(messages: SyncMessage[]): number {
	let max = 0
	for (const m of messages) {
		const v = (m as { maxDeliverySequence?: number }).maxDeliverySequence
		if (m.type === 'operation-batch' && typeof v === 'number') max = Math.max(max, v)
	}
	return max
}

/** Make a harness client behave like a real one: apply chained batches and ack them. */
export function autoAck(
	c: {
		client: { onMessage: (h: (m: SyncMessage) => void) => void; send: (m: SyncMessage) => void }
		messages: SyncMessage[]
	},
	start = 0,
) {
	const state = { watermark: start, gaps: 0 }
	c.client.onMessage((m) => {
		c.messages.push(m)
		if (m.type !== 'operation-batch') return
		const b = m as {
			baseDeliverySequence?: number
			maxDeliverySequence?: number
			messageId: string
		}
		if (typeof b.maxDeliverySequence !== 'number' || typeof b.baseDeliverySequence !== 'number')
			return
		if (b.baseDeliverySequence > state.watermark) {
			state.gaps++
		} else state.watermark = Math.max(state.watermark, b.maxDeliverySequence)
		queueMicrotask(() => {
			try {
				c.client.send({
					type: 'acknowledgment',
					messageId: `ack-${Math.random()}`,
					acknowledgedMessageId: b.messageId,
					lastSequenceNumber: 0,
					deliverySequence: state.watermark,
				} as SyncMessage)
			} catch {}
		})
	})
	return state
}
