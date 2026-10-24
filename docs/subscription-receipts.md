# Jobber subscription receipt downloader

Downloads the original paid USD subscription PDF from Account and Billing → Payment history.
This is separate from weekly-payout-reports.mjs: weekly CSVs use public OAuth data;
subscription receipts use Cotiza's existing authenticated Jobber web session.

## Run
From the repository root, after npm ci:
```powershell
node --test tests/unit/subscription-receipts.test.mjs
node scripts/jobber-subscription-receipts.mjs --month 2026-10 --out subscription-receipt-output
```
The CLI reads the existing remote D1 session using Wrangler and CLOUDFLARE_API_TOKEN.
It does not ask for cookies in chat, export credentials, change billing, send email,
create expenses or initiate payments. Run worker/scripts/sync-cookies.mjs --target remote
from the worker directory if the existing session needs refreshing.

Each PDF is named by the portal payment date and transaction ID. Reruns validate and skip
existing files. Multiple paid subscription receipts in a month remain distinct.
Amounts are read from the live page, not hardcoded to $169.
manifest.json contains the selected month's filenames, amounts and SHA-256 hashes.
Portal dates can differ by a day from Chicago charge dates; do not change expense dates
solely to match the billing portal.

## Automatic runs
The included GitHub workflow runs on days 24–28 at 15:00 UTC after the usual renewal
and also supports a manual month input. It reuses the same GitHub secrets as the existing
cookie refresh workflow. The schedule becomes active only after merge to the default branch.
Each run downloads all receipts for that month, restoring prior PDFs from a private Actions
cache to skip duplicates. Artifacts retain the original PDFs and manifest for 90 days.
Cache eviction only causes safe re-downloads. Artifacts are not a permanent bookkeeping archive.
A failed or unavailable receipt causes a failed run; it is never replaced by a fabricated PDF.
GitHub workflow failure notifications use the repository's existing notification preferences.

## Validation and remaining live check
Node tests exercise month selection, multiple payments, invalid formats, unpaid receipts,
destination restrictions, HTML/truncated PDF rejection, file deduplication, session redaction,
and browser cleanup on login redirects.
The live Jobber page was inspected: payment rows use dt/dd, paidInvoice, and Receipt buttons;
the October Receipt button opens the verified download_invoice/transaction path.
The standalone authenticated runner still needs its first GitHub Actions run to validate D1
access, headless Jobber access and the current PDF response headers end to end.
No Jobber credentials were available to execute that runner locally in the authoring session.
