import { describe, expect, it, vi } from 'vitest'
import { type FallbackCredentialStorage, createTauriCredentialStore } from './credential-store'
import type { InvokeFn } from './tauri-sqlite-adapter'

function fakeKeychain() {
	const entries = new Map<string, string>()
	const calls: string[] = []
	const invoke = (async (cmd: string, args?: Record<string, unknown>) => {
		calls.push(cmd)
		const key = String(args?.key)
		if (cmd === 'plugin:kora-sqlite|credential_get') return entries.get(key) ?? null
		if (cmd === 'plugin:kora-sqlite|credential_set') {
			entries.set(key, String(args?.value))
			return null
		}
		if (cmd === 'plugin:kora-sqlite|credential_delete') {
			entries.delete(key)
			return null
		}
		throw new Error(`unknown command ${cmd}`)
	}) as InvokeFn
	return { entries, calls, invoke }
}

function webStorage(initial: Record<string, string> = {}): FallbackCredentialStorage & {
	map: Map<string, string>
} {
	const map = new Map(Object.entries(initial))
	return {
		map,
		getItem: (key) => map.get(key) ?? null,
		setItem: (key, value) => void map.set(key, value),
		removeItem: (key) => void map.delete(key),
	}
}

describe('createTauriCredentialStore', () => {
	it('keeps credentials in the keychain, never in WebView storage', async () => {
		const keychain = fakeKeychain()
		const web = webStorage()
		const store = createTauriCredentialStore({ invoke: keychain.invoke, fallback: web })
		await store.setItem('kora_auth_refresh_token', 'r1')
		expect(keychain.entries.get('kora_auth_refresh_token')).toBe('r1')
		expect(web.map.size).toBe(0)
		expect(await store.getItem('kora_auth_refresh_token')).toBe('r1')
		expect(store.location).toBe('keychain')
		await store.removeItem('kora_auth_refresh_token')
		expect(keychain.entries.size).toBe(0)
		expect(await store.getItem('kora_auth_refresh_token')).toBeNull()
	})

	it('moves a session an earlier version saved in WebView storage, so the device stays signed in', async () => {
		const keychain = fakeKeychain()
		const web = webStorage({ kora_auth_refresh_token: 'old' })
		const store = createTauriCredentialStore({ invoke: keychain.invoke, fallback: web })
		expect(await store.getItem('kora_auth_refresh_token')).toBe('old')
		expect(keychain.entries.get('kora_auth_refresh_token')).toBe('old')
		expect(web.map.has('kora_auth_refresh_token')).toBe(false)
	})

	it('serves repeat reads without another keychain round trip', async () => {
		const keychain = fakeKeychain()
		const store = createTauriCredentialStore({ invoke: keychain.invoke, fallback: webStorage() })
		await store.setItem('k', 'v')
		const before = keychain.calls.length
		expect(await store.getItem('k')).toBe('v')
		expect(await store.getItem('k')).toBe('v')
		expect(keychain.calls.length).toBe(before)
	})

	it('falls back to WebView storage, once and with a warning, where there is no credential store', async () => {
		const invoke = vi.fn(async () => {
			throw 'CREDENTIAL_STORE_UNAVAILABLE: No default store has been set'
		}) as unknown as InvokeFn
		const web = webStorage()
		const onFallback = vi.fn()
		const store = createTauriCredentialStore({ invoke, fallback: web, onFallback })
		await store.setItem('k', 'v')
		expect(web.map.get('k')).toBe('v')
		expect(await store.getItem('k')).toBe('v')
		expect(store.location).toBe('fallback')
		expect(onFallback).toHaveBeenCalledTimes(1)
		expect(invoke).toHaveBeenCalledTimes(1)
	})

	it('falls back when the app has not granted the credential commands', async () => {
		const invoke = (async () => {
			throw 'kora-sqlite.credential_get not allowed. Permissions associated with this command: kora-sqlite:allow-credential-get'
		}) as InvokeFn
		const store = createTauriCredentialStore({
			invoke,
			fallback: webStorage({ k: 'v' }),
			onFallback: () => {},
		})
		expect(await store.getItem('k')).toBe('v')
		expect(store.location).toBe('fallback')
	})

	it('reports any other keychain failure instead of hiding it', async () => {
		const invoke = (async () => {
			throw 'CREDENTIAL_ERROR: Attribute too long'
		}) as InvokeFn
		const store = createTauriCredentialStore({
			invoke,
			fallback: webStorage(),
			onFallback: () => {},
		})
		await expect(store.setItem('k', 'v')).rejects.toThrow('Credential store credential_set failed')
	})
})
