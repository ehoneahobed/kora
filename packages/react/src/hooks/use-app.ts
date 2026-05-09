import { useKoraContext } from '../context/kora-context'
import type { KoraAppLike } from '../types'

/**
 * React hook that returns the Kora app instance from context.
 *
 * Use the generic parameter to cast to your typed app for full type inference:
 *
 * ```typescript
 * // In your app setup:
 * export const app = createApp({ schema: mySchema })
 * export type App = typeof app
 *
 * // In components:
 * const app = useApp<App>()
 * app.todos.insert({ title: 'Hello' })  // fully typed
 * const todos = useQuery(app.todos.where({ completed: false }))
 * ```
 *
 * Requires `KoraProvider` to be initialized with the `app` prop.
 * Throws if used outside of `KoraProvider` or without an `app` prop.
 *
 * @returns The KoraApp instance, typed as `T`
 */
export function useApp<T extends KoraAppLike = KoraAppLike>(): T {
	const { app } = useKoraContext()
	if (!app) {
		throw new Error(
			'useApp() requires KoraProvider to be initialized with an "app" prop. ' +
				'Pass your createApp() result to <KoraProvider app={app}>.',
		)
	}
	return app as T
}
