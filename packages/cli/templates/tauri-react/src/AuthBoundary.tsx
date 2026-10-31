import { Component, type ReactNode } from 'react'
import { failAuth } from './auth-state'

/**
 * Keeps a failed load of the sign-in client from taking the app down: a rejected lazy import
 * would otherwise unmount the whole tree. Renders nothing, reports once, tells the screen.
 */
export class AuthBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
	override state = { failed: false }

	static getDerivedStateFromError(): { failed: boolean } {
		return { failed: true }
	}

	override componentDidCatch(error: unknown): void {
		console.error(
			'[Kora Auth] The sign-in client did not load; the app keeps working offline:',
			error,
		)
		failAuth()
	}

	override render(): ReactNode {
		return this.state.failed ? null : this.props.children
	}
}

/**
 * Loads a lazy chunk, trying again after a short wait when the request failed (a dropped
 * connection, a deploy in progress). A chunk that is still missing after the last try rejects, and
 * the boundary above reports it.
 */
export async function retryImport<T>(load: () => Promise<T>, tries = 3): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await load()
		} catch (error) {
			if (attempt >= tries) throw error
			await new Promise((resolve) => setTimeout(resolve, attempt * 500))
		}
	}
}
