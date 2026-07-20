import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import { StudioDbReader } from './db-reader'
import type { LabManager } from './lab-manager'
import { buildCausalDag, replayToOperation } from './studio-replay'
import { STUDIO_HTML } from './studio-ui'
import { STUDIO_APP_JS } from './studio-ui-app'
import { STUDIO_CSS } from './studio-ui-css'

/**
 * Kora Studio HTTP server.
 *
 * Two modes share one inspection surface:
 * - FILE mode: read-only against a user database. Strictly GET.
 * - LAB mode: an in-process multi-device sync laboratory. Lab routes accept
 *   POST, but only ever touch the Lab's throwaway databases — a user database
 *   opened by Studio is never writable, in any mode.
 *
 * Live updates flow over Server-Sent Events: file mode polls SQLite's
 * data_version (cheap, cross-connection), lab mode pushes real device events.
 */
export interface StudioServerOptions {
	port: number
	host?: string
	/** File mode: path of the database to inspect. */
	dbPath?: string
	/** Lab mode: the running lab. */
	lab?: LabManager
	/** Spectator mode: live read-only replica of a production sync server. */
	spectator?: import('./spectator-manager').SpectatorManager
}

export interface StudioServer {
	server: Server
	port: number
	url: string
	close(): Promise<void>
}

interface StudioContext {
	mode: 'file' | 'lab' | 'spectator'
	lab: LabManager | null
	spectator: import('./spectator-manager').SpectatorManager | null
	mainReader: StudioDbReader | null
	/** Lazily-opened read-only readers for lab device DBs. */
	deviceReaders: Map<string, StudioDbReader>
}

const SSE_POLL_MS = 700

export async function startStudioServer(options: StudioServerOptions): Promise<StudioServer> {
	const host = options.host ?? '127.0.0.1'
	// The spectator's replica is inspected exactly like a file-mode database.
	const dbPath = options.spectator ? options.spectator.dbPath : options.dbPath
	const context: StudioContext = {
		mode: options.spectator ? 'spectator' : options.lab ? 'lab' : 'file',
		lab: options.lab ?? null,
		spectator: options.spectator ?? null,
		mainReader: dbPath ? await StudioDbReader.open(dbPath) : null,
		deviceReaders: new Map(),
	}

	const sseClients = new Set<ServerResponse>()
	const broadcast = (event: string, data: unknown): void => {
		const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
		for (const client of sseClients) {
			client.write(payload)
		}
	}

	// Spectator mode: forward live client events (op applied, sync, merges).
	let unsubscribeSpectator: (() => void) | null = null
	if (context.spectator) {
		unsubscribeSpectator = context.spectator.onEvent((event) => {
			broadcast('spectator', event)
			broadcast('change', { at: event.at })
		})
	}

	// File mode: poll the DB's data_version and broadcast change ticks.
	let pollTimer: ReturnType<typeof setInterval> | null = null
	if (context.mode === 'file' && context.mainReader) {
		let lastFingerprint = context.mainReader.fingerprint()
		pollTimer = setInterval(() => {
			try {
				const current = context.mainReader?.fingerprint()
				if (current !== undefined && current !== lastFingerprint) {
					lastFingerprint = current
					broadcast('change', { at: Date.now() })
				}
			} catch {
				// DB temporarily busy — next tick will retry.
			}
		}, SSE_POLL_MS)
	}

	// Lab mode: forward live device events.
	let unsubscribeLab: (() => void) | null = null
	if (context.lab) {
		unsubscribeLab = context.lab.onEvent((event) => {
			broadcast('lab', event)
			broadcast('change', { at: event.at })
		})
	}

	const server = createServer((req, res) => {
		handleRequest(context, sseClients, req, res).catch((error: unknown) => {
			const message = error instanceof Error ? error.message : 'Internal error'
			if (!res.headersSent) {
				sendJson(res, 500, { error: message })
			} else {
				res.end()
			}
		})
	})

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen(options.port, host, () => {
			server.removeListener('error', reject)
			resolve()
		})
	})

	const address = server.address()
	const port = typeof address === 'object' && address !== null ? address.port : options.port

	return {
		server,
		port,
		url: `http://${host}:${port}`,
		close: async () => {
			if (pollTimer) {
				clearInterval(pollTimer)
			}
			unsubscribeSpectator?.()
			unsubscribeLab?.()
			for (const client of sseClients) {
				client.end()
			}
			sseClients.clear()
			context.mainReader?.close()
			for (const [, reader] of context.deviceReaders) {
				reader.close()
			}
			context.deviceReaders.clear()
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()))
			})
		},
	}
}

async function resolveReader(context: StudioContext, url: URL): Promise<StudioDbReader> {
	const device = url.searchParams.get('device')
	if (device && context.lab) {
		const cached = context.deviceReaders.get(device)
		if (cached) {
			return cached
		}
		const state = context.lab.deviceState(device)
		const reader = await StudioDbReader.open(state.dbPath)
		context.deviceReaders.set(device, reader)
		return reader
	}
	if (context.mainReader) {
		return context.mainReader
	}
	// Lab mode with no device specified: default to the first device.
	if (context.lab) {
		const first = context.lab.listDevices()[0]
		if (first) {
			return resolveReader(context, new URL(`${url.origin}${url.pathname}?device=${first.name}`))
		}
	}
	throw new Error('No database available')
}

async function handleRequest(
	context: StudioContext,
	sseClients: Set<ServerResponse>,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	const url = new URL(req.url ?? '/', 'http://studio.local')
	const path = url.pathname
	const method = req.method ?? 'GET'

	// ── Static assets ──
	if (method === 'GET' && (path === '/' || path === '/index.html')) {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
		res.end(STUDIO_HTML)
		return
	}
	if (method === 'GET' && path === '/app.js') {
		res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
		res.end(STUDIO_APP_JS)
		return
	}
	if (method === 'GET' && path === '/style.css') {
		res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' })
		res.end(STUDIO_CSS)
		return
	}

	// ── Live updates (SSE) ──
	if (method === 'GET' && path === '/api/events') {
		res.writeHead(200, {
			'content-type': 'text/event-stream',
			'cache-control': 'no-store',
			connection: 'keep-alive',
		})
		res.write(`event: hello\ndata: ${JSON.stringify({ mode: context.mode })}\n\n`)
		if (context.lab) {
			for (const event of context.lab.recentEvents().slice(-100)) {
				res.write(`event: lab\ndata: ${JSON.stringify(event)}\n\n`)
			}
		}
		if (context.spectator) {
			for (const event of context.spectator.recentEvents().slice(-100)) {
				res.write(`event: spectator\ndata: ${JSON.stringify(event)}\n\n`)
			}
		}
		sseClients.add(res)
		req.on('close', () => {
			sseClients.delete(res)
		})
		return
	}

	// ── Lab routes (POST allowed; lab DBs are throwaway) ──
	if (path.startsWith('/api/lab')) {
		if (!context.lab) {
			sendJson(res, 404, {
				error: 'Studio is not running in lab mode. Start with: kora studio --lab',
			})
			return
		}
		await handleLabRoute(context, context.lab, req, res, url)
		return
	}

	// ── Everything else is strictly read-only ──
	if (method !== 'GET') {
		sendJson(res, 405, { error: 'Studio data routes are read-only: GET only.' })
		return
	}

	if (path === '/api/mode') {
		sendJson(res, 200, {
			mode: context.mode,
			devices: context.lab?.listDevices().map((d) => d.name) ?? [],
			...(context.spectator ? { spectator: context.spectator.status() } : {}),
		})
		return
	}

	if (path === '/api/spectator/status') {
		if (!context.spectator) {
			sendJson(res, 404, { error: 'Not in spectator mode' })
			return
		}
		sendJson(res, 200, context.spectator.status())
		return
	}

	if (path === '/api/overview') {
		const reader = await resolveReader(context, url)
		sendJson(res, 200, reader.overview())
		return
	}

	if (path === '/api/audit') {
		const reader = await resolveReader(context, url)
		sendJson(res, 200, { traces: reader.auditTraces(intParam(url, 'limit') ?? 100) })
		return
	}

	const collectionMatch = path.match(
		/^\/api\/collections\/([a-zA-Z0-9_]+)\/(records|ops|replay|dag)(?:\/([^/]+))?(?:\/(ops))?$/,
	)
	if (collectionMatch) {
		const [, collection, kind, recordId, sub] = collectionMatch
		if (!collection || !kind) {
			sendJson(res, 400, { error: 'Bad request' })
			return
		}
		const reader = await resolveReader(context, url)
		if (!reader.listCollections().includes(collection)) {
			sendJson(res, 404, { error: `Unknown collection "${collection}"` })
			return
		}

		if (kind === 'replay') {
			const ops = reader.allOperations(collection)
			const upTo = url.searchParams.get('upTo')
			sendJson(res, 200, replayToOperation(ops, upTo))
			return
		}

		if (kind === 'dag') {
			const record = url.searchParams.get('record')
			const limit = intParam(url, 'limit') ?? 200
			let ops = reader.allOperations(collection)
			if (record) {
				ops = ops.filter((o) => o.recordId === record)
			} else {
				ops = ops.slice(-limit)
			}
			sendJson(res, 200, buildCausalDag(ops))
			return
		}

		if (kind === 'ops') {
			sendJson(
				res,
				200,
				reader.operations(collection, {
					limit: intParam(url, 'limit'),
					offset: intParam(url, 'offset'),
				}),
			)
			return
		}

		if (recordId && sub === 'ops') {
			sendJson(res, 200, { operations: reader.recordOperations(collection, recordId) })
			return
		}

		if (recordId) {
			const record = reader.record(collection, recordId)
			if (!record) {
				sendJson(res, 404, { error: `Record "${recordId}" not found` })
				return
			}
			const richtextPreviews = await decodeRichtextFields(
				reader,
				collection,
				recordId,
				record.fields,
			)
			sendJson(res, 200, {
				record,
				richtextPreviews,
				operations: reader.recordOperations(collection, recordId),
			})
			return
		}

		sendJson(
			res,
			200,
			reader.records(collection, {
				limit: intParam(url, 'limit'),
				offset: intParam(url, 'offset'),
				includeDeleted: url.searchParams.get('includeDeleted') === 'true',
				search: url.searchParams.get('search') ?? undefined,
			}),
		)
		return
	}

	sendJson(res, 404, { error: `No route for ${path}` })
}

// ── Lab routes ───────────────────────────────────────────────────────────────

async function handleLabRoute(
	context: StudioContext,
	lab: LabManager,
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
): Promise<void> {
	const path = url.pathname
	const method = req.method ?? 'GET'

	if (method === 'GET' && path === '/api/lab/state') {
		const schema = lab.getSchema()
		sendJson(res, 200, {
			devices: lab.listDevices(),
			serverOperations: lab.serverOperationCount(),
			collections: Object.entries(schema.collections).map(([name, def]) => ({
				name,
				fields: Object.entries(def.fields).map(([fieldName, descriptor]) => ({
					name: fieldName,
					kind: descriptor.kind,
					optional: !descriptor.required,
					enumValues: descriptor.enumValues ?? null,
					defaultValue: descriptor.defaultValue ?? null,
				})),
			})),
		})
		return
	}

	if (method === 'GET' && path === '/api/lab/convergence') {
		sendJson(res, 200, await lab.convergence())
		return
	}

	if (method !== 'POST') {
		sendJson(res, 405, { error: 'POST required' })
		return
	}

	const body = await readJsonBody(req)

	if (path === '/api/lab/devices') {
		const state = await lab.addDevice(typeof body.name === 'string' ? body.name : undefined)
		sendJson(res, 200, state)
		return
	}

	const deviceMatch = path.match(
		/^\/api\/lab\/devices\/([a-zA-Z0-9_-]+)\/(connect|disconnect|sync|chaos|insert|update|delete)$/,
	)
	if (!deviceMatch) {
		sendJson(res, 404, { error: `No lab route for ${path}` })
		return
	}
	const [, device, action] = deviceMatch
	if (!device || !action) {
		sendJson(res, 400, { error: 'Bad request' })
		return
	}

	switch (action) {
		case 'connect':
			await lab.connect(device)
			break
		case 'disconnect': {
			await lab.disconnect(device)
			// The device's DB file keeps changing while its reader is cached; drop
			// nothing — readers see committed WAL state per query. But a RESET of
			// the lab would invalidate paths; that's handled at close.
			break
		}
		case 'sync':
			await lab.sync(device)
			break
		case 'chaos':
			sendJson(
				res,
				200,
				lab.setChaos(device, body as Partial<import('./lab-manager').LabChaosConfig>),
			)
			return
		case 'insert': {
			const record = await lab.insert(
				device,
				String(body.collection ?? ''),
				(body.data as Record<string, unknown>) ?? {},
			)
			sendJson(res, 200, { record })
			return
		}
		case 'update': {
			const record = await lab.update(
				device,
				String(body.collection ?? ''),
				String(body.id ?? ''),
				(body.data as Record<string, unknown>) ?? {},
				(body.increments as Record<string, number>) ?? undefined,
			)
			sendJson(res, 200, { record })
			return
		}
		case 'delete':
			await lab.delete(device, String(body.collection ?? ''), String(body.id ?? ''))
			break
	}
	sendJson(res, 200, { ok: true, device: lab.deviceState(device) })
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function decodeRichtextFields(
	reader: StudioDbReader,
	collection: string,
	recordId: string,
	fields: Record<string, unknown>,
): Promise<Record<string, string>> {
	const previews: Record<string, string> = {}
	const binaryFields = Object.entries(fields).filter(
		([, value]) => typeof value === 'string' && value.startsWith('<binary '),
	)
	if (binaryFields.length === 0) {
		return previews
	}
	let toPlainText: ((state: Uint8Array) => string) | null = null
	try {
		const storePkg = await import('@korajs/store')
		toPlainText =
			(storePkg as { richtextToPlainText?: (s: Uint8Array) => string }).richtextToPlainText ?? null
	} catch {
		return previews
	}
	if (!toPlainText) {
		return previews
	}
	for (const [field] of binaryFields) {
		try {
			const raw = reader.rawFieldValue(collection, recordId, field)
			if (raw instanceof Uint8Array || Buffer.isBuffer(raw)) {
				previews[field] = toPlainText(new Uint8Array(raw as Uint8Array))
			}
		} catch {
			// Not decodable as Yjs state — leave the byte summary.
		}
	}
	return previews
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = []
	let size = 0
	for await (const chunk of req) {
		size += (chunk as Buffer).length
		if (size > 256 * 1024) {
			throw new Error('Request body too large')
		}
		chunks.push(chunk as Buffer)
	}
	if (chunks.length === 0) {
		return {}
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
	} catch {
		throw new Error('Invalid JSON body')
	}
}

function intParam(url: URL, name: string): number | undefined {
	const raw = url.searchParams.get(name)
	if (raw === null) {
		return undefined
	}
	const parsed = Number.parseInt(raw, 10)
	return Number.isNaN(parsed) ? undefined : parsed
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
	})
	res.end(JSON.stringify(body))
}
