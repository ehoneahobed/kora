import { KoraError } from '@korajs/core'

// ============================================================================
// Types
// ============================================================================

/**
 * Organization info returned by the server.
 */
export interface ClientOrganization {
	id: string
	name: string
	slug: string
	ownerId: string
	createdAt: number
	updatedAt: number
	metadata: Record<string, unknown>
}

/**
 * Membership info returned by the server.
 */
export interface ClientMembership {
	id: string
	orgId: string
	userId: string
	role: string
	invitedBy: string | null
	joinedAt: number
}

/**
 * Invitation info returned by the server.
 */
export interface ClientInvitation {
	id: string
	orgId: string
	email: string
	role: string
	invitedBy: string
	token: string
	createdAt: number
	expiresAt: number
	status: string
}

/**
 * Configuration for the OrgClient.
 */
export interface OrgClientConfig {
	/** Base URL of the auth/org server */
	serverUrl: string
	/** Function that returns a valid access token for authenticated requests */
	getAccessToken: () => Promise<string | null>
}

/**
 * Thrown when an org operation fails.
 */
export class OrgClientError extends KoraError {
	constructor(message: string, code: string, context?: Record<string, unknown>) {
		super(message, code, context)
		this.name = 'OrgClientError'
	}
}

// ============================================================================
// OrgClient
// ============================================================================

/**
 * Client-side organization manager.
 *
 * Handles org CRUD, member management, invitations, and active org switching.
 * Framework-agnostic — works in any JavaScript environment with `fetch`.
 *
 * @example
 * ```typescript
 * const orgClient = new OrgClient({
 *   serverUrl: 'http://localhost:3001',
 *   getAccessToken: () => authClient.getAccessToken(),
 * })
 *
 * const org = await orgClient.createOrg({ name: 'Acme Inc', slug: 'acme' })
 * orgClient.switchOrg(org.id)
 * ```
 */
export class OrgClient {
	private readonly serverUrl: string
	private readonly getAccessToken: () => Promise<string | null>
	private readonly listeners = new Set<(orgId: string | null) => void>()

	private _activeOrgId: string | null = null
	private _activeOrg: ClientOrganization | null = null
	private _activeRole: string | null = null

	constructor(config: OrgClientConfig) {
		this.serverUrl = config.serverUrl.replace(/\/+$/, '')
		this.getAccessToken = config.getAccessToken
	}

	// --- Getters ---

	/** Currently active organization ID */
	get activeOrgId(): string | null {
		return this._activeOrgId
	}

	/** Currently active organization */
	get activeOrg(): ClientOrganization | null {
		return this._activeOrg
	}

	/** Current user's role in the active organization */
	get activeRole(): string | null {
		return this._activeRole
	}

	// --- Organization Operations ---

	/**
	 * Create a new organization.
	 */
	async createOrg(params: {
		name: string
		slug?: string
		metadata?: Record<string, unknown>
	}): Promise<ClientOrganization> {
		return this.request<ClientOrganization>('/orgs', {
			method: 'POST',
			body: params,
		})
	}

	/**
	 * List all organizations the current user belongs to.
	 */
	async listOrgs(): Promise<ClientOrganization[]> {
		return this.request<ClientOrganization[]>('/orgs', { method: 'GET' })
	}

	/**
	 * Get an organization by ID.
	 */
	async getOrg(orgId: string): Promise<ClientOrganization> {
		return this.request<ClientOrganization>(`/orgs/${orgId}`, { method: 'GET' })
	}

	/**
	 * Update an organization.
	 */
	async updateOrg(
		orgId: string,
		params: { name?: string; slug?: string; metadata?: Record<string, unknown> },
	): Promise<ClientOrganization> {
		const result = await this.request<ClientOrganization>(`/orgs/${orgId}`, {
			method: 'PATCH',
			body: params,
		})
		// Update cached active org if this is the active one
		if (this._activeOrgId === orgId) {
			this._activeOrg = result
		}
		return result
	}

	/**
	 * Delete an organization.
	 */
	async deleteOrg(orgId: string): Promise<void> {
		await this.request(`/orgs/${orgId}`, { method: 'DELETE' })
		if (this._activeOrgId === orgId) {
			this._activeOrgId = null
			this._activeOrg = null
			this._activeRole = null
			this.notifyListeners()
		}
	}

	// --- Org Switching ---

	/**
	 * Switch the active organization context.
	 * Fetches the org details and the user's membership/role.
	 */
	async switchOrg(orgId: string): Promise<void> {
		const org = await this.request<ClientOrganization>(`/orgs/${orgId}`, { method: 'GET' })
		const membership = await this.request<ClientMembership>(`/orgs/${orgId}/membership`, {
			method: 'GET',
		})

		this._activeOrgId = orgId
		this._activeOrg = org
		this._activeRole = membership.role
		this.notifyListeners()
	}

	/**
	 * Clear the active organization (no org selected).
	 */
	clearActiveOrg(): void {
		this._activeOrgId = null
		this._activeOrg = null
		this._activeRole = null
		this.notifyListeners()
	}

	// --- Member Management ---

	/**
	 * List members of an organization.
	 */
	async listMembers(orgId: string): Promise<ClientMembership[]> {
		return this.request<ClientMembership[]>(`/orgs/${orgId}/members`, { method: 'GET' })
	}

	/**
	 * Remove a member from an organization.
	 */
	async removeMember(orgId: string, userId: string): Promise<void> {
		await this.request(`/orgs/${orgId}/members/${userId}`, { method: 'DELETE' })
	}

	/**
	 * Update a member's role.
	 */
	async updateMemberRole(orgId: string, userId: string, role: string): Promise<ClientMembership> {
		return this.request<ClientMembership>(`/orgs/${orgId}/members/${userId}/role`, {
			method: 'PATCH',
			body: { role },
		})
	}

	/**
	 * Transfer ownership to another member.
	 */
	async transferOwnership(orgId: string, newOwnerId: string): Promise<void> {
		await this.request(`/orgs/${orgId}/transfer`, {
			method: 'POST',
			body: { newOwnerId },
		})
	}

	/**
	 * Leave an organization (remove yourself).
	 */
	async leaveOrg(orgId: string): Promise<void> {
		await this.request(`/orgs/${orgId}/leave`, { method: 'POST' })
		if (this._activeOrgId === orgId) {
			this._activeOrgId = null
			this._activeOrg = null
			this._activeRole = null
			this.notifyListeners()
		}
	}

	// --- Invitations ---

	/**
	 * Invite a user to an organization by email.
	 */
	async inviteMember(
		orgId: string,
		params: { email: string; role: string },
	): Promise<ClientInvitation> {
		return this.request<ClientInvitation>(`/orgs/${orgId}/invitations`, {
			method: 'POST',
			body: params,
		})
	}

	/**
	 * Accept an invitation by token.
	 */
	async acceptInvitation(token: string): Promise<ClientMembership> {
		return this.request<ClientMembership>('/invitations/accept', {
			method: 'POST',
			body: { token },
		})
	}

	/**
	 * List pending invitations for an organization.
	 */
	async listInvitations(orgId: string): Promise<ClientInvitation[]> {
		return this.request<ClientInvitation[]>(`/orgs/${orgId}/invitations`, { method: 'GET' })
	}

	/**
	 * Revoke a pending invitation.
	 */
	async revokeInvitation(orgId: string, invitationId: string): Promise<void> {
		await this.request(`/orgs/${orgId}/invitations/${invitationId}`, { method: 'DELETE' })
	}

	/**
	 * List pending invitations for the current user's email.
	 */
	async listMyInvitations(email: string): Promise<ClientInvitation[]> {
		return this.request<ClientInvitation[]>(`/invitations?email=${encodeURIComponent(email)}`, {
			method: 'GET',
		})
	}

	// --- Subscriptions ---

	/**
	 * Subscribe to active org changes.
	 * @returns Unsubscribe function
	 */
	onOrgChange(callback: (orgId: string | null) => void): () => void {
		this.listeners.add(callback)
		return () => {
			this.listeners.delete(callback)
		}
	}

	// --- Internal ---

	private notifyListeners(): void {
		for (const listener of this.listeners) {
			try {
				listener(this._activeOrgId)
			} catch {
				// Don't let listener errors break the notification loop
			}
		}
	}

	private async request<T = void>(
		path: string,
		options: {
			method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
			body?: Record<string, unknown>
		},
	): Promise<T> {
		const token = await this.getAccessToken()
		if (!token) {
			throw new OrgClientError(
				'Not authenticated. Sign in before performing organization operations.',
				'ORG_NOT_AUTHENTICATED',
			)
		}

		const url = `${this.serverUrl}${path}`
		const headers: Record<string, string> = {
			Authorization: `Bearer ${token}`,
		}
		if (options.body) {
			headers['Content-Type'] = 'application/json'
		}

		let response: Response
		try {
			response = await fetch(url, {
				method: options.method,
				headers,
				body: options.body ? JSON.stringify(options.body) : undefined,
			})
		} catch (cause) {
			throw new OrgClientError(`Network request to ${path} failed.`, 'ORG_NETWORK_ERROR', {
				path,
				cause: cause instanceof Error ? cause.message : String(cause),
			})
		}

		if (!response.ok) {
			let errorMessage = `Server returned HTTP ${response.status}`
			try {
				const body = (await response.json()) as Record<string, unknown>
				if (typeof body.error === 'string') {
					errorMessage = body.error as string
				}
			} catch {
				// not JSON
			}
			throw new OrgClientError(errorMessage, 'ORG_SERVER_ERROR', {
				path,
				status: response.status,
			})
		}

		// Handle empty responses (DELETE, etc.)
		const text = await response.text()
		if (text.length === 0) return undefined as T

		try {
			const body = JSON.parse(text)
			// Unwrap { data: ... } envelope if present
			if (body && typeof body === 'object' && 'data' in body) {
				return body.data as T
			}
			return body as T
		} catch {
			return undefined as T
		}
	}
}
