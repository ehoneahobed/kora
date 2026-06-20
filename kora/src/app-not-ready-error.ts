import { KoraError } from '@korajs/core'

/**
 * Thrown when collection/query APIs are used before {@link KoraApp.ready} resolves.
 */
export class AppNotReadyError extends KoraError {
	constructor(detail: string) {
		super(detail, 'APP_NOT_READY', {
			fix: 'Await app.ready, or wrap your UI in <KoraProvider app={app}> before calling useQuery().',
		})
		this.name = 'AppNotReadyError'
	}
}
