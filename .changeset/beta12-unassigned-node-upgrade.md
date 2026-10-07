---
"@korajs/store": patch
"@korajs/sync": patch
"korajs": patch
---

A beta.12 database whose user signed up and wrote without reloading the page no longer strands
those writes after the upgrade. beta.12 authored them under the random node the store opened with
before anyone signed in; once `createKoraAuthSync` pinned the store to the device id, that node
was never registered, so its queued writes stayed in the queue, neither uploaded nor reported.
`Store.open` now registers the node id a pinned `nodeId` replaced and the authors of queued
operations: the writes are held as `unassigned` (`status.heldNodes`) until the app assigns them.
When the server then refuses the assigned node (beta.12 history with no recorded owner), the
writes it never stored are re-authored under a fresh node of the user's
(`Store.reauthorLocalNode`) and upload; what it stored is not repeated.
