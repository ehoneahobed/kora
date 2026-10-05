# create-kora-app

Scaffold a new [Kora.js](https://korajs.dev) offline-first application. Kora 1.0 is in beta. The `beta`
tag always names the newest beta (`latest` currently points at the same release):

```bash
npx create-kora-app@beta my-app
cd my-app
pnpm dev
```

The CLI asks for the platform, framework, styling, sync and package manager, then installs the
dependencies. `--yes` takes the recommended setup (`react-tailwind-sync`).

## Templates

| Framework | Templates |
|-----------|-----------|
| React | `react-basic`, `react-sync`, `react-tailwind`, `react-tailwind-sync` |
| Vue | `vue-basic`, `vue-sync`, `vue-tailwind`, `vue-tailwind-sync` |
| Svelte | `svelte-basic`, `svelte-sync`, `svelte-tailwind`, `svelte-tailwind-sync` |
| Desktop | `tauri-react` |

## Options

| Option | Description |
|--------|-------------|
| `--template <id>` | Use a template directly. |
| `--platform web\|desktop-tauri` | Web or Tauri desktop. |
| `--framework react\|vue\|svelte` | UI framework. |
| `--tailwind` / `--no-tailwind` | Tailwind CSS or plain CSS. |
| `--sync` / `--no-sync` | Include a sync server. |
| `--db sqlite\|postgres`, `--db-provider <name>` | Database of the sync server. |
| `--pm pnpm\|npm\|yarn\|bun` | Package manager. |
| `--yes`, `-y` | Accept the defaults. |
| `--skip-install` | Do not install dependencies. |

See [Getting Started](https://korajs.dev/getting-started) and the
[CLI reference](https://korajs.dev/api/cli).
