---
"@korajs/cli": minor
---

`kora deploy --platform kora-cloud` deploys to Kora Cloud, and `kora login`, `kora logout` and `kora whoami` sign the CLI in and out. Login uses a short code approved in the Kora Cloud console (works over SSH); the sign-in is kept in `~/.config/kora/cloud.json` with owner-only permissions, or comes from `KORA_CLOUD_TOKEN` in CI. Deploying uploads the source git would commit (never `node_modules`, `.git`, `.kora` or `.env` files), links the directory in `.kora/cloud.json`, and follows the build and each deployment stage until the app is live, printing the build log's end when a build fails. Kora Cloud deploys to production from the CLI; previews come from pull requests. Nothing changes for self-hosting or the other platforms. Also fixes `kora deploy --platform <name>` (and `--app`, `--region` with a separate value), which was read as an unknown subcommand, and prints an expected error once, without a stack trace.
