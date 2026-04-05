# @korajs/cli

CLI tooling for Kora.js. Scaffold new apps, run the development server, manage schema migrations, and generate TypeScript types.

## Install

```bash
pnpm add -g @korajs/cli
```

Or use directly with `npx`:

```bash
npx create-kora-app my-app
```

## Commands

### create-kora-app

Scaffold a new Kora.js project:

```bash
npx create-kora-app my-app

# Interactive prompts:
#   Select a template: React (basic) | React (with sync)
#   Package manager: pnpm | npm | yarn | bun
```

### kora dev

Start the development environment:

```bash
kora dev
```

This runs:
- Vite dev server for your application
- Kora sync server (if configured)
- Schema file watcher with auto type generation
- Embedded DevTools (toggle with `Ctrl+Shift+K`)

### kora migrate

Detect schema changes and generate migrations:

```bash
kora migrate
# Detects changes, generates migration file, prompts to apply
```

### kora generate types

Generate TypeScript types from your schema:

```bash
kora generate types
# Output: kora/generated/types.ts
```

## Quick Start

```bash
npx create-kora-app my-app
cd my-app
pnpm dev
```

You'll have a working offline-first app in under 2 minutes.

## License

MIT

See the [full documentation](https://github.com/ehoneahobed/kora) for guides, API reference, and examples.
