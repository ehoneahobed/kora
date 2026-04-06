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

- **react-tailwind-sync** — React + Tailwind + sync server (recommended)
- **react-tailwind** — React + Tailwind, local-only
- **react-sync** — React + CSS + sync server
- **react-basic** — React + CSS, local-only

## Options

```bash
npx create-kora-app my-app --template react-tailwind-sync --pm pnpm
```

| Option | Description |
|--------|-------------|
| `--template` | `react-tailwind-sync`, `react-tailwind`, `react-sync`, or `react-basic` |
| `--pm` | Package manager: `pnpm`, `npm`, `yarn`, `bun` |
| `--skip-install` | Skip dependency installation |
| `--yes` / `-y` | Accept recommended defaults |
| `--tailwind` / `--no-tailwind` | Choose Tailwind styling |
| `--sync` / `--no-sync` | Choose sync-enabled template |

See the [full documentation](https://github.com/ehoneahobed/kora) for guides, API reference, and examples.
