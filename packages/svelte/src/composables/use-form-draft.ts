import {
	type FormDraftFieldInput,
	type FormDraftOptions,
	cloneFormValues,
	createFormDraft,
	describeFormDraftInput,
	formDraftAppInfo,
} from '@korajs/core/bindings'
import { type Readable, type Writable, get, writable } from 'svelte/store'
import { getKoraContext } from '../context'
import type { KoraAppLike } from '../types'

/** What {@link createFormDraft} returns. */
export interface FormDraftStore<V extends Record<string, unknown>> extends Writable<V> {
	/**
	 * Svelte action for a field's input (`use:draft.field={'title'}`): the draft reads its
	 * `type` (`password` is never drafted), `autocomplete` and `data-kora-sensitive`, and
	 * re-checks them on every change. On a wrapper element, the form control inside it is
	 * read. A field with no resolvable control is not drafted unless listed in `safe`.
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
	/**
	 * The signed-in user changed (`undefined` while the session loads, `null` signed out):
	 * once known, the user's draft is restored (what was typed meanwhile is kept); another
	 * user's form starts over. Not needed when `userId` is a store.
	 */
	setUser(userId: string | null | undefined): void
	/** Stop listening for `app:before-build-reload` (call in `onDestroy`). */
	destroy(): void
}

/**
 * Options of the Svelte {@link useFormDraft}: `userId` may be a value, a getter or a store
 * of the signed-in user's id (`null` signed out, `undefined` while the session loads).
 */
export type SvelteFormDraftOptions<F extends string = string> = Omit<
	FormDraftOptions<F>,
	'userId'
> & {
	userId?: string | null | (() => string | null | undefined) | Readable<string | null | undefined>
}

/** The part of an input element the draft reads (structural: no DOM lib needed). */
export interface FormDraftInputElement {
	getAttribute(name: string): string | null
	hasAttribute(name: string): boolean
	matches?(selector: string): boolean
	querySelectorAll?(selector: string): ArrayLike<unknown>
	addEventListener(type: 'input', listener: () => void): void
	removeEventListener(type: 'input', listener: () => void): void
}

function isReadable(value: unknown): value is Readable<string | null | undefined> {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as { subscribe?: unknown }).subscribe === 'function'
	)
}

/**
 * A form's values as a Svelte store that keeps them across the reload a new version of the
 * app asks for (version gate). Same rules as `useFormDraft` of `@korajs/react`: opt-in per
 * form, only the listed `fields`; never password inputs, `data-kora-sensitive` inputs,
 * `t.secret()` fields of `collection` or `sensitive` fields (unless `allowSensitive`), fields
 * with no resolvable input unless `safe`; nothing at all when the app enables encryption; a
 * restored draft is removed at once. `userId` is `undefined` while the session loads: pass a
 * store (or call `setUser`) so the draft is restored once the user is known.
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
	options: SvelteFormDraftOptions<keyof V & string>,
	app?: KoraAppLike | null,
): FormDraftStore<V> {
	const kora = app === undefined ? getKoraContext() : null
	const target = app ?? kora?.app ?? null
	const { userId: givenUser, ...rest } = options
	// The user, read at each use: a store's latest value, a getter's result, setUser's value.
	let user: string | null | undefined = 'userId' in options ? undefined : null
	let userGetter: (() => string | null | undefined) | null = null
	if (typeof givenUser === 'function') userGetter = givenUser
	else if (!isReadable(givenUser) && 'userId' in options) user = givenUser
	const currentUser = (): string | null | undefined => (userGetter ? userGetter() : user)
	const draft = createFormDraft(formKey, { ...rest, userId: currentUser }, () =>
		formDraftAppInfo(target),
	)
	const fields = [...options.fields]
	// The baseline is a deep copy: editing nested values never changes it.
	const baseline = cloneFormValues(initial)
	const store = writable<V>(cloneFormValues(initial))
	const restored = writable(false)
	const elements = new Map<string, FormDraftInputElement>()
	let ready = false
	let skipNext = false

	const inputs = (field: string): FormDraftFieldInput | undefined =>
		describeFormDraftInput(elements.get(field))
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

	// Once the user is known, restore their draft (keeping what was typed meanwhile); another
	// user's form starts over.
	const setUser = (next: string | null | undefined): void => {
		const previous = currentUser()
		userGetter = null
		user = next
		if (!ready || next === undefined || next === previous) return
		const before = JSON.stringify(get(store))
		let values = previous !== undefined ? cloneFormValues(baseline) : get(store)
		const draftValues = draft.restore(inputs)
		if (draftValues) values = { ...values, ...draftValues }
		restored.set(draftValues !== null)
		if (JSON.stringify(values) === before) return
		// Not written back until the user changes something.
		skipNext = true
		store.set(values)
	}
	const unsubscribeUser = isReadable(givenUser) ? givenUser.subscribe(setUser) : null

	return {
		subscribe: store.subscribe,
		set: store.set,
		update: store.update,
		field(element, field) {
			let name = field
			elements.set(name, element)
			// Observed at once, not only at save: a field seen as a password once ("show
			// password" toggled before the first keystroke) is never drafted.
			const note = (): void => draft.noteInput(name, inputs(name))
			note()
			// Re-check the input's type on every change (a field that becomes a password input).
			const onInput = (): void => {
				note()
				persist(get(store))
			}
			element.addEventListener('input', onInput)
			// A reactive change of `type` or `data-kora-sensitive` (no input event): re-check
			// at once, so a field that becomes a password input is dropped from the draft.
			const Observer = (globalThis as { MutationObserver?: MutationObserverLike }).MutationObserver
			const isNode = typeof (element as { nodeType?: unknown }).nodeType === 'number'
			let observer: InstanceType<MutationObserverLike> | null = null
			if (Observer && isNode) {
				try {
					observer = new Observer(() => {
						note()
						persist(get(store))
					})
					observer.observe(element, {
						attributes: true,
						subtree: true,
						attributeFilter: ['type', 'autocomplete', 'data-kora-sensitive'],
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
					note()
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
		setUser,
		destroy() {
			unsubscribe()
			unsubscribeUser?.()
			off?.()
		},
	}
}

/** The part of `MutationObserver` the field action uses (structural: no DOM lib needed). */
type MutationObserverLike = new (
	callback: () => void,
) => {
	observe(
		target: unknown,
		options: { attributes: boolean; subtree: boolean; attributeFilter: string[] },
	): void
	disconnect(): void
}

type KoraContextOn = (type: 'app:before-build-reload', listener: () => void) => () => void
