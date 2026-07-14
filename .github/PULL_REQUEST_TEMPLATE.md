## What does this PR do?

<!-- One or two sentences. Link the issue it addresses. -->

Closes #

## Checklist

- [ ] `pnpm build && pnpm test && pnpm typecheck && pnpm lint` pass locally
- [ ] Behavior changes are covered by a test (bug fixes: a test that fails without the fix)
- [ ] `pnpm test:e2e` passes if this touches store, sync, react bindings, CLI, or templates
- [ ] A changeset is included if this changes any published package's behavior (`pnpm changeset`)
- [ ] Merge engine changes: `pnpm test:release-gate` passes (determinism, chaos, benchmarks)
