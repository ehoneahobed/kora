import { DataTransferError } from '../../errors'

const BLOCK = 512

/** One entry of a tar being read. Read `body` to the end (or not at all) before the next one. */
export interface TarEntry {
	name: string
	kind: 'file' | 'directory' | 'other'
	size: number
	body: AsyncIterable<Uint8Array>
}

/** Reads exact byte counts from a stream of chunks of any size. */
class ByteReader {
	private buffer: Uint8Array = new Uint8Array(0)
	private done = false

	constructor(private readonly source: AsyncIterator<Uint8Array>) {}

	private async fill(): Promise<boolean> {
		if (this.done) return false
		const next = await this.source.next()
		if (next.done) {
			this.done = true
			return false
		}
		this.buffer =
			this.buffer.byteLength === 0 ? next.value : Buffer.concat([this.buffer, next.value])
		return true
	}

	async exact(count: number): Promise<Uint8Array | null> {
		while (this.buffer.byteLength < count) if (!(await this.fill())) return null
		const out = this.buffer.subarray(0, count)
		this.buffer = this.buffer.subarray(count)
		return out
	}

	async take(max: number): Promise<Uint8Array> {
		if (this.buffer.byteLength === 0 && !(await this.fill())) {
			throw new DataTransferError('The bundle ends in the middle of a file: it is incomplete.')
		}
		const out = this.buffer.subarray(0, Math.min(max, this.buffer.byteLength))
		this.buffer = this.buffer.subarray(out.byteLength)
		return out
	}
}

function text(header: Uint8Array, offset: number, length: number): string {
	const slice = header.subarray(offset, offset + length)
	const end = slice.indexOf(0)
	return Buffer.from(end === -1 ? slice : slice.subarray(0, end)).toString('utf8')
}

function size(header: Uint8Array): number {
	if (((header[124] ?? 0) & 0x80) !== 0) {
		let value = 0n
		for (let index = 125; index < 136; index += 1)
			value = (value << 8n) | BigInt(header[index] ?? 0)
		return Number(value)
	}
	const digits = text(header, 124, 12).trim()
	return digits ? Number.parseInt(digits, 8) : 0
}

function paxRecords(bytes: Uint8Array): Map<string, string> {
	const records = new Map<string, string>()
	const content = Buffer.from(bytes).toString('utf8')
	for (let offset = 0; offset < content.length; ) {
		const space = content.indexOf(' ', offset)
		const length = Number.parseInt(content.slice(offset, space), 10)
		if (space === -1 || !Number.isFinite(length) || length <= 0) break
		const record = content.slice(space + 1, offset + length - 1)
		const equals = record.indexOf('=')
		if (equals > 0) records.set(record.slice(0, equals), record.slice(equals + 1))
		offset += length
	}
	return records
}

/**
 * Reads a tar as a stream: ustar, GNU (base-256 sizes, long names) and pax (path, size), which
 * covers GNU tar, bsdtar (macOS) and Windows' tar. Header checksums are checked.
 */
export async function* readTar(source: AsyncIterable<Uint8Array>): AsyncGenerator<TarEntry> {
	const reader = new ByteReader(source[Symbol.asyncIterator]())
	let longName: string | null = null
	let pax = new Map<string, string>()
	for (;;) {
		const header = await reader.exact(BLOCK)
		if (!header || header.every((byte) => byte === 0)) return
		let sum = 0
		for (let index = 0; index < BLOCK; index += 1)
			sum += index >= 148 && index < 156 ? 32 : (header[index] ?? 0)
		if (sum !== Number.parseInt(text(header, 148, 8).trim(), 8)) {
			throw new DataTransferError(
				'The bundle is damaged or is not a tar file (a header checksum does not match).',
			)
		}
		const type = String.fromCharCode(header[156] ?? 0)
		const length = pax.has('size') ? Number(pax.get('size')) : size(header)
		if (!Number.isSafeInteger(length) || length < 0)
			throw new DataTransferError('The bundle has an entry with an invalid size.')
		const padding = (BLOCK - (length % BLOCK)) % BLOCK
		if (type === 'x' || type === 'g' || type === 'L') {
			const content = await reader.exact(length + padding)
			if (!content)
				throw new DataTransferError('The bundle ends in the middle of a file: it is incomplete.')
			if (type === 'x') pax = paxRecords(content.subarray(0, length))
			if (type === 'L') longName = text(content, 0, length)
			continue
		}
		const prefix = text(header, 345, 155)
		const shortName = text(header, 0, 100)
		const name = pax.get('path') ?? longName ?? (prefix ? `${prefix}/${shortName}` : shortName)
		longName = null
		pax = new Map()
		const kind =
			type === '0' || type === '\0' || type === '7' ? 'file' : type === '5' ? 'directory' : 'other'
		let left = length
		const body: AsyncIterable<Uint8Array> = {
			[Symbol.asyncIterator]: () => ({
				next: async (): Promise<IteratorResult<Uint8Array>> => {
					if (left === 0) return { done: true, value: undefined }
					const chunk = await reader.take(left)
					left -= chunk.byteLength
					return { done: false, value: chunk }
				},
				return: async (): Promise<IteratorResult<Uint8Array>> => ({ done: true, value: undefined }),
			}),
		}
		yield { name: name.replace(/^\.\//, ''), kind, size: length, body }
		while (left > 0) left -= (await reader.take(left)).byteLength
		if (padding && !(await reader.exact(padding))) {
			throw new DataTransferError('The bundle ends in the middle of a file: it is incomplete.')
		}
	}
}
