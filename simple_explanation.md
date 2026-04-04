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