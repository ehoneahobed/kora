What Kora.js will be                                                                                                                                       
                                                                                                                                                             
  Imagine you're building an app — like a to-do list, a note-taking app, or a project tracker. Normally, if your internet drops, the app breaks. You can't
  save, can't load, can't do anything until you're back online.                                                                                              
                                                                                                                                                           
  Kora.js solves that. It's a toolkit that lets developers build apps that work perfectly without internet. Your data lives on your device first. When     
  internet comes back, it syncs automatically. If two people edited the same thing while offline, Kora figures out how to merge their changes without losing
  anything.

  Think of it like Google Docs' real-time collaboration — but it works even when everyone is offline, and the developer doesn't need a PhD in distributed
  systems to build it.

  What's actually built right now

  Honestly? You can't use it yet. Here's the analogy:

  We're building a car. So far we've built:
  - The engine block (@korajs/core) — the fundamental machinery
  - The fuel system (@korajs/store) — how data gets stored and retrieved locally

  What's still missing:
  - The transmission (@korajs/merge) — how conflicts get resolved
  - The wheels (@korajs/sync) — how devices talk to each other
  - The steering wheel (@korajs/react) — how developers actually interact with it
  - The chassis (@korajs/server) — the backend/server piece
  - The dashboard (@korajs/devtools) — debugging tools
  - The ignition key (@korajs/cli) — the npx create-kora-app command

  There is no npx create-kora-app yet. That's the last thing to be built. Right now this is engine internals — useful only to the developers building Kora
  itself.

  To answer your specific questions

  "How do I run npx to get it?"
  You can't yet. That CLI tool hasn't been built. When it's ready, it'll be as simple as:
  npx create-kora-app my-app
  cd my-app
  npm start

  "How do I build my app using React?"
  When @korajs/react is built, it'll look something like this — you just use your data and Kora handles everything else:
  function TodoList() {
    const todos = useQuery(app.todos.where({ completed: false }))
    // That's it. Works offline. Syncs automatically. No loading spinners.
    return todos.map(todo => <div>{todo.title}</div>)
  }
  But this doesn't exist yet.

  "If React is frontend, how do I get the backend/server/database?"
  This is actually the magic of Kora's design:
  - Database: lives on the user's device (in the browser, using SQLite). No separate database to set up for basic use.
  - Server: Kora will include a small sync server (@korajs/server) that you can run to let multiple devices/users sync with each other. But your app works
  without it — the server is optional, just for syncing.
  - Backend API: You don't need one for data. Traditional apps need a backend because your data lives on a server. With Kora, data lives locally first. The
  "backend" is just a relay for syncing between devices.

  So the developer's setup when Kora is complete would be:
  1. npx create-kora-app my-app — scaffolds everything
  2. Write your React components with Kora hooks — that's your frontend + local database
  3. Optionally run kora dev which starts a sync server — that's your "backend"

  No separate database to install. No REST APIs to write. No backend code for basic CRUD.

  Bottom line

  Today: Kora is a work-in-progress with solid foundations (352 tests) but nothing an app developer can use yet. It's like watching a house being built — the
   foundation and framing are solid, but you can't move in.

  When complete: A developer types one command, writes their React components, and gets an app that works offline, syncs across devices, and handles
  conflicts — all without writing any sync/server/database code themselves.


---------------------------------

## What Kora is (in plain English)

  Think of Kora like a smart notebook app engine for developers:

  - Your app can save data on your device first.
  - It still works when internet is bad or gone.
  - When internet comes back, it syncs changes safely.
  - If two devices edit at the same time, Kora helps decide how to merge changes.

  So instead of you building offline mode + sync + conflict handling from scratch, Kora does that heavy lifting.

  ———

  ## End-to-end flow (simple story)

  ### 1) App starts

  Your app tells Kora what data exists (like todos, notes, projects) and the shape of each item (title, done, date, etc.).

  ### 2) User creates/edits data

  When someone adds or edits a todo:

  - Kora saves it in local storage right away.
  - Kora also creates a “change record” (an operation log entry) describing exactly what changed.

  This is why it works offline immediately.

  ### 3) UI updates automatically

  If your screen is subscribed to data (like “all open todos”), Kora notifies it and the UI updates automatically.

  ### 4) Sync starts (when configured)

  If sync is enabled:

  - App and server first say “here’s what I already have.”
  - They exchange only missing changes (not everything).
  - Then they keep streaming new changes in real time.

  ### 5) Other devices receive updates

  Your phone edit can show up on laptop after sync runs, and vice versa.

  ### 6) Conflicts (same item edited in 2 places)

  Kora has a merge engine to resolve conflicts using rules (latest wins, custom rules, constraints, etc.).
  Some of this is implemented now; full wiring is still in progress.

  ———

  ## How normal developers will eventually use it

  The goal is this kind of DX:

  1. Define schema once (todos, fields, rules).
  2. Use simple CRUD in app code:
      - insert, update, delete, query
  3. Wrap UI with Kora provider/hooks (React package).
  4. Add one sync config line with server URL.
  5. Done: offline-first app behavior by default.

  So usage should feel close to modern app frameworks:

  - Build app features first
  - Get offline + sync as built-in behavior


so if i am building a platform, will i be able to also have a cloud database? and can this app be web based so people can access it via
  the web with a domain name or how will the platform/product end users access it. how about authentication for my application and will i
  be able to use same login credentials on different devices?


## Practical answers

  - Cloud database?
    Yes. Your users’ apps keep local data, and a cloud sync server/store is the shared source for cross-device sync.
    Today, server package exists, but production-grade persistent server storage is still evolving (current default is memory store).
  - Web-based app on a domain?
    Yes. Kora is designed to sit inside a normal web app (React, etc.), so users access your product like any website: yourapp.com.
    Kora powers the app’s local/offline/sync data behavior behind the scenes.
  - Authentication for my app?
    Yes. There is an auth hook on the sync server side (NoAuth and token-based provider).
    You bring your own auth system (JWT, Clerk, Auth0, Firebase Auth, custom backend), and pass tokens to sync.
  - Same login credentials across devices?
    Yes. If device A and B log in as the same user identity, they can sync through the same backend account/workspace.
    That’s the normal intended model.

  ———

  ## What this means for your future platform architecture

  Typical setup will be:

  1. Frontend web app on your domain (Kora embedded).
  2. Local-first client store in browser/device for instant/offline use.
  3. Cloud sync service (Kora server) for multi-device continuity.
  4. Your auth provider issuing tokens; same credentials on all devices.
  5. (Optional) your main cloud DB for analytics, reporting, admin, billing, etc.

  So yes — you can absolutely build a real web platform with domain access, cloud backend, auth, and shared identity across devices.



  What Kora Is (The Big Picture)                                                             
                                                                                                
  Think of Kora like a personal assistant that sits between your app and your data. Its job is
  to make sure your app works even when there's no internet — and when the internet comes back,
  it quietly syncs everything up across all your devices without you (the developer) having to
  write any of that complicated code yourself.

  ---
  What's Built and Working Today (Phases 1–4, 6–7)

  The Foundation (Core) — Done

  The "brain" of the system is fully built. This includes:
  - A smart clock that keeps track of "what happened when" across multiple devices, even if
  their clocks disagree
  - A unique ID system so every piece of data and every change gets a fingerprint that can never
   collide
  - A schema system — a way for developers to describe their data (like "a todo has a title and
  a completed flag") and get automatic type-checking in their code editor
  - An operation system — every time data changes, that change is recorded as an immutable
  "receipt" that can never be altered

  Saving Data in the Browser (Store) — Done

  Your app can save data locally in the browser using:
  - SQLite in the browser (the primary, high-performance option using cutting-edge web tech
  called OPFS)
  - IndexedDB (a backup option for older browsers)
  - SQLite on the server (for Node.js environments)

  Data survives page refreshes. Queries are reactive — meaning if data changes, any part of your
   UI watching that data gets updated automatically.

  Conflict Resolution (Merge) — Done

  When two people edit the same data offline and then sync, the system resolves conflicts
  automatically using a three-tier approach:
  1. Auto-merge — simple "last write wins" for most fields, smart set-union for arrays
  2. Constraint checks — rules like "only one person can book this slot" are enforced after
  merging
  3. Custom resolvers — for special cases (like inventory counts), developers can write their
  own merge logic

  Syncing Data Between Devices (Sync) — Done

  The protocol for sending changes between clients and a server is fully built:
  - Clients exchange only the changes the other side is missing (efficient)
  - If the connection drops mid-sync, it picks up where it left off (resumable)
  - There's even a "chaos transport" for testing what happens when messages get lost,
  duplicated, or arrive out of order

  The Server (Server) — Done

  A self-hosted sync server that:
  - Stores data in Memory (for dev), SQLite (for simple deployments), or PostgreSQL (for
  production)
  - Handles authentication (token-based)
  - Filters data so each user only sees what they're allowed to see (scope filtering)
  - Relays changes from one client to all other connected clients

  React Integration (React) — Done

  React developers get hooks like:
  - useQuery() — automatically re-renders your component when data changes
  - useMutation() — fire-and-forget data writes
  - useSyncStatus() — shows whether you're online, syncing, or offline

  Developer Tooling Backbone (DevTools) — Partially Done

  The behind-the-scenes plumbing is built: every operation, merge decision, and sync event is
  tracked and can be forwarded to a debugging panel. But the actual visual panel you'd see in
  Chrome DevTools doesn't exist yet.

  CLI Tools (CLI) — Done

  - kora create — scaffolds a new project from templates
  - kora dev — starts your app + sync server + file watcher in one command
  - kora generate types — generates TypeScript types from your schema
  - kora migrate — detects schema changes, generates migration files, and applies them

  The Main Entry Point (Meta-Package) — Done

  import { createApp, defineSchema, t } from 'korajs' works. It wires everything together
  automatically.

  ---
  What's NOT Built Yet (Phases 5, 8, 9, 10)

  Phase 5: Rich Text Collaboration — Not Started

  If two people are editing the same document (like Google Docs), you need character-level
  merging. The t.richtext() field type exists in the schema system, but the actual Yjs CRDT
  integration that would power real-time collaborative text editing is not implemented. Right
  now, rich text fields would just use "last write wins" which means one person's edits would
  overwrite the other's.

  Phase 8: DevTools Browser Extension UI — Not Started

  All the data collection and event tracking is working behind the scenes, but there's no visual
   interface yet. The plan is a Chrome/Firefox extension with:
  - A timeline showing every operation and sync event
  - A conflict inspector showing every merge decision
  - A searchable operation log with time-travel debugging
  - A network status panel

  None of these UI panels exist yet.

  Phase 9: Protocol & Performance Hardening — Not Started

  Three things are missing here:
  1. Protobuf wire format — Currently sync uses JSON (readable but bulky). Switching to Protocol
   Buffers would cut bandwidth by 40–60%.
  2. HTTP fallback transport — Currently only WebSocket works. Some corporate networks block
  WebSockets, so an HTTP long-polling fallback is needed.
  3. CI-enforced benchmarks — Performance targets exist on paper but aren't being automatically
  measured and enforced in the build pipeline.
  4. Chaos test suite in CI — The chaos transport exists, but the full 10-client convergence
  stress test isn't running automatically.

  Phase 10: Launch Readiness — Not Started

  The "last mile" for public release:
  1. End-to-end tests — Automated browser tests (using Playwright) that verify the full flow:
  open two browser tabs, edit in one, see changes in the other, go offline, come back, etc.
  2. Documentation site — No docs website, getting-started guide, or API reference yet.
  3. Publish pipeline — No automated npm publishing, versioning, or release automation.

  ---
  Smaller Gaps Worth Noting

  - Relational queries (app.todos.include('project')) — described in the design docs but not
  implemented
  - Full type inference — The schema system generates types, but app.todos.insert({...}) doesn't
   fully type-check field names in your editor yet (it uses generic Record<string, unknown>
  internally)
  - Drizzle ORM — The server stores use raw SQL instead of Drizzle, even though Drizzle was
  specified in the tech stack

  ---
  Summary Scorecard

  ┌──────────────────────────────────────┬─────────────┐
  │                 Area                 │   Status    │
  ├──────────────────────────────────────┼─────────────┤
  │ Core data types, clocks, schema      │ Done        │
  ├──────────────────────────────────────┼─────────────┤
  │ Local browser storage                │ Done        │
  ├──────────────────────────────────────┼─────────────┤
  │ Conflict resolution engine           │ Done        │
  ├──────────────────────────────────────┼─────────────┤
  │ Sync protocol & engine               │ Done        │
  ├──────────────────────────────────────┼─────────────┤
  │ Sync server (Memory/SQLite/Postgres) │ Done        │
  ├──────────────────────────────────────┼─────────────┤
  │ React hooks                          │ Done        │
  ├──────────────────────────────────────┼─────────────┤
  │ CLI (create/dev/migrate/generate)    │ Done        │
  ├──────────────────────────────────────┼─────────────┤
  │ Rich text (collaborative editing)    │ Not started │
  ├──────────────────────────────────────┼─────────────┤
  │ DevTools visual UI                   │ Not started │
  ├──────────────────────────────────────┼─────────────┤
  │ Protobuf + HTTP transport            │ Not started │
  ├──────────────────────────────────────┼─────────────┤
  │ Performance benchmarks in CI         │ Not started │
  ├──────────────────────────────────────┼─────────────┤
  │ End-to-end browser tests             │ Not started │
  ├──────────────────────────────────────┼─────────────┤
  │ Documentation website                │ Not started │
  ├──────────────────────────────────────┼─────────────┤
  │ npm publish automation               │ Not started │
  └──────────────────────────────────────┴─────────────┘

  Bottom line: The core engine is solid — you can build an offline-first app that saves data
  locally, syncs across devices, and resolves conflicts automatically. What's missing is the
  polish layer: collaborative text editing, visual debugging tools, production-grade wire
  format, docs, and release automation.


Plain-English Review

  - Kora is trying to be “the easy button” for apps that still work when internet is
    bad: save locally first, sync later, and auto-resolve edit clashes.
  - Big promise: developers shouldn’t need deep database/sync expertise to build
    offline-capable apps.
  - From the repo, the core engine looks serious and broad (storage, sync, merge, React
    hooks, CLI, devtools, tests).

  What It Promises (to normal people)

  - “Your app still works offline.”
  - “Changes sync when connection returns.”
  - “If two devices edit the same thing, we merge safely.”
  - “Developers can scaffold quickly and ship fast.”

  Where It’s Strong

  - Strong technical coverage and testing culture (roadmap claims 1,100+ tests).
  - Good architecture choices: operation log, causal ordering, merge layers, local-
    first storage.
  - Nice developer onboarding via templates and CLI.

  How It Fails / Can Break Today

  - Some docs and actual behavior don’t fully match:
      - Docs suggest sync is automatic after adding sync, but templates still manually
        call app.sync?.connect().
      - Docs advertise HTTP transport and encryption options, but createApp currently
        always instantiates WebSocket transport.
      - Browser worker export/import durability paths are still partly unsupported in
        worker runtime.
  - In plain terms: core idea is strong, but “it just works” has some edge-case cracks
    and documentation drift.

  DX (Developer Experience) Today

  - Good: scaffolding, typed APIs, React hooks, one-command local dev.
  - Friction: setup details (like worker URL), behavior inconsistencies across docs, and
    a few “advanced features promised vs wired” gaps.
  - Overall DX rating: promising and usable for builders, but not yet “boringly
    reliable” for every production team.

  Current Gaps to Improve

  - Align docs with reality (or wire missing features now).
  - Make sync transport selection real (websocket vs http) at app layer.
  - Clarify and complete encryption/scoping story.
  - Improve startup expectations (ready, sync auto-connect behavior, browser storage
    fallback clarity).

  - Phase 1: Truth pass on docs + examples (fast trust win).
  - Phase 2: Finish/verify missing runtime wiring (HTTP transport, encryption/scopes
    path).
  - Phase 3: Hardening pass on browser durability and failure recovery.
  - Phase 4: “Production readiness checklist” and confidence badges (what is stable
    vs experimental).

  Evidence I used

  - README.md:7
  - ROADMAP.md:25
  - kora/src/create-app.ts:248
  - kora/src/create-app.ts:283
  - kora/src/types.ts:43
  - docs/guide/sync-configuration.md:48
  - packages/store/src/adapters/sqlite-wasm-worker.ts:219
  - packages/cli/templates/react-tailwind-sync/src/main.tsx:22
  - docs/index.md:13
  - kora/package.json:3

  If you want, I can next turn this into a prioritized 30/60/90-day execution plan for
  the team (non-technical, leadership-friendly).


› - Phase 1: Truth pass on docs + examples (fast trust win).


• Perfect choice — this is the highest-leverage move.

  Phase 1: Truth Pass on Docs + Examples (Fast Trust Win)
  Goal: make sure what people read is exactly what works today.

  - 1) Audit claims vs real behavior
      - Check every “you can do X” statement in docs against current code.
      - Flag mismatches (example: options documented but not fully wired in createApp).
  - 2) Fix high-impact mismatches first
      - Sync setup wording (auto vs manual app.sync?.connect() behavior).
      - Transport wording (http vs current runtime wiring).
      - Encryption/scopes wording (what is implemented vs planned).
      - Browser durability/export-import wording (avoid overpromising).
  - 3) Update examples to be copy-paste safe
      - Ensure each snippet includes required bits (like worker URL in browser
        templates).
      - Keep “minimal working example” and “advanced example” clearly separated.
  - 4) Add a clear “Stability/Support Matrix” page
      - Simple table: Available now / Partially available / Planned.
      - This prevents confusion and reduces support questions.
  - 5) Add “Last verified” tags
      - Each major guide gets a small line like: “Last verified against v0.1.4”.

  Definition of done

  - No feature claim in docs contradicts runtime behavior.
  - New users can follow getting-started without hidden steps.
  - Team can point to one honest status page for stakeholders.