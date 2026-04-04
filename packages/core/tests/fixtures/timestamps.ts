import type { TimeSource } from '../../src/types'

/**
 * A controllable time source for deterministic testing.
 * Allows precise control over what Date.now() returns.
 */
export class MockTimeSource implements TimeSource {
	constructor(private time = 1000) {}

	now(): number {
		return this.time
	}

	/** Advance time by the given number of milliseconds */
	advance(ms: number): void {
		this.time += ms
	}

	/** Set time to an exact value */
	set(time: number): void {
		this.time = time
	}
}
