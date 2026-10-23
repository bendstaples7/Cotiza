# Weekly payout reports
Generate Chicago Reno payout reports with the Jobber OAuth connection already stored by Cotiza. No Jobber browser session or new Jobber login is needed.

## API
POST /api/reports/weekly with the existing Cotiza session bearer token and JSON:
```json
{"start":"2026-10-17","end":"2026-10-23"}
```
Only the office@chicago-reno.com account can call this route. The old ops:read MCP grant does not gain financial record access or email permissions. Periods are limited to 31 days; reads stop with an error rather than returning partial data after 50 pages per collection. All source collections must succeed.

The response contains complete:true, period, summary, expense and transaction rows, two CSV files, source and limitations. API-level schema/permission failures are explicit errors. Tokens stay server-side. No email is sent by the route.

The reports are **Cotiza API reports, not native Jobber exports**. One row represents each payment record; native exports may split a receipt across invoice allocations. Keep source IDs, API signs and adjustment types. Invoice rows are not cash receipts. Processor status/fees do not establish bank settlement. Equal-valued source records with different IDs remain separate; repeated IDs or stuck pagination fail.

Expense reports preserve Entered by, Paid by and Reimbursable to separately, plus original descriptions, IDs and job references. Do not infer personal-card payment merely from an entry user's name. Do not invent missing expense categories. Null financial amounts fail rather than becoming zero. CSV text cells are protected against spreadsheet formula injection.

## Script and email handoff
`scripts/weekly-payout-reports.mjs` exports runWeeklyReports. Supply a current Cotiza session and reporting dates. In the assistant workflow, bind its sendEmail callback to the connected **office Gmail** send action. The destination is fixed to office@chicago-reno.com. The callback receives Gmail's structured subject/to/MIME payload, with both CSVs attached. It is invoked once, only after complete generation.

Cotiza's Gmail refresh token is documented as read-only. This workflow does not extract that token, expand its scopes or pretend it can send. Existing ChatGPT Gmail credentials remain with the Gmail connector.

For a local generation-only run:
```powershell
# COTIZA_SESSION_TOKEN must come from your existing Cotiza login; do not paste it into chat.
node scripts/weekly-payout-reports.mjs --start 2026-10-17 --end 2026-10-23 --out weekly-report-output
```
The CLI saves both CSVs and email-payload.json. It does not send mail itself. The assistant can hand that payload directly to its connected office Gmail send action. Verify report totals against available source evidence before sending. Never retry an uncertain send without checking Gmail first.

No recurring schedule is installed. This is an on-demand report generation and connected-Gmail delivery workflow. Reconciliation remains necessary before proposing payments. Mark source emails read only after reconciliation, using the Gmail connector.

## Validation
Unit coverage includes permissions, invalid periods, failed/incomplete reads, pagination, duplicate source IDs, equal-valued legitimate expenses, refund signs, reimbursement identity, CSV escaping and Chicago date boundaries. The script's Node tests verify both attachments and the fixed recipient, reject foreign destinations and incomplete generation, and ensure uncertain sends are not retried. Live totals must also be compared with source exports.
