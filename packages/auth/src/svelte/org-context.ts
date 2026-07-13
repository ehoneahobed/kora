import { getContext, setContext } from 'svelte'
import type { OrgClient } from '../client/org-client'
import { createOrgSession, type OrgSession } from '../bindings/create-org-session'

const orgContextKey = Symbol('korajs-org-context')

export interface OrgContextValue {
	client: OrgClient
	session: OrgSession
}

export function initOrgProvider(client: OrgClient): OrgContextValue {
	const session = createOrgSession(client)
	const value: OrgContextValue = { client, session }
	setContext(orgContextKey, value)
	return value
}

export function getOrgContext(): OrgContextValue {
	const context = getContext<OrgContextValue | undefined>(orgContextKey)
	if (!context) {
		throw new Error(
			'Org context missing. Wrap your app with <OrgProvider client={orgClient}> from @korajs/auth/svelte.',
		)
	}
	return context
}

export function destroyOrgProvider(context: OrgContextValue): void {
	context.session.destroy()
}
