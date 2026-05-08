# Kora.js — Strategic Plan: The Vercel for Offline-First

> **Mission:** Make Kora.js the default way developers build applications for the real world — where connectivity is unreliable, users are mobile, and data must never be lost.

---

## Table of Contents

1. [The Opportunity](#1-the-opportunity)
2. [Competitive Landscape](#2-competitive-landscape)
3. [Product Roadmap](#3-product-roadmap)
4. [Platform Expansion: Desktop & Mobile](#4-platform-expansion-desktop--mobile)
5. [Go-to-Market Strategy](#5-go-to-market-strategy)
6. [Content & Community Playbook](#6-content--community-playbook)
7. [Revenue Model: Kora Cloud](#7-revenue-model-kora-cloud)
8. [Growth Milestones](#8-growth-milestones)
9. [Risks & Mitigations](#9-risks--mitigations)

---

## 1. The Opportunity

### Why now

- **The connectivity assumption is breaking.** Mobile users, emerging markets, field workers, healthcare, logistics, POS systems — the majority of real-world software operates in unreliable network conditions. Every major app (Google Docs, Figma, Linear, Notion) has invested millions building custom offline/sync infrastructure. There is no standard framework.

- **Local-first is gaining momentum.** The local-first movement (Ink & Switch, CRDTs, Automerge, Yjs) has validated the idea. But adoption is stuck at the infrastructure layer — developers can use Yjs for text, but building a full offline-first *application* still requires stitching together 5-10 libraries and solving distributed systems problems.

- **The "Vercel gap" exists.** Vercel made deploying web apps trivial. Nobody has done the same for offline-first. The developer who wants offline-first today faces the same pain that the developer who wanted to deploy a Next.js app faced in 2016 before Vercel existed.

- **Platform expansion is inevitable.** Desktop apps (Electron, Tauri) and mobile apps (React Native, Flutter, native) all face the same offline/sync challenges. A framework that solves this once, across all platforms, captures the entire market.

### The wedge

Kora.js enters through the **web developer** who needs offline-first but doesn't want to become a distributed systems engineer. The same way Next.js entered through React developers who didn't want to configure webpack.

**One line to go from local-only to synced:**
```typescript
const app = createApp({
  schema,
  sync: { url: 'wss://my-server.com/kora' }  // add this line
})
```

That's the pitch. That's the wedge.

---

## 2. Competitive Landscape

### Direct competitors

| Project | Strength | Weakness | Our advantage |
|---------|----------|----------|---------------|
| **PowerSync** | Postgres sync, good DX | Postgres-only, no conflict resolution flexibility, hosted-only | Schema-driven merge engine, self-hostable, multi-database |
| **ElectricSQL** | Postgres replication | Postgres-only, limited conflict strategies, complex setup | Full framework (not just sync), 3-tier merge, works offline-first by default |
| **Replicache** | Battle-tested (Linear uses it) | Requires custom backend mutations, steep learning curve | Zero-config default, schema-driven, no custom mutation layer needed |
| **Triplit** | Good DX, real-time | Early stage, limited offline support | True offline-first (not just real-time), operation-based sync, richer merge |
| **DXOS** | Ambitious local-first vision | Complex, heavy, developer-unfriendly | Simple API, incremental adoption, lighter footprint |
| **RxDB** | Mature, many adapters | No built-in sync server, manual conflict resolution | Integrated sync + merge + server, schema-driven types |
| **Watermelon DB** | React Native focused | Mobile-only, basic sync | Cross-platform (web + desktop + mobile), richer sync protocol |

### Indirect competitors

- **Firebase/Supabase:** Cloud-first with offline as afterthought. Kora is offline-first with cloud as enhancement.
- **Prisma:** Great DX for server-side DB. Zero offline story. Kora owns the client-side data plane.
- **Convex:** Real-time backend. No offline support. Different paradigm.

### Our moat (what's hard to replicate)

1. **Three-tier merge engine** — Auto-merge + constraints + custom resolvers. Nobody else has this layered approach.
2. **Schema-driven everything** — One schema definition drives types, storage, sync, merge, and migrations.
3. **Operation-based sync with causal ordering** — More correct than row-based replication, more efficient than state-based CRDTs.
4. **Full framework, not a library** — Like Next.js vs Express. Opinionated, integrated, batteries-included.
5. **Cross-platform from day one** — Same sync protocol works on web, desktop, and mobile.

---

## 3. Product Roadmap

### Phase 1: Foundation Lock (Current — v0.3.x) ✅

- [x] Core: Schema, operations, HLC, types
- [x] Store: SQLite WASM + better-sqlite3 + IndexedDB fallback
- [x] Merge: Three-tier engine with property-based tests
- [x] Sync: Delta sync, causal ordering, reconnection
- [x] Server: Self-hosted sync server (SQLite + PostgreSQL)
- [x] React: Hooks and bindings
- [x] DevTools: Browser extension
- [x] CLI: Scaffolding + deployment (Vercel, AWS)
- [x] Auth: Email/password, sessions, tokens, device identity

### Phase 2: Developer Experience Polish (v0.4 — 4-6 weeks)

**Goal:** Make the "10-minute demo" flawless. Every rough edge that a new developer would hit gets filed down.

- [ ] **Passkey authentication** — WebAuthn support in @korajs/auth. Passwordless login is table stakes for 2026.
- [ ] **External auth providers** — Google, GitHub, Apple sign-in adapters. Most apps need social login.
- [ ] **E2E encryption** — Client-side encryption for sensitive data. Privacy-first is a differentiator.
- [ ] **Schema migrations (v2)** — `kora migrate` generates and applies migrations automatically. Currently manual.
- [ ] **Sync scopes** — Per-collection, per-user data filtering. Essential for multi-tenant apps.
- [ ] **Error recovery UX** — Better error messages, automatic retry strategies, conflict resolution UI helpers.
- [ ] **Documentation site** — VitePress-based docs with interactive examples. (docs.korajs.dev)
- [ ] **Starter templates** — Todo app, notes app, inventory app, CRM app. Each demonstrates a key capability.
- [ ] **Video tutorials** — 5-10 minute screencasts for each template. Post on YouTube.

### Phase 3: Platform Expansion (v0.5 — see Section 4)

- [ ] Desktop: Tauri adapter
- [ ] Desktop: Electron adapter
- [ ] Mobile: React Native adapter
- [ ] Mobile: Flutter adapter (stretch)

### Phase 4: Kora Cloud (v1.0 — see Section 7)

- [ ] Managed sync server
- [ ] Dashboard (usage, analytics, conflict rates)
- [ ] Team collaboration features
- [ ] Hosted auth
- [ ] Global edge sync relays

### Phase 5: Enterprise (v1.x+)

- [ ] RBAC and row-level security
- [ ] Audit logging
- [ ] Compliance (SOC 2, HIPAA support)
- [ ] On-premise deployment option
- [ ] Priority support SLA

---

## 4. Platform Expansion: Desktop & Mobile

### The thesis

Offline-first is even more critical on desktop and mobile than on web. A field worker's tablet, a POS terminal, a medical device, a warehouse scanner — these are the real-world use cases where Kora's value proposition is strongest.

**The key insight:** The sync protocol, merge engine, and operation format are platform-agnostic. Only the storage adapter and UI bindings change per platform.

### Architecture for cross-platform

```
                    Shared (already built)
                    ┌─────────────────────┐
                    │  @korajs/core       │  Schema, operations, HLC, types
                    │  @korajs/merge      │  Three-tier merge engine
                    │  @korajs/sync       │  Sync protocol + transports
                    │  @korajs/auth       │  Authentication
                    └────────┬────────────┘
                             │
              ┌──────────────┼──────────────────┐
              │              │                   │
         Web (built)    Desktop (new)       Mobile (new)
    ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐
    │ SQLite WASM │  │ Native SQLite│  │ SQLite (native)  │
    │ React hooks │  │ Tauri/Electron│  │ React Native     │
    │ IndexedDB   │  │ bindings     │  │ Flutter bindings  │
    │ fallback    │  │              │  │                   │
    └─────────────┘  └──────────────┘  └──────────────────┘
```

### Desktop: Tauri (Priority 1)

**Why Tauri over Electron:**
- 10x smaller binary size (no bundled Chromium)
- Native SQLite access (no WASM overhead)
- Better security model (no Node.js in renderer)
- Rust backend = performance + safety
- Growing rapidly, preferred by new projects

**What to build:**
- `@korajs/tauri` — Tauri plugin that provides native SQLite storage adapter
- Uses `better-sqlite3`-compatible API but through Tauri's IPC
- Tauri command handlers for storage operations
- Auto-updater integration for schema migrations
- System tray sync status indicator
- CLI template: `npx create-kora-app my-app --template tauri-react`

**Implementation approach:**
```
packages/tauri/
  src/
    tauri-store.ts          # StorageAdapter using Tauri IPC → native SQLite
    tauri-sync.ts           # Sync transport (uses native fetch/WebSocket)
    tauri-plugin/           # Rust plugin for SQLite operations
      src/lib.rs
      Cargo.toml
    index.ts                # Public API
```

**Estimated effort:** 2-3 weeks (core already exists, just need storage adapter + Tauri plugin)

### Desktop: Electron (Priority 2)

**Why still support Electron:**
- Massive existing ecosystem (Slack, VS Code, Discord, Notion)
- Many companies have Electron apps that need offline-first
- Migration path: "Add Kora to your existing Electron app"

**What to build:**
- `@korajs/electron` — Electron adapter using `better-sqlite3` directly (already have this adapter)
- Main process runs storage + sync, renderer gets reactive queries via IPC
- CLI template: `npx create-kora-app my-app --template electron-react`

**Estimated effort:** 1-2 weeks (mostly wiring, storage adapter already exists)

### Mobile: React Native (Priority 3)

**Why React Native:**
- Largest cross-platform mobile framework
- JavaScript/TypeScript — same language as Kora
- Can reuse @korajs/react hooks with minimal changes
- Huge market: field service apps, healthcare, logistics, retail POS

**What to build:**
- `@korajs/react-native` — React Native adapter
- Native SQLite via `react-native-quick-sqlite` or `op-sqlite`
- Background sync service (keeps syncing when app is backgrounded)
- Network quality detection (WiFi vs cellular vs offline)
- Push notification integration for sync events
- CLI template: `npx create-kora-app my-app --template react-native`

**Implementation approach:**
```
packages/react-native/
  src/
    native-sqlite-store.ts   # StorageAdapter using native SQLite bridge
    background-sync.ts       # Background task for sync
    network-monitor.ts       # Native network quality detection
    hooks.ts                 # Re-export @korajs/react hooks + mobile-specific ones
    index.ts
  android/                   # Native Android module (if needed)
  ios/                       # Native iOS module (if needed)
```

**Estimated effort:** 4-6 weeks (native bridge work, background sync, platform testing)

### Mobile: Flutter (Priority 4 — Stretch)

**Why Flutter:**
- Second-largest cross-platform framework
- Strong in enterprise and emerging markets
- Dart is different from TypeScript but the protocol is the same

**What to build:**
- `kora_flutter` — Dart package
- Implements the Kora sync protocol in Dart
- Native SQLite via `sqflite` or `drift`
- Dart code generation from Kora schema

**Estimated effort:** 6-8 weeks (new language, new ecosystem, more work)

### Platform expansion order

```
Month 1-2:  Tauri adapter + Electron adapter
Month 3-4:  React Native adapter
Month 5-6:  Flutter adapter (if demand warrants)
```

---

## 5. Go-to-Market Strategy

### The Vercel Playbook (adapted for Kora)

Vercel succeeded by:
1. Building an incredible open-source framework (Next.js)
2. Creating a cloud platform that makes the framework even better
3. Building community through content, conferences, and developer advocacy
4. Targeting specific use cases that demonstrate clear value
5. Making the free tier generous enough that developers adopt before companies pay

**Our adapted playbook:**

### Phase A: Establish credibility (Months 1-2)

**Target:** Get 1,000 GitHub stars and 500 npm weekly downloads.

1. **Launch blog post:** "Introducing Kora.js: The Offline-First Application Framework"
   - Publish on the Kora blog, cross-post to dev.to, Hashnode, Medium
   - Key narrative: "One line to go from local-only to synced"
   - Include a 2-minute video demo
   - Show the KoraForms case study as proof it works in production

2. **Hacker News launch:**
   - Title: "Show HN: Kora.js — Offline-first framework (like Next.js for local-first apps)"
   - Post on Tuesday/Wednesday at 8am EST
   - Have 3-5 people ready to answer questions in the comments
   - Focus on the technical depth (HLC, three-tier merge, operation-based sync)

3. **Product Hunt launch:**
   - Same week as HN
   - Focus on the developer experience angle
   - Screenshots of DevTools, CLI output, code examples

4. **Twitter/X thread:**
   - "I spent [X months] building the framework I wish existed for offline-first apps. Here's what I learned about distributed systems, CRDTs, and developer experience. 🧵"
   - 15-20 tweets covering key technical decisions
   - End with link to repo and docs

5. **Reddit posts:**
   - r/javascript, r/typescript, r/reactjs, r/programming, r/selfhosted
   - Different angle for each subreddit

### Phase B: Build community (Months 2-4)

6. **Discord server:**
   - Channels: #general, #help, #showcase, #contributors, #rfc
   - Be extremely responsive in #help for the first 3 months. Every question answered within 2 hours.
   - Weekly "office hours" voice chat

7. **Tutorial series:**
   - "Build an offline-first todo app in 10 minutes"
   - "Build a collaborative notes app with real-time sync"
   - "Build a field service app that works without internet"
   - "Build a POS system that never goes down"
   - "Add offline-first to your existing React app"
   - Each tutorial = blog post + YouTube video + GitHub repo

8. **Conference talks:**
   - Submit to: React Conf, ViteConf, JSConf, Node Congress, React Summit
   - Talk titles:
     - "Your App Should Work Without Internet"
     - "The End of Loading Spinners: Building Offline-First with Kora.js"
     - "Conflict Resolution Without a PhD: How Kora.js Makes Distributed Data Simple"

9. **Podcast appearances:**
   - Target: JS Party, Syntax, PodRocket, devtools.fm, Changelog, Software Engineering Daily
   - Pitch angle: "The offline-first movement is going mainstream"

### Phase C: Target verticals (Months 4-8)

Offline-first isn't equally valuable everywhere. Target verticals where it's a **hard requirement**, not a nice-to-have:

| Vertical | Pain point | Kora pitch | Example app |
|----------|-----------|------------|-------------|
| **Healthcare** | Patient data must be accessible without WiFi. HIPAA compliance. | E2E encrypted, offline-first patient records | Medical forms app |
| **Field service** | Technicians work in basements, rural areas, underground | Work orders that sync when back in range | Service ticket app |
| **Logistics** | Warehouse, delivery, fleet — spotty connectivity | Inventory + delivery tracking that never fails | Warehouse management |
| **Retail/POS** | POS must work during internet outage | Transaction processing that syncs later | Point of sale |
| **Education** | Schools in emerging markets with poor connectivity | Learning apps that work offline | Classroom quiz app |
| **Agriculture** | Farm workers in fields with no signal | Crop tracking, inspection forms | Farm management |

**For each vertical:**
- Build a specific template/demo app
- Write a case study or guide
- Find 2-3 early adopters and work with them closely
- Create vertical-specific landing pages

### Phase D: Establish thought leadership (Ongoing)

10. **"State of Offline-First" annual report:**
    - Survey developers about offline-first adoption, challenges, tools
    - Publish findings with beautiful data visualizations
    - Position Kora.js as the authority on offline-first development

11. **Technical blog series:**
    - "How Kora's Three-Tier Merge Engine Works"
    - "HLC vs Lamport Clocks: Why We Chose Hybrid Logical Clocks"
    - "The Operation Log: Why We Don't Replicate Tables"
    - "Chaos Testing a Sync Engine: What We Learned"
    - Deep technical content builds trust with senior engineers who influence adoption

12. **Open-source contributions and integrations:**
    - Contribute to Yjs, SQLite WASM, Tauri ecosystem
    - Build official integrations: Kora + Supabase Auth, Kora + Clerk, Kora + Drizzle
    - Be a good citizen in the ecosystem

---

## 6. Content & Community Playbook

### Content calendar (first 3 months)

**Week 1: Launch**
- Blog: "Introducing Kora.js"
- Video: 2-minute demo
- Social: Twitter thread, Reddit posts
- HN: Show HN post
- Product Hunt launch

**Week 2: Tutorial 1**
- Blog + Video: "Build an offline-first todo app in 10 minutes"
- GitHub: Template repo
- Social: Share on Twitter, Reddit

**Week 3: Deep dive 1**
- Blog: "How Kora's Three-Tier Merge Engine Works"
- Social: Thread summarizing key insights

**Week 4: Tutorial 2**
- Blog + Video: "Build a collaborative notes app with real-time sync"
- GitHub: Template repo

**Week 5: Community**
- Discord launch (or nurture if already active)
- First "office hours" session
- Blog: "What we learned from our first 100 users"

**Week 6: Deep dive 2**
- Blog: "Why Every App Should Be Offline-First in 2026"
- Target general developer audience, not just offline enthusiasts

**Week 7: Tutorial 3**
- Blog + Video: "Build a field service app that works without internet"
- Start targeting vertical-specific audience

**Week 8: Integration**
- Blog: "Using Kora.js with [popular tool]" (Supabase, Clerk, etc.)
- Show how Kora complements existing tools

**Weeks 9-12: Repeat cycle with increasing depth**

### Content principles

1. **Show, don't tell.** Every blog post has working code. Every claim has a demo.
2. **Technical depth builds trust.** Senior engineers recommend tools. Win them with rigor.
3. **Developer stories > feature lists.** "Sarah built an offline POS in 2 days" > "Kora has 3-tier merge"
4. **Consistency > virality.** One quality post per week beats one viral post per quarter.

### Community health metrics

| Metric | Month 1 target | Month 3 target | Month 6 target |
|--------|----------------|----------------|----------------|
| GitHub stars | 500 | 2,000 | 5,000 |
| npm weekly downloads | 200 | 1,000 | 5,000 |
| Discord members | 50 | 300 | 1,000 |
| Contributors | 3 | 10 | 30 |
| Template apps | 2 | 5 | 10 |

---

## 7. Revenue Model: Kora Cloud

### The business model

Like Vercel: **the framework is free, the cloud is paid.**

Kora.js (open-source, MIT) → Kora Cloud (hosted sync infrastructure, paid)

### Why developers will pay

Self-hosting a sync server is fine for prototypes. But in production you need:
- **Uptime guarantees** — Your sync server can't go down
- **Global distribution** — Low-latency sync worldwide
- **Automatic scaling** — Handle 10 users or 10 million
- **Monitoring & analytics** — Conflict rates, sync latency, active devices
- **Security & compliance** — SOC 2, encryption at rest, audit logs
- **Team management** — Multiple projects, role-based access

These are the same reasons developers pay for Vercel instead of self-hosting Next.js.

### Pricing tiers

| Tier | Price | Includes | Target |
|------|-------|----------|--------|
| **Free** | $0/mo | 1 project, 1,000 synced devices, 1GB storage, community support | Indie devs, prototypes |
| **Pro** | $25/mo | 5 projects, 50,000 synced devices, 25GB storage, email support, analytics dashboard | Small teams, startups |
| **Team** | $75/mo per seat | Unlimited projects, 500K devices, 100GB storage, priority support, RBAC, audit logs | Growing companies |
| **Enterprise** | Custom | Unlimited everything, SLA, dedicated support, on-premise option, compliance packages | Large organizations |

### Revenue projections (conservative)

| Milestone | Timeline | MRR |
|-----------|----------|-----|
| First 10 paying customers | Month 6-8 | $500 |
| 100 paying customers | Month 12-14 | $5,000 |
| 500 paying customers | Month 18-24 | $30,000 |
| 1,000+ paying customers | Month 24-36 | $100,000+ |

### Kora Cloud technical architecture

```
Developer's app (any platform)
        │
        │ WebSocket / HTTP
        ▼
┌─────────────────────────┐
│   Kora Cloud Edge       │  (Global CDN / edge network)
│   (Cloudflare Workers   │
│    or Fly.io edge)      │
│                         │
│   - Auth verification   │
│   - Connection routing  │
│   - Rate limiting       │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│   Kora Sync Cluster     │  (Regional, auto-scaling)
│                         │
│   - Operation ingestion │
│   - Merge execution     │
│   - Fan-out to clients  │
│   - Conflict logging    │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│   Storage Layer         │
│                         │
│   - PostgreSQL (ops log)│
│   - S3 (CRDT blobs)    │
│   - Redis (pub/sub)     │
└─────────────────────────┘
```

### Build vs. buy for cloud infrastructure

- **Compute:** Fly.io or Railway for initial launch (simple, developer-friendly). Migrate to AWS/GCP at scale.
- **Database:** Neon (serverless Postgres) — already validated with KoraForms deployment.
- **Edge:** Cloudflare Workers for auth verification and connection routing.
- **Monitoring:** Grafana Cloud for internal metrics. Build custom dashboard for customer-facing analytics.

---

## 8. Growth Milestones

### Milestone 1: "It works" (Current ✅)
- Framework core is functional
- KoraForms proves it works in production
- Published on npm

### Milestone 2: "It's polished" (Next 4-6 weeks)
- Documentation site live at docs.korajs.dev
- 4+ starter templates with tutorials
- Passkeys + external auth providers
- Schema migrations v2
- Desktop adapter (Tauri)
- **Gate:** A new developer can go from zero to deployed offline-first app in under 10 minutes following the docs, without asking for help.

### Milestone 3: "People are talking about it" (Months 2-3)
- Launch: HN, Product Hunt, Twitter, Reddit
- 1,000+ GitHub stars
- 10+ community contributors
- Featured in 2+ JavaScript newsletters
- **Gate:** Organic GitHub issues and PRs from strangers.

### Milestone 4: "People are building with it" (Months 3-6)
- 50+ projects using Kora (tracked via npm downloads, Discord, GitHub)
- 5+ showcase apps built by community
- React Native adapter shipped
- First conference talk delivered
- **Gate:** Companies (not just individuals) are using Kora in production.

### Milestone 5: "Kora Cloud beta" (Months 6-8)
- Managed sync server running
- Dashboard with basic analytics
- Free tier available
- 10+ beta customers
- **Gate:** Paying customers who would be upset if the service went down.

### Milestone 6: "Market leader" (Months 12-18)
- 10,000+ GitHub stars
- 1,000+ Discord members
- 100+ paying Kora Cloud customers
- Desktop + mobile adapters stable
- "Kora" becomes synonymous with "offline-first" the way "Vercel" is synonymous with "deploy"
- **Gate:** When developers google "offline-first framework", Kora is the top result.

### Milestone 7: "Platform" (Months 18-36)
- Flutter adapter
- Kora Cloud enterprise tier
- Marketplace for community plugins/adapters
- Annual "KoraConf" or participation as keynote at major conferences
- Potential funding round if growth warrants it

---

## 9. Risks & Mitigations

### Risk 1: "PowerSync / Electric / Replicache gains critical mass first"

**Likelihood:** Medium
**Impact:** High

**Mitigation:**
- Differentiate on framework (not just sync). Competitors are sync libraries. We are a framework.
- Move faster on DX. Competitors require more setup. Our zero-config story is stronger.
- Cross-platform is our moat. Competitors are web-only or Postgres-only.
- Target verticals they ignore (healthcare, agriculture, field service).

### Risk 2: "Firebase/Supabase adds good offline support"

**Likelihood:** Low-Medium (it's hard to retrofit offline-first)
**Impact:** High

**Mitigation:**
- Offline-first is an architecture, not a feature. You can't bolt it onto a cloud-first system.
- Our merge engine is more sophisticated. LWW-only won't satisfy real applications.
- Self-hostable. Many companies can't use Firebase/Supabase for compliance reasons.
- Build Supabase/Firebase auth integrations so developers can use both.

### Risk 3: "Can't build community fast enough"

**Likelihood:** Medium
**Impact:** Medium

**Mitigation:**
- Quality over quantity. 50 engaged developers > 5,000 drive-by stars.
- Be present. Answer every question. Review every PR. Thank every contributor.
- Build demo apps that solve real problems. People share tools that solve their problems.
- Partner with complementary projects (Tauri, Yjs, Drizzle) for cross-promotion.

### Risk 4: "Platform expansion stretches resources too thin"

**Likelihood:** Medium
**Impact:** Medium

**Mitigation:**
- Shared core is 80% of the work, and it's already done.
- Prioritize ruthlessly: Web → Tauri → React Native → Flutter. Don't start the next until the previous is stable.
- Seek contributors for platform-specific adapters (mobile developers who want offline-first).
- Consider the Tauri/Electron adapters as quick wins (1-3 weeks each) before tackling mobile.

### Risk 5: "Revenue takes too long to materialize"

**Likelihood:** Medium
**Impact:** High (sustainability)

**Mitigation:**
- Keep costs low. Use serverless/managed infrastructure for Kora Cloud.
- Consulting/support revenue bridge: Offer paid implementation help for enterprises adopting Kora.
- Sponsorships: GitHub Sponsors, Open Collective once community is established.
- Consider early funding if traction metrics are strong (stars, downloads, community size).

---

## Appendix A: Immediate Next Actions (This Week)

1. **Set up documentation site** — VitePress at docs.korajs.dev. Content from existing docs/ folder.
2. **Create the "10-minute tutorial"** — Todo app, zero to deployed. This is the most important content asset.
3. **Write the launch blog post** — Draft "Introducing Kora.js" with embedded demo video.
4. **Start Tauri adapter** — Smallest effort, biggest signal ("we're cross-platform").
5. **Polish the README** — The GitHub README is the first thing people see. It needs to be exceptional.

## Appendix B: Brand Guidelines

**Voice:** Technical but approachable. Like talking to a smart friend who happens to be a distributed systems expert. Never condescending. Never hand-wavy.

**Tagline candidates:**
- "Build for the real world" (primary — emphasizes that the real world is offline)
- "Your app, everywhere, always"
- "Offline-first. Zero complexity."
- "Independent strings, shared harmony" (from the kora instrument metaphor — use for deeper brand moments)

**Visual identity:**
- Inspired by the kora instrument — warm, African heritage, musical harmony
- Colors: Warm gold/amber (primary), deep navy (secondary), clean white (background)
- Typography: Clean, modern, technical. Monospace for code, sans-serif for prose.
- The logo should evoke strings/connections/harmony — abstract, not literal.

## Appendix C: Key Metrics Dashboard

Track weekly from day one:

| Category | Metric | Source |
|----------|--------|--------|
| Adoption | npm weekly downloads | npm |
| Adoption | GitHub stars | GitHub |
| Adoption | GitHub clones | GitHub |
| Community | Discord members | Discord |
| Community | GitHub issues opened | GitHub |
| Community | GitHub PRs from external contributors | GitHub |
| Content | Blog post views | Analytics |
| Content | Tutorial completion rate | Analytics |
| Content | YouTube video views | YouTube |
| Revenue | Kora Cloud signups | Internal |
| Revenue | MRR | Stripe |
| Product | `create-kora-app` executions | npm |
| Product | Active projects (estimated from sync connections) | Kora Cloud |

---

*Kora: independent strings, shared harmony.*
