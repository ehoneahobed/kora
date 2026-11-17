---
'@korajs/tauri': patch
---

Binary values (rich text, blobs) now round-trip through the Tauri SQLite plugin. `invoke` carries arguments and results as JSON, so a `Uint8Array` used to arrive as `{"0":..}` and be stored as JSON text, and BLOB columns came back as hex strings the store could not decode, which broke rich text on Tauri. Bytes now travel as `{ $koraBytes: base64 }` both ways: the plugin binds them as BLOBs and returns BLOBs in that form, and the adapter converts back to `Uint8Array`. Update the Rust plugin together with the JS package.
