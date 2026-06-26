# Production Deploy & Secrets Checklist

Run these steps to restore and verify production after the pipeline bug fixes on
`fix/production-pipeline-bugs`. The code fixes are in this branch; the items
below require infrastructure/secret access and are **run by you** (an agent must
not touch production).

Production worker: `https://social-media-cross-poster.chicago-reno.workers.dev`
Run all `wrangler` commands from the `worker/` directory.

## 1. See exactly what's misconfigured (fastest signal)

The `/health` endpoint now reports the **names** (never values) of missing
critical secrets:

```bash
curl.exe -s https://social-media-cross-poster.chicago-reno.workers.dev/health
```

- `status: ok` → all critical secrets present.
- `status: degraded` with `missingEnv: [...]` → set each named secret (step 2).
- `checks.db: error` → D1 binding/migrations problem (see step 5).
- `checks.gmail: missing` → Gmail enrichment secrets absent (optional feature).

## 2. Verify worker secrets

```bash
cd worker
npx wrangler secret list
```

Compare against the **required** set (see `worker/wrangler.toml` lines 34–55).
Critical secrets surfaced by `/health` `missingEnv`:

- `AI_TEXT_API_KEY`
- `CHANNEL_ENCRYPTION_KEY`
- `FB_PAGE_ACCESS_TOKEN`
- `IG_BUSINESS_ACCOUNT_ID`
- `JOBBER_CLIENT_ID`
- `JOBBER_CLIENT_SECRET`
- `JOBBER_ACCESS_TOKEN`
- `JOBBER_REFRESH_TOKEN`

Also required (not in the `/health` critical list but needed for specific
features): `INSTAGRAM_CLIENT_ID`, `INSTAGRAM_CLIENT_SECRET` (OAuth connect flow
only — direct-token publishing does not need them), `JOBBER_WEB_EMAIL`,
`JOBBER_WEB_PASSWORD`, `CLOUDFLARE_ACCOUNT_ID`,
`CLOUDFLARE_API_TOKEN`, `GITHUB_PAT`, and (optional) `GMAIL_CLIENT_ID`,
`GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`.

Set any missing one with:

```bash
npx wrangler secret put <NAME>
```

## 3. Reported error #2 — image generation

- Ensure `AI_TEXT_API_KEY` is set (step 2). With it missing, `POST
  /api/media/generate` now **fails fast** with a clear message instead of
  hanging the client ~3 minutes.
- Ensure the OpenAI **organization is verified** for `gpt-image-1` — unverified
  orgs get a `403` ("organization must be verified"). The queue consumer now
  treats this as a permanent error and reports the real reason.
- If org verification isn't possible, fall back to `dall-e-3` (follow-up code
  change in `worker/src/services/image-generator.ts`).

Verify after deploy: generate an image in Quick Post; on failure the toast now
shows the real reason (missing key / quota / verification) within seconds.

## 4. Reported error #1 — Jobber cookie refresh

- The dispatch target is now `bendstaples7/chicago-reno-social-generator` (was
  the wrong `bendstaples7/Cotiza`), read from the `GITHUB_REPO` var in
  `wrangler.toml`. No action needed unless you fork/rename the repo.
- Ensure `GITHUB_PAT` (with **workflow** scope) is set on the worker so the
  "Refresh Cookies" button can dispatch the workflow.
- Ensure GitHub Actions secrets exist for
  `.github/workflows/refresh-jobber-cookies.yml`: `JOBBER_WEB_EMAIL`,
  `JOBBER_WEB_PASSWORD`, `CLOUDFLARE_API_TOKEN` (Browser Rendering), and
  `CLOUDFLARE_ACCOUNT_ID`.

Verify: click "Refresh Cookies". A 404 now returns a diagnostic `detail`
snippet and a hint naming the repo/workflow.

## 5. Migrations (D1) — reconcile before renumbering

There are currently **two** migrations numbered `0065`
(`0065_add_client_name_property_address.sql` and `0065_deposit_payments.sql`).
A guard test (`tests/unit/migrations-unique-number.test.ts`) allows this single
known duplicate and fails on any *new* one. Renumbering is deferred until the
production ledger is confirmed, because renaming an already-applied migration
makes wrangler re-run it (and the non-idempotent `ALTER`s would then fail).

Check whether the 0064/0065 migrations are recorded as applied and whether their
columns already exist:

```bash
cd worker
npx wrangler d1 migrations list cross-poster-db --remote
npx wrangler d1 execute cross-poster-db --remote --command "PRAGMA table_info(quote_drafts)"
npx wrangler d1 execute cross-poster-db --remote --command "SELECT name FROM d1_migrations ORDER BY id"
```

Then, depending on what you find:

- **Neither 0065 file is recorded as applied** → safe to renumber. Rename the
  newer file `0065_add_client_name_property_address.sql` → `0067_...sql`, then
  remove `'0065'` from `KNOWN_PENDING_DUPLICATES` in
  `tests/unit/migrations-unique-number.test.ts` so the guard becomes strict.
- **A 0065 file is recorded as applied** → do **not** rename it. Instead leave
  the filename and (if needed) make the `ALTER`s idempotent / mark the duplicate
  applied manually, keeping the allowlist entry.
- **A column already exists but the migration isn't recorded** → insert the
  migration row manually so `migrations apply` skips it on the next deploy.

## 6. Instagram publishing

- Confirm the R2 bucket `chicago-reno-media` is publicly served at
  `S3_PUBLIC_URL` (`https://pub-...r2.dev`); the Graph API must fetch image URLs.
  Storage keys are now URL-encoded, so filenames with spaces work.
- Confirm `FB_PAGE_ACCESS_TOKEN`, `IG_BUSINESS_ACCOUNT_ID`, and
  `CHANNEL_ENCRYPTION_KEY` are set (direct-token mode is the working path).
- Hashtags now post with a leading `#`; empty-media posts fail with a clear
  message; Graph API errors are wrapped in friendly text.

## 7. Deploy & final verification

Production deploys from `main` via `.github/workflows/deploy-worker.yml`. After
merging this branch:

```bash
curl.exe -s https://social-media-cross-poster.chicago-reno.workers.dev/health
```

Expect `{"status":"ok","checks":{"env":"ok","gmail":"ok","db":"ok"}}` (no
`missingEnv`). Then smoke-test: generate an image, refresh Jobber cookies, and
publish a test Instagram post.

## 8. Prevention guardrails added on this branch

Three layers now make the two reported failures (cookie refresh + image
generation) much harder to ship again:

### a. Post-deploy health gate + pipeline smoke test (CI)

`.github/workflows/deploy-worker.yml` now:

- **Parses the `/health` JSON** after deploy and fails the job when `status` is
  not `ok` (the old step only checked for HTTP 200, so a `degraded` worker with
  missing secrets still passed). The failing run prints the `missingEnv` names.
- Runs an optional **pipeline smoke test** against the new guarded endpoint
  `GET /health/pipelines`, which does read-only connectivity probes:
  - OpenAI — can the API key see the image model? (catches missing/invalid key)
  - GitHub — does the cookie-refresh workflow exist and can the PAT read it?
    (directly catches the wrong-repo / missing-scope class)
  - Instagram — can the Page token read the business account?

  **To enable the smoke test** (otherwise it is skipped, non-fatally): pick a
  random key and set it in all three places —
  `wrangler secret put HEALTHCHECK_KEY` (worker), a GitHub Actions **repo
  secret** named `HEALTHCHECK_KEY`, and (for local use) `.dev.vars`. Probe it
  manually with:

  ```bash
  curl.exe -s -H "X-Health-Key: <key>" https://social-media-cross-poster.chicago-reno.workers.dev/health/pipelines
  ```

### b. Integration tests at the external HTTP boundary

`tests/integration/*` drive each pipeline through a mocked `fetch`
(`tests/helpers/fetch-mock.ts`) using **real success AND failure response
shapes**: image generation (permanent 403 vs transient 500 vs missing key),
Instagram publish (success, Graph error, empty media), the Jobber orphan-quote
guard, the cookie-refresh dispatch (correct repo, 404, missing PAT), and the
health probes. These run in `npm test` (the CI gate).

### c. Central config + lint guards

- `worker/src/config.ts` is the single source of truth for external identifiers
  (GitHub repo slug + API base, OpenAI/Graph URLs and model names) and for the
  list of critical secrets used by `/health`.
- `npm run lint` (also a CI step) enforces two regression guards via
  `eslint.config.mjs`: no hardcoded GitHub repo slug outside `config.ts`, and no
  raw `throw new Error()` in routes / the queue consumer (use `PlatformError`).

## Flagged follow-ups (not changed in this pass — need a decision)

- Add `write:quotes` + `read:requests` to the Jobber OAuth scope string
  (requires re-auth).
- Instagram OAuth-mode token exchange stores the Basic-Display account id while
  publishing via the Graph API; direct-token mode is the working path.
- The artificial 60-day expiry applied to non-expiring Page tokens.
