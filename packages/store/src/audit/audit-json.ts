const WIRE_BYTES_KEY = '__kora_bytes__'

/**
 * JSON.stringify replacer that preserves binary field values (e.g. richtext).
 */
export function auditJsonReplacer(_key: string, value: unknown): unknown {
	if (value instanceof Uint8Array) {
		let binary = ''
		for (let i = 0; i < value.length; i++) {
			binary += String.fromCharCode(value[i] as number)
		}
		return { [WIRE_BYTES_KEY]: btoa(binary) }
	}
	return value
}

/**
 * JSON.parse reviver that restores binary field values.
 */
export function auditJsonReviver(_key: string, value: unknown): unknown {
	if (
		value !== null &&
		typeof value === 'object' &&
		WIRE_BYTES_KEY in value &&
		typeof (value as Record<string, unknown>)[WIRE_BYTES_KEY] === 'string'
	) {
		const encoded = (value as Record<string, unknown>)[WIRE_BYTES_KEY]
		if (typeof encoded !== 'string') {
			return value
		}
		const binary = atob(encoded)
		const bytes = new Uint8Array(binary.length)
		for (let i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i)
		}
		return bytes
	}
	return value
}

/**
 * Serialize a value for durable audit storage or export.
 */
export function serializeAuditJson(value: unknown): string {
	return JSON.stringify(value, auditJsonReplacer)
}

/**
 * Deserialize audit JSON back to typed values.
 */
export function deserializeAuditJson<T>(json: string): T {
	return JSON.parse(json, auditJsonReviver) as T
}
