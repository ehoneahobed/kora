import {
	type FormDraftFieldInput,
	type FormDraftOptions,
	cloneFormValues,
	createFormDraft,
	formDraftAppInfo,
} from '@korajs/core/bindings'
import { type Readable, type Writable, get, writable } from 'svelte/store'
import { getKoraContext } from '../context'
import type { KoraAppLike } from '../types'

/** What {@link createFormDraft} returns. */
export interface FormDraftStore<V extends Record<string, unknown>> extends Writable<V> {
	/**
	 * Svelte action for a field's input (`use:draft.field={'title'}`): the draft reads its
	 * `type` (`password` is never drafted) and `data-kora-sensitive`, and re-checks them on
	 * every change.
	 */
	field: (
		element: FormDraftInputElement,
		field: keyof V & string,
	) => { destroy(): void; update(field: keyof V & string): void }
	/** Restore the stored draft into the form once its inputs are mounted (call in `onMount`). */
	restore(): void
	/** After a successful submit: remove the draft and reset the form. */
	clear(): void
	/** True once a draft was restored (it was then removed from storage). */
	restored: Readable<boolean>
	/** Stop listening for `app:before-build-reload` (call in `onDestroy`). */
	destroy(): void
}

/** The part of an input element the draft reads (structural: no DOM lib needed). */
export interface FormDraftInputElement {
	getAttribute(name: string): string | null
	hasAttribute(name: string): boolean
	addEventListener(type: 'input', listener: () => void): void
	removeEventListener(type: 'input', listener: () => void): void
}

function describeInput(
	element: FormDraftInputElement | undefined,
): FormDraftFieldInput | undefined {
	if (!element) return undefined
	return {
		type: element.getAttribute('type'),
		sensitive: element.hasAttribute('data-kora-sensitive'),
	}
}

/**
 * A form's values as a Svelte store that keeps them across the reload a new version of the
 * app asks for (version gate). Same rules as `useFormDraft` of `@korajs/react`: opt-in per
 * form, only the listed `fields`; never password inputs, `data-kora-sensitive` inputs,
 * `t.secret()` fields of `collection` or `sensitive` fields (unless `allowSensitive`);
 * nothing at all when the app enables encryption; a restored draft is removed at once.
 *
 * Call it during component initialization (it reads the Kora context), or pass `app`.
 *
 * @example
 * ```svelte
 * const draft = useFormDraft('new-todo', { title: '' }, { fields: ['title'], collection: 'todos' })
 * onMount(draft.restore); onDestroy(draft.destroy)
 * <input bind:value={$draft.title} use:draft.field={'title'} />
 * ```
 */
export function useFormDraft<V extends Record<string, unknown>>(
	formKey: string,
	initial: V,
	options: FormDraftOptions<keyof V & string>,
	app?: KoraAppLike | null,
): FormDraftStore<V> {
	const kora = app === undefined ? getKoraContext() : null
	const target = app ?? kora?.app ?? null
	const draft = createFormDraft(formKey, options, () => formDraftAppInfo(target))
	const fields = [...options.fields]
	// The baseline is a deep copy: editing nested values never changes it.
	const baseline = cloneFormValues(initial)
	const store = writable<V>(cloneFormValues(initial))
	const restored = writable(false)
	const elements = new Map<string, FormDraftInputElement>()
	let ready = false
	let skipNext = false

	const inputs = (field: string): FormDraftFieldInput | undefined =>
		describeInput(elements.get(field))
	const persist = (current: V): void => {
		if (!ready) return
		const unchanged = fields.every(
			(field) => JSON.stringify(current[field]) === JSON.stringify(baseline[field]),
		)
		if (unchanged) draft.clear()
		else draft.save(current as Partial<Record<keyof V & string, unknown>>, inputs)
	}
	const unsubscribe = store.subscribe((current) => {
		if (skipNext) {
			skipNext = false
			return
		}
		persist(current)
	})
	const events =
		(target as { events?: { on: KoraContextOn } } | null)?.events ?? kora?.events ?? null
	const off = events?.on('app:before-build-reload', () => persist(get(store)))

	return {
		subscribe: store.subscribe,
		set: store.set,
		update: store.update,
		field(element, field) {
			let name = field
			elements.set(name, element)
			// Re-check the input's type on every change (a field that becomes a password input).
			const onInput = (): void => persist(get(store))
			element.addEventListener('input', onInput)
			// A reactive change of `type` or `data-kora-sensitive` (no input event): re-check
			// at once, so a field that becomes a password input is dropped from the draft.
			const Observer = (globalThis as { MutationObserver?: MutationObserverLike }).MutationObserver
			const isNode = typeof (element as { nodeType?: unknown }).nodeType === 'number'
			let observer: InstanceType<MutationObserverLike> | null = null
			if (Observer && isNode) {
				try {
					observer = new Observer(() => persist(get(store)))
					observer.observe(element, {
						attributes: true,
						attributeFilter: ['type', 'data-kora-sensitive'],
					})
				} catch {
					observer = null
				}
			}
			return {
				update(next) {
					elements.delete(name)
					name = next
					elements.set(name, element)
					persist(get(store))
				},
				destroy() {
					elements.delete(name)
					element.removeEventListener('input', onInput)
					observer?.disconnect()
				},
			}
		},
		restore() {
			const draftValues = draft.restore(inputs)
			if (draftValues) {
				// Consumed: not written back until the user changes something.
				skipNext = true
				store.update((current) => ({ ...current, ...draftValues }))
				restored.set(true)
			}
			ready = true
		},
		clear() {
			draft.clear()
			store.set(cloneFormValues(baseline))
			restored.set(false)
		},
		restored: { subscribe: restored.subscribe },
		destroy() {
			unsubscribe()
			off?.()
		},
	}
}

/** The part of `MutationObserver` the field action uses (structural: no DOM lib needed). */
type MutationObserverLike = new (
	callback: () => void,
) => {
	observe(target: unknown, options: { attributes: boolean; attributeFilter: string[] }): void
	disconnect(): void
}

type KoraContextOn = (type: 'app:before-build-reload', listener: () => void) => () => void
