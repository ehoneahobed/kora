---
title: DevTools API
description: "@korajs/devtools API reference: instrumentation events, the DevTools bridge, and embedding the in-page overlay."
---

# DevTools API Reference

`@korajs/devtools` instruments a Kora application and feeds events to a browser DevTools panel for real-time inspection of operations, merges, conflicts, sync activity, and network status.

## Imports

```typescript
import {
  Instrumenter,
  EventBuffer,
  MessageBridge,
  filterEvents,
  getEventCategory,
  computeStatistics,
  buildPanelModel,
  renderDevtoolsPanel,
  PortRouter,
} from '@korajs/devtools'

import type {
  DevtoolsConfig,
  EventCategory,
  EventFilterCriteria,
  EventStatistics,
  TimestampedEvent,
} from '@korajs/devtools'
```

## `Instrumenter`

Core orchestrator. Attaches to a `KoraEventEmitter`, records all emitted events into a ring buffer with sequential IDs and reception timestamps, and optionally forwards them through a `MessageBridge` for consumption by a DevTools panel.

### Constructor

```typescript
new Instrumenter(emitter: KoraEventEmitter, config?: DevtoolsConfig)
```

The instrumenter subscribes to all 15 `KoraEventType` values on the emitter and begins recording immediately.

### Methods

- `getBuffer(): EventBuffer` -- returns the underlying event buffer.
- `getBridge(): MessageBridge | null` -- returns the message bridge, or `null` if `bridgeEnabled` is `false`.
- `pause(): void` -- temporarily stop recording. Events emitted while paused are dropped.
- `resume(): void` -- resume recording after a pause.
- `isPaused(): boolean` -- whether the instrumenter is currently paused.
- `destroy(): void` -- detach all listeners from the emitter and destroy the bridge. After calling destroy the instrumenter is inert.

### Example

```typescript
const instrumenter = new Instrumenter(app.emitter, { bufferSize: 5000 })
const buffer = instrumenter.getBuffer()
// ... later
instrumenter.destroy()
```

## `EventBuffer`

Fixed-capacity ring buffer for storing timestamped events. When the buffer is full, the oldest events are evicted to make room for new ones.

### Constructor

```typescript
new EventBuffer(capacity?: number)  // default: 10000
```

Throws if `capacity` is less than 1.

### Properties

- `capacity: number` -- maximum number of events the buffer can hold.
- `size: number` -- current number of events in the buffer.

### Methods

- `push(event: TimestampedEvent): void` -- append an event. Evicts the oldest event when at capacity.
- `getAll(): readonly TimestampedEvent[]` -- returns all events in insertion order (oldest first).
- `getRange(start: number, end: number): readonly TimestampedEvent[]` -- returns events whose sequential IDs fall within `[start, end]` (inclusive).
- `getByType(type: KoraEventType): readonly TimestampedEvent[]` -- returns events matching a specific event type.
- `clear(): void` -- remove all events from the buffer.

## `MessageBridge`

Communicates between the page context and a DevTools panel via `window.postMessage`. All messages are namespaced with a `source` field to avoid collisions. Safe to instantiate in non-browser environments (SSR/Node) -- all operations become no-ops when `window` is not available.

### Constructor

```typescript
new MessageBridge(channelName?: string)  // default: 'kora-devtools'
```

### Methods

- `send(event: TimestampedEvent): void` -- post a timestamped event through the bridge. No-op if window is unavailable or the bridge has been destroyed.
- `onReceive(callback: (event: TimestampedEvent) => void): () => void` -- register a callback for events received through the bridge. Returns an unsubscribe function.
- `destroy(): void` -- remove all listeners and detach from window. After calling destroy all operations become no-ops.

## Event Filtering

### `filterEvents(events, criteria)`

Filters a list of timestamped events by the given criteria. All criteria are combined with AND logic. Returns all events if no criteria are specified.

```typescript
function filterEvents(
  events: readonly TimestampedEvent[],
  criteria: EventFilterCriteria,
): readonly TimestampedEvent[]
```

### `getEventCategory(type)`

Maps a `KoraEventType` to its `EventCategory`.

```typescript
function getEventCategory(type: KoraEventType): EventCategory
```

### Example

```typescript
import { filterEvents, getEventCategory } from '@korajs/devtools'

const mergeEvents = filterEvents(buffer.getAll(), {
  categories: ['merge'],
  timeRange: { start: Date.now() - 60_000, end: Date.now() },
})

getEventCategory('operation:created') // => 'operation'
getEventCategory('sync:sent')         // => 'sync'
```

## Statistics

### `computeStatistics(events)`

Computes aggregate statistics from a collection of timestamped events in a single pass.

```typescript
function computeStatistics(events: readonly TimestampedEvent[]): EventStatistics
```

Returns an `EventStatistics` object with counts by category and type, merge conflict and constraint violation counts, average merge/query durations, and sync operation totals.

## UI State

### `buildPanelModel(events)`

Transforms raw timestamped events into a structured model for the four DevTools panels: timeline, conflicts, operations, and network status.

```typescript
function buildPanelModel(events: readonly TimestampedEvent[]): DevtoolsPanelModel
```

Returns:

```typescript
interface DevtoolsPanelModel {
  timeline: TimelineItem[]
  conflicts: ConflictItem[]
  operations: OperationItem[]
  network: NetworkStatusModel
}
```

### `renderDevtoolsPanel(target, events)`

Renders the DevTools panel UI into the target element using Preact. Supports efficient re-renders via virtual DOM diffing. Contains four tabs: Timeline, Conflicts, Operations, and Network.

```typescript
function renderDevtoolsPanel(
  target: HTMLElement,
  events: readonly TimestampedEvent[],
): void
```

### Example

```typescript
import { buildPanelModel, renderDevtoolsPanel } from '@korajs/devtools'

// Programmatic access to panel data
const model = buildPanelModel(buffer.getAll())
console.log(model.network.connected, model.conflicts.length)

// Render the full UI into a DOM element
renderDevtoolsPanel(document.getElementById('devtools')!, buffer.getAll())
```

## `PortRouter`

Routes content-script events to the matching DevTools panel by browser tab. Used in the Chrome extension background script to connect `kora-content` ports (from content scripts) with `kora-panel` ports (from the DevTools panel).

### Methods

- `handleConnection(port: ExtensionPort): void` -- register a port. Ports named `'kora-panel'` are treated as panel clients; ports named `'kora-content'` are treated as content-script clients. Events from a content script are forwarded to the panel client for the same tab.

### Example

```typescript
import { PortRouter } from '@korajs/devtools'

const router = new PortRouter()
chrome.runtime.onConnect.addListener((port) => {
  router.handleConnection(port)
})
```

## Types

### `DevtoolsConfig`

Configuration for the `Instrumenter`.

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `bufferSize` | `number` | No | `10000` |
| `bridgeEnabled` | `boolean` | No | `true` |
| `channelName` | `string` | No | `'kora-devtools'` |

### `EventCategory`

```typescript
type EventCategory = 'operation' | 'merge' | 'sync' | 'query' | 'connection'
```

### `EventFilterCriteria`

| Field | Type | Description |
|-------|------|-------------|
| `categories` | `EventCategory[]` | Filter by event categories |
| `types` | `KoraEventType[]` | Filter by specific event types |
| `timeRange` | `{ start: number; end: number }` | Filter by reception time range |
| `collection` | `string` | Filter by collection name |

All fields are optional. Criteria are combined with AND logic.

### `EventStatistics`

| Field | Type |
|-------|------|
| `totalEvents` | `number` |
| `eventsByCategory` | `Record<EventCategory, number>` |
| `eventsByType` | `Partial<Record<KoraEventType, number>>` |
| `mergeConflicts` | `number` |
| `constraintViolations` | `number` |
| `avgMergeDuration` | `number \| null` |
| `avgQueryDuration` | `number \| null` |
| `syncOperationsSent` | `number` |
| `syncOperationsReceived` | `number` |

### `TimestampedEvent`

A `KoraEvent` wrapped with a reception timestamp and sequential ID.

| Field | Type | Description |
|-------|------|-------------|
| `id` | `number` | Auto-incrementing sequential ID |
| `event` | `KoraEvent` | The original framework event |
| `receivedAt` | `number` | `Date.now()` when the instrumenter captured the event |
