import type { KoraEvent, KoraEventEmitter } from '@korajs/core'
import type { Store } from '@korajs/store'
import { persistedAuditTraceFromEvent } from '@korajs/store'

const AUDIT_EVENT_TYPES = ['merge:completed', 'merge:conflict', 'constraint:violated'] as const

type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number]

function isAuditEvent(event: KoraEvent): event is Extract<KoraEvent, { type: AuditEventType }> {
	return (AUDIT_EVENT_TYPES as readonly string[]).includes(event.type)
}

/**
 * Persist merge and constraint traces from the event bus to `_kora_audit_traces`.
 */
export function wireAuditPersistence(store: Store, emitter: KoraEventEmitter): () => void {
	const unsubscribers = AUDIT_EVENT_TYPES.map((eventType) =>
		emitter.on(eventType, (event) => {
			if (!isAuditEvent(event)) {
				return
			}
			const trace = persistedAuditTraceFromEvent(event)
			void store.appendAuditTrace(trace).catch(() => {
				// Audit persistence must not break mutations or sync.
			})
		}),
	)

	return () => {
		for (const unsub of unsubscribers) {
			unsub()
		}
	}
}
