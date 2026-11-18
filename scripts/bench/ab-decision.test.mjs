import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decide } from './ab-decision.mjs'

// The gate fails a change that makes the store more than 10% slower than its base, measured
// alternately on the same runner. It must not fail on one unusually fast base run.
const limits = { maxRegression: 0.1, slackMs: 20 }

test('PR #245 (sync-only): one fast base run is not a regression', () => {
	const base = [677.7, 716.9, 767.5, 805.5, 709.0]
	const head = [781.2, 760.5, 778.1, 766.6, 769.3]
	assert.equal(decide(base, head, limits).regressed, false)
})

test('PR #253 (org routes): one fast base run is not a regression', () => {
	const base = [642.2, 718.0, 751.4, 755.5, 755.6]
	const head = [729.2, 736.9, 730.4, 819.3, 758.2]
	assert.equal(decide(base, head, limits).regressed, false)
})

test('a real 15% slowdown is a regression', () => {
	const base = [642.2, 718.0, 751.4, 755.5, 755.6]
	const head = base.map((ms) => ms * 1.15)
	assert.equal(decide(base, head, limits).regressed, true)
})

test('differences below the absolute slack are never a regression', () => {
	assert.equal(
		decide([4, 4, 4, 4, 4], [5, 5, 5, 5, 5], { maxRegression: 0.1, slackMs: 2 }).regressed,
		false,
	)
})
