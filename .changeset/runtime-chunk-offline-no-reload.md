---
"korajs": patch
---

A first visit that goes offline before the runtime has finished downloading no longer reloads the page. When the runtime chunk failed to load, `createApp` reloaded the page once, on the assumption that the tab held files from an old deploy. Offline that reload cannot fetch anything: it replaced a page that was working (a public form already rendered, its answers journaled) with one that could not load its data and showed "Form not found". While `navigator.onLine` is `false` the reload now waits for the `online` event and then happens once, under the same 30 second guard as before; `ready` stays pending meanwhile, writes made before it are journaled and applied when the store opens, and closing the app while it waits stops the listener. A response sent right after the reload may reach the server twice; the second is answered as a duplicate, as always.
