import type { LocalMutationContext } from './types'

/**
 * Merge explicit parent deps (e.g. referential cascade) with tracker-derived deps.
 */
export function resolveCausalDeps(ctx: LocalMutationContext): string[] {
	const merged: string[] = []
	for (const id of ctx.extraCausalDeps ?? []) {
		if (!merged.includes(id)) {
			merged.push(id)
		}
	}
	for (const id of ctx.causalTracker?.nextCausalDeps(ctx.collection, ctx.inTransaction) ?? []) {
		if (!merged.includes(id)) {
			merged.push(id)
		}
	}
	return merged
}
