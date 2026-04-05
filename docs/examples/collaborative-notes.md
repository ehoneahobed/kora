# Collaborative Notes

Build a collaborative note-taking app where multiple users can edit the same document simultaneously. This example demonstrates Kora's `t.richtext()` field type backed by Yjs CRDTs and custom conflict resolvers for computed fields.

## Define Your Schema

```typescript
// schema.ts
import { defineSchema, t } from 'kora'

export const schema = defineSchema({
  version: 1,
  collections: {
    notes: {
      fields: {
        title: t.string(),
        content: t.richtext(),
        wordCount: t.number().default(0),
        tags: t.array(t.string()).default([]),
        lastEditedBy: t.string().optional(),
        createdAt: t.timestamp().auto(),
        updatedAt: t.timestamp().auto(),
      },
      indexes: ['tags', 'updatedAt'],
      resolve: {
        wordCount: (local: number, remote: number, base: number): number => {
          // Additive merge: apply both deltas to the base value.
          // If base was 50, local changed it to 55 (+5), and remote
          // changed it to 48 (-2), the merged result is 50 + 5 + (-2) = 53.
          const localDelta = local - base
          const remoteDelta = remote - base
          return Math.max(0, base + localDelta + remoteDelta)
        },
      },
    },
  },
})
```

Two things to notice here:

- **`t.richtext()`** declares a field backed by a Yjs `Y.Text` CRDT. Concurrent character-level edits merge automatically without any conflict resolution code.
- **`resolve.wordCount`** is a custom Tier 3 resolver. Because word count is derived from content, a simple last-write-wins strategy would lose one user's contribution. The additive merge preserves both deltas relative to the shared base value.

## Create the App

```typescript
// app.ts
import { createApp } from 'kora'
import { schema } from './schema'

export const app = createApp({
  schema,
  sync: {
    url: 'wss://my-server.com/kora',
  },
})
```

## React Components

### App Root

```tsx
// main.tsx
import { KoraProvider } from '@kora/react'
import { app } from './app'
import { NotesApp } from './NotesApp'

function Main() {
  return (
    <KoraProvider app={app}>
      <NotesApp />
    </KoraProvider>
  )
}
```

### Notes List and Editor Layout

```tsx
// NotesApp.tsx
import { useState } from 'react'
import { useQuery, useMutation, useSyncStatus } from '@kora/react'
import { app } from './app'
import { NoteEditor } from './NoteEditor'

export function NotesApp() {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const notes = useQuery(app.notes.orderBy('updatedAt', 'desc'))
  const createNote = useMutation(app.notes.insert)
  const deleteNote = useMutation(app.notes.delete)
  const status = useSyncStatus()

  const handleNewNote = async () => {
    const note = await createNote({ title: 'Untitled', content: '' })
    setSelectedId(note.id)
  }

  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      <aside style={{ width: 260, borderRight: '1px solid #eee', padding: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>Notes</h2>
          <span>{status.status === 'offline' ? 'Offline' : 'Synced'}</span>
        </div>
        <button onClick={handleNewNote}>New Note</button>
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {notes.map((note) => (
            <li
              key={note.id}
              onClick={() => setSelectedId(note.id)}
              style={{
                padding: 8,
                cursor: 'pointer',
                background: note.id === selectedId ? '#f0f0f0' : 'transparent',
              }}
            >
              <strong>{note.title || 'Untitled'}</strong>
              <br />
              <small>{note.wordCount} words</small>
              <button
                onClick={(e) => { e.stopPropagation(); deleteNote(note.id) }}
                style={{ float: 'right' }}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <main style={{ flex: 1, padding: 16 }}>
        {selectedId ? <NoteEditor noteId={selectedId} /> : <p>Select a note or create a new one.</p>}
      </main>
    </div>
  )
}
```

### Rich Text Editor

The `useRichText` hook connects a Kora `t.richtext()` field to a text editor. It returns a Yjs `Y.Text` binding that any Yjs-compatible editor (Tiptap, ProseMirror, Quill, etc.) can consume.

```tsx
// NoteEditor.tsx
import { useQuery, useMutation, useRichText } from '@kora/react'
import { app } from './app'

export function NoteEditor({ noteId }: { noteId: string }) {
  const [note] = useQuery(app.notes.where({ id: noteId }))
  const updateNote = useMutation(app.notes.update)
  const { binding, getText } = useRichText(app.notes, noteId, 'content')

  if (!note) return <p>Note not found.</p>

  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    updateNote(noteId, { title: e.target.value })
  }

  const handleContentChange = () => {
    // Update the word count whenever content changes.
    const text = getText()
    const count = text.trim() ? text.trim().split(/\s+/).length : 0
    updateNote(noteId, { wordCount: count, lastEditedBy: 'current-user' })
  }

  return (
    <div>
      <input
        value={note.title}
        onChange={handleTitleChange}
        style={{ fontSize: 24, border: 'none', width: '100%' }}
      />
      <p style={{ color: '#888' }}>{note.wordCount} words</p>
      {/*
        Pass `binding` to any Yjs-compatible editor.
        This example uses a minimal textarea for clarity.
        In production, use Tiptap or ProseMirror with y-prosemirror.
      */}
      <textarea
        ref={(el) => { if (el) binding.attach(el) }}
        onChange={handleContentChange}
        style={{ width: '100%', minHeight: 400, fontFamily: 'inherit' }}
      />
    </div>
  )
}
```

`useRichText` returns:

- **`binding`** -- a Yjs binding object. Call `binding.attach(element)` to connect it to a DOM node, or pass it to a Yjs editor plugin like `y-prosemirror`.
- **`getText()`** -- returns the current plain-text content of the rich text field.

Edits made through the binding are automatically captured as Kora operations and synced to other clients.

## How Rich Text Sync Works

When two users edit the same note at the same time, here is what happens:

1. **User A** types "Hello" at position 0. Kora records this as a Yjs operation on the `content` field.
2. **User B** types "World" at position 0 in the same note, at the same time. Kora records a separate Yjs operation.
3. Both operations sync to the server and fan out to the other client.
4. The Yjs CRDT merges the operations at the character level. The result deterministically becomes "HelloWorld" or "WorldHello" depending on the node IDs (used for tie-breaking), but both users always see the same result.

There is no last-write-wins for rich text. No content is ever lost. Each keystroke is preserved independently, and the CRDT guarantees convergence across all clients.

This is different from the `title` field, which uses last-write-wins (LWW) via the hybrid logical clock. For short scalar values like titles, LWW is sufficient. For long-form text where users expect character-level merging, `t.richtext()` provides a CRDT.

## Custom Resolver: Additive Word Count

The `wordCount` field uses a custom Tier 3 resolver. Here is why it matters.

Consider this scenario:

| State | Base | User A | User B |
|-------|------|--------|--------|
| Word count | 50 | 55 (added 5 words) | 48 (deleted 2 words) |

With default last-write-wins, the later write would overwrite the earlier one. If User A's edit arrives last, the count becomes 55, ignoring User B's deletion. The count would be wrong.

The additive resolver fixes this:

```typescript
wordCount: (local: number, remote: number, base: number): number => {
  const localDelta = local - base    // +5
  const remoteDelta = remote - base  // -2
  return Math.max(0, base + localDelta + remoteDelta) // 50 + 5 + (-2) = 53
}
```

Both contributions are preserved. The `Math.max(0, ...)` guard prevents the count from going negative in edge cases.

## Tags: Add-Wins Set

The `tags` field is declared as `t.array(t.string())`. Kora merges arrays using an add-wins set strategy by default: if User A adds the tag "work" and User B adds the tag "urgent" concurrently, the merged result contains both tags. If both users add the same tag, it appears once.

```typescript
// User A
updateNote(noteId, { tags: [...note.tags, 'work'] })

// User B (concurrently)
updateNote(noteId, { tags: [...note.tags, 'urgent'] })

// After sync, both users see: ['work', 'urgent']
```

No duplicates, no lost tags, no conflict resolution code required.
