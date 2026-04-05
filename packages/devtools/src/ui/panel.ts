import type { TimestampedEvent } from '../types'
import { buildPanelModel } from './panel-state'

export function renderDevtoolsPanel(target: HTMLElement, events: readonly TimestampedEvent[]): void {
	const model = buildPanelModel(events)

	target.innerHTML = [
		'<section data-panel="timeline"><h2>Sync Timeline</h2>',
		`<p>Total events: ${model.timeline.length}</p>`,
		'<ul>',
		...model.timeline.slice(-20).map(
			(item) =>
				`<li><span style="color:${item.color}">${item.type}</span> · ${escapeHtml(item.label)}</li>`,
		),
		'</ul></section>',
		'<section data-panel="conflicts"><h2>Conflict Inspector</h2>',
		`<p>Conflicts: ${model.conflicts.length}</p>`,
		'<ul>',
		...model.conflicts
			.slice(-20)
			.map(
				(item) =>
					`<li>${escapeHtml(item.collection)}.${escapeHtml(item.field)} · ${escapeHtml(item.strategy)} · tier ${item.tier}</li>`,
			),
		'</ul></section>',
		'<section data-panel="operations"><h2>Operation Log</h2>',
		`<p>Operations: ${model.operations.length}</p>`,
		'<ul>',
		...model.operations.slice(-20).map(
			(item) =>
				`<li>${escapeHtml(item.opType)} ${escapeHtml(item.collection)}/${escapeHtml(item.recordId)} (${escapeHtml(item.operationId)})</li>`,
		),
		'</ul></section>',
		'<section data-panel="network"><h2>Network Status</h2>',
		`<p>Connected: ${model.network.connected ? 'yes' : 'no'}</p>`,
		`<p>Pending ACKs: ${model.network.pendingAcks}</p>`,
		`<p>Sent ops: ${model.network.sentOps}</p>`,
		`<p>Received ops: ${model.network.receivedOps}</p>`,
		'</section>',
	].join('')
}

function escapeHtml(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
