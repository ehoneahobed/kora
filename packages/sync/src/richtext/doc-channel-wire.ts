const WIRE_BYTES_KEY = '__kora_bytes__'

/**
 * Encode a Yjs update for the doc channel wire (base64).
 */
export function encodeYjsUpdate(update: Uint8Array): string {
	let binary = ''
	for (let i = 0; i < update.length; i++) {
		binary += String.fromCharCode(update[i] as number)
	}
	return btoa(binary)
}

/**
 * Decode a base64 Yjs update from the doc channel wire.
 */
export function decodeYjsUpdate(encoded: string): Uint8Array {
	const binary = atob(encoded)
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i)
	}
	return bytes
}

/**
 * Build a stable key for a richtext field document.
 */
export function richtextDocKey(collection: string, recordId: string, field: string): string {
	return `${collection}:${recordId}:${field}`
}

export { WIRE_BYTES_KEY }
