import { type ReactElement, type ReactNode, useEffect, useMemo } from 'react'
import { type OrgSession, createOrgSession } from '../bindings/create-org-session'
import type { OrgClient } from '../client/org-client'
import { OrgContext, type OrgContextValue } from './org-hooks'

export interface OrgProviderProps {
	client: OrgClient
	children?: ReactNode
}

interface SessionEntry {
	session: OrgSession
	refs: number
	destroyTimer: ReturnType<typeof setTimeout> | null
}

/** One org session per client, shared by the providers mounted for it. */
const sessionEntries = new WeakMap<OrgClient, SessionEntry>()

function getSessionEntry(client: OrgClient): SessionEntry {
	let entry = sessionEntries.get(client)
	if (!entry) {
		entry = { session: createOrgSession(client), refs: 0, destroyTimer: null }
		sessionEntries.set(client, entry)
	}
	return entry
}

function retainSession(entry: SessionEntry): () => void {
	if (entry.destroyTimer) {
		clearTimeout(entry.destroyTimer)
		entry.destroyTimer = null
	}
	entry.refs++

	return () => {
		entry.refs = Math.max(0, entry.refs - 1)
		if (entry.refs > 0 || entry.destroyTimer) return

		// React StrictMode runs effect cleanup and setup back-to-back on mount. Deferring the
		// disposal lets the second setup retain the same session, while a real unmount still
		// releases the client's listener shortly after.
		entry.destroyTimer = setTimeout(() => {
			entry.destroyTimer = null
			if (entry.refs > 0) return
			entry.session.destroy()
			if (sessionEntries.get(entry.session.client) === entry) {
				sessionEntries.delete(entry.session.client)
			}
		}, 0)
	}
}

/**
 * Provides organization context for {@link useOrg}, {@link useOrgMembers}, and {@link usePermission}.
 */
export function OrgProvider({ client, children }: OrgProviderProps): ReactElement {
	const entry = useMemo(() => getSessionEntry(client), [client])

	useEffect(() => retainSession(entry), [entry])

	const session = entry.session
	const value = useMemo<OrgContextValue>(() => ({ client, session }), [client, session])

	return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>
}

export type { OrgContextValue }
