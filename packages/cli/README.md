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

### kora deploy

Deploy your Kora app to a cloud platform with a single command:

```bash
kora deploy
```

Supported platforms: **Fly.io**, **Railway** (Render, Docker, Kora Cloud coming soon).

#### Options

| Flag | Description |
|------|-------------|
| `--platform` | Target platform: `fly`, `railway`, `render`, `docker`, `kora-cloud` |
| `--app` | Application name on the platform |
| `--region` | Deployment region (e.g., `iad`, `lhr`, `syd`) |
| `--prod` | Deploy to production environment (default: preview) |
| `--confirm` | Non-interactive mode — fail fast if required data is missing |
| `--reset` | Delete `.kora/deploy/` state and generated artifacts |

#### Subcommands

```bash
kora deploy status      # Show deployment health, URLs, and metadata
kora deploy logs        # View recent deployment logs
kora deploy rollback    # Revert to the previous deployment
```

#### Non-interactive (CI/CD)

```bash
kora deploy --platform=fly --app=my-app --region=iad --confirm
```

#### What it does

1. Generates a `Dockerfile` and `.dockerignore` in `.kora/deploy/`
2. Bundles your server entry (`server.ts`) with esbuild into a single file
3. Builds your client with Vite
4. Generates platform config (`fly.toml` or `railway.json`)
5. Provisions the app on the platform (creates it if new)
6. Deploys and returns your live URL and sync WebSocket endpoint

#### Prerequisites

- **Fly.io**: Install [flyctl](https://fly.io/docs/hands-on/install-flyctl/) and run `fly auth login`
- **Railway**: Install [@railway/cli](https://docs.railway.com/guides/cli) and run `railway login`

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
