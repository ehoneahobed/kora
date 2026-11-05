/**
 * Where development builds register the `createApp` configuration validator. The key is global
 * so the registering entry and `createApp` agree even when a bundler duplicates a module.
 * Production builds register nothing: the runtime validates the same configuration when it
 * loads and a bad option rejects `app.ready` (see `createRuntimeApp`).
 */
export const CONFIG_VALIDATOR_SLOT = Symbol.for('korajs:config-validator')

/** The slot as stored on the global object. */
export interface ConfigValidatorSlot {
	[CONFIG_VALIDATOR_SLOT]?: (config: never) => void
}
