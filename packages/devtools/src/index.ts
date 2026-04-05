// === Core ===
export { Instrumenter } from './instrumenter/instrumenter'
export { EventBuffer } from './buffer/event-buffer'
export { MessageBridge } from './bridge/message-bridge'

// === Filtering & Stats ===
export { filterEvents, getEventCategory } from './filter/event-filter'
export { computeStatistics } from './stats/event-stats'

// === DevTools UI / Extension ===
export { buildPanelModel } from './ui/panel-state'
export { renderDevtoolsPanel } from './ui/panel'
export { PortRouter } from './extension/port-router'

// === Types ===
export type {
	DevtoolsConfig,
	EventCategory,
	EventFilterCriteria,
	EventStatistics,
	TimestampedEvent,
} from './types'
