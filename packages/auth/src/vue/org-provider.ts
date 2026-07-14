import type { InjectionKey } from 'vue'
import type { PropType } from 'vue'
import { defineComponent, inject, onScopeDispose, provide } from 'vue'
import { type OrgSession, createOrgSession } from '../bindings/create-org-session'
import type { OrgClient } from '../client/org-client'

export interface OrgContextValue {
	client: OrgClient
	session: OrgSession
}

export const orgContextKey: InjectionKey<OrgContextValue> = Symbol('korajs-org-context')

export const OrgProvider = defineComponent({
	name: 'OrgProvider',
	props: {
		client: {
			type: Object as PropType<OrgClient>,
			required: true,
		},
	},
	setup(props, { slots }) {
		const session = createOrgSession(props.client)

		onScopeDispose(() => {
			session.destroy()
		})

		const contextValue: OrgContextValue = {
			client: props.client,
			session,
		}

		provide(orgContextKey, contextValue)

		return () => slots.default?.()
	},
})

export function useOrgContext(): OrgContextValue {
	const context = inject(orgContextKey)
	if (!context) {
		throw new Error(
			'useOrg / useOrgMembers / usePermission must be used within an <OrgProvider>. ' +
				'Wrap your component tree with <OrgProvider :client="orgClient">.',
		)
	}
	return context
}
