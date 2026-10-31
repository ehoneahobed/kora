import { CONFIG_VALIDATOR_SLOT, type ConfigValidatorSlot } from './config-validator-slot'
import { validateCreateAppConfig } from './validate-config'

/**
 * Makes `createApp` validate its configuration synchronously (the development behavior: the
 * error is thrown at the call, with the stack of the mistake). Called from the package entry
 * only when `process.env.NODE_ENV !== 'production'`, so a production first-paint bundle carries
 * none of the validation code.
 */
export function registerConfigValidator(): void {
	;(globalThis as ConfigValidatorSlot)[CONFIG_VALIDATOR_SLOT] = validateCreateAppConfig
}
