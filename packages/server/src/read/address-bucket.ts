/**
 * The key a client address is limited under (failed sign-ins, read bodies in flight): the address, with an IPv6 address reduced to
 * its /64 (one subscriber holds the whole range, so rotating the low bits must not mint a
 * fresh bucket) and an IPv4-mapped IPv6 address, in any spelling, to its IPv4 form.
 *
 * @param clientKey - The client address as the HTTP host resolved it
 * @returns The bucket key, or null when there is no address
 */
export function addressBucket(clientKey: string | undefined): string | null {
	if (clientKey === undefined || clientKey === '') return null
	let address = clientKey.split('%')[0]?.toLowerCase() ?? ''
	if (!address.includes(':')) return address
	// A dotted tail (::ffff:1.2.3.4) is two hex groups; write it so every form is parsed alike.
	const dotted = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address)
	if (dotted?.[1] !== undefined) {
		const octets = [dotted[2], dotted[3], dotted[4], dotted[5]].map((o) => Number(o))
		if (octets.some((o) => !Number.isInteger(o) || o > 255)) return address
		const [a, b, c, d] = octets as [number, number, number, number]
		address = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
	}
	const [head = '', tail = ''] = address.split('::')
	const headGroups = head === '' ? [] : head.split(':')
	const tailGroups = address.includes('::') ? (tail === '' ? [] : tail.split(':')) : []
	const groups = address.includes('::')
		? [
				...headGroups,
				...Array<string>(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill('0'),
				...tailGroups,
			]
		: headGroups
	if (groups.length === 8) {
		const words = groups.map((g) => Number.parseInt(g, 16))
		if (words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff) {
			const hi = words[6] ?? 0
			const lo = words[7] ?? 0
			return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
		}
	}
	return `${groups
		.slice(0, 4)
		.map((g) => g.padStart(4, '0'))
		.join(':')}::/64`
}
