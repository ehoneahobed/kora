# Verification results: MERGE / CORE / DX

Verifier: independent. Every verdict is backed by a repro I ran. A repro asserts the CORRECT behavior, so it fails today and passes once the defect is fixed.
Repro files (all fail today):
- packages/test/tests/repro/MERGE-1.test.ts, MERGE-2.test.ts, CORE-1.test.ts, NEW-MERGE-1.test.ts
- packages/core/tests/repro/CORE-1.test.ts
- kora/tests/repro/DX-3.test.ts, DX-4.test.ts, DX-9.test.ts
- kora/tests/repro/types/DX-1.ts, DX-2.ts (tsc probes. Run from kora/: `npx tsc --noEmit --strict --skipLibCheck --module esnext --moduleResolution bundler --target es2022 [--jsx react-jsx] tests/repro/types/DX-N.ts`. These resolve `korajs` to kora/dist/*.d.ts, as an app would.)
- packages/react/tests/repro/DX-5.test.ts, DX-6.test.ts
- packages/vue/tests/repro/DX-7.test.ts
- packages/cli/tests/repro/DX-8.test.ts

DX-10 was refuted, so it has no repro file.

| Item | Verdict | Sev | Effort |
|---|---|---|---|
| MERGE-1 | CONFIRMED (worse than claimed: also client/server divergence) | P1 | S (pairwise) |
| MERGE-2 | CONFIRMED (permanent client divergence for arrays and objects; diverges even with 2 replicas, see NEW-MERGE-1) | P0 | L |
| CORE-1 | PARTIAL ("causalDeps always []" is false; the hash-coverage and no-verification parts are confirmed) | P2 | S/M |
| DX-1 | CONFIRMED | P1 | M |
| DX-2 | CONFIRMED | P2 | M/L |
| DX-3 | CONFIRMED (the "one line" part is partial) | P2 | S |
| DX-4 | CONFIRMED | P3 | S |
| DX-5 | CONFIRMED (StrictMode itself works; a guard test is added) | P3 | S |
| DX-6 | CONFIRMED | P2 | M |
| DX-7 | CONFIRMED | P2 | S |
| DX-8 | CONFIRMED | P3 | S |
| DX-9 | PARTIAL (deliberate design with an `app.collections` escape hatch, but silent at runtime) | P3 | S |
| DX-10 | REFUTED | – | – |
| NEW-MERGE-1 | CONFIRMED (new) | P0 (part of MERGE-2) | – |

---

## MERGE-1: one-sided removal lost when the other side concurrently adds
**Verdict: CONFIRMED.**

**Evidence**
- `addWinsSet([], ['urgent','billing'], ['urgent'])` returns `['urgent','billing']`, and so does the symmetric call.
- End to end (2 TestDevices, real store/sync/server, devices offline while editing):
  - A sets tags `[]` and B sets `['urgent','billing']`. Both clients end with `['urgent','billing']`.
  - The server value is chosen by HLC LWW, so it depends on which edit has the later timestamp:
    - B's edit later: server is `['urgent','billing']`.
    - A's edit later (second test case): server is `[]` while both clients show `['urgent','billing']`. Clients and server diverge, and a fresh device's view depends on the path it syncs through.

**Intent**
- docs/guide/conflict-resolution.md:33,49-51 says "Add-Wins Set… union of elements from both sides" and only gives an add/add example.
- The helper's own header (packages/merge/src/strategies/add-wins-set.ts:5-8) says "if one side adds an element while another removes a different element, both changes are preserved". The code violates that.
- Unit tests add-wins-set.test.ts:26-47 and :120-130 codify the buggy rule "kept unless BOTH removed", even when the other side made no change at all (:38-47). That rule is not OR-set add-wins. An uncontested removal is undone.

**Root cause:** add-wins-set.ts:65-72 removes an element only when `removedLocal ∩ removedRemote` contains it. Single-side removals are discarded.

**Correct semantics (value-level three-way set merge):** for each element e:
- e in base: keep iff e ∈ local AND e ∈ remote. A removal by either side wins over "unchanged".
- e not in base: keep iff e ∈ local OR e ∈ remote. Additions win.

Equivalently, result = (local ∩ remote) ∪ (local − base) ∪ (remote − base).

Under true OR-set semantics, "add-wins" only matters when the same element is concurrently removed and re-added, which needs unique add tags. A value-level merge cannot tell that case apart.

**Fix:** a pairwise formula change in addWinsSet, plus updating the 3 unit tests. This fixes the 2-replica scenario. It does not give convergence across 3+ replicas or arbitrary orders (see MERGE-2). Also make the server materialize arrays with the same merge (SRV-1); otherwise client and server still diverge.

**Regression risk:** low to medium. Behavior visibly changes for apps that relied on removals being undone. Docs should state that removal wins over unchanged.

**Severity:** P1 (silent data change and client/server divergence). **Effort:** S for the helper; the server side is in SRV-1.

---

## MERGE-2: pairwise merge is not convergent for non-scalar kinds
**Verdict: CONFIRMED.** Client replicas permanently diverge for array and object/json fields.

**Test:** packages/test/tests/repro/MERGE-2.test.ts
- Setup: 3 writers plus a late joiner plus the server, real ApplyPipeline/SyncEngine/KoraSyncServer.
- Randomness: mulberry32 seeded. fast-check cannot be resolved from packages/test because it only lives in core/store node_modules; fixed seeds play the same role.
- Each round: writers go offline, each makes one random edit, then they reconnect in a random order (which sets the delivery order).
- After the rounds there are 3 full sync passes. Every replica holds all 7 ops for the record (verified via `getOperationsForRecord`), so the divergence is not delivery lag.

**Results** (12-seed sweep, 2 rounds):

| Field kind | Seeds where clients diverge | Client vs server |
|---|---|---|
| tags (array) | 5/12 | diverge in most seeds |
| object/json | 1/12 | diverge in most seeds |
| quantity, documented additive custom resolver | 0/12 (clients agree on the correct sum) | server diverges every time (server is LWW; that is SRV-1) |

With 1 round (one concurrent edit per writer), clients always converged. Divergence needs a second round, which means merges that run on rows that already contain earlier merges.

**Smallest counterexample found** (tags seed 1, base `['t1']`):
- r0: w0 sets `[]`, w1 sets `['t1','t4']`, w2 sets `['t1','t2']`. Sync order: d0, d1, d2. All clients converge to `['t1','t2','t4']`; the server has `['t1','t2']`.
- r1: w0 sets `['t1','t2']` (removes t4), w1 sets `['t1','t4']` (removes t2), w2 sets `['t1','t4']` (removes t2). Sync order: d2, d1, d0.
- Final state:
  - device-0: `['t1','t4']`
  - device-1, device-2, late joiner: `['t1','t2','t4']`
  - server: `['t1','t4']`
- The correct value is `['t1']`. No replica has it.

**Object counterexample** (seed 3):
- r0: w0 edits meta.a; w1 sets settings.c='y'; w2 rewrites settings unchanged.
- r1: w0 sets settings.c='z'; w1 sets settings.c='x' (latest HLC); w2 edits meta.
- Result: device-2 has settings.c='z'. Everyone else, including the server, has 'x'.

**2-replica divergence (NEW-MERGE-1 below):** this alone proves that the pairwise approach is order and path dependent, not only with 3 replicas.

**Root cause** (kora/src/apply-pipeline.ts):
1. `base = op.previousData` and `local = current row` (:409, :523). The row already folds in earlier merges, so the pairwise 3-way function is applied to inputs that are not a common-ancestor triple. Set and map merge functions are not associative under this use.
2. The fast-forward path (:380-407) is taken when the touched fields equal previousData. The merge path is taken otherwise. Which path runs depends on unrelated local state, so applying the same op set in two orders takes different code paths.
3. `buildLocalDiff` (:523, :835) marks every remote-touched field as locally changed. So "local unchanged" is treated as a concurrent write. With the add-wins rule, that resurrects removed elements.
4. `resolveLocalTimestamp` (:511, :847) attributes the whole row to the latest local op's HLC. Object key-level LWW in mergeObject then compares against the wrong timestamp for keys last written by remote ops. That is the root of the object divergence.

**Correct semantics:** strong eventual consistency. The state must be a deterministic function of the set of ops for the record, independent of delivery order and path. All replicas, including the server and late joiners, must compute the same function.

**Is a pairwise fix sufficient? No.** Fixing the addWinsSet formula (MERGE-1) does not remove causes 1, 2 and 4. Two designs work:
- (a) **Log fold (recommended, M/L).** Materialize array, object/json and resolver fields by folding the record's full op log in total HLC order through a deterministic per-op delta:
  - Array: apply adds = data − prev and removes = prev − data.
  - Object/json: apply the changed keys (data vs prev diff) with per-key LWW.
  - Custom resolver: apply in HLC order.
  - Use the same fold on the server (`replayOperationsForRecord`). Atomic fields already work this way (`materializeAtomicFieldsFromLog`, apply-pipeline.ts ~595).
  - This converges by construction. It gives "last-delta-wins per element" instead of add-wins for a concurrent same-element add/remove, unless causal context exists.
- (b) **True op-level CRDT (L).** OR-set with unique add tags (or dotted version vectors) and a per-key HLC register for maps. This needs real causal metadata. causalDeps today is local-only (see CORE-1), so that metadata does not exist.
- Custom resolvers: document that `resolve(local, remote, base)` must be commutative and associative, and call it in a fold over HLC-ordered ops rather than pairwise on the materialized row.

**Regression risk:** medium to high. It touches every non-scalar merge and the server materializer. Mitigation: run the property test across all kinds, plus the existing convergence suite. Adopt MERGE-2.test.ts and increase the number of seeds.

**Severity:** P0 (permanent silent divergence on default field kinds; violates principle #1 and the "every device always reaches the same result" claim in docs). **Effort:** L.

---

## NEW-MERGE-1: an unchanged array in a concurrent update undoes a removal and diverges 2 replicas
**Verdict: CONFIRMED.** Repro: packages/test/tests/repro/NEW-MERGE-1.test.ts

**Scenario:** A sets tags `[]`. B saves `{title:'renamed', tags:['urgent']}`, with tags unchanged, as a form re-sending every field would.

**Result:** A has `['urgent']` and B has `[]`. This is permanent divergence with only 2 replicas.

**Why:**
- On B, A's op hits the fast-forward path (current tags == prev), so B gets `[]`.
- On A, B's op hits the merge path (tags differ from prev). `buildLocalDiff` marks tags as locally changed, and `addWinsSet([], ['urgent'], ['urgent'])` returns `['urgent']`.

**Fix:** covered by MERGE-1 (formula) together with MERGE-2(a). As a minimal step, buildLocalDiff should only include fields whose local value differs from base.

**Severity:** P0. It is a subset of MERGE-2.

---

## CORE-1: causalDeps / op-id hash coverage / no id verification
**Verdict: PARTIAL.**

### Claim "causalDeps always [] for user ops": REFUTED
- `CausalTracker` (packages/core/src/causal/causal-tracker.ts:27-38) is created per Store (packages/store/src/store/store.ts:150).
- It is passed into every mutation context (store.ts:887, :1176) and used by `resolveCausalDeps` (packages/store/src/mutations/resolve-causal-deps.ts) in execute-insert/update/delete and in transaction-context.
- So causalDeps = [previous LOCAL op in the same collection] plus the in-transaction parent, plus the parent op for cascades (`extraCausalDeps`, apply-pipeline.ts applySideEffectOps).

**Real limitations:**
- The tracker is in-memory only, so the first op after a restart has [].
- The tracker never records applied remote ops, so deps never reference another device. They carry no cross-device causality.

**Consumers:** only `topologicalSort` (core/src/version-vector/topological-sort.ts:36, used in commitTransaction), store replay-to (store/src/replay/replay-to.ts:64), devtools and studio. The merge engine, sync and server ignore them.

### Hash coverage: CONFIRMED
`computeOperationId` (packages/core/src/operations/content-hash.ts:17-27) hashes type, collection, recordId, data, timestamp, nodeId and atomicOps. It excludes:
- previousData
- sequenceNumber
- causalDeps
- schemaVersion
- transactionId and mutationName

Repro packages/core/tests/repro/CORE-1.test.ts: tampering with each of the first four leaves `verifyOperationIntegrity` true. That is 4 failing tests.

### No verification on receive: CONFIRMED
- `verifyOperationIntegrity` (operation.ts:144) is referenced only by tests.
- Server `handleOperationBatch` (packages/server/src/session/client-session.ts:943-1080) checks scope, timestamp, rate, size, schema transform and the validator, but never the id.
- `MemoryServerStore.applyRemoteOperation` deduplicates purely on the client-supplied id (memory-server-store.ts:79).
- Client inbound (sync-engine and store) also never verifies.
- Repro packages/test/tests/repro/CORE-1.test.ts: device B pushes an update with id `'fff…f'` (not a hash). The server stores and relays it, and device A materializes title='forged'.

**Concrete consequences:**
1. Ids are attacker- or bug-chosen. Dedup is first-writer-wins by id, so any op whose id collides with a not-yet-seen genuine op silently drops that op everywhere as 'duplicate'. A buggy client (for example, rebase reusing ids with new content) produces silent loss rather than an error.
2. Even if verification were added, previousData is unprotected. previousData drives the merge base (apply-pipeline.ts:409, 3-way merge) and the server upload scope check (SEC-2). So a relay or tampering party can induce removals or additions in array and object merges without changing the id.
3. sequenceNumber is unprotected. The version vector is advanced from it (memory-server-store.ts ~88-91). A forged huge sequenceNumber skips a node's later ops (SEC-3), and two ops can have the same id but different seq.
4. A content hash is not authentication. A legitimate peer can always mint valid-hash ops for any nodeId. Origin binding needs session-to-nodeId binding (SEC-3) or signatures.

**Fix:**
- Include previousData, sequenceNumber, causalDeps and schemaVersion in the canonical hash. This is a breaking id change and needs a protocol/version bump. `rebase-unsynced-operations.ts` already recomputes ids.
- Verify the id in server handleOperationBatch and in the client inbound path; reject with a non-retriable INVALID_OPERATION_ID.
- Bind op.nodeId to the authenticated session.
- Either persist the CausalTracker heads and record remote ops, or drop the claim that ops carry causal dependencies.

**Regression risk:** medium (id format change touches stored logs and backups). **Severity:** P2 standalone; it is an enabler for SEC-2 and SEC-3. **Effort:** S (verify) / M (hash change plus migration).

---

## DX-1: phantom Req/Auto params make insert/record types vacuous
**Verdict: CONFIRMED.** Probe kora/tests/repro/types/DX-1.ts, importing from 'korajs' resolved to kora/dist/index.d.ts.

**What compiles today but should not:**
- `insert({})`
- `insert({ title: 1 })`
- `insert({ title:'x', createdOn: 5 })` (auto field)

These show as 3 unused `@ts-expect-error` directives.

**Wrong inferred types:**
- `Todo['assignee']` (optional) is `string` instead of `string|null`.
- `Todo['done']` (default) is `boolean` instead of `boolean|null`.

A scratch probe shows `Parameters<insert>[0]` accepts any value.

**Root cause:** packages/core/src/schema/types.ts:27-50.
- `Req` and `Auto` appear only in constructor casts. Fields are declared `boolean`, so `FieldBuilder<K,false,true>` is structurally identical to `FieldBuilder<K,true,false>`.
- The conditionals in infer.ts:77-114 (`extends FieldBuilder<any,true,any>` / `<any,any,true>`) therefore always take one branch: every field counts as "auto", which yields insert input `{}`, and every field counts as required and non-null in the record.

**Type tests are vacuous:**
- infer.test.ts ~74 and ~83 use `toMatchTypeOf<string|null>`, which `string` satisfies.
- ~115, ~129 and onward declare `type _Check = … ? true : false` and never assert it.

**Fix:**
- Add structural brands, for example `declare readonly __req: Req; declare readonly __auto: Auto` (type-only, zero runtime cost), or type `_required: Req` / `_auto: Auto`.
- Replace the type tests with `expectTypeOf<…>().toEqualTypeOf<…>()` and `@ts-expect-error` negative cases. Wire `tsc --noEmit` on these probe files into CI.

**Regression risk:** medium. User code that currently compiles while omitting required fields will start failing typecheck (intended). **Severity:** P1 (the headline "full type inference" DX promise is silently off). **Effort:** M.

---

## DX-2: query, tx, useCollection and builder typings are loose
**Verdict: CONFIRMED.** Probe kora/tests/repro/types/DX-2.ts: 10 errors, every negative case compiles.

| Area | Location | What is wrong |
|---|---|---|
| where | `where(conditions: Record<string, unknown>)` (kora/src/types.ts:441-452 TypedCollectionAccessor; store query-builder.ts:54) | accepts unknown fields and wrong value types |
| orderBy, include | query-builder.ts:66 and :108 take `string` | accept unknown fields and relations |
| transaction proxy | `TransactionProxy` (types.ts:298-301) is `[collection: string]: TransactionCollectionProxy` with `Record<string,unknown>` data | `tx.nope.insert(...)` and `tx.todos.insert({title:1})` compile |
| useCollection | `useCollection(name: string): CollectionAccessor` (packages/react/src/hooks/use-collection.ts:18) | untyped |
| t.object | (types.ts:578) returns `ObjectFieldBuilder` | infers `Record<string, unknown>`, not `{theme:string; size:number}` |
| t.array(t.enum) | `ArrayFieldBuilder<'enum'>` maps via FieldKindToType | infers `string[]`, not the literal union |
| default | `.default(value: unknown)` (types.ts:58) | `t.number().default('not a number')` compiles |

**Fix:**
- Type `where` as `Partial<{[K in keyof R]: R[K] | Operators<R[K]>}>` and `orderBy` as `keyof R & string`.
- Generate the include union from relations.
- Make TransactionProxy `TypedCollections<S>`-shaped (TypedKoraApp.transaction should take `(tx: TypedTx<S>)`).
- Make useCollection generic over the app type (or provide a `createKoraHooks<typeof app>()` factory).
- Carry the inner builder type in ObjectFieldBuilder<F> and ArrayFieldBuilder<B>.
- Type `default(value: InferFieldType<this>)`.

**Regression risk:** medium (stricter types break loose user code). **Severity:** P2. **Effort:** M/L.

---

## DX-3: docs that contradict code
**Verdict: CONFIRMED** (one sub-claim partial). Repro kora/tests/repro/DX-3.test.ts: 5 failing tests.

1. **useMutation result called as a function:** docs/getting-started.md:242-247 has `const addTodo = useMutation(app.todos.insert)` followed by `addTodo({...})`. useMutation returns `{mutate, mutateAsync, …}` (packages/react/src/hooks/use-mutation.ts:35-41), so this throws `TypeError: addTodo is not a function`.
   - Passing the unbound `app.todos.insert` itself is fine, because kora/src/collection-accessor.ts methods do not use `this`.
   - README.md:127-133, docs/api/react.md and docs/examples use `.mutate` or destructuring correctly.
2. **useRichText signature:** docs/api/react.md:389-392 and :422 document `useRichText(recordId, field)` returning `{yText,yDoc,isLoading}`. The actual signature is `useRichText(collectionName, recordId, fieldName, options?)` (react/src/hooks/use-rich-text.ts:17-22). The guide and examples use the correct form.
3. **"There is no loading state for local data"** (docs/api/react.md:91, docs/guide/react-hooks.md:60) is false. useQuery starts at `EMPTY_ARRAY` and creates the QueryStore in `useEffect` (use-query.ts:25, :29-44, :51-56). The first render is always `[]`, and there is no flag to tell "loading" from "empty".
4. **"Enable sync (one line)":** PARTIAL.
   - README shows `await app.sync?.connect()` and so needs 2 more lines.
   - docs/index.md:75 claims `sync: {url}` is "one line for multi-device sync" but never connects. autoConnect defaults to off (kora/src/sync-lifecycle.ts:141 `autoConnect === true`).
5. **README status:** README.md:11 says "Public beta (v1.0.0-beta.0)" while the packages are 1.0.0-beta.12.

**Fix:** edit the docs. Add a docs code-snippet typecheck (extract tsx blocks and run tsc) to CI.

**Risk:** none. **Severity:** P2 (the first-run tutorial crashes). **Effort:** S.

---

## DX-4: findById before ready returns null silently
**Verdict: CONFIRMED.** Repro kora/tests/repro/DX-4.test.ts: insert rejects with AppNotReadyError, while findById resolves `null`.

**Location:** kora/src/collection-accessor.ts:24-27 (`if (!currentStore) return null`). The other methods throw (:17-23, :28-50).

**Fix:** throw `notReady('find')`. Also check the kora/src/create-app.test.ts cases that rely on null.

**Risk:** low (callers relying on null before ready now see a rejection; that is the intended outcome). **Severity:** P3. **Effort:** S.

---

## DX-5: useMutation returns new functions each render and resubscribes
**Verdict: CONFIRMED.** Repro packages/react/tests/repro/DX-5.test.ts:
- `mutate`, `mutateAsync` and `reset` change identity on every render.
- Controller `subscribe` was called 6 times after 5 rerenders (expected 1). The inline subscribe arrow passed to useSyncExternalStore makes React unsubscribe and resubscribe each render.
- A StrictMode test was added and passes: the functional behavior is fine. It is confirmed that no StrictMode test existed for useMutation; only use-query.test.ts and auth-bound-kora-provider.test.ts use StrictMode.

**Location:** packages/react/src/hooks/use-mutation.ts:29-41.

**Fix:**
- Make `subscribe` and `getSnapshot` stable with `useCallback`, keyed on getController, which is already stable.
- Memoize the returned callbacks with `useCallback` / `useMemo`. They already go through getController and the refs, so they are safe to make stable.

The same pattern exists in use-sync-status.ts:24 and use-rich-text.ts:46.

**Risk:** low. **Severity:** P3 (effect-dependency churn and extra work). **Effort:** S.

---

## DX-6: SSR is broken
**Verdict: CONFIRMED.** Repro packages/react/tests/repro/DX-6.test.ts (node environment): `renderToString` of a component using useQuery throws "Missing getServerSnapshot, which is required for server-rendered content".

**Location:**
- use-query.ts:62 calls `useSyncExternalStore` with only 2 arguments.
- use-collaborators.ts:42 has the same problem (NEW-DX-1).
- useMutation, useSyncStatus and useRichText do pass a third argument.

**Module-scope createApp on the server** (confirmed by code reading):
- adapter-resolver.ts:31-32 picks 'better-sqlite3' whenever `process.versions.node` exists.
- createApp starts `initializeApp` eagerly (create-app.ts:81).
- So in Next.js or Remix SSR, a module-scope `createApp` opens a native SQLite store in the server process per module instance.
- The docs position Kora next to Next.js (docs/guide/schema-design.md:200; CLAUDE.md mission), but no SSR guidance or template exists (all CLI templates are Vite SPAs).

**Fix:**
- Pass `getServerSnapshot: () => EMPTY_ARRAY` in useQuery and useCollaborators.
- In the resolver, detect a server render (no `window`, plus a framework flag) and use a no-op/in-memory adapter, or make `createApp` lazy (open on first `ready` access from the client).
- Document the `'use client'` boundary.

**Risk:** low (hooks) / medium (adapter selection in Node, which must not break real Node apps; make it opt-in via `ssr: true` or detect `typeof window`). **Severity:** P2. **Effort:** M.

---

## DX-7: Vue useQuery is not reactive to input changes
**Verdict: CONFIRMED.** Repro packages/vue/tests/repro/DX-7.test.ts: passing a getter `() => queries[props.filter]` throws `query.getDescriptor is not a function`.

**Location:** packages/vue/src/composables/use-query.ts:12-21.
- The signature accepts only a `QueryBuilder` value.
- The watch source `() => JSON.stringify(query.getDescriptor())` reads a plain object, which is not reactive, so a prop change can never re-run it.
- `enabled` is also captured once (:17).
- docs/api/vue.md:67-70 documents the value-only form, so the documentation matches the code, but the design is non-idiomatic.

**Fix:**
- Accept `MaybeRefOrGetter<QueryBuilder<T>>` and `MaybeRefOrGetter<boolean>` for enabled.
- Use `toValue()` inside the watch source.
- Release and re-acquire the cache entry when the descriptor changes; the existing onCleanup already handles this.

The same check applies to the Svelte store API (not verified here).

**Risk:** low (additive). **Severity:** P2. **Effort:** S.

---

## DX-8: deploy prompt offers stub platforms
**Verdict: CONFIRMED.** Repro packages/cli/tests/repro/DX-8.test.ts.

**Location:** packages/cli/src/commands/deploy/deploy-command.ts:322-329 offers "Render" and "Docker (self-hosted)" with no "coming soon" label. factory.ts:21-24 maps both to `StubDeployAdapter`.

**Flow** (deploy-command.ts:229-240):
- The Dockerfile and .dockerignore are written first.
- Then `detect()` returns false and `install()` throws `Deploy adapter "docker" is not implemented yet.`

So "Docker (self-hosted)" emits artifacts and then exits with an error. README's "deploys to Fly.io or Railway" is accurate.

**Fix:** either label both options "(coming soon)" and refuse them up front (like kora-cloud), or remove them from the prompt. For docker, implementing a "generate artifacts only" adapter that returns success with instructions is trivial.

**Risk:** none. **Severity:** P3. **Effort:** S.

---

## DX-9: collections named `sync` or `events` are shadowed
**Verdict: PARTIAL.** Repro kora/tests/repro/DX-9.test.ts: there is no warning and no error.

**Location:** kora/src/create-app.ts:232-234 skips reserved names (`if (reservedProperties.has(collectionName)) continue`). At runtime, `app.events` is the emitter.

**Why partial, not "silent" in every sense:**
- This is deliberate. JSDoc at create-app.ts:34-37 and the beta.12 release notes document `app.collections.<name>` as the collision-free path.
- `TypedKoraApp` omits reserved names from the top-level type (types.ts:458-524), so TypeScript users get a compile error on `app.events.insert`.
- Untyped JS users, and `KoraApp` (index-signature) users, get no signal.

**Fix:** in `validateCreateAppConfig`, warn once in development naming the collection and pointing to `app.collections.<name>`.

**Risk:** none. **Severity:** P3. **Effort:** S.

---

## DX-10: bare 'protobufjs' import under Node ESM
**Verdict: REFUTED** (no repro kept).

Checks run with Node v22.22.2 from packages/sync:
- `node --input-type=module -e "import protobuf from 'protobufjs'"` works: the default import of the CJS main exposes `Root` and `Type`.
- `import('@korajs/sync')` works, with 62 exports, both from packages/sync and from packages/server.
- Only the extensionless subpath `protobufjs/minimal` fails (`ERR_MODULE_NOT_FOUND`). serializer.ts:8 already uses `protobufjs/minimal.js`.

`dynamic-serializer.ts` is not exported from src/index.ts or src/internal.ts and is imported by nothing but its tests, so it is not in dist at all.

**NEW-DX-2:** `DynamicProtobufSerializer` is dead code in the shipped package. This corroborates the SYNC-9 claim that dynamic protobuf negotiation is not wired. Severity P3.

---

## New findings summary
- **NEW-MERGE-1** (P0, part of MERGE-2): an unchanged array in a concurrent full-record update undoes a removal and permanently diverges 2 replicas. Repro is kept. Cause: buildLocalDiff (apply-pipeline.ts:835) plus the fast-forward/merge path asymmetry (:380-409).
- **NEW-DX-1** (P2, part of DX-6): `useCollaborators` (react/src/hooks/use-collaborators.ts:42) has no getServerSnapshot.
- **NEW-DX-2** (P3): `DynamicProtobufSerializer` (sync/src/protocol/dynamic-serializer.ts) is unreachable from the package entry points.
- **Observation** (overlaps SRV-1, already registered): in every MERGE-2 run the server's LWW materialization differed from client results for arrays, objects and custom resolvers. The documented additive resolver is never applied server-side.
