/**
 * Syncs Jobber web session cookies to local and/or production D1.
 *
 * Usage:
 *   node sync-cookies.mjs [--target local|remote|both]
 *
 * --target local   : Check local D1 → if expired, try sync from remote → if still expired, login → write to local only
 * --target remote  : Check remote D1 only → if expired, login → write to remote only
 * --target both    : (default) Check local D1 → if expired, try sync from remote → if still expired, login → write to both
 *
 * Credentials are read from .dev.vars first, then fall back to
 * process.env.JOBBER_WEB_EMAIL and process.env.JOBBER_WEB_PASSWORD.
 *
 * Exit codes:
 *   0 — cookies refreshed or already valid
 *   1 — failure (login failed, validation failed, timeout, missing credentials)
 */
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

/**
 * Parse --target from process.argv. Returns 'local', 'remote', or 'both'.
 * Defaults to 'both' when the flag is absent or the value is unrecognised.
 */
export function parseTarget(args) {
  const idx = args.indexOf('--target');
  if (idx === -1 || idx + 1 >= args.length) return 'both';
  const value = args[idx + 1];
  if (['local', 'remote', 'both'].includes(value)) return value;
  throw new Error(`Invalid --target value '${value}'. Must be 'local', 'remote', or 'both'.`);
}

/**
 * Read credentials from .dev.vars first, then fall back to environment variables.
 * Returns { email, password } or null if neither source has them.
 */
export function readCredentials() {
  // Try .dev.vars first
  try {
    const content = readFileSync('.dev.vars', 'utf8');
    const vars = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      vars[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
    }
    if (vars.JOBBER_WEB_EMAIL && vars.JOBBER_WEB_PASSWORD) {
      return { email: vars.JOBBER_WEB_EMAIL, password: vars.JOBBER_WEB_PASSWORD };
    }
  } catch {
    // .dev.vars not available — fall through
  }

  // Fall back to environment variables (CI environment)
  const email = process.env.JOBBER_WEB_EMAIL;
  const password = process.env.JOBBER_WEB_PASSWORD;
  if (email && password) {
    return { email, password };
  }

  return null;
}

// ---------------------------------------------------------------------------
// D1 cookie operations
// ---------------------------------------------------------------------------

/**
 * Check if valid (non-expired) cookies exist in the given D1 target.
 * Returns { valid: true, cookies, expiresAt } or { valid: false }.
 */
function checkCookies(location) {
  const flag = location === 'remote' ? '--remote' : '--local';
  try {
    const result = run(
      `npx wrangler d1 execute DB ${flag} --json --command "SELECT cookies, expires_at FROM jobber_web_session WHERE id = 'default'"`
    );
    const parsed = JSON.parse(result);
    const rows = parsed[0]?.results || [];
    if (rows.length > 0) {
      const expiresAt = new Date(rows[0].expires_at).getTime();
      if (Date.now() < expiresAt) {
        return { valid: true, cookies: rows[0].cookies, expiresAt: rows[0].expires_at };
      }
    }
  } catch {
    // Table may not exist or query failed
  }
  return { valid: false };
}

/**
 * Write cookies to the specified D1 target(s).
 * `target` can be 'local', 'remote', or 'both'.
 */
function writeCookies(cookieString, expiresAt, target) {
  const escapedCookies = cookieString.replace(/'/g, "''");
  const sql = `INSERT INTO jobber_web_session (id, cookies, expires_at, updated_at) VALUES ('default', '${escapedCookies}', '${expiresAt}', datetime('now')) ON CONFLICT (id) DO UPDATE SET cookies = excluded.cookies, expires_at = excluded.expires_at, updated_at = excluded.updated_at;`;

  const targets = target === 'both' ? ['local', 'remote'] : [target];

  for (const loc of targets) {
    const flag = loc === 'remote' ? '--remote' : '--local';
    const tmpFile = join(tmpdir(), `sync-cookies-${loc}-${Date.now()}.sql`);
    try {
      writeFileSync(tmpFile, sql, 'utf8');
      run(`npx wrangler d1 execute DB ${flag} --file "${tmpFile}"`);
      console.log(`[sync-cookies] Cookies written to ${loc} D1.`);
    } catch (err) {
      if (target === 'both') {
        // When target is 'both', don't fail the whole script if one target fails
        // (e.g. remote table doesn't exist yet because migrations haven't been deployed)
        console.warn(`[sync-cookies] WARNING: Failed to write cookies to ${loc} D1: ${err.message || err}`);
      } else {
        throw err;
      }
    } finally {
      try { unlinkSync(tmpFile); } catch { /* ignore cleanup errors */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Puppeteer login & cookie extraction
// ---------------------------------------------------------------------------

async function loginAndExtractCookies(email, password) {
  const puppeteer = await import('puppeteer');
  const browser = await puppeteer.default.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);

    await page.goto('https://secure.getjobber.com/login', { waitUntil: 'networkidle2', timeout: 60000 });

    // Wait for any visible input field on the login page
    await page.waitForSelector(
      'input[name="username"], input[name="email"], #username, input[type="text"], input[type="email"]',
      { visible: true, timeout: 30000 }
    );

    const usernameField = await page.$('#username') || await page.$('input[name="username"]') || await page.$('input[type="text"]') || await page.$('input[type="email"]');
    const passwordField = await page.$('#password') || await page.$('input[name="password"]') || await page.$('input[type="password"]');

    if (!usernameField || !passwordField) {
      throw new Error('Could not find login form fields on the Jobber login page.');
    }

    await usernameField.type(email, { delay: 50 });
    await passwordField.type(password, { delay: 50 });

    const submitBtn = await page.$('button[type="submit"]') || await page.$('button[name="action"]');
    if (submitBtn) {
      await submitBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });

    const url = page.url();
    if (url.includes('login')) {
      throw new Error('Login failed — still on login page after form submission. Credentials may be invalid or login was rejected.');
    }

    // Extract ALL cookies via CDP
    const client = await page.createCDPSession();
    const { cookies: allCookies } = await client.send('Network.getAllCookies');

    const jobberCookies = allCookies.filter(c =>
      c.domain.includes('getjobber.com') || c.domain.includes('jobber.com')
    );

    const cookieString = jobberCookies.map(c => `${c.name}=${c.value}`).join('; ');
    console.log(`[sync-cookies] Login successful, extracted ${jobberCookies.length} cookies.`);

    return cookieString;
  } finally {
    await browser.close();
  }
}

/**
 * Validate cookies by making a test request to the Jobber internal API.
 * Throws on failure.
 */
async function validateCookies(cookieString) {
  const testResp = await fetch('https://api.getjobber.com/api/graphql?location=j', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookieString,
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({ query: '{ account { id } }' }),
  });
  if (!testResp.ok) {
    throw new Error(`Cookie validation failed: HTTP ${testResp.status}`);
  }
  const testData = await testResp.json();
  if (testData?.errors?.length > 0) {
    throw new Error(`Cookie validation failed: ${testData.errors[0]?.message}`);
  }
  if (!testData?.data?.account?.id) {
    throw new Error('Cookie validation failed: no account data returned (cookies may not be authenticated)');
  }
  console.log('[sync-cookies] Cookie validation passed.');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const target = parseTarget(process.argv);
  console.log(`[sync-cookies] Target: ${target}`);

  // ---- Step 1: Check if target store(s) already have valid cookies --------

  if (target === 'remote') {
    // Remote-only: check remote D1
    const remote = checkCookies('remote');
    if (remote.valid) {
      console.log('[sync-cookies] Valid cookies found in remote D1. Skipping.');
      return;
    }
  } else {
    // 'local' or 'both': check local D1 first
    const local = checkCookies('local');
    if (local.valid) {
      console.log('[sync-cookies] Valid cookies found in local D1. Skipping.');
      return;
    }

    // Local cookies expired/missing — try syncing from remote
    const remote = checkCookies('remote');
    if (remote.valid) {
      writeCookies(remote.cookies, remote.expiresAt, 'local');
      console.log('[sync-cookies] Synced valid cookies from remote D1 to local.');
      return;
    }
  }

  // ---- Step 2: No valid cookies anywhere — need to login ------------------

  const creds = readCredentials();
  if (!creds) {
    throw new Error('Credentials not available. Set JOBBER_WEB_EMAIL and JOBBER_WEB_PASSWORD in .dev.vars or as environment variables.');
  }

  console.log('[sync-cookies] No valid cookies found. Logging into Jobber...');

  const cookieString = await loginAndExtractCookies(creds.email, creds.password);
  await validateCookies(cookieString);

  // ---- Step 3: Write cookies to target store(s) ---------------------------

  const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
  writeCookies(cookieString, expiresAt, target);

  console.log(`[sync-cookies] Done. Cookies written to ${target} D1.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    let target = 'both';
    try {
      target = parseTarget(process.argv);
    } catch {
      console.error(`[sync-cookies] FATAL: ${msg}`);
      process.exit(1);
      return;
    }
    if (target === 'local' && /Could not find Chrome/i.test(msg)) {
      console.warn('[sync-cookies] Chrome not available — skipping cookie login for local dev.');
      process.exit(0);
      return;
    }
    console.error(`[sync-cookies] FATAL: ${msg}`);
    process.exit(1);
  });
