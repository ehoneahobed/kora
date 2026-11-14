import { KoraError } from '@korajs/core/lite'

/**
 * A local write while the app is read-only (`Store.setReadOnly`), for example while an
 * admin previews the app as another person. Reads and incoming sync are unaffected.
 */
export class StoreReadOnlyError extends KoraError {
	constructor(public readonly reason: string) {
		super(
			`This app is read-only right now (${reason}), so the change was not saved. Leave read-only mode to make changes.`,
			'STORE_READ_ONLY',
			{ reason },
		)
		this.name = 'StoreReadOnlyError'
	}
}
