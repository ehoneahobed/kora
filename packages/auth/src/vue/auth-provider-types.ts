/** Props for {@link AuthProvider}. */
export interface AuthProviderProps {
	client: import('../client/auth-client').AuthClient
	fallback?: import('vue').VNode | string | null
}
