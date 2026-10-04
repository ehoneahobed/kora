---
layout: home
title: Kora.js
titleTemplate: Offline-first application framework for React, Vue, and Svelte

hero:
  name: Kora.js
  text: Apps that work anywhere
  tagline: The offline-first framework. Local SQLite storage, automatic conflict resolution, and multi-device sync, with zero distributed-systems code.
  image:
    src: /kora-emblem-color-transparent.png
    alt: Kora.js emblem
  actions:
    - theme: brand
      text: Get Started in 10 Minutes
      link: /getting-started
    - theme: alt
      text: How It Works
      link: /guide/offline-patterns
    - theme: alt
      text: GitHub
      link: https://github.com/ehoneahobed/kora

features:
  - icon: 🔌
    title: Offline by Default
    details: Every code path works without a network connection. Connectivity enables sync, it never gates functionality. Built for the real world, where networks fail.
  - icon: 🧩
    title: Zero Sync Code
    details: Define your schema and build your UI. Kora owns the whole data plane, so storage, conflict resolution, and sync are handled before you write a single line of it.
  - icon: ⚖️
    title: Deterministic Merges
    details: Every field merges as a CRDT (last-write-wins, element sets, counters, rich text), with server-checked constraints and custom resolvers when your domain needs them. Every merge decision is traceable.
  - icon: 🗄️
    title: A Real Database in the Browser
    details: SQLite compiled to WebAssembly, persisted with OPFS, running in a worker so your UI never blocks. A durable IndexedDB fallback and native SQLite adapters are included.
  - icon: ⚡
    title: Type-Safe by Design
    details: Full TypeScript inference flows from your schema to your queries, mutations, and hooks. Your IDE knows your data shape everywhere.
  - icon: 🚀
    title: Scaffold to Deployed in Two Commands
    details: create-kora-app scaffolds a working offline-first app with an offline app shell. kora deploy ships your sync server to Fly.io, Railway or AWS with the Dockerfile and platform config generated for you.
---

<div class="home-section">

## From nothing to offline-first in one command

No boilerplate, no sync plumbing, no distributed-systems reading list. Scaffold, run, and you have an app with local persistence, reactive queries, and an optional sync server.

```bash
npx create-kora-app@beta my-app
cd my-app
npm run dev
```

Upgrading an app from 1.0.0-beta.12? Read [Upgrading to beta.13](/guide/upgrading-to-beta13) first: the release is breaking, and servers upgrade before clients.

Your data layer is just a schema. Everything else is inferred:

<!-- docs-check-prelude
declare function render(rows: readonly { title: string }[]): void
-->

```typescript
import { createApp, defineSchema, t } from 'korajs'

const app = createApp({
  schema: defineSchema({
    version: 1,
    collections: {
      todos: {
        fields: {
          title: t.string(),
          completed: t.boolean().default(false),
          createdAt: t.timestamp().auto(),
        },
      },
    },
  }),
  sync: { url: 'wss://your-server.com/kora-sync', autoConnect: true }, // optional: one line for multi-device sync
})

await app.ready
await app.todos.insert({ title: 'Works on a plane' })

app.todos
  .where({ completed: false })
  .orderBy('createdAt')
  .subscribe((todos) => render(todos)) // reactive: fires now and on every change
```

</div>

<div class="home-section">

## Built for real-world networks

Kora treats offline as the normal state, not the error state. Writes land in local SQLite instantly and queue durably, surviving page refreshes. When a connection appears, sync sends only the operations the other side is missing, in causal order, and resumes from the last acknowledged position if the connection drops mid-sync; nothing delivered is ever skipped. Concurrent edits from different devices converge deterministically: every replica folds the same operations into the same record, and every merge decision can be inspected in DevTools.

That makes Kora a fit wherever connectivity is expensive, intermittent, or hostile: field data collection, point of sale, clinics, warehouses, and any app whose users ride elevators, board planes, or live beyond reliable coverage.

</div>

<div class="home-cta">

## Build something that survives the tunnel

<p class="section-lead" style="margin: 8px auto 24px;">One command. Ten minutes. No sync code.</p>

<a class="cta-button" href="/getting-started">Get Started</a>

</div>
