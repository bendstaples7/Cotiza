# Operations assistant (read-only)

An authenticated assistant can read Chicago Reno’s Jobber requests and quotes through Cotiza. Jobber’s own login stays on the server. The assistant never sees Jobber tokens, and it cannot create, edit, send, or delete records.

Checked against OpenAI’s docs on 13 Oct 2026:

- [Add a custom MCP server](https://developers.openai.com/api/docs/guides/custom-mcp-server) — ChatGPT connects to a remote MCP server over **SSE or streaming HTTP**.
- [MCP servers](https://developers.openai.com/api/docs/guides/tools-connectors-mcp) — the API connects with a server URL (or a tunnel).
- [Plugin authentication](https://developers.openai.com/plugins/build/auth) — an authenticated server uses **OAuth 2.1** with **PKCE S256**, protected-resource metadata, and authorization-server metadata.

## Connection we ship

| Piece | Choice |
| --- | --- |
| Transport | Streaming HTTP at `POST /mcp`. One JSON response per call. `GET /mcp` returns 405 because this server does not push messages. |
| Assistant login | Separate from Jobber. Scope is only `ops:read`. |
| ChatGPT | OAuth authorization-code + PKCE. Public client (`token_endpoint_auth_method=none`). Dynamic client registration is limited to ChatGPT redirect URLs. |
| Local exercise | Mint a bearer token with your existing Cotiza session, then run `scripts/ops-assistant-exercise.mjs`. |
| Jobber | The worker reuses `openJobberIntegration` (saved Jobber tokens in D1 / worker secrets). |

Send `Accept: application/json, text/event-stream` on every MCP call. A missing or revoked token gets **401** and a `WWW-Authenticate` header pointing at `/.well-known/oauth-protected-resource`.

Tokens are stored as a hash. They expire (access: 1 hour, refresh: 30 days). Revoke one with `DELETE /api/assistant/tokens/:id` while logged into Cotiza, or `POST /oauth/revoke`. Each token is tied to one Cotiza user and one site (`https://that-host/mcp`). Draft lookups use that user id. Jobber data is the one company account already connected to Cotiza.

Each tool call reads at most one Jobber page (10 rows by default, 20 max) and at most 30 calls a minute per token. Customer, title, date, and status filters run **on that page only**. The result says so. A later page can still hold a match.

Notes and quote messages are marked untrusted. Attachment **download URLs are not returned**.

A Jobber failure uses the same read contract as the rest of Cotiza (`docs/jobber-read-contract.md`): `read.status` is `failed`, `read.liveLookupFailed` is true, and `read.error.code` is one of `auth`, `timeout`, `throttled`, `graphql`, `network`, or `unavailable`. An empty page is `read.status: "empty"` with `liveLookupFailed: false`. A missing id is `outcome: "not_found"` and is not a failed read. The error text sent to the assistant is shortened and scrubbed.

## Tools

- `find_requests` — customer, title, status, dates, cursor
- `read_request` — one request, notes, attachment names
- `find_quotes` — client, quote number, status, cursor
- `read_quote` — one quote and its line items
- `list_request_quotes` — Jobber quotes for a request, plus **this user’s** Cotiza drafts for that request

There is no tool that writes.

## Jobber permissions (do not change them for this release)

Jobber’s public docs say scopes are set on the app in the Developer Center and shown on Jobber’s Allow Access screen. The pages checked on 13 Oct 2026 do **not** publish a fixed list of scope ids. This change does **not** edit the Jobber app and does **not** re-authorize production.

Before you trust a live answer, open the existing app and confirm it can **read** requests, quotes, and clients (the fixed queries ask for those). Leave write scopes as they already are. Do not add write scopes for this assistant.

If a tool returns `read.error.code` of `auth`, Jobber refused the read. That is not an empty list.

How to look (do not click Save):

1. Sign in to Jobber as an admin.
2. Open **Settings** (gear) → **Developer Center** (or go to [developer.getjobber.com](https://developer.getjobber.com/docs/)).
3. Open **Manage Apps** and the app Cotiza already uses.
4. Read the scopes list. You want read access for requests, quotes, and clients.
5. Close the page without changing scopes.

## What is tested with a fake Jobber

`tests/unit/ops-assistant.test.ts` mocks Jobber. It covers rejected tokens, the code-for-token exchange, refresh, revoke, the user boundary on drafts, bad input, page tokens, failed reads versus empty reads, and a sample request plus its quotes. Those tests do **not** prove the live Jobber account works.

A local run of `scripts/ops-assistant-exercise.mjs` on 13 Oct 2026 did use the real Jobber connection already stored for Cotiza. It exchanged an authorization code for a token, refreshed that token, listed the five tools, read a live request (notes and an attachment name, no download link), listed the quotes on a request that has one quote, read that quote, and then showed the revoked token rejected with 401. That run is not repeated by the unit tests. Production was not deployed, and Jobber permissions were not changed.

## Local exercise

1. Apply the new table to your **local** database only (migration `0068_assistant_access.sql`):

   ```bash
   npx wrangler d1 migrations apply DB --local
   ```

   Run that from the `worker` folder. Do not add `--remote` as part of this work.

2. Start the worker the way you usually do (`npm run dev:worker` from the repo root).

3. Run the same sign-in ChatGPT uses (authorization code and PKCE), then read one live request and its quotes. The script prints counts only. It does not print the token or customer notes.

   ```powershell
   $env:OPS_ASSISTANT_BASE_URL = "http://127.0.0.1:8787"
   $env:OPS_ASSISTANT_EMAIL = "you@chicago-reno.com"
   node scripts/ops-assistant-exercise.mjs
   ```

   Set `OPS_ASSISTANT_REQUEST_ID` to read a specific request. Leave it unset to use the first request on the live page. The script has no Jobber credentials. The worker uses the Jobber connection it already has.

## ChatGPT

1. Deploy only when you mean to (this implementation does not deploy).
2. In ChatGPT: **Plugins → plus → Add custom MCP server**.
3. Server URL: `https://YOUR-WORKER/mcp`
4. Authentication: **OAuth** (not “No authentication”).
5. ChatGPT will read `/.well-known/oauth-protected-resource`, register a client, and send the user to `/oauth/authorize`.
6. Sign in with a `@chicago-reno.com` email and choose **Allow read access**.

The OAuth screens are served by the worker. They are not the main Cotiza app.

## Deploy later (not part of this change)

From `worker`, when you are ready:

```bash
npx wrangler d1 migrations apply DB --remote
npx wrangler deploy
```

No new secret is required. Jobber keys stay the secrets you already have. Do not change Jobber scopes as part of the deploy.

Jobs, schedules, invoices, expenses, and any assistant write tools are later work.
