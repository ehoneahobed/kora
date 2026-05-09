import htm from 'htm'
import { h, render } from 'preact'
import { useCallback, useMemo, useState } from 'preact/hooks'

import { filterEvents } from '../filter/event-filter'
import { computeStatistics } from '../stats/event-stats'
import type { EventCategory, TimestampedEvent } from '../types'
import { eventTypeToCategory } from '../types'
import { formatTime, formatValue, truncate } from './components'
import { buildPanelModel } from './panel-state'
import type {
	ConflictItem,
	DevtoolsPanelModel,
	NetworkStatusModel,
	OperationItem,
	TimelineItem,
} from './panel-state'

const html = htm.bind(h)

// ============================================================================
// Types
// ============================================================================

type ActiveTab = 'timeline' | 'conflicts' | 'operations' | 'network'

const ALL_CATEGORIES: EventCategory[] = ['operation', 'merge', 'sync', 'query', 'connection']

// ============================================================================
// Main Panel Component
// ============================================================================

function DevToolsPanel({ events }: { events: readonly TimestampedEvent[] }) {
	const [activeTab, setActiveTab] = useState<ActiveTab>('timeline')
	const [search, setSearch] = useState('')
	const [categories, setCategories] = useState<Set<EventCategory>>(() => new Set(ALL_CATEGORIES))
	const [expanded, setExpanded] = useState<Set<number>>(() => new Set())
	const [paused, setPaused] = useState(false)

	const toggleCategory = useCallback((cat: EventCategory) => {
		setCategories((prev) => {
			const next = new Set(prev)
			if (next.has(cat)) next.delete(cat)
			else next.add(cat)
			return next
		})
	}, [])

	const toggleExpand = useCallback((id: number) => {
		setExpanded((prev) => {
			const next = new Set(prev)
			if (next.has(id)) next.delete(id)
			else next.add(id)
			return next
		})
	}, [])

	const filtered = useMemo(
		() => filterEvents(events, { categories: [...categories] }),
		[events, categories],
	)

	const model = useMemo(() => buildPanelModel(filtered), [filtered])
	const stats = useMemo(() => computeStatistics(events), [events])

	return html`
		<div class="kora-devtools">
			<${Toolbar}
				activeTab=${activeTab}
				onTabChange=${setActiveTab}
				totalEvents=${events.length}
				conflicts=${stats.mergeConflicts}
				search=${search}
				onSearchChange=${setSearch}
				paused=${paused}
				onPauseToggle=${() => setPaused((p: boolean) => !p)}
				onClear=${() => setExpanded(new Set())}
				categories=${categories}
				onToggleCategory=${toggleCategory}
			/>
			<div class="kora-content">
				${
					activeTab === 'timeline' &&
					html`<${TimelinePanel}
					items=${model.timeline}
					search=${search}
					expanded=${expanded}
					onToggle=${toggleExpand}
				/>`
				}
				${
					activeTab === 'conflicts' &&
					html`<${ConflictsPanel}
					items=${model.conflicts}
					search=${search}
					expanded=${expanded}
					onToggle=${toggleExpand}
				/>`
				}
				${
					activeTab === 'operations' &&
					html`<${OperationsPanel}
					items=${model.operations}
					search=${search}
					expanded=${expanded}
					onToggle=${toggleExpand}
				/>`
				}
				${
					activeTab === 'network' &&
					html`<${NetworkPanel} network=${model.network} events=${events} />`
				}
			</div>
		</div>
	`
}

// ============================================================================
// Toolbar
// ============================================================================

function Toolbar({
	activeTab,
	onTabChange,
	totalEvents,
	conflicts,
	search,
	onSearchChange,
	paused,
	onPauseToggle,
	onClear,
	categories,
	onToggleCategory,
}: {
	activeTab: ActiveTab
	onTabChange: (tab: ActiveTab) => void
	totalEvents: number
	conflicts: number
	search: string
	onSearchChange: (s: string) => void
	paused: boolean
	onPauseToggle: () => void
	onClear: () => void
	categories: Set<EventCategory>
	onToggleCategory: (cat: EventCategory) => void
}) {
	const tabs: Array<{ id: ActiveTab; label: string; badge?: number }> = [
		{ id: 'timeline', label: 'Timeline', badge: totalEvents },
		{ id: 'conflicts', label: 'Conflicts', badge: conflicts },
		{ id: 'operations', label: 'Operations' },
		{ id: 'network', label: 'Network' },
	]

	return html`
		<div class="kora-toolbar">
			<div class="kora-tabs">
				${tabs.map(
					(tab) => html`
						<button
							class="kora-tab${activeTab === tab.id ? ' active' : ''}"
							onClick=${() => onTabChange(tab.id)}
						>
							${tab.label}
							${
								tab.badge != null && tab.badge > 0
									? html`<span class="kora-badge">${tab.badge}</span>`
									: null
							}
						</button>
					`,
				)}
			</div>
			<div class="kora-controls">
				<input
					type="text"
					class="kora-search"
					placeholder="Filter..."
					value=${search}
					onInput=${(e: Event) => onSearchChange((e.target as HTMLInputElement).value)}
				/>
				<button class="kora-btn" onClick=${onPauseToggle}>
					${paused ? 'Resume' : 'Pause'}
				</button>
				<button class="kora-btn" onClick=${onClear}>Clear</button>
				${ALL_CATEGORIES.map(
					(cat) => html`
						<button
							class="kora-cat-toggle${categories.has(cat) ? ' active' : ''}"
							onClick=${() => onToggleCategory(cat)}
						>
							${cat}
						</button>
					`,
				)}
			</div>
		</div>
	`
}

// ============================================================================
// Timeline Panel
// ============================================================================

function TimelinePanel({
	items,
	search,
	expanded,
	onToggle,
}: {
	items: TimelineItem[]
	search: string
	expanded: Set<number>
	onToggle: (id: number) => void
}) {
	const lowerSearch = search.toLowerCase()
	const filtered = lowerSearch
		? items.filter(
				(i) =>
					i.label.toLowerCase().includes(lowerSearch) || i.type.toLowerCase().includes(lowerSearch),
			)
		: items

	const visible = filtered.slice(-200).reverse()

	if (visible.length === 0) {
		return html`<div class="kora-panel"><div class="kora-empty">No events recorded yet.</div></div>`
	}

	return html`
		<div class="kora-panel kora-timeline">
			<div class="kora-summary">Showing ${visible.length} of ${items.length} events</div>
			<div class="kora-event-list">
				${visible.map(
					(item) => html`
						<div
							key=${item.id}
							class="kora-row${expanded.has(item.id) ? ' expanded' : ''}"
							onClick=${() => onToggle(item.id)}
						>
							<span class="kora-time">${formatTime(item.receivedAt)}</span>
							<span class="kora-dot" style="background:${item.color}"></span>
							<span class="kora-type">${item.type}</span>
							<span class="kora-label">${item.label}</span>
							${
								item.dependsOn.length > 0
									? html`<span class="kora-deps">deps: ${item.dependsOn.length}</span>`
									: null
							}
						</div>
						${
							expanded.has(item.id)
								? html`
									<div class="kora-detail">
										<div>
											<span class="kora-detail-label">Event ID:</span> ${item.id}
										</div>
										<div>
											<span class="kora-detail-label">Received:</span>
											${new Date(item.receivedAt).toISOString()}
										</div>
										${
											item.dependsOn.length > 0
												? html`<div>
													<span class="kora-detail-label">Causal deps:</span>
													${item.dependsOn.join(', ')}
												</div>`
												: null
										}
									</div>
								`
								: null
						}
					`,
				)}
			</div>
		</div>
	`
}

// ============================================================================
// Conflicts Panel
// ============================================================================

function ConflictsPanel({
	items,
	search,
	expanded,
	onToggle,
}: {
	items: ConflictItem[]
	search: string
	expanded: Set<number>
	onToggle: (id: number) => void
}) {
	const lowerSearch = search.toLowerCase()
	const filtered = lowerSearch
		? items.filter(
				(i) =>
					i.collection.toLowerCase().includes(lowerSearch) ||
					i.field.toLowerCase().includes(lowerSearch) ||
					i.strategy.toLowerCase().includes(lowerSearch),
			)
		: items

	const visible = filtered.slice(-100).reverse()

	if (visible.length === 0) {
		return html`<div class="kora-panel"><div class="kora-empty">No merge conflicts detected.</div></div>`
	}

	return html`
		<div class="kora-panel kora-conflicts">
			<div class="kora-summary">
				${items.length} conflict${items.length !== 1 ? 's' : ''}
			</div>
			<table class="kora-table">
				<thead>
					<tr>
						<th>Time</th>
						<th>Collection</th>
						<th>Field</th>
						<th>Strategy</th>
						<th>Tier</th>
						<th>Result</th>
					</tr>
				</thead>
				<tbody>
					${visible.map(
						(item) => html`
							<tr
								key=${item.id}
								class="kora-conflict-row${item.constraintViolated ? ' violated' : ''}${expanded.has(item.id) ? ' expanded' : ''}"
								onClick=${() => onToggle(item.id)}
							>
								<td>${formatTime(item.timestamp)}</td>
								<td>${item.collection}</td>
								<td class="kora-mono">${item.field}</td>
								<td>
									<span class="kora-strategy tier-${item.tier}">${item.strategy}</span>
								</td>
								<td>${item.tier}</td>
								<td class="kora-mono">${truncate(String(item.output), 30)}</td>
							</tr>
							${
								expanded.has(item.id)
									? html`
										<tr class="kora-detail-row">
											<td colspan="6">
												<div class="kora-conflict-detail">
													<div class="kora-comparison">
														<div class="kora-value-box">
															<div class="kora-value-label">Input A (local)</div>
															<pre class="kora-value-code">
${formatValue(item.inputA)}</pre
															>
														</div>
														<div class="kora-value-box">
															<div class="kora-value-label">Input B (remote)</div>
															<pre class="kora-value-code">
${formatValue(item.inputB)}</pre
															>
														</div>
														<div class="kora-value-box result">
															<div class="kora-value-label">Result</div>
															<pre class="kora-value-code">
${formatValue(item.output)}</pre
															>
														</div>
													</div>
													${
														item.constraintViolated
															? html`<div class="kora-constraint-warning">
																Constraint violated: ${item.constraintViolated}
															</div>`
															: null
													}
												</div>
											</td>
										</tr>
									`
									: null
							}
						`,
					)}
				</tbody>
			</table>
		</div>
	`
}

// ============================================================================
// Operations Panel
// ============================================================================

function OperationsPanel({
	items,
	search,
	expanded,
	onToggle,
}: {
	items: OperationItem[]
	search: string
	expanded: Set<number>
	onToggle: (id: number) => void
}) {
	const lowerSearch = search.toLowerCase()
	const filtered = lowerSearch
		? items.filter(
				(i) =>
					i.collection.toLowerCase().includes(lowerSearch) ||
					i.recordId.toLowerCase().includes(lowerSearch) ||
					i.operationId.toLowerCase().includes(lowerSearch) ||
					i.opType.toLowerCase().includes(lowerSearch),
			)
		: items

	const visible = filtered.slice(-200).reverse()

	if (visible.length === 0) {
		return html`<div class="kora-panel"><div class="kora-empty">No operations recorded yet.</div></div>`
	}

	return html`
		<div class="kora-panel kora-operations">
			<div class="kora-summary">
				Showing ${visible.length} of ${items.length} operations
			</div>
			<div class="kora-op-list">
				${visible.map(
					(item) => html`
						<div
							key=${item.id}
							class="kora-op-row${expanded.has(item.id) ? ' expanded' : ''}"
							onClick=${() => onToggle(item.id)}
						>
							<span class="kora-time">${formatTime(item.timestamp)}</span>
							<span class="kora-op-type op-${item.opType}">${item.opType}</span>
							<span class="kora-op-collection">${item.collection}</span>
							<span class="kora-op-record kora-mono"
								>${truncate(item.recordId, 12)}</span
							>
							<span class="kora-op-node">node:${truncate(item.nodeId, 8)}</span>
							<span class="kora-op-seq">#${item.sequenceNumber}</span>
						</div>
						${
							expanded.has(item.id)
								? html`
									<div class="kora-op-detail">
										<div>
											<span class="kora-detail-label">Operation ID:</span>
											<span class="kora-mono">${item.operationId}</span>
										</div>
										<div>
											<span class="kora-detail-label">Node:</span>
											<span class="kora-mono">${item.nodeId}</span>
										</div>
										<div>
											<span class="kora-detail-label">Sequence:</span>
											${item.sequenceNumber}
										</div>
										${
											item.causalDeps.length > 0
												? html`<div>
													<span class="kora-detail-label">Causal deps:</span>
													<span class="kora-mono"
														>${item.causalDeps.join(', ')}</span
													>
												</div>`
												: null
										}
										${
											item.data
												? html`<div>
													<div class="kora-detail-label">Data:</div>
													<pre class="kora-value-code">
${JSON.stringify(item.data, null, 2)}</pre
													>
												</div>`
												: null
										}
									</div>
								`
								: null
						}
					`,
				)}
			</div>
		</div>
	`
}

// ============================================================================
// Network Panel
// ============================================================================

function NetworkPanel({
	network,
	events,
}: {
	network: NetworkStatusModel
	events: readonly TimestampedEvent[]
}) {
	const statusClass = network.connected ? 'connected' : 'disconnected'
	const statusText = network.connected
		? network.quality
			? `Connected (${network.quality})`
			: 'Connected'
		: 'Disconnected'

	const syncEvents = events
		.filter((e) => {
			const cat = eventTypeToCategory(e.event.type)
			return cat === 'sync' || cat === 'connection'
		})
		.slice(-50)
		.reverse()

	return html`
		<div class="kora-panel kora-network">
			<div class="kora-network-status">
				<div class="kora-status-indicator ${statusClass}">
					<span class="kora-status-dot"></span>
					<span class="kora-status-text">${statusText}</span>
				</div>
			</div>

			<div class="kora-stats-grid">
				<${StatCard} label="Sent" value=${String(network.sentOps)} unit="ops" />
				<${StatCard} label="Received" value=${String(network.receivedOps)} unit="ops" />
				<${StatCard} label="Pending" value=${String(network.pendingAcks)} unit="acks" />
				<${StatCard}
					label="Last Sync"
					value=${network.lastSyncAt ? formatTime(network.lastSyncAt) : 'never'}
				/>
			</div>

			${
				network.versionVector.length > 0
					? html`
						<div class="kora-vv-section">
							<h3>Version Vector</h3>
							<table class="kora-table kora-vv-table">
								<thead>
									<tr>
										<th>Node</th>
										<th>Sequence</th>
									</tr>
								</thead>
								<tbody>
									${network.versionVector.map(
										(entry) => html`
											<tr key=${entry.nodeId}>
												<td class="kora-mono">${truncate(entry.nodeId, 16)}</td>
												<td>${entry.sequenceNumber}</td>
											</tr>
										`,
									)}
								</tbody>
							</table>
						</div>
					`
					: null
			}

			${
				syncEvents.length > 0
					? html`
						<div class="kora-sync-log">
							<h3>Recent Sync Activity</h3>
							<div class="kora-event-list">
								${syncEvents.map(
									(entry) => html`
										<div key=${entry.id} class="kora-row compact">
											<span class="kora-time"
												>${formatTime(entry.receivedAt)}</span
											>
											<span class="kora-type">${entry.event.type}</span>
										</div>
									`,
								)}
							</div>
						</div>
					`
					: null
			}
		</div>
	`
}

function StatCard({
	label,
	value,
	unit,
}: {
	label: string
	value: string
	unit?: string
}) {
	return html`
		<div class="kora-stat-card">
			<div class="kora-stat-value">${value}</div>
			<div class="kora-stat-label">${label}${unit ? ` (${unit})` : ''}</div>
		</div>
	`
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Render the DevTools panel into the target element using Preact.
 * Efficient re-renders via virtual DOM diffing.
 */
export function renderDevtoolsPanel(
	target: HTMLElement,
	events: readonly TimestampedEvent[],
): void {
	render(html`<${DevToolsPanel} events=${events} />`, target)
}
