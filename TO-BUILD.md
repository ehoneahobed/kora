# Kora.js — Projects To Build

What to build, why it matters, and who pays for it.

**Existing:** Todo app (4 template variants), collaborative notes example.

---

## Demo Apps (Open Source — Prove the Framework)

These are free, open-source example apps that ship with the Kora docs and templates. Their job is to make developers say "I need this."

### 1. Offline Survey / Field Data Collection

**What:** A form builder + data collector that works entirely offline. Health workers, researchers, or NGO field agents fill out surveys in areas with no internet. Data syncs when they return to connectivity.

**Why it matters:** Currently dominated by ODK/KoboToolbox — clunky Java-based tools from 2010. A modern React + offline-first alternative is overdue. Demonstrates Kora in the exact scenario it was built for.

**Schema highlights:**
- `surveys` collection with nested field definitions (JSON schema)
- `responses` collection with `respondentId`, `location`, `submittedAt`
- `media` collection for photo/audio attachments (blob references)
- Scoped sync: field workers only sync their own survey assignments

**Kora features demonstrated:**
- Full offline operation with large datasets
- Scoped sync (per-user data partitioning)
- Conflict resolution on concurrent edits to survey definitions
- LAN sync (when built) — supervisor syncs with field workers over local WiFi

**Priority:** High
**Effort:** 1-2 weeks
**Template name:** `react-tailwind-survey`

---

### 2. Point-of-Sale / Inventory Tracker

**What:** A shop inventory and sales system. Track products, record sales, manage stock levels. Works offline — no sale is ever lost because the internet dropped.

**Why it matters:** Small businesses in emerging markets lose revenue when their POS goes down with the internet. This is the most immediately relatable demo for non-developer stakeholders (investors, partners, business owners).

**Schema highlights:**
- `products` collection with `name`, `price`, `sku`, `stockQuantity`
- `sales` collection with `items` (array), `total`, `paymentMethod`, `createdAt`
- `stockAdjustments` for inventory corrections
- Tier 3 custom resolver: `stockQuantity` uses additive merge (two sales from different devices both decrement correctly)

**Kora features demonstrated:**
- Custom conflict resolver (inventory quantities)
- Constraint validation (stock can't go negative)
- Relations (sale items → products)
- Reactive queries (live dashboard of sales totals)

**Priority:** High
**Effort:** 1-2 weeks
**Template name:** `react-tailwind-pos`

---

### 3. Collaborative Kanban Board

**What:** A Trello-like board with drag-and-drop cards across columns. Multiple users edit simultaneously with real-time sync.

**Why it matters:** Kanban is the "hello world" of collaborative apps. Every developer immediately understands the complexity (card ordering, concurrent moves, column management). Great for landing page demos and conference talks.

**Schema highlights:**
- `boards` collection
- `columns` collection with `boardId`, `position` (number)
- `cards` collection with `columnId`, `position`, `title`, `description` (richtext), `assignee`
- Relations: cards → columns → boards

**Kora features demonstrated:**
- Relational queries with `.include()`
- Rich text fields (card descriptions)
- Optimistic mutations (drag feels instant)
- Conflict resolution on concurrent card moves (position ordering)
- Real-time sync indicators

**Priority:** High
**Effort:** 1 week
**Template name:** `react-tailwind-kanban`

---

### 4. Shared Shopping List

**What:** A family/group shopping list that syncs across phones. Check items off, add items, see who added what — all in real time.

**Why it matters:** The simplest possible multi-user app. Perfect for the "show your friend in 2 minutes" viral loop. Low complexity, high relatability. Good first app for developers new to Kora.

**Schema highlights:**
- `lists` collection with `name`, `sharedWith` (array of user IDs)
- `items` collection with `listId`, `name`, `quantity`, `checked`, `addedBy`

**Kora features demonstrated:**
- Array merge (add-wins set for shared users)
- LWW merge on `checked` field
- Reactive queries (list updates in real time)
- Minimal schema, minimal code — shows how little is needed

**Priority:** Medium
**Effort:** 3-5 days
**Template name:** `react-tailwind-shopping`

---

### 5. Offline-First Chat / Messaging

**What:** A simple group chat where messages queue offline and deliver when connectivity returns. Not a WhatsApp replacement — a demonstration of reliable message ordering with CRDTs.

**Why it matters:** Chat is universally understood. Showing that messages never get lost, arrive in causal order, and resolve conflicts gracefully is a powerful demo of the sync engine.

**Schema highlights:**
- `channels` collection with `name`, `members`
- `messages` collection with `channelId`, `text`, `senderId`, `sentAt`
- Optional: `reactions` collection (demonstrates many-to-many)

**Kora features demonstrated:**
- Causal ordering (messages appear in correct order)
- Offline queue (messages send when back online)
- Real-time streaming
- Scoped sync (only channels you're a member of)

**Priority:** Medium
**Effort:** 1 week

---

### 6. Expense Tracker / Split Bills

**What:** Track personal or group expenses. Split bills with friends. Works offline on the go — add expenses on the bus, sync later.

**Why it matters:** Personal finance apps are universally needed. Group expense splitting demonstrates multi-user conflict resolution in a context everyone understands.

**Schema highlights:**
- `expenses` collection with `amount`, `category`, `description`, `paidBy`, `splitWith`, `date`
- `settlements` collection for tracking who owes whom
- Tier 3 resolver: balance calculations use additive merge

**Kora features demonstrated:**
- Custom resolvers (balance computation)
- Multi-user sync with conflict resolution
- Reactive computed queries (running totals, balances)

**Priority:** Medium
**Effort:** 1 week

---

## Sellable Products (Revenue — Built on Kora)

These are commercial products built with Kora that solve real problems people will pay for. They also serve as the most convincing proof that the framework works in production.

### A. KoraForms — Field Data Collection Platform

**What:** A hosted version of the survey/data collection demo, but production-grade. Organizations sign up, create surveys, deploy to field teams, collect data offline, analyze results.

**Target customers:**
- NGOs doing field research (health, agriculture, education)
- Government census and survey teams
- Market research firms operating in emerging markets
- Academic researchers

**Why they'll pay:** ODK is free but painful. SurveyCTO charges $500+/year and still has sync issues. KoraForms would be modern, reliable, and actually work offline.

**Revenue model:**
- Free: 3 surveys, 100 responses, 1 user
- Pro ($15/month): Unlimited surveys, 10,000 responses, 5 users
- Team ($49/month): Unlimited everything, 20 users, priority support
- Enterprise (custom): SSO, on-premise, audit logs

**Build effort:** 4-6 weeks on top of the demo app
**Capital required:** $0 (host on Fly.io, charge through Paystack/Stripe)

---

### B. KoraSync POS — Point-of-Sale for African & Emerging Markets

**What:** A complete point-of-sale system designed for markets where internet is unreliable. Inventory management, sales tracking, receipt generation, daily reports — all working offline, syncing when connected.

**Target customers:**
- Small retail shops (1-5 employees)
- Market stall vendors
- Pharmacies
- Small restaurants/cafes

**Why they'll pay:** Current POS options either require constant internet (Square, Shopify POS) or are expensive legacy systems. A $10/month POS that never goes down because the internet dropped is an easy sell.

**Revenue model:**
- Free: 1 device, 50 products, basic reporting
- Business ($10/month): 3 devices, unlimited products, full reports, LAN sync
- Multi-store ($25/month): Unlimited devices, multiple locations, cross-store inventory

**Key features beyond the demo:**
- Receipt printing (Bluetooth thermal printers)
- Barcode/QR scanning
- Daily/weekly/monthly sales reports
- Multi-device LAN sync (cashier 1 + cashier 2 sync without internet)
- M-Pesa / mobile money integration

**Build effort:** 6-8 weeks
**Capital required:** $0 to start, ~$500 for thermal printer testing hardware

---

### C. KoraHealth — Offline Patient Records for Clinics

**What:** A lightweight electronic health records (EHR) system for small clinics and community health workers. Patient registration, visit notes, prescriptions, referrals — all offline-capable.

**Target customers:**
- Rural clinics and health posts
- Community health worker programs (funded by WHO, UNICEF, Gates Foundation)
- Small private practices in emerging markets

**Why they'll pay:** Existing EHR systems (OpenMRS, DHIS2) are server-dependent and complex. A clinic with 1 doctor and 2 nurses doesn't need a hospital system — they need something that works when the power goes out.

**Revenue model:**
- Free for community health workers (funded by grants/NGO partnerships)
- Clinic ($30/month): 5 staff, patient records, prescriptions, referrals
- Network ($100/month): Multi-clinic, central dashboard, aggregate reporting

**Build effort:** 8-12 weeks (regulatory considerations for health data)
**Capital required:** $0 for software, potential grant funding for pilots

---

### D. KoraLearn — Offline Classroom & Training App

**What:** A classroom management and learning app where teachers distribute assignments, students submit work, and everything syncs over LAN — no internet required.

**Target customers:**
- Schools in areas with poor internet connectivity
- Corporate training programs in field locations
- Workshop and bootcamp organizers

**Why they'll pay:** Google Classroom requires internet. Schools in rural areas can't use it. A teacher with a laptop and 30 students with tablets can run an entire class over LAN sync.

**Revenue model:**
- Free: 1 classroom, 30 students
- School ($20/month): Unlimited classrooms, grade book, parent reports
- District (custom): Multi-school management, curriculum distribution

**LAN sync showcase:** Teacher's device acts as the sync hub. Students connect over school WiFi. Zero internet needed. This is the killer feature.

**Build effort:** 6-8 weeks
**Capital required:** $0

---

## Build Priority & Sequencing

### Phase 1: Prove the Framework (Next 4-6 weeks)

Build in this order — each builds on the previous:

| # | Project | Type | Primary Purpose |
|---|---------|------|-----------------|
| 1 | Shared Shopping List | Demo | Simplest multi-user app, viral potential |
| 2 | Kanban Board | Demo | Conference demos, developer credibility |
| 3 | POS / Inventory | Demo | Bridges to commercial product |
| 4 | Survey App | Demo | Bridges to commercial product |

### Phase 2: First Revenue (Weeks 6-14)

| # | Project | Type | Revenue Target |
|---|---------|------|---------------|
| 5 | KoraSync POS | Product | $10-25/month per shop |
| 6 | KoraForms | Product | $15-49/month per org |

### Phase 3: LAN Sync + Expansion (Weeks 14-24)

| # | Project | Type | Revenue Target |
|---|---------|------|---------------|
| 7 | LAN Sync (framework feature) | Framework | Enables products below |
| 8 | KoraLearn | Product | $20/month per school |
| 9 | KoraHealth | Product | $30-100/month per clinic, grant funding |

---

## Metrics That Matter

For demo apps:
- GitHub stars and forks
- `npx create-kora-app` weekly downloads
- Discord community size
- "Time to working app" (target: under 5 minutes)

For commercial products:
- Monthly recurring revenue (MRR)
- Customer acquisition cost (should be near $0 — content marketing + word of mouth)
- Churn rate (target: under 5%/month)
- Offline usage ratio (proves the value prop — if users are rarely offline, the product isn't reaching the right market)

---

## One Rule

Every project on this list must work **completely offline on first launch**. If it shows a loading spinner waiting for a server, it has failed the Kora promise.
