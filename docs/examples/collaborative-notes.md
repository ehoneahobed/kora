---
title: Collaborative Notes Example
description: "Build collaborative notes with Kora.js: CRDT rich text with Yjs, tags that merge, counters that add up, and editing that works offline."
---

# Collaborative Notes

A note-taking app where several people edit the same note at once, online or offline. It shows
`t.richtext()` (character-level merging with Yjs), arrays that merge, and a counter field. Every
block below is a file of the app.

## Schema

<!-- docs-check: file schema.ts -->
```typescript
// schema.ts
import { defineSchema, t } from 'korajs'

export const schema = defineSchema({
  version: 1,
  collections: {
    notes: {
      fields: {
        title: t.string(),
        content: t.richtext(),
        tags: t.array(t.string()).default([]),
        views: t.number().default(0).merge('counter'),
        lastEditedBy: t.string().optional(),
        createdAt: t.timestamp().auto(),
      },
      indexes: ['createdAt'],
    },
  },
})
```

- **`t.richtext()`** is backed by a Yjs `Y.Text`: concurrent edits merge character by character.
- **`t.array(...)`** merges as an element set: concurrent additions and removals both apply.
- **`.merge('counter')`** adds up concurrent changes instead of keeping the last one: two devices
  that each count a view from 10 end at 12, whether they write `op.increment(1)` or `11`.
- Every record also has `updatedAt` (the last write time), so the schema does not declare it.

## App

<!-- docs-check: file app.ts -->
```typescript
// app.ts
import { createApp } from 'korajs'
import { createKoraHooks } from 'korajs/react'
import { schema } from './schema'

export const app = createApp({
  schema,
  sync: { url: 'wss://my-server.example.com/kora-sync', autoConnect: true },
})

export const { useMutation, useQuery, useSyncStatus } = createKoraHooks<typeof app>()
```

## Root

<!-- docs-check: file main.tsx -->
```tsx
// main.tsx
import { KoraProvider } from '@korajs/react'
import { createRoot } from 'react-dom/client'
import { app } from './app'
import { NotesApp } from './NotesApp'

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <KoraProvider app={app} fallback={<p>Loading...</p>}>
      <NotesApp />
    </KoraProvider>,
  )
}
```

## Notes list

<!-- docs-check: file NotesApp.tsx -->
```tsx
// NotesApp.tsx
import { useState } from 'react'
import { app, useMutation, useQuery, useSyncStatus } from './app'
import { NoteEditor } from './NoteEditor'

export function NotesApp() {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const notes = useQuery(app.notes.where({}).orderBy('updatedAt', 'desc'))
  const createNote = useMutation(app.notes.insert)
  const deleteNote = useMutation(app.notes.delete)
  const status = useSyncStatus()

  const handleNewNote = async () => {
    const note = await createNote.mutateAsync({ title: 'Untitled', content: '' })
    setSelectedId(note.id)
  }

  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      <aside style={{ width: 260, borderRight: '1px solid #eee', padding: 16 }}>
        <h2>Notes</h2>
        <p>{status.status === 'offline' ? 'Offline: changes are kept on this device' : status.status}</p>
        <button type="button" onClick={handleNewNote}>
          New note
        </button>
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {notes.map((note) => (
            <li key={note.id}>
              <button type="button" onClick={() => setSelectedId(note.id)}>
                {note.title || 'Untitled'} ({note.views ?? 0} views)
              </button>
              <button type="button" onClick={() => deleteNote.mutate(note.id)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <main style={{ flex: 1, padding: 16 }}>
        {selectedId ? <NoteEditor noteId={selectedId} /> : <p>Select a note or create one.</p>}
      </main>
    </div>
  )
}
```

## Rich text editor

`useRichText` binds a `t.richtext()` field to a shared Yjs document. Any Yjs-aware editor (Tiptap,
ProseMirror with y-prosemirror, Quill) consumes `doc` through its collaboration plugin.

<!-- docs-check: file NoteEditor.tsx -->
```tsx
// NoteEditor.tsx
import { useRichText } from '@korajs/react'
import Collaboration from '@tiptap/extension-collaboration'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect, useState } from 'react'
import { op } from 'korajs'
import { app, useMutation, useQuery } from './app'

export function NoteEditor({ noteId }: { noteId: string }) {
  const [note] = useQuery(app.notes.where({ id: noteId }))
  const updateNote = useMutation(app.notes.update)
  const { doc, text, ready } = useRichText('notes', noteId, 'content', {
    user: { name: 'Ada', color: '#e91e63' },
  })
  const [wordCount, setWordCount] = useState(0)

  const editor = useEditor({ extensions: [StarterKit, Collaboration.configure({ document: doc })] }, [doc])

  // Count a view once per opened note; concurrent views from other devices add up.
  useEffect(() => {
    updateNote.mutate(noteId, { views: op.increment(1) })
  }, [noteId, updateNote.mutate])

  // A derived value: compute it from the merged text instead of storing it.
  useEffect(() => {
    const recount = () => {
      const value = text.toString().trim()
      setWordCount(value ? value.split(/\s+/).length : 0)
    }
    recount()
    text.observe(recount)
    return () => text.unobserve(recount)
  }, [text])

  if (!note) return <p>Note not found.</p>
  if (!ready) return <p>Loading...</p>

  return (
    <div>
      <input
        value={note.title}
        onChange={(e) => updateNote.mutate(noteId, { title: e.target.value, lastEditedBy: 'Ada' })}
        style={{ fontSize: 24, border: 'none', width: '100%' }}
      />
      <p style={{ color: '#888' }}>{wordCount} words</p>
      <button type="button" onClick={() => updateNote.mutate(noteId, { tags: op.append('work') })}>
        Tag as work
      </button>
      <EditorContent editor={editor} />
    </div>
  )
}
```

`useRichText` returns `doc` and `text` (the field's `Y.Text`), `ready` once the field has loaded
from the local store, `undo`/`redo`, and the other editors' `cursors` with `setCursor`. Editor
changes are written to the record as rich-text updates and sync like any other write; large fields
stream their Yjs updates over the connection.

## What happens when two people edit at once

**Rich text.** User A types "Hello" at the start of the note while user B types "World" at the
same place. Both edits are kept and merged character by character; every device ends with the same
text ("HelloWorld" or "WorldHello", decided deterministically by Yjs). Nothing is lost.

**Title.** `title` is a plain string: the later write wins, ordered by hybrid logical clock. Use
`t.richtext()` for text that several people edit together.

**Tags.** A adds `work` while B adds `urgent` from the same starting list: both tags are kept. If
both add `work`, it appears once. A removal and a concurrent addition of different tags both apply.
`op.append(tag)` and `op.remove(tag)` express exactly that intent.

**Views.** Two devices at 10 views each count one view offline. `op.increment(1)` keeps both
increments on any number field, so every device shows 12. `.merge('counter')` makes every write of
the field add up, also plain ones (`{ views: 11 }` written from 10 counts as +1); under the default
last-write-wins rule two plain writes of 11 would leave 11.
For domain rules beyond the built-in strategies, a collection can declare
`resolve: { field: (local, remote, base) => value }`; see
[Conflict Resolution](/guide/conflict-resolution#custom-resolvers).

**Derived values** such as a word count belong in the UI, computed from the merged content.
Stored copies would be rewritten by every device that recomputes them and could drift.
