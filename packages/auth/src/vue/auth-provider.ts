import type { PropType, VNode } from 'vue'
import { defineComponent, h, inject, onScopeDispose, provide, shallowRef } from 'vue'
import type { AuthClient } from '../client/auth-client'
import { createAuthSession, type AuthSessionSnapshot } from '../bindings/create-auth-session'
import { authContextKey, type AuthContextValue } from './auth-context'

export const AuthProvider = defineComponent({
	name: 'AuthProvider',
	props: {
		client: {
			type: Object as PropType<AuthClient>,
			required: true,
		},
		fallback: {
			type: [Object, String] as PropType<VNode | string | null>,
			default: null,
		},
	},
	setup(props, { slots }) {
		const session = createAuthSession(props.client)
		const snapshot = shallowRef<AuthSessionSnapshot>(session.getSnapshot())

		const unsubscribe = session.subscribe(() => {
			snapshot.value = session.getSnapshot()
		})

		onScopeDispose(() => {
			unsubscribe()
			session.destroy()
		})

		const contextValue: AuthContextValue = {
			client: props.client,
			get state() {
				return snapshot.value.state
			},
			get isLoading() {
				return snapshot.value.isLoading
			},
			session,
		}

		provide(authContextKey, contextValue)

		return () => {
			const current = snapshot.value

			if (current.initError) {
				return h(
					'div',
					{
						style: { color: 'red', padding: '1rem', fontFamily: 'monospace' },
						role: 'alert',
					},
					[h('strong', null, 'Kora Auth initialization error: '), current.initError.message],
				)
			}

			if (current.isLoading && props.fallback !== null) {
				return props.fallback
			}

			return slots.default?.()
		}
	},
})

export function useAuthContext(): AuthContextValue {
	const context = inject<AuthContextValue | undefined>(authContextKey)
	if (!context) {
		throw new Error(
			'useAuth must be used within <AuthProvider>. Wrap your app with <AuthProvider client={authClient}>.',
		)
	}
	return context
}
