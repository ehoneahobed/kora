/**
 * Which reverse proxies in front of the server are trusted to report the client
 * address in `X-Forwarded-For`.
 *
 * - `number`: trust that many hops, counting the socket peer as the first. `1` means
 *   "one proxy (for example a load balancer) sits directly in front of the server".
 * - `string[]`: trust peers whose address is in one of these IPs or CIDR ranges
 *   (IPv4 and IPv6, for example `['10.0.0.0/8', '::1']`).
 *
 * When unset, `X-Forwarded-For` is ignored and the socket address is the client
 * address, so a directly connected client cannot choose its own address.
 */
export type TrustProxySetting = number | string[]

/**
 * Resolve the client address of a request.
 *
 * The address chain is the socket peer followed by the `X-Forwarded-For` entries
 * from right (nearest proxy) to left. Starting at the socket peer, the walk moves
 * one hop further only while the current hop is trusted; the first untrusted hop
 * (or the last entry) is the client. Entries a client could forge are therefore
 * only believed when every hop between them and the server is a trusted proxy.
 *
 * @param socketAddress - The TCP peer address (`req.socket.remoteAddress`)
 * @param forwardedFor - The raw `X-Forwarded-For` header value(s), if any
 * @param trustProxy - Trusted proxy configuration; undefined trusts none
 * @returns The resolved client address, or undefined when the socket has none
 */
export function resolveClientIp(
	socketAddress: string | undefined,
	forwardedFor: string | string[] | undefined,
	trustProxy: TrustProxySetting | undefined,
): string | undefined {
	if (trustProxy === undefined || socketAddress === undefined) return socketAddress
	const forwarded = (Array.isArray(forwardedFor) ? forwardedFor.join(',') : (forwardedFor ?? ''))
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
	const chain = [socketAddress, ...forwarded.reverse()]
	const isTrusted = compileTrust(trustProxy)
	let index = 0
	while (index < chain.length - 1 && isTrusted(chain[index] ?? '', index)) {
		index += 1
	}
	return chain[index]
}

function compileTrust(setting: TrustProxySetting): (address: string, hop: number) => boolean {
	if (typeof setting === 'number') {
		const hops = Number.isInteger(setting) && setting > 0 ? setting : 0
		return (_address, hop) => hop < hops
	}
	const ranges = setting.map(parseRange).filter((range): range is IpRange => range !== null)
	return (address) => {
		const parsed = parseIp(address)
		if (!parsed) return false
		return ranges.some(
			(range) =>
				range.version === parsed.version &&
				parsed.value >> BigInt(range.bits - range.prefix) ===
					range.value >> BigInt(range.bits - range.prefix),
		)
	}
}

interface ParsedIp {
	version: 4 | 6
	value: bigint
}

interface IpRange extends ParsedIp {
	bits: number
	prefix: number
}

function parseRange(spec: string): IpRange | null {
	const [addressPart, prefixPart] = spec.trim().split('/')
	const parsed = parseIp(addressPart ?? '')
	if (!parsed) return null
	const bits = parsed.version === 4 ? 32 : 128
	const prefix = prefixPart === undefined ? bits : Number(prefixPart)
	if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) return null
	return { ...parsed, bits, prefix }
}

function parseIp(input: string): ParsedIp | null {
	const address = input.trim()
	// IPv4-mapped IPv6 (how Node reports IPv4 peers on dual-stack sockets).
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
	if (mapped?.[1]) return parseIpv4(mapped[1])
	if (address.includes(':')) return parseIpv6(address)
	return parseIpv4(address)
}

function parseIpv4(address: string): ParsedIp | null {
	const parts = address.split('.')
	if (parts.length !== 4) return null
	let value = 0n
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null
		const octet = Number(part)
		if (octet > 255) return null
		value = (value << 8n) | BigInt(octet)
	}
	return { version: 4, value }
}

function parseIpv6(address: string): ParsedIp | null {
	const zoneless = address.split('%')[0] ?? ''
	const halves = zoneless.split('::')
	if (halves.length > 2) return null
	const head = halves[0] ? halves[0].split(':') : []
	const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
	const missing = 8 - head.length - tail.length
	if ((halves.length === 1 && missing !== 0) || missing < 0) return null
	const groups = [...head, ...Array.from({ length: missing }, () => '0'), ...tail]
	let value = 0n
	for (const group of groups) {
		if (!/^[0-9a-f]{1,4}$/i.test(group)) return null
		value = (value << 16n) | BigInt(Number.parseInt(group, 16))
	}
	return { version: 6, value }
}
