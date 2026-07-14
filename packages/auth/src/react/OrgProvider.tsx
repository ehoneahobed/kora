import { type ReactNode, useEffect, useMemo, useRef } from 'react'
import { type OrgSession, createOrgSession } from '../bindings/create-org-session'
import type { OrgClient } from '../client/org-client'
import { OrgContext, type OrgContextValue } from './org-hooks'

export interface OrgProviderProps {
	client: OrgClient
	children?: ReactNode
}

/**
 * Provides organization context for {@link useOrg}, {@link useOrgMembers}, and {@link usePermission}.
 */
export function OrgProvider({ client, children }: OrgProviderProps) {
	const sessionRef = useRef<OrgSession | null>(null)

	if (sessionRef.current === null || sessionRef.current.client !== client) {
		sessionRef.current?.destroy()
		sessionRef.current = createOrgSession(client)
	}

	useEffect(() => {
		return () => {
			sessionRef.current?.destroy()
			sessionRef.current = null
		}
	}, [])

	const session = sessionRef.current
	const value = useMemo<OrgContextValue>(
		() => ({
			client,
			session,
		}),
		[client, session],
	)

	return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>
}

export type { OrgContextValue }
