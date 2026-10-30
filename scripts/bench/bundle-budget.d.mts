/** Types of bundle-budget.mjs, for the tests that import it. */

export declare const K3_BUDGET_BYTES: number

export interface SourceMapLike {
	sources: Array<string | null>
	mappings: string
}

export interface ChunkAttribution {
	byPackage: Map<string, number>
	koraParts: string[]
}

export interface BudgetMeasurement {
	chunks: string[]
	criticalRaw: number
	criticalGzip: number
	koraRaw: number
	koraGzip: number
	packages: Array<{ label: string; bytes: number; kora: boolean }>
}

export declare function packageOf(source: string): string | null
export declare function koraPackages(appDir: string): Set<string>
export declare function attributeChunk(
	code: string,
	map: SourceMapLike,
	kora: ReadonlySet<string>,
): ChunkAttribution
export declare function measure(dist: string): BudgetMeasurement
