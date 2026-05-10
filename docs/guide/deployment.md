# Deployment

This guide walks you through deploying a Kora.js app to the internet. By the end, your app will have a public URL where anyone can use it, with real-time sync across devices.

**Time required:** ~10 minutes for your first deploy.

## The Fastest Path: `kora deploy`

If you scaffolded your app with `npx create-kora-app` and chose a sync template, you already have everything needed. One command handles the entire deployment:

```bash
kora deploy
```

That's it. Kora will prompt you for a platform, build your app, and deploy it.

::: tip New to deployment?
If you've never deployed an app before, we recommend **Fly.io**. It has a generous free tier and works well with Kora's real-time sync. The guide below walks you through every step.
:::

---

## Step-by-Step: Deploy to Fly.io

### Step 1: Create your app

Skip this if you already have a Kora app. Otherwise:

```bash
npx create-kora-app my-app
```

When prompted:
- **Template:** Pick "React + Tailwind (with sync)" (the recommended option)
- **Package manager:** Pick whichever you prefer (pnpm, npm, yarn, or bun)

Then install dependencies and verify it runs locally:

```bash
cd my-app
pnpm install
pnpm dev
```

Open `http://localhost:5173` in your browser. You should see a working todo app. Close the dev server when you're done (Ctrl+C).

### Step 2: Install the Fly CLI

Fly.io needs a small command-line tool installed on your computer.

**macOS:**

```bash
brew install flyctl
```

**Linux/WSL:**

```bash
curl -L https://fly.io/install.sh | sh
```

**Windows (PowerShell):**

```powershell
pwsh -Command "iwr https://fly.io/install.ps1 -useb | iex"
```

Verify it's installed:

```bash
fly version
```

You should see a version number like `0.3.x`. If you get "command not found", close and reopen your terminal.

### Step 3: Create a Fly.io account and log in

If you don't have an account yet, create one at [fly.io](https://fly.io). The free tier includes enough resources to run a Kora app.

Then log in from your terminal:

```bash
fly auth login
```

This opens a browser window. Sign in and return to your terminal.

### Step 4: Deploy

Make sure you're in your project directory, then run:

```bash
kora deploy
```

Kora will ask:

```
? Where do you want to deploy?
  > Fly.io (recommended for sync apps)
```

Select **Fly.io**. Kora then:

1. Generates a Dockerfile and deployment configuration
2. Bundles your server code into a single file
3. Builds your client (React app) for production
4. Creates your app on Fly.io
5. Deploys everything

After a minute or two, you'll see:

```
✓ Deployment completed: https://my-app.fly.dev
  Sync endpoint: wss://my-app.fly.dev/kora-sync
```

Open that URL in your browser. Your app is live.

### Step 5: Verify sync works

Open the URL in two browser tabs (or on your phone). Add a todo in one tab — it should appear in the other tab within a second. That's real-time sync working.

---

## Subsequent Deploys

After your first deploy, Kora remembers your settings. Just run:

```bash
kora deploy
```

It reuses your platform, app name, and region from the previous deploy.

---

## Non-Interactive Deploy (CI/CD)

For automated deployments in a CI/CD pipeline, pass all options as flags:

```bash
kora deploy --platform=fly --app=my-app --region=iad --confirm
```

The `--confirm` flag tells Kora to fail fast instead of prompting.

---

## Managing Your Deployment

### Check status

```bash
kora deploy status
```

Shows whether your app is healthy, its URL, and sync endpoint.

### View logs

```bash
kora deploy logs
```

Shows recent output from your deployed app. Useful for debugging issues.

### Observability endpoints

`createProductionServer` exposes these operational endpoints:

- `GET /health` for public platform health checks.
- `GET /__kora/status` for server status.
- `GET /__kora/metrics` for Prometheus-format metrics.
- `GET /__kora/events` for live Server-Sent Events.
- `GET /__kora` for the built-in dashboard.

Set `KORA_ADMIN_TOKEN`, `KORA_METRICS_TOKEN`, and `KORA_BACKUP_TOKEN` in production. Then call protected endpoints with:

```bash
curl -H "Authorization: Bearer $KORA_ADMIN_TOKEN" https://your-app.example.com/__kora/status
```

The CLI reads the same token from `KORA_ADMIN_TOKEN`, or you can pass it directly:

```bash
kora status --url https://your-app.example.com --token "$KORA_ADMIN_TOKEN"
kora logs --url https://your-app.example.com --token "$KORA_ADMIN_TOKEN"
```

### Roll back

```bash
kora deploy rollback
```

Reverts to the previous deployment. Use this if a deploy breaks something.

### Start fresh

```bash
kora deploy --reset
```

Deletes all deployment state and generated files. Your next `kora deploy` will start from scratch.

---

## Deploy to Railway

Railway is another good option, especially if you prefer a dashboard-based workflow.

### Prerequisites

Install the Railway CLI:

```bash
npm install -g @railway/cli
railway login
```

### Deploy

```bash
kora deploy --platform=railway
```

The flow is the same as Fly.io — Kora handles Dockerfile generation, bundling, and deployment.

---

## Deploy to AWS

Kora supports two AWS deployment targets: **Lightsail Containers** (simpler, cheaper) and **ECS Fargate** (production-grade, scalable). Both use Docker containers and require the AWS CLI.

### Prerequisites (both AWS options)

1. **Install Docker Desktop:**

   Both AWS options build a Docker container image locally before pushing to AWS. You need Docker running on your machine.

   Download from [docker.com/get-started](https://www.docker.com/get-started/) and make sure Docker Desktop is **running** (not just installed) before deploying.

   Verify:

   ```bash
   docker --version
   ```

2. **Install the AWS CLI:**

   **macOS:**

   ```bash
   brew install awscli
   ```

   **Linux:**

   ```bash
   curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
   unzip awscliv2.zip
   sudo ./aws/install
   ```

   **Windows:**

   Download and run the installer from [AWS CLI install page](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html).

3. **Configure credentials:**

   ```bash
   aws configure
   ```

   Enter your AWS Access Key ID, Secret Access Key, and preferred region (e.g., `us-east-1`). You can create an access key in the [AWS IAM console](https://console.aws.amazon.com/iam/).

4. **Verify it works:**

   ```bash
   aws sts get-caller-identity
   ```

   You should see your account ID and ARN.

### Option A: AWS Lightsail Containers

**Best for:** Simple deployments, side projects, and small-to-medium apps. Lightsail has predictable pricing starting at $7/month for a nano container.

#### Additional prerequisite: lightsailctl plugin

Lightsail requires the `lightsailctl` plugin to push container images. Install it once:

**macOS:**

```bash
brew install aws/tap/lightsailctl
```

**Linux:**

```bash
curl "https://s3.us-west-2.amazonaws.com/lightsailctl/latest/linux-amd64/lightsailctl" -o "/usr/local/bin/lightsailctl"
chmod +x /usr/local/bin/lightsailctl
```

**Windows:**

```powershell
Invoke-WebRequest -Uri "https://s3.us-west-2.amazonaws.com/lightsailctl/latest/windows-amd64/lightsailctl.exe" -OutFile "C:\Program Files\Amazon\lightsailctl\lightsailctl.exe"
```

Verify:

```bash
aws lightsail push-container-image --help
```

#### Deploy

```bash
kora deploy --platform=aws-lightsail
```

Or select "AWS Lightsail Containers" when prompted interactively.

Kora will:
1. Create a Lightsail container service (nano size, 1 instance)
2. Build your Docker image locally
3. Push the image to Lightsail via `lightsailctl`
4. Create a deployment with health check configuration
5. Return your live URL

#### Environment variables

Kora automatically forwards these environment variables from your machine to the Lightsail container:

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | For PostgreSQL | Connection string (e.g., `postgres://user:pass@host/db?sslmode=require`) |
| `AUTH_SECRET` | For auth | Secret key for signing JWT tokens. Generate with `openssl rand -base64 32` |
| `PUBLIC_URL` | Optional | Public URL of your app (for OG meta tags, email links, etc.) |

Set them before deploying:

```bash
export DATABASE_URL="postgres://user:pass@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require"
export AUTH_SECRET="$(openssl rand -base64 32)"
kora deploy --platform=aws-lightsail --confirm
```

You can also update environment variables after deployment via the [Lightsail console](https://lightsail.aws.amazon.com/) under your container service's deployment settings.

**Example output:**

```
✓ Deployment completed: https://my-app.abc123.us-east-1.cs.amazonlightsail.com
  Sync endpoint: wss://my-app.abc123.us-east-1.cs.amazonlightsail.com/kora-sync
```

::: tip Scaling Lightsail
To change the container size or instance count after your first deploy, use the AWS console or CLI:
```bash
aws lightsail update-container-service \
  --service-name my-app \
  --power small \
  --scale 2
```
Available powers: `nano`, `micro`, `small`, `medium`, `large`, `xlarge`.
:::

### Option B: AWS ECS Fargate

**Best for:** Production deployments that need auto-scaling, load balancing, and fine-grained control. ECS Fargate runs your containers without managing servers.

```bash
kora deploy --platform=aws-ecs
```

Or select "AWS ECS Fargate" when prompted interactively.

Kora will:
1. Create an ECR repository for your Docker image
2. Create an ECS cluster and CloudWatch log group
3. Build and push your Docker image to ECR
4. Register an ECS task definition with health checks
5. Update or create the ECS service

**First-time setup note:** ECS Fargate requires networking configuration (VPC, subnets, security groups) that varies by AWS account. On the first deploy, if no service exists yet, Kora registers the task definition and provides the `aws ecs create-service` command you need to run with your specific VPC settings:

```bash
aws ecs create-service \
  --cluster my-app \
  --service-name my-app \
  --task-definition my-app \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-xxx],securityGroups=[sg-xxx],assignPublicIp=ENABLED}" \
  --region us-east-1
```

After the service is created, subsequent deploys with `kora deploy` work automatically.

::: tip Using PostgreSQL with AWS
For production AWS deployments, use a managed PostgreSQL service (Amazon RDS, Neon, Supabase) instead of SQLite. Set the `DATABASE_URL` environment variable before deploying:

**Lightsail** — Kora automatically forwards `DATABASE_URL` from your shell to the container. See [Environment variables](#environment-variables) above. You can also update it later via the Lightsail console.

**ECS** — add `DATABASE_URL` to the task definition's environment variables or use AWS Secrets Manager.

See [Storage backends](#storage-backends) below for server code examples.
:::

### CI/CD with AWS

Both AWS adapters work in non-interactive mode:

```bash
# Lightsail
kora deploy --platform=aws-lightsail --app=my-app --region=us-east-1 --confirm

# ECS Fargate
kora deploy --platform=aws-ecs --app=my-app --region=us-east-1 --confirm
```

Make sure your CI environment has AWS credentials configured (e.g., via `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` environment variables).

---

## Deploy a Tauri Desktop App's Sync Server

Tauri desktop apps store data locally in native SQLite. To sync across multiple devices, you deploy the **sync server** — the desktop binary is distributed separately.

### How it differs from web deployment

| | Web App | Tauri Desktop App |
|---|---------|-------------------|
| **Client** | Deployed with the server (static files) | Distributed as a native binary (.dmg, .msi, .deb) |
| **Sync server** | Same deployment serves both | Deployed independently |
| **`staticDir`** | Points to `./dist` (built frontend) | Not needed (desktop doesn't serve HTML) |
| **Sync URL** | Derived from page host | Set via `VITE_SYNC_URL` at build time |

### Step 1: Deploy the sync server

From your Tauri project directory:

```bash
pnpm deploy:server
```

This is the same `kora deploy` command used for web apps. It works with all supported platforms (Fly.io, Railway, AWS).

::: tip
The sync server for a Tauri app is identical to a web app's server — it's just a Node.js process with WebSocket support. Any deployment method in this guide works.
:::

### Step 2: Build the desktop binary with the server URL

Once deployed, build the desktop app pointing to your server:

```bash
VITE_SYNC_URL=wss://my-app.fly.dev/kora-sync pnpm build
```

### Step 3: Distribute

Share the built installers from `src-tauri/target/release/bundle/` with your users. Every installed copy syncs through your deployed server.

For the full Tauri workflow, see the [Tauri Desktop Guide](/guide/tauri-desktop).

---

## More Platforms (Coming Soon)

The following platforms appear in the `kora deploy` interactive prompt but are not yet implemented:

- **Render** — Web service deployment with automatic HTTPS
- **Docker (self-hosted)** — Generate a production Docker image for any hosting environment
- **Kora Cloud** — Managed hosting optimized for Kora apps

Selecting these will show a "not implemented yet" message. For now, use Fly.io, Railway, or one of the AWS options. If you need to deploy to an unsupported platform, see [Manual Server Setup](#advanced-manual-server-setup) below.

---

## What `kora deploy` Does Under the Hood

You don't need to know this to use it, but if you're curious:

1. **Generates a Dockerfile** in `.kora/deploy/` — a recipe for building your app's container image
2. **Bundles your server** — combines `server.ts` and its dependencies into a single `server-bundled.js` file using esbuild
3. **Builds your client** — runs `vite build` to create optimized HTML, CSS, and JavaScript for the browser
4. **Generates platform config** — creates `fly.toml` (Fly.io), `railway.json` (Railway), or configures AWS resources (ECS/Lightsail) with the right settings
5. **Provisions the app** — creates the app on the platform if it doesn't exist yet
6. **Deploys** — pushes the container image and starts your app

All generated files go into `.kora/deploy/`. Add this to your `.gitignore`:

```
.kora/deploy/
```

---

## Advanced: Manual Server Setup

If you want full control over your deployment (or need to deploy to a platform Kora doesn't support yet), you can set up the server manually.

### Install the server package

```bash
pnpm add @korajs/server
```

### Create a server entry file

Create `server.ts` in your project root:

```typescript
import { createProductionServer, createSqliteServerStore } from '@korajs/server'
import schema from './src/schema'

const store = createSqliteServerStore({ filename: './kora-server.db' })
await store.setSchema(schema)

const server = createProductionServer({
  store,
  port: Number(process.env.PORT) || 3001,
  staticDir: './dist',
  syncPath: '/kora-sync',
  operationalAuth: {
    adminToken: process.env.KORA_ADMIN_TOKEN,
    metricsToken: process.env.KORA_METRICS_TOKEN,
    backupToken: process.env.KORA_BACKUP_TOKEN,
  },
})

server.start().then((url) => {
  console.log(`Kora app running at ${url}`)
})
```

`createProductionServer` serves both your built frontend files and the WebSocket sync endpoint on a single port. `/health` is public for deploy platform health checks. `/__kora/*` operational endpoints are token-protected when you set the matching token environment variables.

### Build and run

```bash
pnpm build                    # Build the client with Vite
node --import tsx server.ts   # Start the production server
```

### Connect the client

In your app code, point sync to the server:

```typescript
const app = createApp({
  schema,
  sync: {
    url: 'wss://your-domain.com/kora-sync',
  },
})
```

### Storage backends

**SQLite** (default — good for single-server deployments):

```typescript
import { createSqliteServerStore } from '@korajs/server'

const store = createSqliteServerStore({ filename: './kora-server.db' })
```

**PostgreSQL** (recommended for production):

```bash
pnpm add postgres
```

```typescript
import { createPostgresServerStore } from '@korajs/server'

const store = await createPostgresServerStore({
  connectionString: process.env.DATABASE_URL,
})
```

**Memory** (development/testing only — data lost on restart):

```typescript
import { MemoryServerStore } from '@korajs/server'

const store = new MemoryServerStore()
```

### Docker (manual)

If you need a custom Dockerfile:

```dockerfile
FROM node:20-alpine
WORKDIR /app

# Install native module build tools
RUN apk add --no-cache python3 make g++

COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm && pnpm install --prod

COPY dist ./dist
COPY server.ts ./

ENV PORT=3000
CMD ["node", "--import", "tsx", "server.ts"]
```

---

## Production Checklist

Before sharing your app publicly:

- [ ] **Use HTTPS/WSS** — Fly.io, Railway, and AWS Lightsail/ECS provide this automatically. If self-hosting, put a reverse proxy (nginx, Caddy) in front of your server.
- [ ] **Add authentication** — The default server accepts all connections. See [Sync Configuration](/guide/sync-configuration) for setting up token-based auth.
- [ ] **Use PostgreSQL for production** — SQLite works great for development and small deployments, but PostgreSQL is better for production workloads.
- [ ] **Add `.kora/deploy/` to `.gitignore`** — Generated deployment files shouldn't be committed.

---

## Troubleshooting

### "Fly CLI is required but not installed"

Install the Fly CLI and make sure it's in your PATH. See [Step 2](#step-2-install-the-fly-cli) above.

### "Could not find a server entry file"

Kora looks for `server.ts`, `server.js`, `src/server.ts`, or `src/server.js` in your project root. If you used a sync template, this file already exists. If not, create one — see [Manual Server Setup](#advanced-manual-server-setup).

### "Name has already been taken" on Fly.io

App names on Fly.io are globally unique. Pick a different name:

```bash
kora deploy --app=my-unique-app-name
```

### App deploys but shows a blank page

Check that your `server.ts` uses `createProductionServer` with `staticDir: './dist'`. The production server needs to know where your built frontend files are.

### "Cannot connect to the Docker daemon"

Docker Desktop must be **running** (not just installed) before deploying to AWS. Open Docker Desktop and wait for the engine to start, then retry `kora deploy`. You can verify Docker is ready with:

```bash
docker info
```

### "lightsailctl plugin was not found"

The Lightsail adapter uses the `lightsailctl` plugin to push container images. Install it before deploying:

**macOS:**

```bash
brew install aws/tap/lightsailctl
```

**Linux:**

```bash
curl "https://s3.us-west-2.amazonaws.com/lightsailctl/latest/linux-amd64/lightsailctl" -o "/usr/local/bin/lightsailctl"
chmod +x /usr/local/bin/lightsailctl
```

See [Lightsail prerequisites](#additional-prerequisite-lightsailctl-plugin) for all platforms.

### "AWS CLI is not authenticated"

Run `aws configure` and enter your credentials, or set the `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` environment variables. Verify with:

```bash
aws sts get-caller-identity
```

### Lightsail deploy stuck on "DEPLOYING"

Lightsail container deployments can take 2-5 minutes. Check status with:

```bash
kora deploy status
```

Or directly:

```bash
aws lightsail get-container-services --service-name my-app
```

If the deployment fails, check the container logs:

```bash
kora deploy logs
```

### "image does not provide linux/amd64 platform"

This happens on Apple Silicon Macs (M1/M2/M3/M4). AWS requires `linux/amd64` images, but Docker on Apple Silicon builds `linux/arm64` by default.

The `kora deploy` command handles this automatically for AWS adapters. If you're building manually, add the platform flag:

```bash
docker build --platform linux/amd64 -t my-app .
```

Note: Cross-platform builds are slower than native builds. This is normal on Apple Silicon.

### ECS service won't start

ECS Fargate requires proper networking. Make sure your security group allows inbound traffic on port 3001 and your subnets have internet access (either public subnets with `assignPublicIp=ENABLED` or private subnets with a NAT gateway).

### Sync not working after deploy

Make sure your client-side `sync.url` matches the deployed WebSocket URL. If you deployed to `my-app.fly.dev`, the sync URL is `wss://my-app.fly.dev/kora-sync`.
