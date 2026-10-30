// The evaluator lives in @korajs/core so the sync server's read-through endpoint judges a
// query with the very code the client's instant-updates overlay runs (first-visit parity,
// design section 5.2). This module keeps the store's import path and names.
export {
	type PatchRefusalReason,
	type PatchVerdict,
	MAX_PATCHABLE_IN_LIST,
	PATCH_REFUSAL_REASONS,
	checkPatchable,
	compareQueryRecords as compare,
	isPatchable,
	matchesQuery as matches,
} from '@korajs/core/internal'
