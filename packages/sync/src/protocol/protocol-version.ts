/**
 * Sync protocol version this build speaks (decision D2: one bump carrying all wire
 * breaks). Version 2 adds:
 * - operation ids hashed with content-hash version 2 (CORE-1), with `hashVersion`
 *   carried on the wire and verified on receive;
 * - the end-to-end encryption envelope v2 (`op.encrypted`, AES-GCM AAD, ENC-3 and
 *   NEW-ENC-1);
 * - the sequence-reservation capability on every handshake (RT-37);
 * - `authoritativeNodeIds` and server-authored `foldState` (W7).
 *
 * A handshake without `protocolVersion` is version 1 (Kora <= beta.12), which servers
 * refuse with {@link PROTOCOL_VERSION_UNSUPPORTED}. Operations such clients wrote long ago
 * keep their version-1 ids and stay valid.
 */
export const SYNC_PROTOCOL_VERSION = 2

/** Protocol version assumed when a handshake or response does not declare one. */
export const LEGACY_SYNC_PROTOCOL_VERSION = 1

/** Non-retriable handshake refusal for a client below the server's sync protocol. */
export const PROTOCOL_VERSION_UNSUPPORTED = 'PROTOCOL_VERSION_UNSUPPORTED'

/** Non-retriable rejection code for an operation whose id is not its content hash. */
export const INVALID_OPERATION_ID = 'INVALID_OPERATION_ID'

/**
 * Non-retriable rejection code for a plaintext operation uploaded to a server that
 * requires the encryption envelope.
 */
export const PLAINTEXT_REJECTED = 'PLAINTEXT_REJECTED'

/**
 * The protocol version a handshake (or handshake response) declares.
 *
 * @param declared - The message's `protocolVersion`
 * @returns The declared version, or 1 when absent or malformed
 */
export function declaredProtocolVersion(declared: unknown): number {
	return typeof declared === 'number' && Number.isInteger(declared) && declared >= 1
		? declared
		: LEGACY_SYNC_PROTOCOL_VERSION
}
