---
'@korajs/cli': patch
---

Resolve bundled templates, the CLI package version, and optional database drivers without relying on `import.meta.url` in CommonJS output. The `@korajs/cli/create` side-effect entry is now ESM-only, matching the published `create-kora-app` executable, while the documented main and Vite programmatic entry points retain both ESM and CommonJS exports.
