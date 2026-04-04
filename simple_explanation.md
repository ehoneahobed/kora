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
  - The engine block (@kora/core) — the fundamental machinery
  - The fuel system (@kora/store) — how data gets stored and retrieved locally

  What's still missing:
  - The transmission (@kora/merge) — how conflicts get resolved
  - The wheels (@kora/sync) — how devices talk to each other
  - The steering wheel (@kora/react) — how developers actually interact with it
  - The chassis (@kora/server) — the backend/server piece
  - The dashboard (@kora/devtools) — debugging tools
  - The ignition key (@kora/cli) — the npx create-kora-app command

  There is no npx create-kora-app yet. That's the last thing to be built. Right now this is engine internals — useful only to the developers building Kora
  itself.

  To answer your specific questions

  "How do I run npx to get it?"
  You can't yet. That CLI tool hasn't been built. When it's ready, it'll be as simple as:
  npx create-kora-app my-app
  cd my-app
  npm start

  "How do I build my app using React?"
  When @kora/react is built, it'll look something like this — you just use your data and Kora handles everything else:
  function TodoList() {
    const todos = useQuery(app.todos.where({ completed: false }))
    // That's it. Works offline. Syncs automatically. No loading spinners.
    return todos.map(todo => <div>{todo.title}</div>)
  }
  But this doesn't exist yet.

  "If React is frontend, how do I get the backend/server/database?"
  This is actually the magic of Kora's design:
  - Database: lives on the user's device (in the browser, using SQLite). No separate database to set up for basic use.
  - Server: Kora will include a small sync server (@kora/server) that you can run to let multiple devices/users sync with each other. But your app works
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