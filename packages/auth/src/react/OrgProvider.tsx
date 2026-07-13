import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import type { OrgClient } from '../client/org-client'
import { createOrgSession, type OrgSession } from '../bindings/create-org-session'
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

	const value = useMemo<OrgContextValue>(
		() => ({
			client,
			session: sessionRef.current!,
		}),
		[client],
	)

	return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>
}

export type { OrgContextValue }
