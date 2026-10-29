# Refreshing the Jobber web session by hand

Cotiza reads customer request form answers through Jobber's website session, not the public API (see `.kiro/steering/jobber-session-rules.md`). Normally the session is kept fresh automatically:

- A Cloudflare cron (`worker/src/scheduled/jobber-session-keepalive.ts`, every 30 minutes) checks the stored session with Jobber and extends it while it still works.
- The `refresh-jobber-cookies.yml` GitHub workflow logs in again when it doesn't. Jobber's login captcha often blocks GitHub's servers, so this login can fail.

When the app shows the Jobber session gate, or the ops assistant reports `jobber_web_session_unavailable`, log in from a home PC instead. Home internet connections rarely get the captcha.

## Windows steps

Needs Git and Node.js 20+, plus a Cloudflare API token with **Account > D1 > Edit** on the Chicago Reno account (Cloudflare dashboard > My Profile > API Tokens).

1. Get the code (first time only), or update it:

   ```powershell
   git clone https://github.com/bendstaples7/Cotiza.git $HOME\Cotiza
   ```

   ```powershell
   git -C $HOME\Cotiza pull --ff-only
   ```

2. Install dependencies and the browser the login script drives (first time, or after dependency changes):

   ```powershell
   cd $HOME\Cotiza; npm ci; npx puppeteer browsers install chrome
   ```

3. Run the login with the secrets set for this window only. The prompts hide what you type:

   ```powershell
   cd $HOME\Cotiza\worker
   $env:JOBBER_WEB_EMAIL = Read-Host 'Jobber login email'
   $env:JOBBER_WEB_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR((Read-Host 'Jobber password' -AsSecureString)))
   $env:CLOUDFLARE_API_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR((Read-Host 'Cloudflare API token' -AsSecureString)))
   node scripts/sync-cookies.mjs --target remote
   Remove-Item Env:JOBBER_WEB_EMAIL, Env:JOBBER_WEB_PASSWORD, Env:CLOUDFLARE_API_TOKEN
   ```

4. Check the result line:
   - `[sync-cookies] Done. Cookies written to remote D1.` means the new session is saved.
   - `[sync-cookies] Valid cookies found in remote D1. Skipping.` means the stored session already works.
   - Anything else: read the `[sync-cookies]` error lines. If Jobber shows a captcha, set `headless: false` in `scripts/sync-cookies.mjs` for that run only (don't commit it), solve the captcha in the browser window, and let the script finish. The script waits only about 30 seconds after the login button is pressed, so solve it quickly or rerun.

Reload Cotiza afterwards; the session gate should clear.
