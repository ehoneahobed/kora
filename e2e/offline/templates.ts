/**
 * The 13 bundled CLI templates and what the offline-readiness suite needs to know about each.
 * `packages/cli/src/types.ts` (`TEMPLATES`) is the source of truth for the list; the suite fails
 * when this table and the CLI disagree, so a new template cannot ship untested.
 */
export interface TemplateSpec {
	/** The `--template` value. */
	name: string
	/** UI framework, which decides how the app is patched for tests. */
	framework: 'react' | 'vue' | 'svelte'
	/** Whether the template ships its own sync server (`server.ts`) and a sign-in flow. */
	sync: boolean
	/** `tauri-react` is a desktop template: it cannot run in a browser. */
	desktop: boolean
}

export const TEMPLATE_SPECS: readonly TemplateSpec[] = [
	{ name: 'react-basic', framework: 'react', sync: false, desktop: false },
	{ name: 'react-tailwind', framework: 'react', sync: false, desktop: false },
	{ name: 'react-sync', framework: 'react', sync: true, desktop: false },
	{ name: 'react-tailwind-sync', framework: 'react', sync: true, desktop: false },
	{ name: 'vue-basic', framework: 'vue', sync: false, desktop: false },
	{ name: 'vue-tailwind', framework: 'vue', sync: false, desktop: false },
	{ name: 'vue-sync', framework: 'vue', sync: true, desktop: false },
	{ name: 'vue-tailwind-sync', framework: 'vue', sync: true, desktop: false },
	{ name: 'svelte-basic', framework: 'svelte', sync: false, desktop: false },
	{ name: 'svelte-tailwind', framework: 'svelte', sync: false, desktop: false },
	{ name: 'svelte-sync', framework: 'svelte', sync: true, desktop: false },
	{ name: 'svelte-tailwind-sync', framework: 'svelte', sync: true, desktop: false },
	{ name: 'tauri-react', framework: 'react', sync: true, desktop: true },
]

/**
 * The templates to run: `KORA_OFFLINE_TEMPLATES=react-basic,vue-sync` selects a subset (CI
 * shards and local runs); unset means all 13.
 */
export function selectedTemplates(env: NodeJS.ProcessEnv = process.env): TemplateSpec[] {
	const wanted = (env.KORA_OFFLINE_TEMPLATES ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
	if (wanted.length === 0) return [...TEMPLATE_SPECS]
	const unknown = wanted.filter((n) => !TEMPLATE_SPECS.some((t) => t.name === n))
	if (unknown.length > 0) {
		throw new Error(`Unknown template(s) in KORA_OFFLINE_TEMPLATES: ${unknown.join(', ')}`)
	}
	return TEMPLATE_SPECS.filter((t) => wanted.includes(t.name))
}
