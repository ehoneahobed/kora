# @korajs/core

## 1.0.0-beta.15

### Minor Changes

- 24f5531: Scope grants may be disjunctive: a collection scope is a conjunction of field predicates or `{ $or: [conjunction, ...] }` (up to 8 branches), so "my own records OR records in spaces I belong to" is one grant. Every decision (delivery, live relay, scope snapshots, uploads, reference checks, route queries, presence partition keys, the client's upload pre-check and local scope narrowing) goes through one matcher in `@korajs/core`, which fails closed on any malformed scope. Equivalent grants normalize to one canonical form; a handshake can only narrow each branch. First step of the beta.15 access rules.

  Clients now declare `supportsScopeDisjunction` at handshake. A server refuses a client that does not (Kora beta.14 and earlier) with `CLIENT_TOO_OLD` when its resolved grant contains a disjunction, because an older client would read `$or` as a field name and treat every record as outside its scope. Grants without `$or` are unaffected.

  A grant whose field predicate is an object other than exactly `{ $in: [...] }` (for example `{ $in: [...], $ne: ... }` or `{ $ne: ... }`) is now refused at handshake (`SCOPE_PREDICATE_LIMIT`) instead of being normalized to its `$in` part.

  With a disjunctive upload grant, a write must keep the record in every branch it matched before: a team member cannot move a shared record out of the team into their own branch (moving between branches is a server write). A `null` or non-object collection grant now denies that collection instead of being read as `{}`, and grant normalization keeps `0`, `-0`, `NaN` and `±Infinity` distinct.

- 6c72c04: Schemas can declare access rules. A schema-level `access` block names the memberships collection, the ordered roles and the group collections whose creator becomes a member; each collection declares `read`, `create`, `update`, `delete` (or `write`) and per-field `fields` rules built from `owner()`, `member()`, `memberOfKey()`, `where()`, `anyone()`, `serverOnly()`, `or()`, `and()` and `custom()`. `t.string().stamp('userId')` marks a field the server sets to the writing user. `defineSchema` validates every rule against the schema with an actionable message (unknown fields, roles, ambiguous groups, `anyone()` writes without `{ writes: true }`, `custom()` in read rules, read rules that expand past 8 alternatives). Read rules compile per user into the scope predicate the sync stream uses, and writes are decided by one evaluator (field rules, immutable access fields, stamps, server-owned memberships). The sync server enforces them (see the access-rules entries of this release).

  `where()` values must fit their field (type and enum domain). A group collection's owner field must be stamped (`t.string().stamp('userId')`).

- 0b461fa: Field rules on insert: a field left at its schema default no longer needs the field rule's `create`. Before, a field rule that declared only `update` (`resolved: { update: member(...) }` on `resolved: t.boolean().default(false)`) refused every insert, because each device fills in the default and the missing `create` denied it. Now the collection's `create` rule judges a field that is unset or holds its default (the client did not choose it), and any other value still needs the field's `create`: a rule without one refuses it with an `ACCESS_DENIED` message that says so. A field without a default, and an `auto()` field, are still refused under a rule without `create`.

  The collection's `create` rule now applies to every insert. Before, it was skipped when every field of the collection had a field rule, so such a collection admitted inserts that leave fields unset with no rule consulted at all; a collection that relied on field rules alone to admit inserts now needs a `create` rule (leaving it out denies every client, as documented). `CollectionAccess` gains `fieldDefaults`.

  Security fix (atomic intents): access rules now judge exactly the value the fold stores. An insert's field value is `data[field]` (before, an insert carrying `atomicOps: { credits: { type: 'increment', value: 0 } }` beside `data: { credits: 1000000 }` was judged as 0, the default, and stored 1,000,000); a field carrying an atomic intent never takes the default or unset shortcut; and an update is judged on the record exactly as the fold stores it: each built-in store folds the write onto the record's stored fold state inside the write's critical section and hands the result to the authorizer (`ApplyRemoteOptions.previewResult`, `context.resulting`), because whether an intent composes is decided per field from that field's history. Before, a write could pass a `where()` or `custom()` rule or a field rule with values the fold never stored (also before this release); every field an update writes now counts as changed for the rules even when a newer write wins it. A custom store without `previewResult` has every combination of per-field outcomes judged and refuses more than 4 atomic intents per operation in access-ruled collections (`INVALID_ATOMIC_OP`). The server now refuses, with `INVALID_ATOMIC_OP`, an operation whose atomic intent has an unknown type (before, it was judged as an unset field) or an invalid operand (a non-finite number for `increment`, `max`, `min`; none for `append`, `remove`), names a field it does not write, sits on a delete, or disagrees with its data: `data[field]` must be the intent applied to `previousData[field]` (to an unset field on insert), as every Kora client and `kora.apply` write it.

- 8411be3: Access rules can require a real membership: `member(field, minRole, { grants: false })` and `memberOfKey(field, minRole, { grants: false })` hold only through a row of the memberships collection or ownership of the group record, never through a capability grant (`AuthContext.accessGrants`, such as a share link), whatever role the grant names. Evaluation, the compiled download scope and history gating all honor it, so a group reached only through a grant never enters such a rule's scope; a user holding both is judged on the membership's role. `defineSchema` refuses a non-boolean `grants` and leaves the default out of the resolved rule, so the read-rules key of existing schemas is unchanged (turning `grants` off changes it, and devices are re-scoped once). `MembershipView.roleOf` and `groupKeys` take an optional `{ grants: false }` for `custom()` checks; without it they count grants as before. On the server, grant-derived intervals now carry `source: 'grant'` (never stored, reconciled or reported by `roleOf`). `@korajs/spaces` declares `space_members` and `space_invitations` with `{ grants: false }`: a share-link holder receives the space's records, not its member list or its invitations (the read rules change, so each device of an app using the kit is re-scoped once after the upgrade).
- 714ebd2: Blob pulls no longer hang on a lost message. A blob chunk request was sent only while the sync engine was `streaming`, so a pull started while the initial sync was still arriving (when its rows are already visible) was silently dropped; it then waited 30 s and failed with a plain `Error`, and neither a lost answer nor a reconnect led to a retry.

  - Blob chunk messages go out as soon as the handshake is accepted (`syncing` or `streaming`); servers since 1.0.0-beta.13 already accept them then. `BlobChunkChannel.send` returns whether the message was sent, and `onReady(handler)` runs after each accepted handshake.
  - `createRemoteChunkProvider` re-sends an unanswered request under the same request id after 5 s, then a wait doubling to 30 s (20% jitter), re-sends every pending request when the connection is ready again, and fails only after 2 minutes without any answer (`deadlineMs`; `timeoutMs` is a deprecated alias). Failures reject with `BlobTransferError` (a `KoraError`: `BLOB_CHUNK_TIMEOUT`, `BLOB_CHUNK_UNAVAILABLE`, `BLOB_CHUNK_CANCELLED`, with `hash`, `attempts` (requests actually sent: tries made offline are not counted), `lastReason`); `receiveBlob` and `fetchBlobManifest` report a chunk nobody holds as `BLOB_CHUNK_UNAVAILABLE`. The provider takes an injectable `clock` and `random`, and `close()` cancels pending requests and clears their timers (called on `app.close()`).
  - New events `blob:request-retried`, `blob:request-failed` and `blob:handler-error`, recorded by DevTools. A blob channel handler that throws no longer stops the other handlers (or the message from reaching the chunk provider); its error is emitted as `blob:handler-error`, or logged when the engine has no emitter.
  - The sync server's blob relay always answers a connected requester: "not held" once every peer it asked said not held or left, and when a request expires (counted from its first arrival, so client re-sends do not extend it, on a timer rather than when the next request arrives); `throttled` (with `retryAfterMs`) over the per-session pending cap, when bytes are ready but the session may not receive them, and for a request id pending for another session. Counters are kept per answer kind (`BlobChunkRelay.getStats()`: each delivered answer once under its kind, a request whose requester left once under `requesterGone`), and the pending-cap and duplicate-id cases are logged.

  No wire or protocol change: every answer is a `blob-chunk-response` of a shape servers already send (`throttled` since 1.0.0-beta.13, whose clients retry on it). An older client against a new server gets an answer instead of silence (a beta.12 client reads `throttled` as "not held", as it already does for the request budget); a new client against an older server recovers through its retries.

- 95f5a26: `useMutation` reports writes the sync server refuses. In React, Vue and Svelte, `useMutation(fn, { onRejected })` and a `rejected` state (`{ code, message, collection, recordId, operationId, operationIds, reverted, args }`) tell the component that made a write when the server permanently refuses it, even hours later after an offline period, so an app can show "this change was undone, and why" without listening to sync events. One `mutate()` call is one write: every operation it committed, including a delete's cascades and a whole `app.transaction()`; it is reported once. `reverted` is false only for the refusals the device keeps locally (`OUT_OF_UPLINK_SCOPE`, `NODE_ID_MISMATCH`, `SEQUENCE_CONFLICT`). Retriable rejections are not reported. A hook reports nothing after it unmounts, and tracks at most 500 unsynced writes; the app-level `sync:operation-rejected` event and `app.sync.getRejectedOperations()` still report every refusal. Tracking needs `<KoraProvider app={app}>`. Svelte's mutation also gains `subscribeRejected(fn)`.

  Two new sync events support it: `sync:operations-acknowledged` (`operationIds` the server stored) and `sync:operations-rewritten` (`reason`, `idMapping`: unsent operations re-authored under new ids by a clock rebase, a node-id rotation or a sequence renumbering).

- 0b461fa: The sync server reports committed writes: `createKoraServer({ onOperationsCommitted(operations, context) })` (also `syncOptions.onOperationsCommitted`) and `server.onOperationsCommitted(handler)` on `KoraSyncServer` and `createProductionServer` (returns an unsubscribe function) run once per batch after it is durably committed. Device uploads over WebSocket and HTTP long-polling arrive with `source: 'sync'` and the session's `auth` and `sessionId`; server-authored writes (`server.kora.apply`, `applyConditional`, `transaction`, `server.access`, the spaces routes, writes a validator makes through `context.kora`, `applyLocalOperation`, `relayServerOperations`) with `source: 'server'`. The referential side effects and cross-record corrections a write causes are in its batch. Refused, ignored and duplicate operations never appear, and a backup restore does not call it. Each handler gets its own deep, frozen copy of the operations as stored and of the context (the session's `auth` included, so a handler cannot change the credential that decides the session's later reads and writes), are not awaited, and fire on the instance that committed; a handler that throws or rejects is logged (`operations.commit_hook_failed`), counted as an error and emitted on the server's `emitter` as the new `server:commit-hook-failed` event, and never affects the commit, the acknowledgment or the fan-out. Apps that wrapped `store.applyRemoteOperation` to see committed writes can use it instead (that wrapper missed transactions, conditional applies and server writes).

  An upload batch that stops part way (a store error, the session ending because a grant was deleted) now relays the operations it committed before stopping to the other connected sessions, as a completed batch does; before, a protocol-1 client missed them until it reconnected. A `kora.transaction` and the side effects it causes are fanned out together.

  Operations committed before a follow-up step fails (a cascade or set-null write, a cross-record correction, the side effects of a transaction) are now relayed to connected devices and reported to `onOperationsCommitted`; before, a failing follow-up left the committed write unannounced until the next delivery poll (and a protocol-1 client until it reconnected). A `kora.apply` whose follow-up failed still rejects.

### Patch Changes

- 6fd998a: Experimental: the sync server can enforce access rules (`experimentalAccessRules: true` on the server, `{ accessRulesEnforced: true }` on `store.setSchema`). Uploads to access collections are decided by the rules against the writer's memberships read inside the store's write transaction, so a revoke refuses the next write at once; cascades and rich-text updates follow the same rules. A client insert onto an existing group id is refused (`GROUP_EXISTS`), stamped fields must be present and equal to the writer (`STAMP_REQUIRED`, `STAMP_MISMATCH`), and the memberships collection is server-written (`SERVER_OWNED`). A session's read grant over access collections is compiled from its memberships at handshake (a user always reads their own membership rows); it does not yet follow membership changes until the client reconnects. `server.access.grant`, `revoke`, `transfer` and `sweepExpired` change memberships with logged server writes, and a sweeper ends expired memberships (`accessSweepIntervalMs`). Clients that cannot follow access rules are refused with `CLIENT_TOO_OLD`.
- 946dd42: With `experimentalAccessRules`, the download stream follows membership changes. When a session's stream reaches a change to the user's memberships, it re-reads them and sends what changed as one re-scope unit at that delivery sequence, starting a batch: a narrowing (the grant now in force per access collection, new `accessNarrowing` batch field) that the client applies to the records it holds, judged on its own values and keeping records with unsent writes, then scope entries (current values) for records the user may now read, filtered by the client's query view. Narrowing on the client removes records that moved or were deleted while the user was revoked, which the server cannot name. A group revoked and granted again, or a membership whose role changed in place since the client's watermark (tracked by a new `role_seq` index column, added to existing databases on open), is re-sent in full. History is gated by the open membership interval: a late joiner receives a group's current state, never the operations written before they joined, on a live session, a reconnect and a fresh device alike. What a reconnecting client holds is rebuilt from the membership intervals at its watermark, so a reconnect after changes made while offline resumes from the watermark. Access collections are reported to clients as unrestricted, so a client's view and its watermark stay the same across membership changes; the server alone enforces the grant. Records leaving an access collection's grant are always retracted. The delivery poll refreshes each session's memberships, so rich-text, presence and blob channels follow a change within one poll interval even when a client's stream is not progressing. `server.access.grant` no longer writes `expiresAt` when the memberships collection does not declare it.

  Rule types (`OwnerRule`, `MemberRule`, `OrRule`, ...) are exported from `@korajs/core` and `korajs`, so a schema module with declaration emit can export a schema that uses access rules.

  `@korajs/sync` applies a batch's `accessNarrowing` before its retractions and operations (`SyncStore.applyCollectionNarrowing`, implemented by `@korajs/store`); a failure stalls the delivery watermark so the batch is re-sent.

  A device keeps the key of the read rules it was last fully re-scoped under (`accessRulesKey`, sent at the handshake and carried by the batch that re-scopes it); a server running other read rules (a deploy, or another instance mid-rollout) narrows every access collection and sends everything it may read again, and a collection whose rules were dropped is re-sent under the session's own scope. Index reconciles, which write no operation, take a delivery sequence of their own, and the stream advances caught-up clients past it. When a client's own accepted write leaves an existing record outside what it may read (a write rule broader than the read rule), the server retracts that record from the client; records the client created stay. Records a narrowing kept for unsent writes are remembered on the device and removed once those writes are refused, unless the server sent them again meanwhile.

- 8667762: Access rules on the device. An insert fills fields declared `t.string().stamp('userId')` with the signed-in user (the app knows it through `authClient` or a `principal`), so apps no longer pass `ownerId` themselves; naming another user, or inserting before the app knows who is signed in without passing the field, throws `StampedFieldError` (`STAMP_MISMATCH`, `STAMP_USER_UNKNOWN`). A group created offline, with content in it, syncs without ever leaving the device. A scope retraction of an access-collection record that has unsent writes is deferred, durably, until those writes are acknowledged or refused, so offline work is judged by the server instead of quarantined; the record is hidden then and `sync:scope-retracted` is emitted.
- 003d7bf: Capability grants: an auth provider can return `accessGrants` on a session's `AuthContext` (a share link, a signed URL), each a role in a group held without a membership. Under access rules every rule that admits members of the group admits the session, anonymous sessions included, for reads, writes, rich text, presence and blobs. Grants the schema cannot honor (not a group collection, an unknown role, a missing or deleted group, an expired grant) give nothing; `roleOf`, `server.access` and `@korajs/spaces` never see them; a change of grants ends the session at its next credential check and re-scopes the device in full. Membership rules (`member`, `memberOfKey`) now evaluate the memberships resolved for the principal even when it is anonymous (empty unless the server granted capabilities).
- 180923d: The server's startup re-materialization (first start after upgrading from beta.12, a fold plan change, a replace-mode restore) is linear in the operation log again. Rebuilding each operation's scope snapshot materialized every field of the record after every operation, so a `t.richtext()` body was re-merged from all its stored edits once per operation (quadratic: a 1,100-edit document needed about 600,000 Yjs merges, and a 25-document production database took over 30 minutes). Snapshots now materialize only the scalar fields they keep; the values are byte-identical. A 600-edit document migrates with 599 merges instead of about 223,000 (1.5 s instead of 187 s).

  The migration commits in bounded transactions of whole records (at most 2,000 operations each), so the delivery-counter lock that appends take is held for one batch at a time, and a killed process resumes where it stopped; the scope snapshot rebuild is resumable too (`scope_snapshot_fields_pending`). A migration longer than 5 seconds logs its progress every 5 seconds.

  Rich-text writes no longer re-merge the field's whole history: each server keeps the merge of the updates it materialized last per field (bounded, 64 MiB) and merges only what a write adds (one Yjs merge per write instead of one per stored edit: 600 merges, about 1 s, per write to a 600-edit document in the regression test). Merges over incomplete Yjs content are always done from scratch, so the bytes never depend on the cache.

  New: `materialize(state, { fields })` materializes only the given fields, `FoldOptions.richtextKeyed` (a richtext merger told which record field it merges), and `mergeRichtextUpdate` in `@korajs/merge` (`mergeRichtext` without a base that also reports whether the merged Yjs document is complete).

- 89cb4c4: A record deleted on the server while outside a device's view no longer comes back on that device, or on a new device, through a stale write. An operation after which the record is deleted (a delete, or a write older than the record's newest delete) is now delivered by the record's folded state and by what each session's view held of the record, not by the operation's own values: a delete reaches every view in which the record was live at some point (including `scopeExit: 'retain'` devices, retracted records, query-subset views and access-rules members who joined after the last write), and a stale write is sent only to such a view, when its values are in view, after the record's newest delete (sent once per delivery pass).

  The decision costs one batched read of a bounded per-record summary (`kora_record_live_views`) over the fields the server's own grants read, never the record's history. A summary is trusted only while the record's fold state records that it accounts for the record's newest operation (`lv_through` beside `covered_op_id`); a write by an instance that does not maintain it (an older version during a rolling deploy), a re-fold or a restore leaves it unknown until a background rebuild, and a later write never makes it current again. A write that changes neither the record's liveness nor a tracked value touches no summary. Scope snapshots gain an additive `deleted` field. Summaries and the tombstone state of existing data are filled by a background backfill after start (short, guarded transactions; no startup rebuild, the snapshot fingerprint is unchanged). While unknown, a delete is delivered as in 1.0.0-beta.14, and a write older than the record's delete is delivered as before when its values are in view, preceded by the record's newest delete (the fold keeps its fields, so a device without it would diverge after a revival); for an access-rules collection, only to a member whose membership began before the record was deleted (judged at the first delete after its last live write, so a second delete does not move it: read from the stored tombstone state, else decided by a bounded replay of the record's history; never withheld on a guess, since the watermark would pass the write. If it still cannot be decided, only that write is held (the watermark does not pass it; the rest of the member's stream and other devices of the author flow on) and the record rebuilt, judged again with a 500 ms to 5 s backoff from a per-operation cache shared by all sessions, and after 15 seconds the write is sent as before, which means a member who joined after the delete can be shown that one stale write once the hold expires (logged and emitted); at most 1,024 writes are held per session, the rest are sent; clients without a delivery watermark are refused when access rules apply, so no path sends past a hold). Tracked fields come from the server's grant before any client narrowing; a replace-mode restore or a snapshot wipe by this version bumps an epoch that voids rebuilds in flight (a wipe by an older instance does not; its snapshot fills are guarded by the snapshot they read, and its summary writes by the fold state); a fold state invalidated in place (`covered_seq = -1`) leaves its summary unknown. Stores gain the optional `registerLiveViewFields`, `getRecordLiveViews`, `requestLiveViewRebuild` and `whenLiveViewsIdle`; a custom store without them keeps the previous behavior. An undetermined deletion point is logged (`session.tombstone_delivery_undetermined`), counted in `errorCount` when it is a failed read or a send, and emitted as the new `server:tombstone-delivery-undetermined` event.

  A delete that carries the record it removed (a delete made through a server route) reaches a view that only held an earlier version of the record, before it moved elsewhere, without that record: the copy keeps the id, drops `previousData` and declares no hash version (clients do not check the id of such a server-rewritten operation). A write onto a tombstone still has to pass the access history gate (membership at the write), also on the known-summary path. A replace-mode restore resets the live-view backfill cursors and rebuilds the summaries of the restored log. A held write that resolves sends the operations scanned beyond it again in the chain that moves the watermark past them, and a version-vector delta carries a replayed delete once.

  For an access-rules collection, every outbound path (the delivery stream, a live relay and a version-vector delta) now cuts a delete's `previousData` unless the delete's own delivery sequence is known and the session's history gate admits the content at it; an unknown sequence is never replaced by the end of the log (that admitted a membership opened after the delete), so the content is cut and the delete still arrives. `ServerStore.findStoredOperations` returns the delivery sequence as an optional field. A write onto a tombstone also has to pass the membership-predates-the-tombstone gate when the record's summary is known, not only when it is unknown.

- b378fb9: Shared browsers: each account gets a device id, and so a sync node, of its own. beta.12 gave every
  account on a browser the same device id, so with `store.namespaceByAuthUser` two users' databases
  authored under one node; later servers refused every account but the device's first
  (`DEVICE_OWNERSHIP_CONFLICT`). The persistent device identity now holds one device id per account
  that signed in on the device (and one unused id), storing nothing about the accounts; every
  sign-in, sign-up and OAuth callback offers them all (`deviceCandidates`) and the auth server picks
  the one registered to the account, else an unregistered one (sign-up checks before creating the
  account; an MFA sign-in registers it only after the second factor; when every candidate is refused
  the browser replaces its unused id and retries once). A namespaced database whose pinned node moved retires the previous node, asks the server
  by id which of its own writes it stores (`probeOperationIds` / `operationProbe` in the handshake),
  and re-authors the rest under its own node (`sync:operations-rewritten`, reason `node-rotation`;
  `sync:local-node` action `retired-repaired`), never an operation it received under that node, and
  not while a tab still has the node open. The device's registered owner keeps the old node, and the
  server hands it over as before.
  A node known only from outbound-queue entries (beta.12 queued writes a tab received from the
  user's other device) is asked about by id too: what the server stores is settled
  (`queue-settled`) instead of being reported as held unassigned writes.
- 0388bd7: Version gate, stage 1 (`docs/design/version-gate.md`): one build of an app writes a browser database at a time. When a tab running a newer build opens, every tab of an older build stops writing before the newer tab writes, and no write a stored snapshot confirmed (IndexedDB fallback) or that committed (OPFS) is lost.

  - Every tab declares `{ build, format, openSeq, tabId }` and holds a Web Lock named after it (`kora-tab:<db>:<identity>`) for its life; `navigator.locks.query()` is the roster, so silent followers and tabs that have not processed a message are seen. `openSeq` comes from an IndexedDB counter (`kora-gate`), never the clock. The ordering key is `(format, openSeq)`.
  - A tab retires when it learns of a tab of another build with a higher key (discovery, a `kora-build-hello`, or the leader heartbeat, which now carries the leader's identity): it refuses new writes with `BuildSupersededError` (`code: 'BUILD_SUPERSEDED'`, retriable, carries `collection` and `operation`, never data), waits for every write it started, makes them durable (IndexedDB fallback: a failed barrier keeps the tab lock and retries; `SNAPSHOT_SUPERSEDED` does not hold it; from the moment retirement starts, `close()` first waits for admitted writes and saves them with the throwing barrier, and is refused with `PersistenceError` `context.code: 'UNSAVED_WRITES'` when that fails, instead of handing the database over without them; `Store.prepareClose()` runs that check), gives up its storage roles (a leader first waits for its old-build followers to retire, then stops its worker; a follower withdraws its queued promotion) and releases its tab lock. Reads keep working through the newer build's leader. A retiring fallback tab with no storage worker left (its leader closed) settles its writes against the stored snapshot version, read from IndexedDB without a worker. Inbound delivery batches (`Store.applyRemoteBatch`) go through the same write gate: a retired tab applies none.
  - A tab opens storage only when no tab of another build with a lower key holds its tab lock, and no storage leader of another build is alive (the leader marker carries the leader's identity, `kora-gated-leader-id:<db>:<identity>`, so a leader whose tab lock is gone is still waited for); there is no deadline. After 10 s it reports `store:build-gate-waiting` (`reason: 'live-writer' | 'unsaved-writes' | 'legacy-build'`). A tab granted the leader lock checks the roster first and releases it unopened when a newer build is listed, so an old-build worker never starts after a newer tab appeared.
  - Page lifecycle: on `freeze` / bfcache `pagehide` a tab releases its storage roles, then its tab lock, as before the gate (the IndexedDB fallback included: writes after its last stored snapshot are lost if another tab takes over, reported as `SNAPSHOT_SUPERSEDED`). A tab still opening, promoting or closing keeps both. A tab resuming after a newer build opened never re-attaches: requests queued behind its suspension fail retriably and it retires.
  - Missing coordination APIs fail closed: without `BroadcastChannel`, one tab at a time (`kora-db:<db>`, `store:tab-exclusive`); without Web Locks in a secure context (an old browser), storage open refuses with `TabCoordinationUnavailableError` unless `allowUncoordinatedTabs` is set. On plain HTTP (not HTTPS, not localhost) browsers expose no Web Locks: there the gate does not apply, as before it, with one console warning (serve over HTTPS or localhost to turn it on). Outside a browser page the gate does not apply.
  - Kora storage format `1` (`KORA_STORAGE_FORMAT`): stored once in `_kora_meta('storage_format')` and in the IndexedDB snapshot version record, never written by older code. A newer stored format refuses the open (`StorageFormatAheadError`, `store:format-ahead`) before any DDL or write (`--kora:format-ceiling` DDL directive).
  - A leader running a pre-gate build is detected by the gated-leader marker lock it does not hold; the newer tab waits for its leader lock (`store:legacy-build-detected`). Builds without a build id fall back to a schema fingerprint (`store:build-unidentified`).
  - New: `VersionGate`, `Store.trackWrite()`, `StorageAdapter.getVersionGate()`, adapter options `versionGate`, `build`, `allowUncoordinatedTabs`, and events `store:format-ahead`, `store:build-gate-waiting`, `store:build-unidentified`, `store:legacy-build-detected`, `store:tab-exclusive`, `store:tab-coordination-unavailable`.

- 68cbb70: Version gate, stage 2: the app API. `createApp({ build })` names the deployment (otherwise the build id the `@korajs/cli/vite` plugins inject, read from `globalThis.__KORA_BUILD__` or `<meta name="kora-build">`; never the package version). In a browser, createApp creates the database's version gate and:

  - announces supersession with `app:build-superseded` (`{ currentBuild, newerBuild, preventDefault() }`) before any write is refused, then shows "A new version of this app is available. Reload to continue." with a Reload button, unless a listener called `preventDefault()`, the app set `store.onBuildSuperseded`, `store.buildPrompt` is false, or the app handles the offline shell's `kora:update-available` event (reused for this prompt);
  - shows "Your latest changes are not saved yet. Retry, or Export them." with Retry and Export (a JSON download of the in-memory database) while a failed IndexedDB barrier holds retirement, naming the reason when it is known (`QUOTA_EXCEEDED`: storage is full; `STORAGE_UNAVAILABLE`: no storage worker left), and waiting / other-tab messages in a tab whose gate is closed; from the moment retirement starts, `app.close()` saves every admitted write first and is refused (`PersistenceError`, `context.code: 'UNSAVED_WRITES'`) before anything is torn down when that fails;
  - stops sync as a retirement step: the engine is destroyed (a permanent fence: an auth reconnect or a `connect()` already in flight never opens a session or touches persisted sync state), and retirement waits (bounded) for those attempts before releasing the tab lock; inbound operations refused meanwhile stall without a `sync:apply-blocked` report. Every sync API that connects or changes persisted sync state (`connect`, `reconnect`, `retryNow`, `setQuerySubsets`, `clearRejectedOperations`, `assignHeld`, `discardHeld`) then refuses with `BuildSupersededError`; `app.sync.connect()` and `reconnect()` then refuse with `BuildSupersededError`, and no automatic reconnect starts. Queued operations stay in the outbound queue and the new build uploads them;
  - refuses blob writes (`app.blobs.put`, `delete`, `pull`, `gc`, and `put` / `delete` on `app.blobs.store`) like every other write.

  New: `app.reloadForNewBuild()` (emits `app:before-build-reload` synchronously; under the offline shell it checks for (within 10 s) and activates the newer build's waiting service worker, `KORA_SW_SKIP_WAITING`, and reloads on `controllerchange`; it never reloads under the worker that served the page's own build: when no newer worker is ready (offline, a failed update) it resolves false and the prompt offers Try again; otherwise a plain reload), `store.onBuildSuperseded`, `store.buildPrompt`, `store.allowUncoordinatedTabs`, exports `BuildSupersededError`, `StorageFormatAheadError`, `TabCoordinationUnavailableError`. `BUILD_SUPERSEDED` is a local refusal: it is a mutation's `error`, never its server `rejected` state. A storage format or schema ahead, a superseded tab and missing Web Locks are never answered with an in-memory database. On plain HTTP (not HTTPS, not localhost) the gate is off, as before it, with one console warning. A failed initialization whose cleanup close is refused with `UNSAVED_WRITES` keeps the gate (the retirement releases it once the writes are saved).

- df7a430: Version gate, stage 4: form drafts. `useFormDraft(formKey, initial, { fields })` (React hook, Vue composable, Svelte store; `korajs/react`, `korajs/vue`, `korajs/svelte`) keeps what the user was typing across the reload a new build asks for. Opt-in per form: nothing is stored unless a form calls it, and only the listed `fields` are drafted (in `sessionStorage`, under `kora-draft:<db>:<formKey>`).

  - Never drafted, even when listed: a field bound to a password input (`type="password"`, or `autocomplete` `current-password` / `new-password` / `one-time-code` / `cc-*`; observed when the binding first sees the input and on every type change, not only at save, and once seen never drafted again in that form, so a "show password" toggle, even before the first keystroke, does not draft it), an input marked `data-kora-sensitive`, a `t.secret()` field of `collection` (nothing of such a form is drafted until the schema is known), and `sensitive` fields (a dotted path such as `answers.ssn` removes that nested value; sensitivity is otherwise per top-level field); `allowSensitive` overrides (discouraged). A `sensitive`, `allowSensitive` or `safe` entry that is not a listed field warns.
  - Fail closed: the control is resolved at or inside the bound element (a component whose ref lands on a wrapper is read through it; any password control inside makes the field secret). A listed field with no resolvable `<input>` / `<textarea>` / `<select>` (values set from code, wrappers without a control) is not drafted unless listed in `safe`. `describeFormDraftInput()` (core bindings) is the shared resolver.
  - When the app enables encryption (`app.encryption`), no draft is stored at all: no plaintext copy, the form is simply not restored. (Decision for the design's deferred question; a sealed draft store may come later.)
  - A restored draft is removed at once and rewritten only on the next change; `clear()` after a successful submit; `clearFormDrafts(app)` (from `korajs`) removes every draft of the database on sign-out or a user change (with `namespaceByAuthUser`, of every namespace of the base name), and a draft written under another known `userId` is removed, never restored. `userId: undefined` means the session is still loading: nothing is restored, consumed or saved until the user is known, then the draft is restored (keeping what was typed meanwhile). Pass `null` when signed out. Vue accepts a ref or getter, Svelte a store or getter (or `draft.setUser()`).
  - `app:before-build-reload` saves the latest values synchronously before `app.reloadForNewBuild()` reloads.

  Review round: a `userId` getter is followed (an account switch it reports resets the form and restores that user's draft; values are never stored under another user); the last known user is tracked across loading states (alice, loading, bob never carries Alice's input to Bob); fields typed while the session loads win over the restored draft; `clear()` and the automatic "back at the initial values" removal keep the stored draft while the user is unknown; `allowSensitive` overrides dotted sensitive paths (`answers` or `answers.ssn`); `clearFormDrafts(app)` takes the app as documented (or a database name); equality checks never throw on `bigint` or cyclic values (`formValuesEqual`); an ancestor gaining `data-kora-sensitive` is observed in every binding (React and Vue observe attributes React or Vue does not re-render for).

- b7f964a: Version gate, stage 5: every template drafts its new-task field with `useFormDraft` (React, Vue, Svelte; the only drafted field, cleared once the write is stored, kept when a write is refused), and the templates with sign-in pass the user only once the session has loaded (`userId: undefined` while it loads, so the reload's draft survives the session restore) and clear every draft on sign-out and when a known signed-in user changes, never on the first load (`clearFormDrafts(app)`, which now also accepts the app). New guide: [App updates and multiple tabs](https://korajs.dev/guide/app-updates) (deployments, build ids, the reload prompt and its states, frozen and background tabs, the beta.15 upgrade note, HTTPS and test environments, form drafts and their privacy rules); API pages for the new errors, events, `useFormDraft` and the Vite plugins.

## 1.0.0-beta.14

### Patch Changes

- 99cedc4: Smaller fixes from the beta.13 rollout:

  - `defineSchema` refuses a unique or capacity constraint whose `where` holds an operator object,
    an array, or an unknown field: none could ever match, so the constraint was silently disabled
    (F2).
  - `PostgresUserStore.close()` ends the connections of a store made by `createPostgresUserStore`,
    so scripts exit (F11).
  - `/health` and `getStatus()` report the real `@korajs/server` version instead of
    `1.0.0-beta.0` (F13).
  - A `sqlite3.wasm` download or compile failure fails the store open within seconds with a
    `WorkerInitError` naming the binary, instead of waiting out the 60-second init timeout, and a
    failed SQLite load is not cached, so the next open tries again (F15).
  - `undefined` inside a `t.json()` value is written the way JSON writes it (a member is absent, an
    array element is `null`), as the server already stored it, instead of failing the write on the
    device (F12a).

- 4ec1bc5: Protocol 1 (beta.12 clients), `experimental.legacyMerge` and the `allowLegacyAnonymousClaims`
  default stay as in beta.13: each would break part of the beta.12 upgrade path this release
  completes. The deprecation messages now say a later release refuses them, announced in its notes.

## 1.0.0-beta.13

### Major Changes

- **Breaking.** One deterministic per-field CRDT fold (`foldRecord`, `mergeOp`) used by every
  replica: arrays are multisets, objects merge per top-level key, resolvers run once per write in
  HLC order, `counter`/`max`/`min`/`append-only` fold over every write, and an update equal to its
  own `previousData` is not a write.
- Content-hash version 2 operation ids (`hashVersion`) covering `previousData`, `sequenceNumber`,
  `causalDeps` and `schemaVersion`; one canonical operation body (`NON_CANONICAL_VALUE` for values
  with no JSON form).
- One value domain enforced at write time (integer-millisecond timestamps, finite numbers, json
  depth, no `__proto__`); enum membership and requiredness are enforced by validation, and
  `t.enum()` refuses values SQLite cannot store exactly.
- Schema transforms run at fold time (`operationSchemaView`); stored operations are never
  rewritten.
- The HLC reports drift instead of blocking writes, and `receive()` validates remote timestamps
  (`InvalidTimestampError`, `RemoteClockDriftError`).
- Records and inputs are typed from the schema (required, optional, defaulted and auto fields).
- New events for storage, sync, encryption and query errors (see `KoraEvent`).

See the [1.0.0-beta.13 release notes](https://github.com/ehoneahobed/kora/blob/main/docs/releases/v1.0.0-beta.13.md) and the [upgrade guide](https://github.com/ehoneahobed/kora/blob/main/docs/guide/upgrading-to-beta13.md) (servers first, then clients).

### Patch Changes

- `op.*` helpers are typed by operation and operand: numeric helpers only on number and timestamp fields, `op.append`/`op.remove` only on arrays with the element type (`NumericAtomicOpSentinel`, `ArrayAtomicOpSentinel`).
- Relaxing beta.12 enum checks only touches enum-shaped checks on the schema's enum fields; every other CHECK constraint is preserved.

## 1.0.0-beta.12

### Minor Changes

- Add structured delivery-stall and scope-retraction events and protocol fields.

## 1.0.0-beta.9

### Patch Changes

- b657130: Harden the framework paths surfaced by production-style E2E usage.

  - Fix generated app templates so auth routes proxy correctly, dev database writes do not trigger Vite full reloads, and cross-origin isolation can be configured for embedded media.
  - Keep React auth subscriptions stable through StrictMode remounts, and keep `useQuery` from transiently reporting an empty result while a replacement query subscription is still settling.
  - Add query-store snapshot readiness so adapters can distinguish "not emitted yet" from an authoritative empty result.
  - Serialize `json`, `object`, and `blob` fields during server materialization, and fail loudly instead of acknowledging an operation whose persistence failed.
  - Serialize sync start/stop transitions and retry pending outbound operations when an auth/session transition leaves the connection idle.
  - Register broad and unsupported-only live queries as collection-wide sync subsets, so mixed narrow and `where({})` subscriptions cannot starve admin-style broad views.
  - Invalidate a client's delivery watermark when the server resolves a different authoritative scope than the client requested, forcing a scoped backfill instead of skipping operations hidden under the old view.
  - Treat retryable per-operation rejections as unacknowledged on the client, and have the server acknowledge only through the last safely processed operation. Stale-scope pushes now remain queued for rescope/retry instead of being silently dropped.
  - Make delivery-stream retransmission stale-aware so slow or large server-to-client batches are not re-sent on every retry tick while the original ack is still in flight.
  - Add a serialized `sync.reconnect()` control and use it for auth-driven scope refreshes and query-subset reconnects, avoiding app-level disconnect/connect races during permission changes.
  - Load local `.env` files in `kora dev` and generated sync servers before auth/server setup, so first-run auth configuration mounts consistently whether the app is started by the CLI or the server is run directly.
  - Update generated template docs to use `/kora-sync` WebSocket endpoints for `VITE_SYNC_URL`, avoiding noisy root-path WebSocket retries from copied defaults.
  - Pin `create-kora-app` template dependencies to the exact Kora prerelease when the CLI itself is a prerelease, avoiding accidental stable-range resolution or split beta installs.
  - Improve JSON schema validation errors by reporting the exact invalid nested path, including `undefined`, non-finite numbers, and circular objects.
  - Fix IndexedDB fallback persistence so logical dumps are durable when binary SQLite export is unavailable, stale binary snapshots cannot shadow newer dumps, and dump-only databases restore correctly.
  - Allow production server COEP policy configuration and document route access to the owned Kora data plane.

## 1.0.0-beta.5

### Minor Changes

- Fix a lost-update bug where three or more concurrent atomic writes (`op.increment`,
  `op.max`, ...) to the same field failed to converge on clients.

  The client apply pipeline composed a remote atomic op through the merge engine's
  pairwise rule (`base + localDelta + remoteDelta`), which is correct only for exactly
  two concurrent writes from a shared base. With a third concurrent writer, the current
  row already folded in an earlier remote delta, and re-deriving the value from the base
  plus the local device's own delta silently dropped that earlier delta. Three devices
  each incrementing a shared counter by 5, 3, and 2 could settle at 7/5/5 across devices
  instead of 10.

  The client now materializes atomic-op fields by folding the record's operation log in
  HLC order through the same atomic-aware replay the server uses (moved into
  `@korajs/core` as `replayOperationsForRecord` so both sides share one definition).
  The fold composes a same-type atomic chain and resolves anything else — including a
  plain set breaking the chain — by last-write-wins, so every replica converges to the
  same value regardless of how many concurrent atomic writers there were or which device
  authored them, including a passive device that only observes the writes. Non-atomic
  fields are unaffected.

- Compose atomic operations in the server's materialized view so it matches what
  clients converge to.

  Previously the server materialized records by last-write-wins over each operation's
  resolved `data`, and did not persist the atomic-op intent (`op.increment`,
  `op.max`, `op.min`, `op.append`, `op.remove`). Concurrent, independent atomic writes
  to the same field — two offline clients each incrementing a shared counter, then
  syncing — collapsed to a single winner in the server's view (materialized reads and
  initial-sync hydration), even though clients converge to the composed result.

  The server now persists atomic-op intent alongside each operation and composes it
  during materialization. Per field, an atomic op composes onto the running value when
  the previous writer on that field was an atomic op of the same type (a same-type
  chain: increments sum, maxes take the max, appends accumulate); any other write,
  including the first atomic write after a plain set, resolves by last-write-wins. This
  mirrors the client merge engine, so the server's materialized value equals the
  clients' converged value. Verified end to end against real client devices syncing
  through the server (`@korajs/test`), plus SQLite and Postgres persistence.

  Details:

  - `@korajs/core` exports `applyAtomicOp(currentValue, atomicOp)`, the single source
    of truth for atomic-op semantics that both the client write path (`resolveAtomicOp`)
    and the server materialization use.
  - The SQLite and Postgres operation logs gain a nullable `atomic_ops` column, added
    by a backward-compatible migration. Existing rows read as "no atomic ops" and keep
    materializing by last-write-wins exactly as before, so no data migration is required.
  - Materialization now orders operations by full HLC total order (wallTime, logical,
    nodeId), matching `HybridLogicalClock.compare`, so composition and last-write-wins
    see operations in the order the merge engine converges them.

  Operations that carry no atomic-op intent (the common case) materialize exactly as
  before.

- Server-side adjudication of untrusted client operations before they become
  authoritative. This is what lets Kora serve public and multi-tenant offline apps
  where the client cannot be trusted (anonymous form submissions, one tenant that
  must not write another's data).

  Pass `validateOperation` in the server's `syncOptions` (or to `KoraSyncServer`).
  It runs at sync ingestion, after HLC ordering and the built-in guards, and before
  materialization, returning `accept`, `reject`, or `ignore`. On `reject` the
  operation never enters the authoritative log, so no other replica ever sees it,
  and a structured rejection travels back to the submitter tied to the operation id.
  The validator receives an `auth` context (null for anonymous connections) and the
  trusted `kora` data-plane, so it can read current state and author a derived
  server operation — for example promoting a validated anonymous submission into an
  owner-visible collection.

  On the client, a rejected operation is diverted out of the pending outbound queue
  into a durable rejected store (`_kora_sync_rejected`, survives a page refresh)
  rather than being retried forever or lost on the batch ack, and a
  `sync:operation-rejected` event fires. `app.sync.getRejectedOperations()` and
  `app.sync.clearRejectedOperations()` let the app surface failed submissions and
  reconcile (roll back the optimistic write or resubmit). Convergence holds: the
  authoritative state is defined purely by accepted operations, so every synced
  device agrees without the rejected op, and the submitter is told rather than
  diverging silently. See the new "Server-side operation validation" guide.

### Patch Changes

- Storage persistence failures are no longer silent. When OPFS is unavailable the
  store falls back to a non-persistent in-memory database so the app keeps working,
  but anything written that session is lost on reload — previously with no signal.
  The SQLite WASM worker now classifies why OPFS could not be used (`lock-conflict`,
  `timeout`, or `unsupported`) and the store emits a `store:opfs-unavailable` event,
  so the condition is observable instead of a quiet data-loss trap. The most common
  cause, `lock-conflict`, is two runtimes on one origin contending for the same
  database.

  A `store:db-name-collision` event now fires when a runtime attaches to a database
  name another runtime on the same origin already owns. That is expected for
  multiple tabs of the same app (they share one leader), and the exact clue a
  developer needs when two logically separate apps accidentally share the default
  store name and should each use a distinct one. Both events surface in DevTools and
  via `app.events`. See the new "Multi-runtime storage and isolation" guide.

- SQL identifiers are now quoted everywhere they are generated, so a collection or
  field name that is valid JavaScript always produces valid SQL. camelCase
  (`formResponses`), PascalCase (`UserProfiles`), and names that happen to be SQL
  reserved words (`order`, `select`) now work end to end across the client store,
  both server stores, migrations, and CLI-generated migration files. Previously a
  camelCase collection was rejected at `defineSchema` and a reserved-word name
  produced a runtime SQL syntax error.

  A new `quoteIdent` helper is exported from `@korajs/core`. Schema validation
  still fails fast for genuinely malformed names (empty, or containing characters
  that are not letters, numbers, or underscores). Existing all-lowercase schemas
  are unaffected: quoting a lowercase identifier is a no-op in both SQLite and
  Postgres.

## 1.0.0-beta.0

### Minor Changes

- Add a `blob` field type backed by a content-addressed store (data model + store core).

  Files no longer belong in the operation log. A `blob` field carries a small content-addressed reference, and the bytes live in a deduplicated, integrity-checked store keyed by their hash.

  - `t.blob()` fields hold a `BlobRef` (`{ hash, size, mimeType?, filename? }`), a hex SHA-256 content address plus metadata. Values persist as JSON (`TEXT`) and converge by last-write-wins on the reference (the bytes are immutable and deduplicated by hash, so the reference is the only thing that can change).
  - `@korajs/core` exposes `hashBlob`, `createBlobRef`, and `isBlobRef` (reusing the same SHA-256 content addressing as operation ids).
  - `@korajs/store` adds a `ContentAddressedBlobStore` interface and a `MemoryBlobStore` backend: `put` deduplicates identical content (stored once, same hash), and `get` verifies the stored bytes hash to the requested key, throwing `BlobIntegrityError` on corruption rather than returning bad data.

  Proven with unit tests (content addressing, dedup, integrity, buffer-isolation) and validated end-to-end through the real store + sync path (a blob reference round-trips through insert and converges under concurrent replacement). The out-of-band, resumable, chunked byte-transfer channel and persistent backends (OPFS, filesystem/S3) build on top of this reference model.

- Pull a blob's bytes knowing only its reference. This closes the last gap in blob sync: a device that receives a `BlobRef` in a synced record can now fetch the bytes with no separate manifest hand-off.

  - `@korajs/core`'s `BlobRef` gains an optional `manifestHash` — the content hash of the blob's chunk manifest. Because it is a content address like `hash`, the manifest is fetched and integrity-verified over the same channel as the chunks. It rides inside the reference that already syncs in the record, so no new protocol or operation-log surface is needed.
  - `@korajs/store` adds `putBlobForTransfer` (stage chunks + store the full blob + store the manifest as its own content-addressed object, returning a ref that carries `manifestHash`), `resolveBlobManifest` / `fetchBlobManifest` (fetch and verify a manifest by hash before pulling), and the canonical `serializeBlobManifest` / `parseBlobManifest`. The manifest is served over the existing chunk channel with no special casing — it is just another content-addressed object.
  - `korajs`: `app.blobs.put` now stores the manifest and returns a ref carrying `manifestHash`, and `app.blobs.pull` accepts that `BlobRef` directly (resolving the manifest by hash) or an explicit `BlobManifest`. The "attach a file, it appears everywhere" path now needs only the reference from the synced record.

  Proven end to end over the live server relay: a blob authored on device A is pulled on device B from the reference alone — B resolves the manifest by `manifestHash`, then fetches only the chunks it is missing and verifies integrity against the blob hash.

- Clock integrity: protection against wrong device clocks at every layer.

  - HLC now validates remote timestamps BEFORE adopting them (`RemoteClockDriftError`),
    so a far-future timestamp can no longer poison a replica's clock.
  - Local timestamp generation never throws and never blocks writes: drift is
    reported through callbacks and `sync:clock-skew` events instead.
  - The sync handshake now carries `serverTime`; clients measure their own skew,
    pause sync with a new `clock-error` status when the device clock is more than
    60s fast (local writes keep queuing), and warn via events when it is very slow.
  - `SyncStatusInfo` gains `clockSkewMs`; the store's HLC receives the measured
    offset so remote validation works even on devices with wrong clocks.
  - Scaffolded templates render a plain-language banner telling end users how to
    fix their device clock. See the new Clock Integrity guide.
  - Automatic timestamp rebase: after the clock is corrected, the next handshake
    clears the clock block on its own and re-stamps queued never-acknowledged
    operations (new content-addressed ids, causal deps remapped, original order
    preserved) so sync resumes immediately instead of waiting for real time to
    catch up. A new `sync:clock-rebase` event reports `rebasedCount` and
    `maxSkewMs`. Safe because unacknowledged operations are private to the
    device — like rewriting unpushed git commits.
  - Bounded logical counter with carry: the HLC logical counter is capped at
    99,999 (`MAX_LOGICAL`, exported from `@korajs/core`) so serialized timestamps
    always sort lexicographically identically to `HybridLogicalClock.compare`.
    Overflow carries into wallTime (+1ms, counter resets) in `now()`, `receive()`,
    and `advanceTo()`; malformed timestamps (non-integer/negative fields, logical
    past the cap) are rejected with `InvalidTimestampError`
    (`INVALID_TIMESTAMP_FIELDS`) before any clock state changes, both at the
    replica and at server ingest.
  - Canonical binary encoding in op payloads: richtext `Uint8Array`/`ArrayBuffer`
    values are normalized to a tagged `{ $koraBytes: base64 }` form in
    `op.data`/`op.previousData` at operation creation, BEFORE content hashing, so
    the hash input, persisted JSON, and wire payload are the identical value and
    operation ids survive persistence round-trips. Plain-string richtext values
    are untouched (existing operation ids are unaffected); apply paths decode the
    tagged form (and tolerate the pre-fix numeric-key shape from dev databases)
    back to bytes.

- Add `object` and `json` field types that merge as convergent CRDTs.

  Structured data is no longer an opaque last-write-wins blob. Two devices that edit different keys of the same object offline both keep their edits on reconnect.

  - `t.object({ ...nested field schema })`: a structured field whose keys each merge by their own kind (scalars via LWW, nested arrays add-wins, nested objects recursively). Nested values are validated against the declared schema.
  - `t.json<T>()`: a dynamic-key JSON field with the same convergent semantics, resolved structurally, carrying a compile-time shape `T`.

  Merge is a 3-way LWW map with add-wins key presence: per key, one side's write to a key the other left untouched survives; concurrent writes to the same key resolve by HLC (or recurse for nested objects / add-wins for nested arrays); a write always wins over a concurrent delete of that key, so an edit is never silently dropped. The strategy is proven commutative, idempotent, and deterministic with fast-check property tests, and validated end-to-end through the real store + sync path (two devices editing different keys of an object converge). Values persist as JSON (`TEXT`) and cross the existing wire unchanged.

- Add a `secret` field type with mandatory trace redaction and field-level cryptography (security core).

  Secrets (passwords, tokens, API keys) get first-class handling instead of living in plain `string` fields that leak into logs and DevTools.

  - `t.secret()` fields choose their at-rest protection with `.hashed()` (one-way, for passwords) or `.encrypted()` (reversible, for tokens); the default is `encrypted`. On input the value is a plaintext string; the framework applies the transform.
  - Merge traces redact secret fields. A secret's value never appears in a `MergeTrace` — not in `inputA`/`inputB`/`base`/`output`, and not inside the embedded `operationA`/`operationB` (whose `data`/`previousData` are redacted too). This closes a real leak where plaintext secrets appeared in DevTools, logs, and audit exports. Non-secret fields are unaffected.
  - `@korajs/core` exposes the field-level crypto primitives (standard WebCrypto, no `@korajs/auth` dependency): `encryptSecret` / `decryptSecret` (AES-256-GCM with a per-value random salt and IV, wrong-key decryption fails), and `hashSecret` / `verifySecret` (PBKDF2-SHA-256, salted, one-way, constant-time verification).

  Secret values merge by last-write-wins on the stored representation (ciphertext or hash), never on plaintext. The write-time transform wiring (apply the hash/encrypt on write via a key provider, decrypt on read) is the remaining integration step; these primitives and the redaction are the security core it builds on.

- Encrypt/hash `secret` fields at rest, end to end. `secret` fields are now secure at rest, not just redacted in traces.

  - The mutation pipeline transforms secret fields to their at-rest form before the operation is built, so plaintext never enters the store, the operation log, or the sync stream. `encrypted` fields are stored as AES-256-GCM ciphertext; `hashed` fields as a one-way salted hash. Verified end to end: after inserting a record, both the materialized column and the op-log JSON contain only ciphertext, never the plaintext.
  - Encrypted secret fields reuse the app's `sync.encryption.key` (a passphrase string or an async provider). A schema with encrypted secret fields but no key configured throws `MissingSecretKeyError` on write rather than silently storing plaintext.
  - `@korajs/core` exposes `transformSecretFieldsForWrite` (the pipeline transform), `revealSecret` (decrypt an encrypted field on demand — reads otherwise return the at-rest form), and `verifySecretValue` (check a candidate against a hashed field, since hashed secrets are one-way and cannot be revealed), plus the `SecretKeyProvider` type.

  Reads return the at-rest form by default; call `revealSecret` at the point of use so plaintext is never spread across query results or subscriptions. This completes the `secret` field: redaction in merge traces (already shipped), the crypto primitives, and now automatic at-rest protection on every write.

### Patch Changes

- Package export hygiene and auth secret-handling hardening.

  - Every published package now exposes `./package.json` in its `exports` map. Previously `require.resolve('@korajs/core/package.json')` (and the same for every other package) failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`, which breaks tooling that reads a package's manifest or version at runtime.
  - `createKoraAuthServer` now warns loudly when it falls back to an ephemeral random JWT secret outside production, so a deployment that never set `NODE_ENV=production` no longer silently regenerates its signing key on every restart (which invalidates all existing tokens) without any signal.
  - `KORA_AUTH_SECRET` set to an empty or whitespace-only string is now treated as unset rather than as an invalid secret, so it triggers the intended dev fallback / production guard instead of crashing `TokenManager` with a "secret too short" error.

- Fix silent data loss and divergence on concurrent cross-device edits.

  Two connected devices editing the same record while briefly offline could
  permanently drop one edit and diverge, violating the "no operation is ever
  lost" guarantee. This release closes that bug and every adjacent defect found
  while auditing the apply path:

  - **Per-field LWW register.** Materialized rows now carry `_field_versions`
    (field → last-writer HLC). Remote updates resolve field-by-field, atomically,
    inside the write transaction: deterministic, order-independent, commutative,
    and idempotent. Concurrent edits to different fields both survive; same-field
    conflicts converge to one agreed winner on every node.
  - **Optimistic-concurrency guard for merge results.** Richtext, add-wins-set,
    constraint, and custom-resolver merges are computed from a version snapshot
    and applied only if the row is unchanged; otherwise the merge recomputes from
    fresh state (bounded retries). A local edit can no longer slip between a
    merge's read and its write.
  - **Operation-log integrity.** Merge results are no longer persisted under the
    original operation's content-addressed id. The log always stores the
    canonical operation; only the materialized row reflects merged values.
  - **Insert collisions.** A remote insert targeting an existing record id no
    longer crashes with a primary-key violation (or silently drops the merged
    result on a timestamp tie) — it resolves per-field like an update, with
    `createdAt` converging to the max insert wall time.
  - **Deterministic add-wins ordering.** Concurrent array edits previously
    converged on membership but diverged on element ORDER across devices
    (local-before-remote ordering flips per device). Additions now order
    deterministically, so merged arrays are byte-identical everywhere.
  - **Transaction serialization.** The better-sqlite3 adapter serializes async
    transactions through a mutex, eliminating nested-BEGIN collisions that could
    silently drop a relayed operation applied during a local write.
  - **Atomic increment composition.** Concurrent `op.increment` updates now
    compose to the sum of both deltas through the real sync path (previously one
    side's delta could be lost to last-write-wins, and the merge engine's
    synthetic local operation carried the REMOTE op's intent metadata, doubling
    the remote delta whenever atomic composition ran).
  - **Out-of-order delivery.** An update or delete delivered before its insert
    (reordering transports) no longer vanishes from the materialized row: when
    the insert lands, already-logged operations for that record are folded in
    timestamp order inside the same transaction, matching in-order devices
    exactly. Ops tables gained a `record_id` index to keep record-scoped
    lookups fast.

  Clock rebases re-stamp per-field versions, and backups round-trip them, so
  field-level LWW stays correct across clock corrections and restores.

## 0.6.0

### Minor Changes

- Public beta 0.6.0: Vue 3 and Svelte 5 bindings with shared QueryStore, sync-status controller, and richtext controller; `@korajs/core/bindings` shared types; `@korajs/auth` org hooks and providers for React/Vue/Svelte; presence/collaboration hooks; CLI scaffolds; `korajs/vue` and `korajs/svelte` meta-package re-exports; Svelte component precompile and KoraProvider context bridge fix.

## 0.5.0

### Minor Changes

- b909e5a: v0.5 internal beta: structured apply results and sync apply-failure events, audit trace export, benchmark gates in CI, release-gate script, and E2E fixture hardening (SQLite worker + local multi-tab Playwright project).

## 0.4.0

### Minor Changes

- ff155cd: Add framework enhancements and 9 completeness features

  **Phase 1-5 features:**

  - `op.increment()`, `op.decrement()`, `op.max()`, `op.min()`, `op.append()`, `op.remove()` — atomic field operations
  - `t.number().merge('counter')`, `.merge('max')`, `.merge('min')`, `t.array().merge('append-only')`, `.merge('server-authoritative')` — schema-level merge strategies
  - `app.transaction()` and `app.mutation()` — atomic multi-collection operations
  - `app.sequences.next()`, `.current()`, `.reset()` — offline-safe formatted sequences
  - `buildScopeMap()` — sync scope computation from schema
  - `migrate()` / `MigrationBuilder` — programmatic schema migration builder
  - `@korajs/test` — testing harness with `createTestNetwork()`, `TestDevice`, `expectConverged()`

  **Framework completeness features:**

  - E2E sync encryption (AES-256-GCM, PBKDF2 key derivation)
  - Bloom filter subscription optimization for high-volume reactive queries
  - Referential integrity enforcement during merge (cascade, set-null, restrict)
  - Sync diagnostics and metrics (bandwidth estimation, RTT tracking, percentiles)
  - Migration rollbacks with auto-generated inverse steps
  - Sync scope filtering for operation-level access control
  - State machine constraints on enum fields with `.transitions()` API
  - Awareness/presence protocol with `usePresence()` and `useCollaborators()` React hooks
  - Protobuf code generation from schema definitions

  **Fixes:**

  - Resolved all biome lint errors across the entire codebase

## 0.3.1

### Patch Changes

- fix(server): use BIGINT for PostgreSQL timestamp columns to prevent overflow

  - **server**: Fixed critical bug where PostgreSQL `INTEGER` columns overflowed for millisecond timestamps (wall_time, received_at, last_seen_at). Now uses `BIGINT`.
  - **server**: Added `/health` endpoint to production server.
  - **auth**: Added `UserStore` interface with `createSqliteUserStore` and `createPostgresUserStore` factory functions.
  - **core**: Added `sync:auth-failed` event for detecting stale auth tokens.
  - **sync**: Sync engine now emits `sync:auth-failed` when the server rejects authentication.
  - **cli**: Added AWS ECS Fargate and Lightsail Container deploy adapters.
  - **cli**: Docker builds now use `--platform linux/amd64` for Apple Silicon compatibility.
  - **cli**: Lightsail adapter forwards `DATABASE_URL`, `AUTH_SECRET`, `PUBLIC_URL` environment variables to containers.
  - **cli**: Fixed trailing slash in Lightsail URLs causing double-slash in sync endpoint.

## 0.3.0

### Patch Changes

- 6a05e88: Performance: Replace O(n²) topological sort with binary heap in @korajs/core (19x faster sync for large operation sets).

  New: @korajs/auth package with sessions, TOTP MFA, organizations, RBAC, passkeys, encrypted tokens, and E2E operation encryption (912 tests).

  New: Full Preact-based DevTools UI panel with sync timeline, conflict inspector, operation log, and network status.

  Docs: Comprehensive documentation refinement — added API references for merge, sync, auth, and devtools; added authentication guide; expanded sync configuration guide; updated all package descriptions.

## 0.1.2

### Patch Changes

- Fix template path resolution in create-kora-app and add package READMEs

## 0.1.0

### Minor Changes

- Initial release
