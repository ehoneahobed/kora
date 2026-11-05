/** The longest keyring name a record or a config may carry. */
export const MAX_KEYRING_NAME_LENGTH = 128

/** Whether a keyring name is acceptable. */
export function isValidKeyringName(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= MAX_KEYRING_NAME_LENGTH &&
		/^[A-Za-z0-9._:-]+$/.test(value)
	)
}
