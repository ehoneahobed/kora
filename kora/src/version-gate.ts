import type { KoraEventByType, KoraEventEmitter } from '@korajs/core'
import { BuildSupersededError, type BuildSupersededInfo, VersionGate } from '@korajs/store'
import type { ContentAddressedBlobStore, VersionGateSnapshot } from '@korajs/store'
import type { SyncRuntimeState } from './sync-lifecycle'
import type { AdapterType, KoraConfig } from './types'

/**
 * App side of the version gate (`docs/design/version-gate.md`): the build id, the
 * `app:build-superseded` announcement, the default prompts, the sync retirement step and
 * `app.reloadForNewBuild()`. The store layer (`@korajs/store` `VersionGate`) owns the
 * protocol, the write refusal and the storage steps.
 */

/** Name of the `<meta>` the `@korajs/cli/vite` plugins inject with the build id. */
export const BUILD_META_NAME = 'kora-build'

/**
 * The build id of this deployment: `createApp({ build })`, else the one the
 * `@korajs/cli/vite` plugins injected (`globalThis.__KORA_BUILD__` or
 * `<meta name="kora-build">`). Undefined when neither exists; the gate then falls back to a
 * schema fingerprint and reports `store:build-unidentified`. Never the package version.
 */
export function resolveAppBuild(config: Pick<KoraConfig, 'build'>): string | undefined {
	if (typeof config.build === 'string' && config.build.length > 0) return config.build
	const injected = (globalThis as { __KORA_BUILD__?: unknown }).__KORA_BUILD__
	if (typeof injected === 'string' && injected.length > 0) return injected
	if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
		const meta = document.querySelector(`meta[name="${BUILD_META_NAME}"]`)
		const content = meta?.getAttribute('content')
		if (content) return content
	}
	return undefined
}

/**
 * The version gate for one opening of the app's database: the one the app was given
 * (`store.versionGate`, tests and embedders), else a new one for a browser adapter in a
 * browser page, else null (Node, Tauri and other native adapters: one process owns the
 * database file).
 */
export function createAppVersionGate(
	config: KoraConfig,
	dbName: string,
	emitter: KoraEventEmitter,
	adapterType: AdapterType,
): VersionGate | null {
	const given = config.store?.versionGate
	if (typeof given === 'function') return given()
	// A given instance serves one opening: a closed gate never reopens, so a fallback
	// adapter (OPFS to IndexedDB) gets a gate of its own.
	if (given && !usedGivenGates.has(given)) {
		usedGivenGates.add(given)
		return given
	}
	// Native SQLite (Tauri plugin, better-sqlite3): one process owns the database file.
	if (adapterType !== 'sqlite-wasm' && adapterType !== 'indexeddb') return null
	if (typeof window === 'undefined' || typeof document === 'undefined') return null
	const build = resolveAppBuild(config)
	return new VersionGate({
		dbName,
		emitter,
		...(build !== undefined ? { build } : {}),
		...(config.store?.allowUncoordinatedTabs ? { allowUncoordinatedTabs: true } : {}),
	})
}

const usedGivenGates = new WeakSet<VersionGate>()

/** What {@link wireAppVersionGate} needs from the app. */
export interface AppVersionGateContext {
	config: KoraConfig
	emitter: KoraEventEmitter
	syncState: SyncRuntimeState
	reloadForNewBuild: () => void
}

/**
 * Connect a gate to the app: announce supersession (section 5, step 1) before the store's
 * write gate refuses anything, stop sync as the `sync` retirement step, and drive the
 * default prompts. Returns a function that detaches it.
 */
export function wireAppVersionGate(gate: VersionGate, context: AppVersionGateContext): () => void {
	const { config, emitter, syncState } = context
	const prompt = config.store?.buildPrompt === false ? null : createDefaultGatePrompt(gate, context)
	const detach: Array<() => void> = []

	detach.push(
		gate.onSuperseded(({ current, newer }) => {
			// Step 1 (announce) runs in the same task as step 2 (refuse writes): the store's
			// own listener closes its write gate in this task too, after this one.
			syncState.supersededBy = { currentBuild: current.build, newerBuild: newer.build }
			// No reconnect attempt (online event, backoff) starts from now on.
			syncState.intentionalDisconnect = true
			let prevented = false
			const event = {
				type: 'app:build-superseded' as const,
				currentBuild: current.build,
				newerBuild: newer.build,
			} as KoraEventByType<'app:build-superseded'>
			// Not enumerable: the event stays structured-clonable for DevTools.
			Object.defineProperty(event, 'preventDefault', {
				value: () => {
					prevented = true
				},
				enumerable: false,
			})
			Object.defineProperty(event, 'defaultPrevented', {
				get: () => prevented,
				enumerable: false,
			})
			try {
				emitter.emit(event)
			} catch (error) {
				console.error('[kora] An app:build-superseded listener failed:', error)
			}
			const handler = config.store?.onBuildSuperseded
			if (handler) {
				try {
					handler({ currentBuild: current.build, newerBuild: newer.build })
				} catch (error) {
					console.error('[kora] store.onBuildSuperseded failed:', error)
				}
			}
			if (!prevented && !handler) prompt?.superseded()
		}),
	)

	// Step 5: stop sync. Unsent operations are already in the outbound queue
	// (`_kora_sync_queue`, persisted before upload); the new build uploads them.
	detach.push(
		gate.addRetireStep('sync', async () => {
			syncState.intentionalDisconnect = true
			syncState.reconnectionManager?.stop()
			const engine = syncState.syncEngine
			if (engine) {
				try {
					await engine.stop()
				} catch (error) {
					console.warn('[kora] Stopping sync while retiring this tab failed:', error)
				}
			}
			syncState.syncStatusBridge?.refresh()
		}),
	)

	if (prompt) {
		detach.push(gate.onChange((snapshot) => prompt.update(snapshot)))
		detach.push(
			emitter.on('store:tab-exclusive', () =>
				prompt.blocked('This app is open in another tab. Close it to continue here.'),
			),
		)
		detach.push(
			emitter.on('store:legacy-build-detected', () =>
				prompt.blocked('Close other tabs of this app, then reload.'),
			),
		)
	}
	return () => {
		for (const fn of detach.splice(0)) fn()
		prompt?.remove()
	}
}

/**
 * `app.blobs.store` for advanced use, with its writes (`put`, `delete`) routed through the
 * store's write gate like every other write.
 */
export function gatedBlobStore(
	blobStore: ContentAddressedBlobStore,
	track: <T>(operation: string, fn: () => Promise<T>) => Promise<T>,
): ContentAddressedBlobStore {
	return new Proxy(blobStore, {
		get(target, property, receiver) {
			const value: unknown = Reflect.get(target, property, receiver)
			if (typeof value !== 'function') return value
			if (property === 'put' || property === 'delete') {
				return (...args: unknown[]) =>
					track(`blob-${String(property)}`, () =>
						(value as (...a: unknown[]) => Promise<unknown>).apply(target, args),
					)
			}
			return (value as (...a: unknown[]) => unknown).bind(target)
		},
	})
}

/** The refusal sync control methods raise once the tab retired. */
export function supersededSyncError(info: BuildSupersededInfo): BuildSupersededError {
	return new BuildSupersededError({ operation: 'sync' }, info)
}

// === Default prompt ===

interface DefaultGatePrompt {
	superseded(): void
	update(snapshot: VersionGateSnapshot): void
	blocked(message: string): void
	remove(): void
}

/** Prefix of the default prompt's element id (one element per database). */
export const PROMPT_ID_PREFIX = 'kora-version-gate-prompt'
const BAR_STYLE =
	'position:fixed;left:16px;right:16px;bottom:16px;z-index:2147483647;display:flex;gap:12px;align-items:center;justify-content:space-between;max-width:520px;margin:0 auto;padding:12px 16px;border-radius:8px;background:#111;color:#fff;font:14px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3)'
const BUTTON_STYLE =
	'padding:6px 12px;border:0;border-radius:6px;background:#fff;color:#111;font:inherit;cursor:pointer'

/** Message of the default prompt in a superseded tab (design section 5, step 1). */
export const SUPERSEDED_MESSAGE = 'A new version of this app is available. Reload to continue.'
/** Message of the default prompt while a failed barrier holds retirement (step 4). */
export const UNSAVED_MESSAGE =
	'Your latest changes are not saved yet (storage is full). Free up space, then Retry.'

/**
 * Kora's built-in prompts, rendered as a small banner with plain DOM (no UI framework).
 * In a page with the offline-shell plugin, a superseded tab first offers the update
 * through the plugin's `kora:update-available` event, so an app that already shows its
 * own update UI shows it here too.
 */
function createDefaultGatePrompt(
	gate: VersionGate,
	context: AppVersionGateContext,
): DefaultGatePrompt | null {
	if (typeof document === 'undefined' || typeof window === 'undefined') return null
	let mode: 'none' | 'superseded' | 'unsaved' | 'waiting' | 'blocked' = 'none'
	// This app's own element: two apps on one page never remove each other's prompt.
	let element: HTMLElement | null = null
	const promptId = `${PROMPT_ID_PREFIX}-${gate.dbName.replace(/[^A-Za-z0-9_-]/g, '_')}`
	const removeElement = (): void => {
		element?.remove()
		element = null
	}

	const render = (
		message: string,
		buttons: Array<{ label: string; onClick: (button: HTMLButtonElement) => void }>,
	): void => {
		removeElement()
		const bar = document.createElement('div')
		bar.id = promptId
		bar.setAttribute('role', 'alertdialog')
		bar.setAttribute('aria-live', 'assertive')
		bar.style.cssText = BAR_STYLE
		const text = document.createElement('span')
		text.textContent = message
		bar.append(text)
		const actions = document.createElement('span')
		actions.style.cssText = 'display:flex;gap:8px'
		for (const spec of buttons) {
			const button = document.createElement('button')
			button.type = 'button'
			button.textContent = spec.label
			button.style.cssText = BUTTON_STYLE
			button.addEventListener('click', () => spec.onClick(button))
			actions.append(button)
		}
		if (buttons.length > 0) bar.append(actions)
		const host = document.body ?? document.documentElement
		host.append(bar)
		element = bar
	}

	const reloadButton = {
		label: 'Reload',
		onClick: (button: HTMLButtonElement) => {
			button.disabled = true
			context.reloadForNewBuild()
		},
	}

	const showSuperseded = (): void => {
		mode = 'superseded'
		// The offline shell's update UI, when the app shows its own for it.
		const offer = new CustomEvent('kora:update-available', {
			detail: { update: context.reloadForNewBuild, reason: 'build-superseded' },
			cancelable: true,
		})
		const handledByApp = !window.dispatchEvent(offer)
		if (handledByApp) {
			removeElement()
			return
		}
		render(SUPERSEDED_MESSAGE, [reloadButton])
	}

	return {
		superseded: showSuperseded,
		update(snapshot) {
			if (snapshot.newer !== null) {
				if (snapshot.unsaved) {
					mode = 'unsaved'
					render(UNSAVED_MESSAGE, [
						{ label: 'Retry', onClick: () => gate.retryNow() },
						{
							label: 'Export',
							onClick: () => {
								void exportUnsaved(gate)
							},
						},
					])
				} else if (mode === 'unsaved') {
					// The barrier succeeded: back to the reload prompt.
					showSuperseded()
				}
				return
			}
			const waiting = snapshot.waiting
			if (snapshot.state === 'waiting' && waiting) {
				mode = 'waiting'
				render(
					waiting.reason === 'unsaved-writes'
						? 'Another tab of this app is on an older version and needs attention: its latest changes are not saved yet. Switch to that tab.'
						: waiting.reason === 'legacy-build'
							? 'Close other tabs of this app, then reload.'
							: 'Another tab of this app is still open on an older version. Close it to continue.',
					[],
				)
				return
			}
			if (snapshot.state === 'open' && (mode === 'waiting' || mode === 'blocked')) {
				mode = 'none'
				removeElement()
			}
		},
		blocked(message) {
			if (mode === 'superseded' || mode === 'unsaved') return
			mode = 'blocked'
			render(message, [])
		},
		remove() {
			removeElement()
		},
	}
}

/** Download the retiring tab's in-memory database (the explicit recovery path). */
async function exportUnsaved(gate: VersionGate): Promise<void> {
	try {
		const dump = await gate.exportRecoveryDump()
		if (dump === null) return
		const blob = new Blob([JSON.stringify(dump)], { type: 'application/json' })
		const url = URL.createObjectURL(blob)
		const link = document.createElement('a')
		link.href = url
		link.download = `${gate.dbName}-unsaved-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
		document.body.append(link)
		link.click()
		link.remove()
		setTimeout(() => URL.revokeObjectURL(url), 10_000)
	} catch (error) {
		console.error('[kora] Exporting the unsaved database failed:', error)
	}
}
