/// <reference lib="dom" />
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
		// The placeholder of a build whose files were never stamped is not an id.
		if (content && content !== '__KORA_BUILD_ID__') return content
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
	/** Resolves false when the reload was deferred (see `reloadIntoNewestBuild`). */
	reloadForNewBuild: () => unknown
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
			// A permanent fence first: the engine is destroyed (not just stopped), so a start
			// or reconnect already in flight (an auth change, a connect() that passed its check
			// before supersession) never opens a session or touches persisted sync state.
			const coordinator = syncState.authSyncCoordinator
			coordinator?.destroy()
			const engine = syncState.syncEngine
			if (engine) {
				try {
					await engine.destroy()
				} catch (error) {
					console.warn('[kora] Stopping sync while retiring this tab failed:', error)
				}
			}
			// Then let those attempts finish (bounded) before the tab lock is released.
			await settledWithin(
				[coordinator?.whenIdle(), ...(syncState.syncAttempts ?? [])].filter(
					(attempt): attempt is Promise<unknown> => attempt !== undefined,
				),
				SYNC_ATTEMPT_DRAIN_MS,
			)
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

/** Options of {@link reloadIntoNewestBuild} (tests). */
export interface ReloadIntoNewestBuildOptions {
	/** How long to wait for a new service worker to install or take control. Default 10 s. */
	timeoutMs?: number
}

/**
 * The service workers that served this page's own build: the one controlling it when it
 * loaded, or (a page loaded uncontrolled, the shell's first install) the registration's
 * workers at that time, which then claim it. A reload served by one of them brings this
 * page's (old) build back.
 */
const pageOwnWorkers = new WeakSet<object>()
let pageWorkersRecorded: Promise<void> | null = null

/**
 * Record which service workers served this page's build. `createApp()` calls it once per
 * page, as early as possible; {@link reloadIntoNewestBuild} never reloads under them.
 */
export function recordPageServiceWorkers(): Promise<void> {
	if (pageWorkersRecorded) return pageWorkersRecorded
	const container = (globalThis as { navigator?: { serviceWorker?: ServiceWorkerContainer } })
		.navigator?.serviceWorker
	if (!container) {
		pageWorkersRecorded = Promise.resolve()
		return pageWorkersRecorded
	}
	const controller = container.controller
	if (controller) {
		pageOwnWorkers.add(controller)
		pageWorkersRecorded = Promise.resolve()
		return pageWorkersRecorded
	}
	pageWorkersRecorded =
		typeof container.getRegistration === 'function'
			? container
					.getRegistration()
					.then((registration) => {
						// Uncontrolled at load (first install, or a hard reload): the active worker and
						// the one installing are this build's or older; a waiting one may be newer.
						for (const worker of [registration?.active, registration?.installing]) {
							if (worker) pageOwnWorkers.add(worker)
						}
					})
					.catch(() => undefined)
			: Promise.resolve()
	return pageWorkersRecorded
}

/** @internal Tests: forget what {@link recordPageServiceWorkers} recorded. */
export function resetPageServiceWorkersForTests(): void {
	pageWorkersRecorded = null
}

/** Whether a reload now would be served by a worker of this page's own (old) build. */
function controlledByOwnBuild(container: ServiceWorkerContainer): boolean {
	const controller = container.controller
	return controller !== null && controller !== undefined && pageOwnWorkers.has(controller)
}

/**
 * Reload the page into the newest deployed build. Under the offline shell
 * (`koraServiceWorker()`), a plain reload is served by the active service worker, which
 * may still be the old build's (the newer tab was loaded with a hard reload or online
 * bypass): the old build would come back with a higher open order and, under the rollback
 * rule, supersede the genuinely newer tab. So first ask the registration for an update,
 * activate the waiting worker (`KORA_SW_SKIP_WAITING`, what the shell's own update prompt
 * posts) and reload once it controls the page. Without a service worker, a plain reload.
 *
 * When no newer worker is ready (offline, a failed or timed-out update check) and the page
 * is still controlled by the worker that served its own build, it does not reload: that
 * worker would serve the old build again. It resolves false and the tab stays open with
 * its prompt (Retry); the user can try again once the newer worker is there.
 *
 * @returns true when the reload was requested, false when it was deferred
 */
export async function reloadIntoNewestBuild(
	options: ReloadIntoNewestBuildOptions = {},
): Promise<boolean> {
	const timeoutMs = options.timeoutMs ?? 10_000
	const page = (globalThis as { location?: { reload?: () => void } }).location
	const reload = (): void => {
		if (typeof page?.reload === 'function') page.reload()
	}
	const container = (globalThis as { navigator?: { serviceWorker?: ServiceWorkerContainer } })
		.navigator?.serviceWorker
	if (!container || typeof container.getRegistration !== 'function') {
		reload()
		return true
	}
	await recordPageServiceWorkers()
	// A reload served by this page's own worker brings its old build back: never do that.
	const reloadUnlessOwnBuild = (): boolean => {
		if (controlledByOwnBuild(container)) {
			console.warn(
				'[kora] The new version is not ready in this browser yet (its service worker is not installed); not reloading into the old version. Try again in a moment.',
			)
			return false
		}
		reload()
		return true
	}
	let registration: ServiceWorkerRegistration | undefined
	try {
		registration = await container.getRegistration()
	} catch (error) {
		console.warn('[kora] Reading the service worker registration failed:', error)
	}
	if (!registration) return reloadUnlessOwnBuild()
	try {
		// The newer build's worker may not be known to this tab yet: check the server now,
		// bounded (a stalled link, a captive portal), then use what is already installed.
		const checked = await withTimeout(registration.update(), timeoutMs)
		if (!checked) console.warn('[kora] Checking for a newer service worker timed out.')
	} catch (error) {
		// Offline, or the worker script cannot be fetched: use what is already installed.
		console.warn('[kora] Checking for a newer service worker failed:', error)
	}
	const waiting =
		registration.waiting ?? (await installedWorker(registration.installing, timeoutMs))
	if (!waiting) {
		// No newer worker: reload only when the page is no longer controlled by its own
		// build's worker (the active worker is a newer one, or none controls the page).
		return reloadUnlessOwnBuild()
	}
	await new Promise<void>((resolve) => {
		const done = (): void => {
			clearTimeout(timer)
			container.removeEventListener('controllerchange', done)
			resolve()
		}
		const timer = setTimeout(done, timeoutMs)
		container.addEventListener('controllerchange', done)
		waiting.postMessage({ type: 'KORA_SW_SKIP_WAITING' })
	})
	// The newer worker took control (controllerchange), or it did not within the timeout:
	// then the page may still be under its own build's worker.
	return reloadUnlessOwnBuild()
}

/** Whether `promise` settled within `ms` (its rejection propagates); false on timeout. */
function withTimeout(promise: Promise<unknown>, ms: number): Promise<boolean> {
	return new Promise<boolean>((resolve, reject) => {
		const timer = setTimeout(() => resolve(false), ms)
		promise.then(
			() => {
				clearTimeout(timer)
				resolve(true)
			},
			(error: unknown) => {
				clearTimeout(timer)
				reject(error)
			},
		)
	})
}

/** `worker` once it finished installing (waiting to activate), or null. */
function installedWorker(
	worker: ServiceWorker | null,
	timeoutMs: number,
): Promise<ServiceWorker | null> {
	if (!worker) return Promise.resolve(null)
	if (worker.state === 'installed') return Promise.resolve(worker)
	return new Promise<ServiceWorker | null>((resolve) => {
		const done = (result: ServiceWorker | null): void => {
			clearTimeout(timer)
			worker.removeEventListener('statechange', onState)
			resolve(result)
		}
		const onState = (): void => {
			if (worker.state === 'installed') done(worker)
			else if (worker.state === 'redundant' || worker.state === 'activated') done(null)
		}
		const timer = setTimeout(() => done(null), timeoutMs)
		worker.addEventListener('statechange', onState)
	})
}

/** How long retirement waits for in-flight sync attempts after the engine is destroyed. */
const SYNC_ATTEMPT_DRAIN_MS = 5000

/** Resolves when every promise settled, or after `ms`, whichever is first. */
function settledWithin(promises: Array<Promise<unknown>>, ms: number): Promise<void> {
	if (promises.length === 0) return Promise.resolve()
	return new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms)
		void Promise.allSettled(promises).then(() => {
			clearTimeout(timer)
			resolve()
		})
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

/** Message of the default prompt when the reload had to wait for the new version. */
export const RELOAD_DEFERRED_MESSAGE =
	'The new version is still downloading in this browser. Try again in a moment.'

/** Message of the default prompt in a superseded tab (design section 5, step 1). */
export const SUPERSEDED_MESSAGE = 'A new version of this app is available. Reload to continue.'
/** The generic text of {@link unsavedMessage}. */
export const UNSAVED_MESSAGE = 'Your latest changes are not saved yet. Retry, or Export them.'

/**
 * Message of the default prompt while a failed barrier holds retirement (step 4), by the
 * `code` of the barrier's last `store:persistence-error`: storage full, no storage worker
 * left, or (any other code) the generic text.
 */
export function unsavedMessage(code: string | null): string {
	if (code === 'QUOTA_EXCEEDED') {
		return 'Your latest changes are not saved yet: storage is full. Free up space, then Retry, or Export them.'
	}
	if (code === 'STORAGE_UNAVAILABLE') {
		return 'Your latest changes are not saved yet: this tab lost its connection to the local database. Retry, or Export them.'
	}
	return UNSAVED_MESSAGE
}

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
	// The reason of the retirement barrier's last failure (`store:persistence-error` code,
	// emitted just before the gate reports unsaved writes).
	let unsavedCode: string | null = null
	const stopListening = context.emitter.on('store:persistence-error', (event) => {
		if (event.dbName === gate.dbName) unsavedCode = event.code
	})
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
			void Promise.resolve(context.reloadForNewBuild()).then((reloading) => {
				if (reloading !== false) return
				// Deferred: the new version is not installed in this browser yet.
				render(RELOAD_DEFERRED_MESSAGE, [{ ...reloadButton, label: 'Try again' }])
			})
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
					render(unsavedMessage(unsavedCode), [
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
			stopListening()
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
