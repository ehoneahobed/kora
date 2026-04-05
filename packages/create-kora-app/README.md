# create-kora-app

Scaffold a new [Kora.js](https://github.com/ehoneahobed/kora) offline-first application.

## Usage

```bash
npx create-kora-app my-app
cd my-app
pnpm install
pnpm dev
```

## Templates

- **react-basic** — Local-only React app, no sync
- **react-sync** — React app with sync server included

## Options

```bash
npx create-kora-app my-app --template react-sync --pm pnpm
```

| Option | Description |
|--------|-------------|
| `--template` | `react-basic` or `react-sync` |
| `--pm` | Package manager: `pnpm`, `npm`, `yarn`, `bun` |
| `--skip-install` | Skip dependency installation |

See the [full documentation](https://github.com/ehoneahobed/kora) for guides, API reference, and examples.
