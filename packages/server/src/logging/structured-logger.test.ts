import { describe, expect, it } from 'vitest'
import { createJsonLogger, createPrettyLogger, createSilentLogger } from './structured-logger'
import type { LogEntry } from './structured-logger'

function collectJsonLogger(): { logger: ReturnType<typeof createJsonLogger>; lines: string[] } {
	const lines: string[] = []
	const logger = createJsonLogger({
		info: (s: string) => lines.push(s),
		error: (s: string) => lines.push(s),
	})
	return { logger, lines }
}

describe('createJsonLogger', () => {
	it('writes JSON lines for info entries', () => {
		const { logger, lines } = collectJsonLogger()

		logger.log({
			timestamp: 1000000,
			level: 'info',
			event: 'session.connected',
			sessionId: 'sess-1',
		})

		expect(lines).toHaveLength(1)
		const parsed = JSON.parse(lines[0] as string)
		expect(parsed.timestamp).toBe(1000000)
		expect(parsed.level).toBe('info')
		expect(parsed.event).toBe('session.connected')
		expect(parsed.sessionId).toBe('sess-1')
	})

	it('writes error entries to error output', () => {
		const { logger, lines } = collectJsonLogger()

		logger.log({
			timestamp: 2000000,
			level: 'error',
			event: 'session.error',
			error: 'something went wrong',
		})

		const parsed = JSON.parse(lines[0] as string)
		expect(parsed.level).toBe('error')
		expect(parsed.error).toBe('something went wrong')
	})

	it('includes optional fields', () => {
		const { logger, lines } = collectJsonLogger()

		logger.log({
			timestamp: 3000000,
			level: 'info',
			event: 'operations.received',
			count: 42,
			bytes: 5000,
			duration: 150,
			details: { collection: 'todos' },
		})

		const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>
		expect(parsed.count).toBe(42)
		expect(parsed.bytes).toBe(5000)
		expect(parsed.duration).toBe(150)
		expect((parsed.details as Record<string, unknown>).collection).toBe('todos')
	})
})

describe('createPrettyLogger', () => {
	it('formats entries as human-readable strings', () => {
		const lines: string[] = []
		const logger = createPrettyLogger({ write: (s: string) => lines.push(s) })

		logger.log({
			timestamp: new Date('2026-05-09T12:00:00.000Z').getTime(),
			level: 'info',
			event: 'session.connected',
		})

		expect(lines[0]).toBeTruthy()
		expect(lines[0]).toContain('session.connected')
	})

	it('includes node ID when provided', () => {
		const lines: string[] = []
		const logger = createPrettyLogger({ write: (s: string) => lines.push(s) })

		logger.log({
			timestamp: Date.now(),
			level: 'info',
			event: 'session.handshake',
			nodeId: 'node-a1b2c3d4',
		})

		expect(lines[0]).toContain('[node-a1b]')
	})
})

describe('createSilentLogger', () => {
	it('discards all entries', () => {
		const logger = createSilentLogger()
		let called = false
		const spy = {
			get called() {
				return called
			},
			set called(v: boolean) {
				called = v
			},
		}

		const originalWrite = process.stdout.write
		process.stdout.write = () => {
			spy.called = true
			return true
		}

		logger.log({ timestamp: 0, level: 'info', event: 'test' })

		process.stdout.write = originalWrite
		expect(spy.called).toBe(false)
	})
})
