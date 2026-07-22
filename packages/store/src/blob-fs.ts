// Node-only entry point for @korajs/store/blob-fs.
// Kept as a separate subpath so the filesystem backend (which imports node:fs)
// never enters a browser bundle's module graph.
export { FilesystemBlobStore } from './blob/filesystem-blob-store'
