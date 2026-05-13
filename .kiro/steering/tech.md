---
description: Tech stack, frameworks, and build system details
category: Tech Stack
---

# Tech Stack & Build System

## IMPORTANT: Production Architecture
- **The Cloudflare Worker (`worker/`) is the sole production API backend.** There is no Express server.
- **All API and business-logic server-side code lives in `worker/src/`.** Backend tooling, scripts, and config (e.g., `worker/scripts/`, Wrangler config, deploy files) live elsewhere under `worker/`. Any `server/` directory is legacy and not deployed.
- **Always verify your local branch is up to date with `origin/main` before starting work.** The codebase evolves rapidly — stale local checkouts will lead to changes against deleted or outdated code.

## Monorepo Structure
- **npm workspaces** with three packages: `client`, `worker`, `shared`
- Shared base TypeScript config in `tsconfig.base.json` (ES2022, ESNext modules, bundler resolution, strict mode)

## Client
- **React 18** with **TypeScript**
- **Vite** for dev server and bundling
- **react-router-dom v6** for routing (two sections: `/social/*` and `/quotes/*`)
- No state management library — uses React context (`AuthContext`, `ErrorToastProvider`)
- API layer in `client/src/api.ts` — plain `fetch` calls with Bearer token auth via localStorage

## Worker (Cloudflare Workers)
- **Hono** web framework
- **Cloudflare D1** (SQLite) for database
- **Cloudflare R2** for object storage
- **Cloudflare Queues** for async image generation jobs
- **Wrangler** for local dev and deployment
- SQL migrations in `worker/src/migrations/`
- Bindings typed in `worker/src/bindings.ts`
- Environment variables in `worker/.dev.vars` (see `worker/.dev.vars.example` for required keys)

## Shared Package
- Pure TypeScript types — no runtime dependencies
- Exports all types from `shared/src/types/`
- Used by both client and worker via workspace dependency
- **The worker resolves `shared` via a TypeScript `paths` mapping in `worker/tsconfig.json` pointing to `../shared/src/index.ts`, so it reads directly from `shared/src/` — no build into `shared/dist/` is required.**
- The client (Vite) resolves `shared` via `package.json` `exports` pointing to `./src/index.ts` — same source-direct resolution.
- Neither the worker nor the client requires a `shared` rebuild when types change; both pick up changes from `shared/src/` directly.
- `dev.mjs` still runs `npm run build --workspace=shared` on startup as a safety step, but this is not required for the worker or client to see type changes.

## Testing
- **Vitest** (v2) as test runner, configured at repo root
- **fast-check** for property-based testing
- Test files: `tests/unit/*.test.ts`, `tests/property/*.property.test.ts`
- Test helpers in `tests/unit/helpers/` (mock D1, R2, Queue)

## Common Commands

```bash
# Run all tests (single run, no watch)
npm test

# Run tests in watch mode
npm run test:watch

# Dev servers (run these manually in separate terminals)
npm run dev:client    # Vite dev server on :5173, proxies /api to :8787
npm run dev:worker    # applies D1 migrations then starts wrangler dev on :8787

# Build
npm run build:shared  # builds shared/dist/ (not required for worker/client, but used by deploy pipeline)
npm run build:client
npm run build:worker  # automatically builds shared first

# Worker (from worker/ directory)
npm run dev           # applies local D1 migrations + wrangler dev
npm run deploy        # applies remote D1 migrations + wrangler deploy
npm run build         # tsc -b
```
