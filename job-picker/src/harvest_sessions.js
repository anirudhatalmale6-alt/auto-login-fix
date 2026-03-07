/**
 * Session Harvester — Logs in accounts via Playwright and extracts session data
 * (candidateId + accessToken + cookies) for the job picker.
 *
 * Flow:
 *   1. Read accounts from created_accounts.json (from auto_create) or config
 *   2. For each account: open browser → login → solve CAPTCHA → handle OTP
 *   3. After login: extract candidateId + accessToken + cookies from localStorage
 *   4. Save sessions to job-picker/config.json
 *   5. Keep browsers alive, re-harvest tokens every 2 hours
 *
 * Usage:
 *   node src/harvest_sessions.js [accounts_file.json]
 *
 * Accounts file format (same as created_accounts.json):
 *   [{ "email": "kp65619+78@email.com", "pin": "112233" }, ...]
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { Configuration, NopeCHAApi } = require('nopecha');
const Imap = require('imap');

const LOG_FILE = fs.createWriteStream('harvest.log', { flags: 'a' });
function log(level, msg, tag = 'Harvest') {
  const line = `${new Date().toISOString()} [${level}] [${tag}] ${msg}`;
  console.log(line);
  LOG_FILE.write(line + '\n');
}

// ===== CAPTCHA SOLVER (from auto_login v7.1) =====
async function solveCaptcha(page, nopecha, tag) {
  if (!nopecha) { log('ERROR', 'NopeCHA not configured', tag); return false; }

  try {
    // Wait for CAPTCHA
    let found = false;
    try { await page.waitForSelector('#captchaModal', { timeout: 8000, state: 'attached' }); found = true; } catch (e) {}
    if (!found) {
      try { const waf = await page.$('awswaf-captcha'); if (waf) found = true; } catch (e) {}
    }
    if (!found) { log('INFO', 'No CAPTCHA found', tag); return true; }

    await page.waitForTimeout(2000);

    // Click audio button — try multiple strategies
    let audioClicked = false;

    // Strategy 1: Direct selectors
    for (const sel of ['#captchaModal #amzn-btn-audio-internal', '#amzn-btn-audio-internal']) {
      try {
        const btn = await page.$(sel);
        if (btn && await btn.isVisible().catch(() => true)) {
          await btn.click({ force: true, timeout: 5000 });
          log('INFO', `Audio clicked: ${sel}`, tag);
          audioClicked = true;
          break;
        }
      } catch (e) {}
    }

    // Strategy 2: Shadow DOM search
    if (!audioClicked) {
      try {
        const clicked = await page.evaluate(() => {
          function findInShadow(root) {
            const btn = root.querySelector('#amzn-btn-audio-internal');
            if (btn) { btn.click(); return true; }
            for (const el of root.querySelectorAll('*')) {
              if (el.shadowRoot && findInShadow(el.shadowRoot)) return true;
            }
            return false;
          }
          const waf = document.querySelector('awswaf-captcha');
          if (waf && waf.shadowRoot && findInShadow(waf.shadowRoot)) return 'shadow';
          for (const el of document.querySelectorAll('*')) {
            if (el.shadowRoot && findInShadow(el.shadowRoot)) return 'shadow-global';
          }
          return null;
        });
        if (clicked) { audioClicked = true; log('INFO', `Audio clicked via JS: ${clicked}`, tag); }
      } catch (e) {}
    }

    // Strategy 3: Text-based search
    if (!audioClicked) {
      try {
        const clicked = await page.evaluate(() => {
          function search(root) {
            for (const btn of root.querySelectorAll('button, [role="button"]')) {
              const t = (btn.textContent || '').toLowerCase();
              const a = (btn.getAttribute('aria-label') || '').toLowerCase();
              if (t.includes('audio') || a.includes('audio') || (btn.id || '').includes('audio')) {
                btn.click(); return btn.id || t.substring(0, 20);
              }
            }
            for (const el of root.querySelectorAll('*')) {
              if (el.shadowRoot) { const r = search(el.shadowRoot); if (r) return r; }
            }
            return null;
          }
          return search(document);
        });
        if (clicked) { audioClicked = true; log('INFO', `Audio clicked via text: ${clicked}`, tag); }
      } catch (e) {}
    }

    if (!audioClicked) { log('WARN', 'Audio button not found', tag); return false; }

    await page.waitForTimeout(3000);

    // Extract audio from Shadow DOM
    let audioData = null;
    for (let i = 0; i < 15; i++) {
      audioData = await page.evaluate(() => {
        function find(root) {
          for (const audio of root.querySelectorAll('audio')) {
            const src = audio.src || audio.currentSrc;
            if (src && src.startsWith('data:audio')) {
              const m = src.match(/^data:audio\/[^;]+;base64,(.+)$/);
              if (m) return m[1];
            }
            for (const s of audio.querySelectorAll('source')) {
              if (s.src && s.src.startsWith('data:audio')) {
                const m = s.src.match(/^data:audio\/[^;]+;base64,(.+)$/);
                if (m) return m[1];
              }
            }
          }
          for (const el of root.querySelectorAll('*')) {
            if (el.shadowRoot) { const r = find(el.shadowRoot); if (r) return r; }
          }
          return null;
        }
        const waf = document.querySelector('awswaf-captcha');
        if (waf && waf.shadowRoot) return find(waf.shadowRoot);
        return null;
      });
      if (audioData) break;
      await page.waitForTimeout(1000);
    }

    if (!audioData) { log('ERROR', 'No audio data found', tag); return false; }

    log('INFO', `Audio extracted (${audioData.length} chars)`, tag);

    // Solve with NopeCHA
    const result = await nopecha.solveRecognition({ type: 'awscaptcha', audio_data: [audioData] });
    const answer = Array.isArray(result) ? result[0] : result;
    log('INFO', `NopeCHA answer: "${answer}"`, tag);

    // Type answer
    await page.evaluate((ans) => {
      function findInput(root) {
        for (const inp of root.querySelectorAll('input[type="text"], input:not([type])')) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(inp, ans);
          inp.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          return true;
        }
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) { const r = findInput(el.shadowRoot); if (r) return r; }
        }
        return null;
      }
      const waf = document.querySelector('awswaf-captcha');
      if (waf && waf.shadowRoot) return findInput(waf.shadowRoot);
    }, answer);

    await page.waitForTimeout(500);

    // Click submit
    await page.evaluate(() => {
      function findSubmit(root) {
        for (const btn of root.querySelectorAll('button, [role="button"]')) {
          const t = (btn.textContent || '').toLowerCase().trim();
          if (t.includes('submit') || t.includes('verify') || t.includes('confirm')) {
            btn.click(); return true;
          }
        }
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) { const r = findSubmit(el.shadowRoot); if (r) return r; }
        }
        return null;
      }
      const waf = document.querySelector('awswaf-captcha');
      if (waf && waf.shadowRoot) return findSubmit(waf.shadowRoot);
    });

    log('INFO', 'CAPTCHA submitted', tag);
    await page.waitForTimeout(5000);
    return true;

  } catch (err) {
    log('ERROR', `CAPTCHA error: ${err.message}`, tag);
    return false;
  }
}

// ===== OTP RETRIEVAL =====
function getOtpFromEmail(imapConfig, targetEmail, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    function tryFetch() {
      if (Date.now() - startTime > timeout) return reject(new Error('OTP timeout'));
      const imap = new Imap({
        user: imapConfig.user, password: imapConfig.password,
        host: imapConfig.host || 'imap.gmail.com', port: imapConfig.port || 993,
        tls: true, tlsOptions: { rejectUnauthorized: false }
      });
      imap.once('ready', () => {
        imap.openBox('INBOX', false, (err) => {
          if (err) { imap.end(); return reject(err); }
          const since = new Date(Date.now() - 5 * 60 * 1000);
          const criteria = [['SINCE', since], ['OR', ['FROM', 'amazon'], ['FROM', 'hiring.amazon']]];
          if (targetEmail) criteria.push(['TO', targetEmail]);
          imap.search(criteria, (err, results) => {
            if (err || !results || results.length === 0) { imap.end(); setTimeout(tryFetch, 5000); return; }
            const f = imap.fetch([results[results.length - 1]], { bodies: ['TEXT'] });
            let body = '';
            f.on('message', (msg) => {
              msg.on('body', (stream) => { stream.on('data', c => body += c.toString('utf8')); });
            });
            f.once('end', () => {
              imap.end();
              const m = body.match(/\b(\d{6})\b/);
              if (m) resolve(m[1]);
              else setTimeout(tryFetch, 5000);
            });
            f.once('error', () => { imap.end(); setTimeout(tryFetch, 5000); });
          });
        });
      });
      imap.once('error', () => setTimeout(tryFetch, 5000));
      imap.connect();
    }
    tryFetch();
  });
}

// ===== SESSION EXTRACTION =====
async function extractSession(page, tag) {
  // Wait for page to settle after login
  await page.waitForTimeout(3000);

  // Navigate to hiring page to trigger token loading
  const url = page.url();
  if (!url.includes('hiring.amazon')) {
    try {
      await page.goto('https://hiring.amazon.ca/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(5000);
    } catch (e) {}
  }

  // Extract candidateId and accessToken from localStorage
  let candidateId = null;
  let accessToken = null;

  for (let attempt = 0; attempt < 10; attempt++) {
    const data = await page.evaluate(() => {
      const cid = localStorage.getItem('bbCandidateId') ||
                  localStorage.getItem('sfCandidateId') ||
                  localStorage.getItem('CandidateId');
      const token = localStorage.getItem('accessToken');
      return { candidateId: cid, accessToken: token };
    });

    if (data.candidateId) candidateId = data.candidateId;
    if (data.accessToken && data.accessToken.startsWith('AQICAH') && data.accessToken.length >= 1000) {
      accessToken = data.accessToken;
    }

    if (candidateId && accessToken) break;

    log('DEBUG', `Attempt ${attempt + 1}/10: candidateId=${!!candidateId}, accessToken=${!!accessToken}`, tag);

    // Try clicking around to trigger token loading
    if (attempt === 3) {
      try {
        await page.click('[data-test-id="topPanelMyAccountLink"]').catch(() => {});
        await page.waitForTimeout(2000);
      } catch (e) {}
    }

    // Try refreshing the page
    if (attempt === 6) {
      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(5000);
      } catch (e) {}
    }

    await page.waitForTimeout(2000);
  }

  if (!candidateId || !accessToken) {
    log('WARN', `Session extraction incomplete: candidateId=${!!candidateId}, token=${!!accessToken}`, tag);
    return null;
  }

  // Extract cookies
  const context = page.context();
  const allCookies = await context.cookies();
  const hiringCookies = allCookies
    .filter(c => c.domain.includes('hiring.amazon') || c.domain.includes('amazon.com') || c.domain.includes('amazon.ca'))
    .map(c => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path,
      expires: c.expires, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite,
    }));

  log('INFO', `Session extracted: ${candidateId} (${hiringCookies.length} cookies, token ${accessToken.length} chars)`, tag);

  return { candidateId, accessToken, cookies: hiringCookies };
}

// ===== LOGIN + HARVEST FOR ONE ACCOUNT =====
async function loginAndHarvest(browser, account, accountNum, config, nopecha, proxies) {
  const tag = `Acct#${accountNum}`;
  const proxy = proxies.length > 0 ? proxies[Math.floor(Math.random() * proxies.length)] : null;

  const ctxOpts = {
    viewport: { width: 1366, height: 768 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };
  if (proxy) {
    // Parse proxy: http://user:pass@host:port
    const m = proxy.match(/^https?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
    if (m) {
      ctxOpts.proxy = { server: `http://${m[3]}:${m[4]}`, username: m[1], password: m[2] };
      log('INFO', `Using proxy: ${m[3]}:${m[4]}`, tag);
    }
  }

  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();

  // Stealth
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });

  try {
    // Step 1: Navigate
    log('INFO', `Logging in: ${account.email}`, tag);
    await page.goto('https://hiring.amazon.ca/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch (e) {}
    await page.waitForTimeout(2000);

    // Dismiss cookie banner
    try {
      const consentBtn = await page.$('#onetrust-accept-btn-handler');
      if (consentBtn && await consentBtn.isVisible()) await consentBtn.click();
    } catch (e) {}

    // Step 2: Click Sign In
    try {
      await page.waitForSelector('[data-test-id="topPanelSigninLink"]', { timeout: 10000, state: 'visible' });
      await page.click('[data-test-id="topPanelSigninLink"]');
      await page.waitForTimeout(3000);
    } catch (e) {
      log('WARN', 'Sign in link not found, trying direct URL', tag);
      await page.goto('https://auth.hiring.amazon.com/#/signin', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);
    }

    // Wait for auth page
    try { await page.waitForURL('**/auth.hiring.amazon*', { timeout: 15000 }); } catch (e) {}
    await page.waitForTimeout(2000);

    // Step 3: Fill email
    const emailSelectors = ['input[name="email"]', 'input[type="email"]', '#email', '#login'];
    for (const sel of emailSelectors) {
      try {
        const el = await page.$(sel);
        if (el && await el.isVisible()) {
          await el.fill(account.email);
          log('INFO', `Email filled: ${account.email}`, tag);
          break;
        }
      } catch (e) {}
    }

    // Step 4: Fill PIN
    const pinSelectors = ['input[name="pin"]', 'input[type="password"]', '#pin'];
    for (const sel of pinSelectors) {
      try {
        const el = await page.$(sel);
        if (el && await el.isVisible()) {
          await el.fill(account.pin);
          log('INFO', 'PIN filled', tag);
          break;
        }
      } catch (e) {}
    }

    await page.waitForTimeout(500);

    // Step 5: Click sign in button
    const signInSels = [
      'button:has-text("Sign in")', 'button:has-text("Sign In")',
      'button:has-text("Continue")', 'button[type="submit"]',
      'button[data-test-component="StencilReactButton"]',
    ];
    for (const sel of signInSels) {
      try {
        const btn = await page.$(sel);
        if (btn && await btn.isVisible() && await btn.isEnabled()) {
          await btn.click({ timeout: 5000 });
          log('INFO', `Sign in clicked: ${sel}`, tag);
          break;
        }
      } catch (e) {}
    }

    await page.waitForTimeout(3000);

    // Step 6: Handle CAPTCHA
    const hasCaptcha = await page.$('#captchaModal') || await page.$('awswaf-captcha');
    if (hasCaptcha) {
      log('INFO', 'CAPTCHA detected, solving...', tag);
      for (let attempt = 1; attempt <= 3; attempt++) {
        const solved = await solveCaptcha(page, nopecha, tag);
        if (solved) break;
        log('WARN', `CAPTCHA attempt ${attempt} failed`, tag);
        await page.waitForTimeout(2000);
      }
    }

    await page.waitForTimeout(3000);

    // Step 7: Handle OTP if present
    const pageText = await page.evaluate(() => document.body.innerText.toLowerCase()).catch(() => '');
    const hasOtp = pageText.includes('verification code') || pageText.includes('enter the code') || pageText.includes('one-time');

    if (hasOtp && config.email_imap) {
      log('INFO', 'OTP page detected, fetching from email...', tag);
      try {
        const otp = await getOtpFromEmail(config.email_imap, account.email, 120000);
        log('INFO', `OTP: ${otp}`, tag);

        // Fill OTP
        const otpSels = ['input[name="otp"]', 'input[name="verificationCode"]', 'input[name="code"]',
                         'input[placeholder*="code" i]', '#verificationCode', '#otp'];
        let filled = false;
        for (const sel of otpSels) {
          try { const el = await page.$(sel); if (el && await el.isVisible()) { await el.fill(otp); filled = true; break; } } catch (e) {}
        }
        if (!filled) {
          // Fallback: first visible text input
          const inputs = await page.$$('input');
          for (const inp of inputs) {
            if (await inp.isVisible()) {
              const type = await inp.getAttribute('type');
              if (!type || type === 'text' || type === 'tel' || type === 'number') {
                await inp.fill(otp); filled = true; break;
              }
            }
          }
        }

        await page.waitForTimeout(500);

        // Click verify
        for (const sel of ['button:has-text("Verify")', 'button:has-text("Continue")', 'button[type="submit"]',
                           'button[data-test-component="StencilReactButton"]']) {
          try {
            const btn = await page.$(sel);
            if (btn && await btn.isVisible() && await btn.isEnabled()) { await btn.click(); break; }
          } catch (e) {}
        }
        await page.waitForTimeout(3000);
      } catch (e) {
        log('ERROR', `OTP failed: ${e.message}`, tag);
      }
    }

    // Click any remaining continue buttons
    for (let i = 0; i < 5; i++) {
      try {
        const btn = await page.$('button[data-test-component="StencilReactButton"]');
        if (btn && await btn.isVisible() && await btn.isEnabled()) {
          const text = (await btn.textContent().catch(() => '')).trim().toLowerCase();
          if (text.includes('consent') || text.includes('accept')) { await btn.click(); await page.waitForTimeout(1000); continue; }
          await btn.click();
          await page.waitForTimeout(2000);
        } else break;
      } catch (e) { break; }
    }

    // Step 8: Extract session data
    log('INFO', 'Extracting session data...', tag);
    const session = await extractSession(page, tag);

    if (session) {
      log('INFO', `SUCCESS: ${account.email} → candidateId: ${session.candidateId}`, tag);
      return { success: true, email: account.email, session, page, context };
    } else {
      log('WARN', `Login succeeded but session extraction failed: ${account.email}`, tag);
      return { success: false, email: account.email, error: 'Session extraction failed', page, context };
    }

  } catch (err) {
    log('ERROR', `Login failed: ${account.email} — ${err.message}`, tag);
    return { success: false, email: account.email, error: err.message, page, context };
  }
}

// ===== MAIN =====
async function main() {
  log('INFO', '========================================');
  log('INFO', '  Session Harvester v1.0');
  log('INFO', '  Login → Extract → Feed to Job Picker');
  log('INFO', '========================================');

  // Load harvest config
  const harvestConfigPath = path.join(__dirname, '..', 'harvest_config.json');
  if (!fs.existsSync(harvestConfigPath)) {
    log('ERROR', `Config not found: ${harvestConfigPath}`);
    log('INFO', 'Create harvest_config.json — see harvest_config.example.json');
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(harvestConfigPath, 'utf8'));

  // Load accounts
  const accountsPath = process.argv[2] || config.accounts_file || path.join(__dirname, '..', '..', 'created_accounts.json');
  if (!fs.existsSync(accountsPath)) {
    log('ERROR', `Accounts file not found: ${accountsPath}`);
    process.exit(1);
  }
  const accounts = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
  log('INFO', `Loaded ${accounts.length} accounts from ${accountsPath}`);

  // Load proxies
  let proxies = [];
  const pickerConfig = path.join(__dirname, '..', 'config.json');
  if (fs.existsSync(pickerConfig)) {
    const pc = JSON.parse(fs.readFileSync(pickerConfig, 'utf8'));
    proxies = pc.proxies || [];
  }
  log('INFO', `Loaded ${proxies.length} proxies`);

  // Init NopeCHA
  let nopecha = null;
  if (config.captcha && config.captcha.api_key) {
    try {
      const nConf = new Configuration({ apiKey: config.captcha.api_key });
      nopecha = new NopeCHAApi(nConf);
      log('INFO', 'NopeCHA initialized');
    } catch (e) { log('WARN', `NopeCHA failed: ${e.message}`); }
  }

  // Launch browser
  const browser = await chromium.launch({
    headless: process.env.HEADLESS === 'true',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  });

  log('INFO', `Browser launched (headless: ${process.env.HEADLESS === 'true'})`);

  // Login and harvest sessions SEQUENTIALLY
  const sessions = [];
  const activePages = []; // Keep pages alive for token refresh

  for (let i = 0; i < accounts.length; i++) {
    log('INFO', `\n=== Account ${i + 1} of ${accounts.length}: ${accounts[i].email} ===`);

    const result = await loginAndHarvest(browser, accounts[i], i + 1, config, nopecha, proxies);

    if (result.success && result.session) {
      sessions.push(result.session);
      activePages.push({ email: accounts[i].email, page: result.page, context: result.context });

      log('INFO', `\n  *** Session #${sessions.length} ***`);
      log('INFO', `  Email:       ${accounts[i].email}`);
      log('INFO', `  CandidateId: ${result.session.candidateId}`);
      log('INFO', `  Token:       ${result.session.accessToken.substring(0, 30)}...`);
      log('INFO', `  Cookies:     ${result.session.cookies.length}`);
      log('INFO', `  ************************\n`);
    } else {
      log('WARN', `Failed: ${accounts[i].email} — ${result.error || 'unknown'}`);
      // Close failed context
      try { await result.context.close(); } catch (e) {}
    }

    // Save sessions incrementally to job picker config
    saveSessions(sessions, pickerConfig);

    // Delay between accounts
    if (i < accounts.length - 1) {
      log('INFO', 'Waiting 5s before next account...');
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  // Summary
  log('INFO', `\n========================================`);
  log('INFO', `  HARVEST COMPLETE`);
  log('INFO', `  Total accounts: ${accounts.length}`);
  log('INFO', `  Sessions harvested: ${sessions.length}`);
  log('INFO', `========================================`);

  if (sessions.length > 0) {
    log('INFO', '\n  Harvested sessions:');
    sessions.forEach((s, i) => {
      log('INFO', `    ${i + 1}. ${s.candidateId}`);
    });
    log('INFO', `\n  Sessions saved to: ${pickerConfig}`);
    log('INFO', '  You can now run the job picker: node src/index.js');
  }

  // Keep alive for token refresh
  if (activePages.length > 0 && !process.env.NO_KEEPALIVE) {
    log('INFO', '\n  Keeping browsers alive for token refresh every 2 hours...');
    log('INFO', '  Press Ctrl+C to stop.\n');

    const REFRESH_INTERVAL = 2 * 60 * 60 * 1000; // 2 hours

    setInterval(async () => {
      log('INFO', 'Re-harvesting tokens (2h refresh)...');
      const refreshed = [];

      for (const { email, page, context } of activePages) {
        try {
          // Refresh the page to get new tokens
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          await page.waitForTimeout(5000);

          const session = await extractSession(page, `Refresh:${email}`);
          if (session) {
            refreshed.push(session);
            log('INFO', `Refreshed: ${email} → ${session.candidateId}`);
          } else {
            log('WARN', `Refresh failed: ${email} — token may have expired`);
          }
        } catch (e) {
          log('ERROR', `Refresh error: ${email} — ${e.message}`);
        }
      }

      if (refreshed.length > 0) {
        saveSessions(refreshed, pickerConfig);
        log('INFO', `Refreshed ${refreshed.length} sessions`);
      }
    }, REFRESH_INTERVAL);
  }
}

function saveSessions(sessions, configPath) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.sessions = sessions;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch (e) {
    // Write standalone file as backup
    fs.writeFileSync('harvested_sessions.json', JSON.stringify(sessions, null, 2));
  }
}

main().catch(err => {
  log('ERROR', `Fatal: ${err.message}`);
  process.exit(1);
});
