import { KoraError } from '../errors/errors'

/**
 * A fold state cannot be used: unknown format version, malformed JSON, a state
 * for a different record, or a field whose stored kind no longer matches the
 * schema. The fix is always the same: re-fold the record from its operation log
 * (`foldRecord`), which is the source of truth.
 */
export class FoldStateError extends KoraError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, 'FOLD_STATE_INVALID', {
			fix: 'Rebuild the record state from its operation log with foldRecord(ops, schema).',
			...context,
		})
		this.name = 'FoldStateError'
	}
}

/**
 * The fold was asked for something its configuration cannot provide, for example
 * materializing a richtext field with several concurrent Yjs updates without a
 * richtext merger.
 */
export class FoldConfigurationError extends KoraError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, 'FOLD_CONFIGURATION', context)
		this.name = 'FoldConfigurationError'
	}
}
