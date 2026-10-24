# Jobber subscription receipts → Google Drive

Downloads the original paid USD subscription PDF from Jobber Account and Billing → Payment history,
then saves it in the configured Chicago Reno Google Drive folder. GitHub Actions is the scheduler;
Google Drive is the document archive. No receipts, manifests, financial amounts, or Google tokens
are uploaded to GitHub artifacts, caches, or commits. Normal runner logs contain counts only.

## Current status
Implementation and 18 local Node tests pass. The destination folder has been created and verified
using the office Drive connector. The standalone authenticated download/upload has NOT run live.
The workflow remains disabled until Google authorization, a manual live run, and activation.
The authoring session reached Google's account-verification screen for office@chicago-reno.com;
the user must complete that sign-in before Google Cloud OAuth setup can continue.

## Commands
From repository root after npm ci:
```powershell
node --test tests/unit/subscription-receipts.test.mjs tests/unit/subscription-drive.test.mjs
node scripts/jobber-subscription-receipts.mjs --month 2026-10 --out subscription-receipt-output
node scripts/upload-subscription-receipts.mjs subscription-receipt-output
```
The downloader reads the existing Jobber web session from remote D1 using Wrangler and
CLOUDFLARE_API_TOKEN. If stale, reuse worker/scripts/sync-cookies.mjs --target remote from worker/.
No Jobber credentials are returned to callers. Amounts are read from the billing page, not fixed at $169.
Portal dates may differ from the Chicago card charge date. Do not automatically alter expense dates.

## Google authorization (one-time, still required)
ChatGPT's Drive connector does not supply reusable credentials to GitHub Actions. Cotiza's existing
Gmail token is read-only and must not be reused as a Drive token.
Configure a separate user OAuth grant for office@chicago-reno.com. Prefer the drive.file scope.
The existing destination folder must be explicitly granted to that OAuth app through Google Picker;
entering its ID alone does not grant drive.file access. If Picker is unavailable, stop for a deliberate
authorization decision rather than silently requesting access to all Drive files.
Use an internal/production OAuth configuration appropriate for this Workspace; do not rely on a
testing-mode refresh token that may expire. Enable Drive API in the chosen Google Cloud project.
Store client ID, client secret and refresh token only in GitHub Actions secrets:
- JOBBER_DRIVE_CLIENT_ID
- JOBBER_DRIVE_CLIENT_SECRET
- JOBBER_DRIVE_REFRESH_TOKEN

Never place OAuth tokens in chats, source, workflow inputs, logs or documents.
Set the repository variable JOBBER_RECEIPTS_DRIVE_FOLDER_ID to the verified destination folder ID.
The uploader supports both My Drive folders and shared-drive folders, preserving inherited access.
It does not create permissions, share files, change ownership, delete, or overwrite receipts.
Keep JOBBER_RECEIPTS_DRIVE_ENABLED unset/false while this setup is incomplete.

## Scheduling and activation
The workflow checks on days 24–28 at 15:00 UTC, with a manual month input available.
Only bendstaples7/Cotiza main can run financial steps, and only when
JOBBER_RECEIPTS_DRIVE_ENABLED=true. No PR or fork run can run them.
After review/merge, configure authorization, enable the variable, and dispatch a manual current-month
run. Confirm its PDF in Drive and verify a second run skips the same receipt. Then leave the schedule
enabled. A GitHub workflow schedule is the recurring automation; do not create a duplicate ChatGPT task.
The destination folder is year-labelled by its parent; this workflow continues saving into its configured
folder until intentionally changed rather than silently moving financial documents at year-end.

## Integrity and retry behavior
Downloaded files have payment-date and transaction-ID names and SHA-256 checksums in a local manifest.
All local PDFs are validated before upload. Drive is searched within the designated folder, then an
existing identical file is skipped. A same-name checksum conflict or ambiguous duplicates fail.
New files are verified by reading metadata back and comparing parent, MIME type, size and MD5.
No uncertain create is automatically retried: a later run searches for the result first.
GitHub concurrency prevents overlapping workflow writes. Local concurrent executions are not supported.
PDFs are limited to 5 MB for multipart upload; unusually large receipts require a deliberate resumable
upload implementation. Temporary runner files are removed in an always-run cleanup step.
A failed delivery does not count as successful archival. This workflow does not log Jobber expenses,
attach receipts to expenses, send emails, or initiate payments.

## Validation
18 Node tests cover month selection, multiple payments, unpaid/non-USD records, allowed download
destinations, HTML/truncated PDF rejection, local and remote duplicates, checksum conflicts,
incomplete Drive listings, path traversal, OAuth refresh errors, My Drive support, sensitive-output
redaction and browser cleanup. The live Jobber receipt button and invoice #4106309 were inspected;
headless/D1 access and authenticated Drive delivery still need a successful end-to-end run.
