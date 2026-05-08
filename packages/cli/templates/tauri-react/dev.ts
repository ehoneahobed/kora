import { spawn, type ChildProcess } from 'node:child_process'

// Starts both the sync server and the Tauri app with a single command.
// The sync server runs in the background so the desktop app can sync
// data across devices during development.

const children: ChildProcess[] = []

function cleanup() {
  for (const child of children) {
    child.kill()
  }
  process.exit()
}

process.on('SIGINT', cleanup)
process.on('SIGTERM', cleanup)

// Start the sync server
const syncServer = spawn('tsx', ['server.ts'], {
  stdio: 'inherit',
  shell: true,
})
children.push(syncServer)

// Start the Tauri app (manages Vite dev server + Rust build)
const tauriApp = spawn('tauri', ['dev'], {
  stdio: 'inherit',
  shell: true,
})
children.push(tauriApp)

// If the Tauri app exits, stop everything
tauriApp.on('close', (code) => {
  syncServer.kill()
  process.exit(code ?? 0)
})
