---
title: Settings
description: "Declare the environment variables a Kora app reads in .env.example, with tags for required, secret and development-only settings, so every host knows what to ask for."
---

# Settings

Every environment variable your app reads belongs in `.env.example`, with a comment saying what it's for. That file is how people, hosts and AI agents learn what the app needs: Kora Cloud reads it to know which settings to ask for, and `kora doctor --production` checks it against the environment. Nothing runs your code to find out.

## The convention

A comment describes the variables directly below it, up to the next blank line. Bracketed tags in the comment set the rules:

| Tag | Meaning |
|---|---|
| `[required]` | Production can't run correctly without it |
| `[secret]` | A credential: hosts store it encrypted and never display it |
| `[development]` | Used only outside production; hosts don't ask for it |

```bash
# [required] [secret] Sends invitation and verification emails.
RESEND_API_KEY=

# [required] Sender for every email, on a domain verified with your email provider.
EMAIL_FROM="Acme <hello@acme.dev>"

# [development] Where emails are written instead of sent, outside production.
DEV_MAILBOX=./mail
```

Values in the file are examples or defaults, never real secrets. Copy it to `.env` for local development.

## What the framework sets for you

Hosts set `PORT`, `DATABASE_URL`, `PUBLIC_URL` and the file store (`KORA_BLOB_STORE_URL` or `KORA_BLOB_DIR`, see [where a server keeps blobs](/guide/storage-configuration#where-a-server-keeps-blobs)). On Kora Cloud the operational tokens (`KORA_ADMIN_TOKEN`, `KORA_METRICS_TOKEN`, `KORA_BACKUP_TOKEN`) and `KORA_AUTH_SECRET` are generated as well. List them anyway: self-hosters need to know they exist.

## Checking

```bash
npx kora doctor               # what production will need
npx kora doctor --production  # fails on a [required] setting missing from this environment
```

Templates from `create-kora-app` start with a tagged `.env.example`. Use the [`parseEnvExample`](/api/core) and `missingRequiredEnv` functions from `@korajs/core` to read the same declarations in your own tooling.
