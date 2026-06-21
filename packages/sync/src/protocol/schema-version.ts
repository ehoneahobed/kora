/** Prefix for handshake rejection when client schema version is unsupported. */
export const SCHEMA_MISMATCH_PREFIX = 'SCHEMA_MISMATCH'

/**
 * Returns true when a handshake `rejectReason` indicates unsupported schema version.
 */
export function isSchemaMismatchReject(rejectReason: string | undefined): boolean {
	return rejectReason?.startsWith(SCHEMA_MISMATCH_PREFIX) === true
}

/**
 * Returns true when the client schema version is within the inclusive supported range.
 */
export function isClientSchemaVersionSupported(
	clientVersion: number,
	supported: { min: number; max: number },
): boolean {
	return clientVersion >= supported.min && clientVersion <= supported.max
}
