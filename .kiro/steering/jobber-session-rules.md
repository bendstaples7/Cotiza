---
description: Critical rules for Jobber session cookie handling and login gating
category: Integrations
---

# Jobber Session Cookie Rules

## Jobber API Limitations (Critical)

The Jobber public GraphQL API is **incomplete**. The following data is NOT available through the public API and requires Jobber web session cookies (internal API access):

- **`requestDetails.form`** — The actual form submission data that customers fill out when submitting a request through Jobber's online booking form. This includes text inputs, multiple-choice answers, date fields, and other structured form data. This is the primary source of customer request details for many requests.

The public API only exposes `notes` and `noteAttachments` on requests. For requests where the customer submitted a form but no team member manually added notes, the public API returns **no content** — even though the form data exists in Jobber's system.

**The `JobberWebSession` service and the cookie refresh system exist specifically to work around this limitation.** Do NOT remove this system unless Jobber adds `requestDetails.form` to their public API. Any proposal to simplify the Jobber integration by removing the cookie system must account for this gap — the public API alone is insufficient for the quote generation workflow.

How cookies are kept fresh:
- **Login:** `.github/workflows/refresh-jobber-cookies.yml` runs `worker/scripts/sync-cookies.mjs` (Puppeteer on a GitHub runner) and writes cookies to production D1. It is also triggered on demand by `POST /api/jobber-auth/trigger-cookie-refresh`.
- **Keep-alive:** a Cloudflare cron (`worker/src/scheduled/jobber-session-keepalive.ts`, every 30 minutes) asks Jobber whether the stored cookies still work using a plain API call. If they do, it extends `expires_at` and saves any rotated cookies; if Jobber rejects them, it clears them so the blocking gate shows. The 4-hour `expires_at` written at login is a local estimate, not Jobber's real session lifetime.
- `JobberCookieRefresher` (Cloudflare Browser Rendering login) is NOT used: Jobber's Auth0 login page shows a captcha to Cloudflare's browsers. Do not wire it back in without solving that.

## Jobber Session Cookies Are a BLOCKING Gate

The systems check at login verifies Jobber session cookies are valid. **If cookies are expired or missing, the user MUST be blocked from entering the app.** This is by design — the app is completely unusable without working session cookies because customer request form data cannot be fetched.

- The `jobber_session_expired` state in `AuthContext` MUST render a blocking overlay in `Layout.tsx`, NOT a dismissible banner.
- Do NOT make this check skippable, non-blocking, or optional.
- Do NOT downgrade this to a warning banner based on code review suggestions about "legacy gating" or "non-critical checks."
- The Jobber session check has the same criticality as the Jobber OAuth check — both are hard requirements.
