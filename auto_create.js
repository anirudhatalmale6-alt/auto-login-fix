/**
 * Auto Account Creation Script for Amazon Hiring Portal
 * Creates multiple accounts automatically with:
 * - Random or sequential email addresses
 * - CAPTCHA solving via NopeCHA (audio)
 * - OTP retrieval from a forwarded email inbox (Gmail IMAP)
 *
 * Usage:
 *   node auto_create.js
 *
 * Config: create_config.json
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { Configuration, NopeCHAApi } = require('nopecha');
const Imap = require('imap');

// Configure logging
const logFile = fs.createWriteStream('auto_create.log', { flags: 'a' });

function log(level, message, accountNum = null) {
    const timestamp = new Date().toISOString();
    const prefix = accountNum !== null ? `[Create #${accountNum}] ` : '';
    const logMessage = `${timestamp} - ${level} - ${prefix}${message}`;
    console.log(logMessage);
    logFile.write(logMessage + '\n');
}

// Parse proxy string format: host:port:username:password
function parseProxy(proxyString) {
    if (!proxyString) return null;
    const parts = proxyString.split(':');
    if (parts.length !== 4) return null;
    const [host, port, username, password] = parts;
    return { server: `http://${host}:${port}`, username, password };
}

/**
 * Solve AWS WAF audio CAPTCHA using NopeCHA.
 * Extracts audio from Shadow DOM, sends to NopeCHA, types answer, clicks submit.
 */
async function solveCaptcha(page, nopecha, accountNum) {
    if (!nopecha) {
        log('ERROR', 'NopeCHA not configured', accountNum);
        return false;
    }

    try {
        // Wait for CAPTCHA modal
        log('INFO', 'Waiting for CAPTCHA modal...', accountNum);
        try {
            await page.waitForSelector('#captchaModal', { timeout: 15000, state: 'attached' });
        } catch (e) {
            log('INFO', 'No CAPTCHA modal found, might not need solving', accountNum);
            return true; // No captcha = success
        }

        await page.waitForTimeout(2000);

        // Click audio button — may be in regular DOM, inside #captchaModal, or inside Shadow DOM
        let audioClicked = false;

        // Strategy 1: Direct selector
        for (const sel of ['#captchaModal #amzn-btn-audio-internal', '#amzn-btn-audio-internal']) {
            try {
                const btn = await page.$(sel);
                if (btn) {
                    const isVisible = await btn.isVisible().catch(() => true);
                    const isEnabled = await btn.isEnabled().catch(() => true);
                    if (isVisible && isEnabled) {
                        await btn.click({ force: true, timeout: 5000 });
                        log('INFO', `Audio button clicked via: ${sel}`, accountNum);
                        audioClicked = true;
                        break;
                    }
                }
            } catch (e) {}
        }

        // Strategy 2: Wait for it to appear (may render with delay)
        if (!audioClicked) {
            try {
                await page.waitForSelector('#amzn-btn-audio-internal', { timeout: 10000, state: 'attached' });
                const btn = await page.$('#amzn-btn-audio-internal');
                if (btn) {
                    await btn.click({ force: true });
                    log('INFO', 'Audio button clicked after wait', accountNum);
                    audioClicked = true;
                }
            } catch (e) {
                log('DEBUG', `Audio button wait failed: ${e.message.substring(0, 60)}`, accountNum);
            }
        }

        // Strategy 3: JavaScript DOM search (including inside captcha modal)
        if (!audioClicked) {
            try {
                const clicked = await page.evaluate(() => {
                    // Try in captcha modal
                    const modal = document.querySelector('#captchaModal');
                    if (modal) {
                        const btn = modal.querySelector('#amzn-btn-audio-internal');
                        if (btn) { btn.click(); return 'modal'; }
                    }
                    // Try global
                    const globalBtn = document.querySelector('#amzn-btn-audio-internal');
                    if (globalBtn) { globalBtn.click(); return 'global'; }
                    // Try inside any shadow roots
                    function findInShadow(root) {
                        const btn = root.querySelector('#amzn-btn-audio-internal');
                        if (btn) { btn.click(); return true; }
                        const els = root.querySelectorAll('*');
                        for (const el of els) {
                            if (el.shadowRoot) {
                                const found = findInShadow(el.shadowRoot);
                                if (found) return true;
                            }
                        }
                        return false;
                    }
                    const waf = document.querySelector('awswaf-captcha');
                    if (waf && waf.shadowRoot && findInShadow(waf.shadowRoot)) return 'shadow';
                    // Search all shadow roots
                    const allEls = document.querySelectorAll('*');
                    for (const el of allEls) {
                        if (el.shadowRoot && findInShadow(el.shadowRoot)) return 'shadow-global';
                    }
                    return null;
                });
                if (clicked) {
                    log('INFO', `Audio button clicked via JS: ${clicked}`, accountNum);
                    audioClicked = true;
                }
            } catch (e) {
                log('DEBUG', `JS audio button search failed: ${e.message.substring(0, 60)}`, accountNum);
            }
        }

        // Strategy 4: Find any button with "audio" in its text/aria-label
        if (!audioClicked) {
            try {
                const clicked = await page.evaluate(() => {
                    function searchDOM(root) {
                        const buttons = root.querySelectorAll('button, [role="button"]');
                        for (const btn of buttons) {
                            const text = (btn.textContent || '').toLowerCase();
                            const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
                            const id = (btn.id || '').toLowerCase();
                            if (text.includes('audio') || aria.includes('audio') || id.includes('audio')) {
                                btn.click();
                                return btn.id || btn.textContent.trim().substring(0, 30);
                            }
                        }
                        const els = root.querySelectorAll('*');
                        for (const el of els) {
                            if (el.shadowRoot) {
                                const r = searchDOM(el.shadowRoot);
                                if (r) return r;
                            }
                        }
                        return null;
                    }
                    return searchDOM(document);
                });
                if (clicked) {
                    log('INFO', `Audio button clicked via text search: ${clicked}`, accountNum);
                    audioClicked = true;
                }
            } catch (e) {}
        }

        if (!audioClicked) {
            log('WARNING', 'Audio button not found after all strategies', accountNum);
            // Take debug screenshot
            try { await page.screenshot({ path: 'debug_captcha_no_audio.png' }); } catch (e) {}
            return false;
        }

        await page.waitForTimeout(3000);

        // Extract audio from Shadow DOM
        let audioData = null;
        for (let i = 0; i < 15; i++) {
            audioData = await page.evaluate(() => {
                function findAudioInShadow(root) {
                    const audioElements = root.querySelectorAll('audio');
                    for (const audio of audioElements) {
                        const src = audio.src || audio.currentSrc;
                        if (src && src.startsWith('data:audio')) {
                            const match = src.match(/^data:audio\/[^;]+;base64,(.+)$/);
                            if (match) return match[1];
                        }
                        for (const source of audio.querySelectorAll('source')) {
                            const sSrc = source.src;
                            if (sSrc && sSrc.startsWith('data:audio')) {
                                const match = sSrc.match(/^data:audio\/[^;]+;base64,(.+)$/);
                                if (match) return match[1];
                            }
                        }
                    }
                    const allElements = root.querySelectorAll('*');
                    for (const el of allElements) {
                        if (el.shadowRoot) {
                            const result = findAudioInShadow(el.shadowRoot);
                            if (result) return result;
                        }
                    }
                    return null;
                }
                const waf = document.querySelector('awswaf-captcha');
                if (waf && waf.shadowRoot) return findAudioInShadow(waf.shadowRoot);
                return null;
            });
            if (audioData) break;
            await page.waitForTimeout(1000);
        }

        if (!audioData) {
            log('ERROR', 'Could not extract audio data from Shadow DOM', accountNum);
            return false;
        }

        log('INFO', `Audio extracted (${audioData.length} chars)`, accountNum);

        // Solve with NopeCHA
        const result = await nopecha.solveRecognition({ type: 'awscaptcha', audio_data: [audioData] });
        const answer = Array.isArray(result) ? result[0] : result;
        log('INFO', `NopeCHA answer: "${answer}"`, accountNum);

        // Type answer into Shadow DOM input
        await page.evaluate((ans) => {
            function findInput(root) {
                const inputs = root.querySelectorAll('input[type="text"], input:not([type])');
                for (const input of inputs) {
                    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                    setter.call(input, ans);
                    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                    return true;
                }
                const allEls = root.querySelectorAll('*');
                for (const el of allEls) {
                    if (el.shadowRoot) { const r = findInput(el.shadowRoot); if (r) return r; }
                }
                return null;
            }
            const waf = document.querySelector('awswaf-captcha');
            if (waf && waf.shadowRoot) return findInput(waf.shadowRoot);
        }, answer);

        await page.waitForTimeout(500);

        // Click submit in Shadow DOM
        await page.evaluate(() => {
            function findSubmit(root) {
                const buttons = root.querySelectorAll('button, [role="button"]');
                for (const btn of buttons) {
                    const text = (btn.textContent || '').toLowerCase().trim();
                    if (text.includes('submit') || text.includes('verify') || text.includes('confirm')) {
                        btn.click();
                        return true;
                    }
                }
                const allEls = root.querySelectorAll('*');
                for (const el of allEls) {
                    if (el.shadowRoot) { const r = findSubmit(el.shadowRoot); if (r) return r; }
                }
                return null;
            }
            const waf = document.querySelector('awswaf-captcha');
            if (waf && waf.shadowRoot) return findSubmit(waf.shadowRoot);
        });

        log('INFO', 'CAPTCHA submit clicked', accountNum);
        await page.waitForTimeout(5000);

        // Check if overlay cleared
        const overlayGone = await page.evaluate(() => {
            const overlay = document.querySelector('#captchaModalOverlay');
            if (!overlay) return true;
            const style = window.getComputedStyle(overlay);
            return style.display === 'none' || style.visibility === 'hidden' ||
                   style.pointerEvents === 'none' || style.opacity === '0';
        });

        if (overlayGone) {
            log('INFO', 'CAPTCHA solved!', accountNum);
            return true;
        }

        log('WARNING', 'CAPTCHA overlay still present', accountNum);
        return false;

    } catch (error) {
        log('ERROR', `CAPTCHA error: ${error.message}`, accountNum);
        return false;
    }
}

/**
 * Click any visible continue/submit button on the page.
 * Returns true if a button was clicked.
 */
async function clickContinueButton(page, accountNum) {
    // Strategy 1: StencilReactButton
    try {
        const buttons = await page.$$('button[data-test-component="StencilReactButton"]');
        for (const btn of buttons) {
            if (await btn.isVisible() && await btn.isEnabled()) {
                const text = await btn.textContent().catch(() => '');
                log('INFO', `Clicking StencilReactButton: "${text.trim()}"`, accountNum);
                try {
                    await btn.click({ timeout: 5000 });
                } catch (e) {
                    await btn.click({ force: true, timeout: 5000 });
                }
                return true;
            }
        }
    } catch (e) {}

    // Strategy 2: data-test-id="button-continue"
    try {
        const contBtns = await page.$$('button[data-test-id="button-continue"]');
        for (const btn of contBtns) {
            if (await btn.isVisible() && await btn.isEnabled()) {
                await btn.click({ timeout: 5000 }).catch(() => btn.click({ force: true }));
                return true;
            }
        }
    } catch (e) {}

    // Strategy 3: JS fallback
    try {
        const clicked = await page.evaluate(() => {
            const selectors = [
                'button[data-test-component="StencilReactButton"]',
                'button[data-test-id="button-continue"]',
                'button[type="submit"]'
            ];
            for (const sel of selectors) {
                const buttons = document.querySelectorAll(sel);
                for (const btn of buttons) {
                    if (btn.offsetParent !== null && !btn.disabled) {
                        btn.click();
                        return true;
                    }
                }
            }
            return false;
        });
        if (clicked) return true;
    } catch (e) {}

    return false;
}

/**
 * Retrieve OTP from Gmail via IMAP.
 * Searches for the latest email from Amazon to the specified address.
 */
function getOtpFromEmail(imapConfig, targetEmail, timeout = 120000) {
    return new Promise((resolve, reject) => {
        const startTime = Date.now();

        function tryFetch() {
            if (Date.now() - startTime > timeout) {
                return reject(new Error('OTP retrieval timed out'));
            }

            const imap = new Imap({
                user: imapConfig.user,
                password: imapConfig.password,
                host: imapConfig.host || 'imap.gmail.com',
                port: imapConfig.port || 993,
                tls: true,
                tlsOptions: { rejectUnauthorized: false }
            });

            imap.once('ready', () => {
                imap.openBox('INBOX', false, (err, box) => {
                    if (err) {
                        imap.end();
                        return reject(err);
                    }

                    // Search for recent emails from Amazon containing verification/OTP
                    const since = new Date(Date.now() - 5 * 60 * 1000); // Last 5 minutes
                    const searchCriteria = [
                        ['SINCE', since],
                        ['OR',
                            ['FROM', 'amazon'],
                            ['FROM', 'hiring.amazon']
                        ]
                    ];

                    // If we're looking for emails to a specific address
                    if (targetEmail) {
                        searchCriteria.push(['TO', targetEmail]);
                    }

                    imap.search(searchCriteria, (err, results) => {
                        if (err || !results || results.length === 0) {
                            imap.end();
                            // Retry after 5 seconds
                            setTimeout(tryFetch, 5000);
                            return;
                        }

                        // Get the latest email
                        const latestId = results[results.length - 1];
                        const f = imap.fetch([latestId], { bodies: ['TEXT', 'HEADER.FIELDS (SUBJECT FROM TO DATE)'] });

                        let emailBody = '';
                        let emailSubject = '';

                        f.on('message', (msg) => {
                            msg.on('body', (stream, info) => {
                                let buffer = '';
                                stream.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
                                stream.on('end', () => {
                                    if (info.which === 'TEXT') {
                                        emailBody = buffer;
                                    } else {
                                        emailSubject = buffer;
                                    }
                                });
                            });
                        });

                        f.once('end', () => {
                            imap.end();

                            // Extract OTP - look for 6-digit code
                            const otpMatch = emailBody.match(/\b(\d{6})\b/);
                            if (otpMatch) {
                                resolve(otpMatch[1]);
                            } else {
                                // Try other patterns
                                const codeMatch = emailBody.match(/(?:code|otp|verification|pin)[:\s]*(\d{4,8})/i);
                                if (codeMatch) {
                                    resolve(codeMatch[1]);
                                } else {
                                    // Retry
                                    setTimeout(tryFetch, 5000);
                                }
                            }
                        });

                        f.once('error', (err) => {
                            imap.end();
                            setTimeout(tryFetch, 5000);
                        });
                    });
                });
            });

            imap.once('error', (err) => {
                // Retry on connection errors
                setTimeout(tryFetch, 5000);
            });

            imap.connect();
        }

        tryFetch();
    });
}

/**
 * Create a single account on Amazon Hiring Portal.
 */
async function createAccount(browser, config, accountData, accountNum, proxies, nopecha) {
    const proxy = proxies.length > 0
        ? parseProxy(proxies[Math.floor(Math.random() * proxies.length)])
        : null;

    const contextOptions = {
        viewport: { width: 1366, height: 768 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };

    if (proxy) {
        contextOptions.proxy = proxy;
        log('INFO', `Using proxy: ${proxy.server}`, accountNum);
    }

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    // Stealth
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        window.chrome = { runtime: {} };
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    });

    // Monitor network
    page.on('response', async (response) => {
        const url = response.url();
        if (url.includes('sign-up') || url.includes('register') || url.includes('create') || url.includes('verification') || url.includes('captcha')) {
            log('NET', `${response.request().method()} ${url.substring(0, 120)} -> ${response.status()}`, accountNum);
        }
    });

    try {
        // Step 1: Navigate to hiring portal
        log('INFO', 'Navigating to hiring.amazon.ca...', accountNum);
        // Use domcontentloaded instead of networkidle — proxy connections can be slow
        // and third-party scripts (captcha SDK, analytics) may never fully settle
        await page.goto('https://hiring.amazon.ca/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        // Give extra time for page to render
        try {
            await page.waitForLoadState('networkidle', { timeout: 15000 });
        } catch (e) {
            log('DEBUG', 'networkidle not reached, continuing anyway...', accountNum);
        }
        await page.waitForTimeout(2000);

        // Dismiss cookie consent banner
        try {
            const consentBtn = await page.$('button:has-text("I consent"), button:has-text("Accept"), button:has-text("Got it"), #onetrust-accept-btn-handler');
            if (consentBtn && await consentBtn.isVisible()) {
                await consentBtn.click();
                log('INFO', 'Dismissed cookie consent banner', accountNum);
                await page.waitForTimeout(500);
            }
        } catch (e) {}
        // Dismiss any other popups
        try {
            await page.keyboard.press('Escape');
            await page.waitForTimeout(500);
        } catch (e) {}

        // Step 2: Click My Account
        log('INFO', 'Clicking My Account...', accountNum);
        try {
            await page.waitForSelector('[data-test-id="topPanelMyAccountLink"]', { timeout: 15000, state: 'visible' });
            await page.click('[data-test-id="topPanelMyAccountLink"]');
            await page.waitForTimeout(1000);
        } catch (e) {
            log('WARNING', `My Account link not found: ${e.message}`, accountNum);
        }

        // Step 3: Click Create Account / Sign Up
        log('INFO', 'Looking for Create Account / Sign Up...', accountNum);

        // Try various selectors for the create account link/button
        const createAccountSelectors = [
            '[data-test-id="topPanelCreateAccountLink"]',
            'a:has-text("Create Account")',
            'a:has-text("Create an Account")',
            'button:has-text("Create Account")',
            'a:has-text("Sign Up")',
            'a:has-text("Register")',
            '[data-test-id="createAccountLink"]',
            // On the auth page
            'a[href*="create"]',
            'a[href*="register"]',
            'a[href*="signup"]',
        ];

        let createAccountClicked = false;
        for (const sel of createAccountSelectors) {
            try {
                const el = await page.$(sel);
                if (el && await el.isVisible()) {
                    await el.click();
                    log('INFO', `Clicked create account with selector: ${sel}`, accountNum);
                    createAccountClicked = true;
                    await page.waitForTimeout(2000);
                    break;
                }
            } catch (e) {}
        }

        // If not found on the My Account panel, try the sign-in page
        if (!createAccountClicked) {
            log('INFO', 'Trying Sign In page for Create Account link...', accountNum);
            try {
                await page.waitForSelector('[data-test-id="topPanelSigninLink"]', { timeout: 5000, state: 'visible' });
                await page.click('[data-test-id="topPanelSigninLink"]');
                await page.waitForTimeout(3000);
                await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
            } catch (e) {}

            // On the auth page, look for create account
            for (const sel of createAccountSelectors) {
                try {
                    const el = await page.$(sel);
                    if (el && await el.isVisible()) {
                        await el.click();
                        log('INFO', `Clicked create account on auth page: ${sel}`, accountNum);
                        createAccountClicked = true;
                        await page.waitForTimeout(2000);
                        break;
                    }
                } catch (e) {}
            }
        }

        // Try navigating directly to create account URL
        if (!createAccountClicked) {
            const createUrls = [
                'https://auth.hiring.amazon.com/#/createAccount',
                'https://auth.hiring.amazon.com/#/create',
                'https://auth.hiring.amazon.com/#/register',
                'https://auth.hiring.amazon.com/#/signup',
            ];
            for (const url of createUrls) {
                try {
                    log('INFO', `Trying direct URL: ${url}`, accountNum);
                    await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
                    await page.waitForTimeout(2000);

                    // Check if we're on a form page
                    const hasInput = await page.$('input');
                    if (hasInput) {
                        createAccountClicked = true;
                        log('INFO', `Found registration form at: ${url}`, accountNum);
                        break;
                    }
                } catch (e) {}
            }
        }

        if (!createAccountClicked) {
            // Try JS to find any create account link
            const found = await page.evaluate(() => {
                const allLinks = document.querySelectorAll('a, button');
                for (const el of allLinks) {
                    const text = (el.textContent || '').toLowerCase();
                    if (text.includes('create') && text.includes('account') ||
                        text.includes('sign up') || text.includes('register') ||
                        text.includes('new account')) {
                        el.click();
                        return el.textContent.trim().substring(0, 60);
                    }
                }
                return null;
            });
            if (found) {
                log('INFO', `Clicked via JS: "${found}"`, accountNum);
                createAccountClicked = true;
                await page.waitForTimeout(2000);
            }
        }

        log('INFO', `Current URL: ${page.url()}`, accountNum);

        // The registration page is a SPA — may redirect or take time to render.
        // Wait for the form to actually appear before filling it.
        log('INFO', 'Waiting for registration form to load...', accountNum);

        // The page redirects from hiring.amazon.ca to auth.hiring.amazon.com
        // Wait for that redirect to complete first, then wait for form to render
        try {
            // Wait for URL to change to auth page or for page to settle
            await page.waitForURL('**/auth.hiring.amazon*', { timeout: 15000 }).catch(() => {});
            log('INFO', `After redirect, URL: ${page.url()}`, accountNum);
        } catch (e) {
            log('DEBUG', `URL wait: ${e.message}`, accountNum);
        }

        // Wait for page to finish loading after redirect
        try {
            await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
        } catch (e) {}
        await page.waitForTimeout(2000);

        // Now wait for form inputs to appear
        let formReady = false;
        for (let waitRound = 1; waitRound <= 10; waitRound++) {
            try {
                const curUrl = page.url();
                log('DEBUG', `Form wait round ${waitRound}/10, URL: ${curUrl}`, accountNum);

                // Wait for at least one visible input
                try {
                    await page.waitForSelector('input', { timeout: 5000, state: 'visible' });
                } catch (e) {
                    log('DEBUG', 'No visible inputs yet...', accountNum);
                    await page.waitForTimeout(2000);
                    continue;
                }

                // Count visible inputs
                const visibleInputCount = await page.evaluate(() => {
                    return Array.from(document.querySelectorAll('input')).filter(el => el.offsetParent !== null).length;
                });

                log('DEBUG', `Visible inputs: ${visibleInputCount}`, accountNum);

                if (visibleInputCount >= 3) {
                    formReady = true;
                    log('INFO', `Registration form loaded with ${visibleInputCount} visible fields`, accountNum);
                    break;
                }

                await page.waitForTimeout(2000);
            } catch (e) {
                // Execution context destroyed — page is still navigating
                log('DEBUG', `Form wait error (round ${waitRound}): ${e.message.substring(0, 80)}`, accountNum);
                await page.waitForTimeout(3000);
            }
        }

        if (!formReady) {
            log('WARNING', 'Registration form did not load within timeout', accountNum);
            try {
                await page.screenshot({ path: 'debug_form_not_loaded.png' });
                log('INFO', 'Debug screenshot: debug_form_not_loaded.png', accountNum);
            } catch (e) {}
        }

        // Step 4: Fill in registration form
        log('INFO', 'Filling registration form...', accountNum);

        // Dismiss cookie consent on registration page
        try {
            // Use JS click to handle cookie consent — avoid it being picked as submit button
            await page.evaluate(() => {
                const buttons = document.querySelectorAll('button');
                for (const btn of buttons) {
                    const text = (btn.textContent || '').trim().toLowerCase();
                    if (text === 'i consent' || text === 'accept' || text === 'accept all') {
                        btn.click();
                        return true;
                    }
                }
                return false;
            });
            await page.waitForTimeout(500);
        } catch (e) {}

        // Take screenshot of registration form for debugging
        try {
            await page.screenshot({ path: 'debug_registration_form.png' });
            log('INFO', 'Debug screenshot saved: debug_registration_form.png', accountNum);
        } catch (e) {}

        // Log all visible input fields on the page for debugging
        try {
            const allInputs = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('input, select, textarea'))
                    .filter(el => el.offsetParent !== null)
                    .map(el => ({
                        tag: el.tagName,
                        type: el.type,
                        name: el.name,
                        id: el.id,
                        placeholder: el.placeholder,
                        ariaLabel: el.getAttribute('aria-label'),
                        label: (() => {
                            // Try to find associated label
                            if (el.id) {
                                const lbl = document.querySelector(`label[for="${el.id}"]`);
                                if (lbl) return lbl.textContent.trim();
                            }
                            // Check parent for label
                            const parent = el.closest('.form-group, .field, [class*="field"], [class*="input"]');
                            if (parent) {
                                const lbl = parent.querySelector('label');
                                if (lbl) return lbl.textContent.trim();
                            }
                            return '';
                        })()
                    }));
            });
            log('INFO', `Registration form fields: ${JSON.stringify(allInputs)}`, accountNum);
        } catch (e) {}

        // Amazon Hiring registration form fields (from screenshot):
        // - Legal first name * (placeholder: "First name")
        // - Legal middle name * (with "I don't have a middle name" checkbox)
        // - Legal surname * (placeholder: "Surname")
        // - Preferred first name (optional, placeholder: "If provided, this is displayed on your badge")
        // - Email or mobile number *
        // - PIN *
        // - Confirm PIN *

        // Use multiple strategies to fill each field:
        // 1. Playwright getByLabel() — finds by associated label text
        // 2. Playwright getByPlaceholder() — finds by placeholder
        // 3. CSS selectors — finds by attributes
        // 4. JS label proximity — finds input near label text

        async function fillField(page, fieldName, value, labelTexts, placeholderTexts, cssSelectors, accountNum) {
            if (!value) return false;

            // Strategy 1: getByLabel
            for (const label of labelTexts) {
                try {
                    const el = page.getByLabel(label, { exact: false });
                    if (await el.count() > 0 && await el.first().isVisible()) {
                        await el.first().fill(value);
                        log('INFO', `Filled ${fieldName} via getByLabel("${label}"): ${fieldName.includes('pin') ? '***' : value}`, accountNum);
                        await page.waitForTimeout(300);
                        return true;
                    }
                } catch (e) {}
            }

            // Strategy 2: getByPlaceholder
            for (const ph of placeholderTexts) {
                try {
                    const el = page.getByPlaceholder(ph, { exact: false });
                    if (await el.count() > 0 && await el.first().isVisible()) {
                        await el.first().fill(value);
                        log('INFO', `Filled ${fieldName} via getByPlaceholder("${ph}"): ${fieldName.includes('pin') ? '***' : value}`, accountNum);
                        await page.waitForTimeout(300);
                        return true;
                    }
                } catch (e) {}
            }

            // Strategy 3: CSS selectors
            for (const sel of cssSelectors) {
                try {
                    const el = await page.$(sel);
                    if (el && await el.isVisible()) {
                        await el.fill(value);
                        log('INFO', `Filled ${fieldName} via CSS("${sel}"): ${fieldName.includes('pin') ? '***' : value}`, accountNum);
                        await page.waitForTimeout(300);
                        return true;
                    }
                } catch (e) {}
            }

            // Strategy 4: Find input near a label containing text (JS-based)
            for (const label of labelTexts) {
                try {
                    const inputInfo = await page.evaluate((labelText) => {
                        const labels = document.querySelectorAll('label, .label, [class*="label"]');
                        for (const lbl of labels) {
                            if (lbl.textContent.toLowerCase().includes(labelText.toLowerCase())) {
                                // Check for associated input via 'for' attribute
                                if (lbl.htmlFor) {
                                    const inp = document.getElementById(lbl.htmlFor);
                                    if (inp) return { id: inp.id, name: inp.name, found: true };
                                }
                                // Check for input inside the label
                                const inp = lbl.querySelector('input, textarea');
                                if (inp) return { id: inp.id, name: inp.name, found: true };
                                // Check sibling/next elements
                                let next = lbl.nextElementSibling;
                                while (next) {
                                    const inp = next.tagName === 'INPUT' ? next : next.querySelector('input, textarea');
                                    if (inp && inp.offsetParent !== null) return { id: inp.id, name: inp.name, found: true };
                                    next = next.nextElementSibling;
                                }
                                // Check parent container
                                const parent = lbl.closest('div, fieldset, section');
                                if (parent) {
                                    const inp = parent.querySelector('input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"])');
                                    if (inp && inp.offsetParent !== null) return { id: inp.id, name: inp.name, found: true };
                                }
                            }
                        }
                        return { found: false };
                    }, label);

                    if (inputInfo.found) {
                        let sel = inputInfo.id ? `#${inputInfo.id}` : `input[name="${inputInfo.name}"]`;
                        const el = await page.$(sel);
                        if (el && await el.isVisible()) {
                            await el.fill(value);
                            log('INFO', `Filled ${fieldName} via label proximity("${label}"→${sel}): ${fieldName.includes('pin') ? '***' : value}`, accountNum);
                            await page.waitForTimeout(300);
                            return true;
                        }
                    }
                } catch (e) {}
            }

            log('WARNING', `Could not find field: ${fieldName}`, accountNum);
            return false;
        }

        // Fill first name
        await fillField(page, 'firstName', accountData.firstName,
            ['Legal first name', 'First name', 'first name'],
            ['First name', 'first name', 'First Name'],
            ['#firstName', 'input[name="firstName"]', 'input[name="first_name"]', 'input[data-test-id*="firstName" i]'],
            accountNum);

        // Check "I don't have a middle name" checkbox
        try {
            // Try getByLabel first
            const cbLabel = page.getByLabel("I don't have a middle name", { exact: false });
            if (await cbLabel.count() > 0 && await cbLabel.first().isVisible()) {
                if (!(await cbLabel.first().isChecked())) {
                    await cbLabel.first().check();
                    log('INFO', 'Checked "I don\'t have a middle name" via getByLabel', accountNum);
                }
            } else {
                // Try has-text selector
                const cbText = page.locator('text=middle name').locator('..').locator('input[type="checkbox"]');
                if (await cbText.count() > 0) {
                    await cbText.first().check();
                    log('INFO', 'Checked "I don\'t have a middle name" via text locator', accountNum);
                } else {
                    // JS fallback
                    const checked = await page.evaluate(() => {
                        const checkboxes = document.querySelectorAll('input[type="checkbox"]');
                        for (const cb of checkboxes) {
                            const parent = cb.closest('div, label, span, li, p');
                            if (parent && parent.textContent.toLowerCase().includes('middle name')) {
                                cb.checked = true;
                                cb.dispatchEvent(new Event('change', { bubbles: true }));
                                cb.dispatchEvent(new Event('input', { bubbles: true }));
                                cb.click();
                                return true;
                            }
                        }
                        return false;
                    });
                    if (checked) {
                        log('INFO', 'Checked "I don\'t have a middle name" via JS', accountNum);
                    } else {
                        log('WARNING', 'Could not find middle name checkbox', accountNum);
                    }
                }
            }
            await page.waitForTimeout(300);
        } catch (e) {
            log('DEBUG', `Middle name checkbox error: ${e.message}`, accountNum);
        }

        // Fill surname
        await fillField(page, 'lastName', accountData.lastName,
            ['Legal surname', 'Surname', 'Last name', 'surname'],
            ['Surname', 'surname', 'Last name', 'last name'],
            ['#lastName', '#surname', 'input[name="lastName"]', 'input[name="surname"]', 'input[data-test-id*="lastName" i]', 'input[data-test-id*="surname" i]'],
            accountNum);

        // Fill email
        await fillField(page, 'email', accountData.email,
            ['Email address', 'Email or mobile', 'Email', 'email'],
            ['email', 'Email', 'Email or mobile', 'Email address'],
            ['#email', '#login', 'input[name="email"]', 'input[type="email"]', 'input[name="login EmailId"]', 'input[data-test-id*="email" i]'],
            accountNum);

        // Re-enter email address (same value)
        await fillField(page, 'confirmEmail', accountData.email,
            ['Re-enter email', 'Confirm email', 'Re-enter email address'],
            ['Re-enter', 're-enter email', 'Confirm email'],
            ['input[name="confirmEmail"]', 'input[name="reenterEmail"]', 'input[name="confirm_email"]', 'input[data-test-id*="confirmEmail" i]', 'input[data-test-id*="reenter" i]'],
            accountNum);

        // Fill mobile number
        await fillField(page, 'phone', accountData.phone,
            ['Mobile number', 'Phone', 'Mobile', 'Phone number'],
            ['Phone', 'phone', 'Mobile', 'mobile', 'Phone number'],
            ['#phoneNumber', '#phone', 'input[name="phone"]', 'input[name="phoneNumber"]', 'input[name="mobileNumber"]', 'input[type="tel"]'],
            accountNum);

        // Re-enter mobile number (same value)
        let confirmPhoneFilled = await fillField(page, 'confirmPhone', accountData.phone,
            ['Re-enter mobile number', 'Re-enter mobile'],
            ['Re-enter the mobile number', 'Re-enter mobile'],
            ['input[name="confirmPhone"]', 'input[name="reenterPhone"]', 'input[name="confirmMobile"]', 'input[name="reenterMobileNumber"]'],
            accountNum);

        // Fallback: find all tel inputs, fill the first empty one
        if (!confirmPhoneFilled) {
            try {
                const telInputs = await page.$$('input[type="tel"]');
                log('DEBUG', `Found ${telInputs.length} tel inputs for confirmPhone`, accountNum);
                for (const tel of telInputs) {
                    if (await tel.isVisible()) {
                        const val = await tel.inputValue();
                        if (!val || val.trim() === '') {
                            await tel.fill(accountData.phone);
                            log('INFO', 'Filled confirmPhone via empty tel input', accountNum);
                            confirmPhoneFilled = true;
                            break;
                        }
                    }
                }
            } catch (e) {}
        }

        // Last fallback: JS native setter for React inputs
        if (!confirmPhoneFilled) {
            try {
                const result = await page.evaluate((phone) => {
                    const inputs = document.querySelectorAll('input[type="tel"], input[type="number"]');
                    const visible = Array.from(inputs).filter(el => el.offsetParent !== null);
                    for (const inp of visible) {
                        if (!inp.value || inp.value.trim() === '') {
                            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                            nativeSetter.call(inp, phone);
                            inp.dispatchEvent(new Event('input', { bubbles: true }));
                            inp.dispatchEvent(new Event('change', { bubbles: true }));
                            return true;
                        }
                    }
                    return false;
                }, accountData.phone);
                if (result) {
                    log('INFO', 'Filled confirmPhone via JS native setter', accountNum);
                    confirmPhoneFilled = true;
                }
            } catch (e) {}
        }

        if (!confirmPhoneFilled) log('WARNING', 'Could not fill re-enter mobile number', accountNum);

        // Select Preferred Language dropdown → English
        log('INFO', 'Selecting preferred language: English...', accountNum);
        try {
            let langSelected = false;

            // Try Playwright getByLabel for the dropdown
            const langSelectors = [
                'select[name*="language" i]', 'select[id*="language" i]',
                'select[data-test-id*="language" i]', 'select[aria-label*="language" i]',
            ];

            // Strategy 1: Find <select> element and choose option
            for (const sel of langSelectors) {
                try {
                    const selectEl = await page.$(sel);
                    if (selectEl && await selectEl.isVisible()) {
                        await selectEl.selectOption({ label: 'English' });
                        log('INFO', 'Selected English from language dropdown via select element', accountNum);
                        langSelected = true;
                        break;
                    }
                } catch (e) {}
            }

            // Strategy 2: getByLabel
            if (!langSelected) {
                try {
                    const langDropdown = page.getByLabel('Preferred language', { exact: false });
                    if (await langDropdown.count() > 0 && await langDropdown.first().isVisible()) {
                        const tag = await langDropdown.first().evaluate(el => el.tagName);
                        if (tag === 'SELECT') {
                            await langDropdown.first().selectOption({ label: 'English' });
                        } else {
                            // Custom dropdown — click to open then select
                            await langDropdown.first().click();
                            await page.waitForTimeout(500);
                            const engOption = page.getByText('English', { exact: true });
                            if (await engOption.count() > 0) {
                                await engOption.first().click();
                            }
                        }
                        log('INFO', 'Selected English via getByLabel', accountNum);
                        langSelected = true;
                    }
                } catch (e) {}
            }

            // Strategy 3: JS — find select near "language" label, select English
            if (!langSelected) {
                const jsResult = await page.evaluate(() => {
                    // Find all select elements
                    const selects = document.querySelectorAll('select');
                    for (const sel of selects) {
                        const parent = sel.closest('div, fieldset');
                        if (parent && parent.textContent.toLowerCase().includes('language')) {
                            const options = sel.querySelectorAll('option');
                            for (const opt of options) {
                                if (opt.textContent.toLowerCase().includes('english')) {
                                    sel.value = opt.value;
                                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                                    sel.dispatchEvent(new Event('input', { bubbles: true }));
                                    return opt.textContent.trim();
                                }
                            }
                        }
                    }
                    // Try custom dropdown (React/Stencil)
                    const labels = document.querySelectorAll('label, .label, [class*="label"]');
                    for (const lbl of labels) {
                        if (lbl.textContent.toLowerCase().includes('language')) {
                            const container = lbl.closest('div, fieldset, section');
                            if (container) {
                                // Click the dropdown trigger
                                const trigger = container.querySelector('button, [role="listbox"], [role="combobox"], [class*="select"], [class*="dropdown"]');
                                if (trigger) {
                                    trigger.click();
                                    return '__clicked_dropdown__';
                                }
                            }
                        }
                    }
                    return null;
                });

                if (jsResult === '__clicked_dropdown__') {
                    await page.waitForTimeout(500);
                    // Find and click "English" in the opened dropdown
                    try {
                        const engOpt = page.getByText('English', { exact: false }).first();
                        if (await engOpt.isVisible()) {
                            await engOpt.click();
                            langSelected = true;
                            log('INFO', 'Selected English from custom dropdown', accountNum);
                        }
                    } catch (e) {}
                } else if (jsResult) {
                    langSelected = true;
                    log('INFO', `Selected language via JS: ${jsResult}`, accountNum);
                }
            }

            if (!langSelected) {
                log('WARNING', 'Could not select preferred language', accountNum);
            }
            await page.waitForTimeout(300);
        } catch (e) {
            log('WARNING', `Language selection error: ${e.message}`, accountNum);
        }

        // Select Preferred Time Zone dropdown → EST / Eastern
        log('INFO', 'Selecting preferred time zone: EST...', accountNum);
        try {
            let tzSelected = false;

            // Strategy 1: Find <select> for timezone
            const tzSelectors = [
                'select[name*="time" i]', 'select[name*="timezone" i]', 'select[name*="zone" i]',
                'select[id*="time" i]', 'select[id*="timezone" i]',
                'select[data-test-id*="time" i]', 'select[aria-label*="time" i]',
            ];

            for (const sel of tzSelectors) {
                try {
                    const selectEl = await page.$(sel);
                    if (selectEl && await selectEl.isVisible()) {
                        // Try to find EST/Eastern option
                        const options = await selectEl.evaluate(el => {
                            return Array.from(el.options).map(o => ({ value: o.value, text: o.textContent.trim() }));
                        });
                        log('DEBUG', `Timezone options: ${JSON.stringify(options.slice(0, 10))}...`, accountNum);
                        const estOption = options.find(o =>
                            o.text.toLowerCase().includes('eastern') ||
                            o.text.includes('EST') ||
                            o.text.includes('ET') ||
                            o.value.toLowerCase().includes('eastern') ||
                            o.value.includes('America/New_York') ||
                            o.value.includes('US/Eastern')
                        );
                        if (estOption) {
                            await selectEl.selectOption(estOption.value);
                            log('INFO', `Selected timezone: ${estOption.text}`, accountNum);
                            tzSelected = true;
                            break;
                        }
                    }
                } catch (e) {}
            }

            // Strategy 2: getByLabel
            if (!tzSelected) {
                try {
                    const tzDropdown = page.getByLabel('Preferred time zone', { exact: false });
                    if (await tzDropdown.count() > 0 && await tzDropdown.first().isVisible()) {
                        const tag = await tzDropdown.first().evaluate(el => el.tagName);
                        if (tag === 'SELECT') {
                            // List options and find Eastern
                            const opts = await tzDropdown.first().evaluate(el => {
                                return Array.from(el.options).map(o => ({ value: o.value, text: o.textContent.trim() }));
                            });
                            const estOpt = opts.find(o =>
                                o.text.toLowerCase().includes('eastern') || o.text.includes('EST') ||
                                o.value.includes('America/New_York') || o.value.includes('US/Eastern')
                            );
                            if (estOpt) {
                                await tzDropdown.first().selectOption(estOpt.value);
                                log('INFO', `Selected timezone via getByLabel: ${estOpt.text}`, accountNum);
                                tzSelected = true;
                            }
                        } else {
                            // Custom dropdown
                            await tzDropdown.first().click();
                            await page.waitForTimeout(500);
                            const estOption = page.getByText('Eastern', { exact: false }).first();
                            if (await estOption.isVisible()) {
                                await estOption.click();
                                tzSelected = true;
                                log('INFO', 'Selected Eastern timezone from custom dropdown', accountNum);
                            }
                        }
                    }
                } catch (e) {}
            }

            // Strategy 3: JS fallback
            if (!tzSelected) {
                const jsResult = await page.evaluate(() => {
                    const selects = document.querySelectorAll('select');
                    for (const sel of selects) {
                        const parent = sel.closest('div, fieldset');
                        if (parent && (parent.textContent.toLowerCase().includes('time zone') || parent.textContent.toLowerCase().includes('timezone'))) {
                            const options = sel.querySelectorAll('option');
                            for (const opt of options) {
                                const text = opt.textContent.toLowerCase();
                                if (text.includes('eastern') || text.includes('est') || opt.value.includes('America/New_York') || opt.value.includes('US/Eastern')) {
                                    sel.value = opt.value;
                                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                                    sel.dispatchEvent(new Event('input', { bubbles: true }));
                                    return opt.textContent.trim();
                                }
                            }
                        }
                    }
                    return null;
                });
                if (jsResult) {
                    tzSelected = true;
                    log('INFO', `Selected timezone via JS: ${jsResult}`, accountNum);
                }
            }

            if (!tzSelected) {
                log('WARNING', 'Could not select preferred time zone', accountNum);
            }
            await page.waitForTimeout(300);
        } catch (e) {
            log('WARNING', `Timezone selection error: ${e.message}`, accountNum);
        }

        // Fill PIN
        await fillField(page, 'pin', accountData.pin,
            ['Create personal PIN', 'PIN', 'Password', 'Create a PIN', 'personal PIN'],
            ['PIN', 'pin', 'Password', 'password', 'Create a PIN', '6-digit'],
            ['#pin', 'input[name="pin"]', 'input[type="password"]'],
            accountNum);

        // Re-enter PIN (same value)
        await fillField(page, 'confirmPin', accountData.confirmPin || accountData.pin,
            ['Re-enter personal PIN', 'Re-enter PIN', 'Confirm PIN', 'Re-enter the PIN'],
            ['Re-enter', 're-enter', 'Confirm PIN', 'confirm'],
            ['#confirmPin', '#confirm-pin', 'input[name="confirmPin"]', 'input[name="reenterPin"]', 'input[name="confirm_pin"]'],
            accountNum);

        // Click "Yes" for SMS consent
        log('INFO', 'Clicking Yes for SMS consent...', accountNum);
        try {
            let smsClicked = false;

            // Try clicking Yes button
            const yesSelectors = [
                'button:has-text("Yes")',
                '[role="button"]:has-text("Yes")',
                'input[type="radio"][value="yes"]',
                'input[type="radio"][value="Yes"]',
            ];
            for (const sel of yesSelectors) {
                try {
                    const btn = await page.$(sel);
                    if (btn && await btn.isVisible()) {
                        await btn.click();
                        log('INFO', `Clicked Yes for SMS consent: ${sel}`, accountNum);
                        smsClicked = true;
                        break;
                    }
                } catch (e) {}
            }

            // JS fallback — find Yes button near SMS/consent text
            if (!smsClicked) {
                const jsResult = await page.evaluate(() => {
                    // Find section about SMS
                    const allText = document.body.innerText;
                    const buttons = document.querySelectorAll('button, [role="button"], input[type="radio"]');
                    for (const btn of buttons) {
                        const text = (btn.textContent || btn.value || '').trim();
                        if (text === 'Yes' || text === 'yes') {
                            btn.click();
                            return 'Yes';
                        }
                    }
                    return null;
                });
                if (jsResult) {
                    log('INFO', 'Clicked Yes for SMS consent via JS', accountNum);
                    smsClicked = true;
                }
            }

            if (!smsClicked) {
                log('WARNING', 'Could not find Yes button for SMS consent', accountNum);
            }
            await page.waitForTimeout(300);
        } catch (e) {
            log('WARNING', `SMS consent error: ${e.message}`, accountNum);
        }

        // Scroll down to make sure submit button is visible
        try {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await page.waitForTimeout(500);
        } catch (e) {}

        // Take screenshot before submit for debugging
        try {
            await page.screenshot({ path: 'debug_before_submit.png' });
            log('INFO', 'Debug screenshot saved: debug_before_submit.png', accountNum);
        } catch (e) {}

        await page.waitForTimeout(1000);

        // Step 5: Click submit/create account button
        log('INFO', 'Clicking submit/create button...', accountNum);

        // Try specific submit button selectors first
        let submitClicked = false;
        const submitSelectors = [
            'button:has-text("Continue")',
            'button:has-text("Create account")',
            'button:has-text("Create Account")',
            'button:has-text("Register")',
            'button:has-text("Sign up")',
            'button:has-text("Submit")',
            'button[type="submit"]',
            'input[type="submit"]',
        ];

        for (const sel of submitSelectors) {
            try {
                const btn = await page.$(sel);
                if (btn && await btn.isVisible() && await btn.isEnabled()) {
                    const text = await btn.textContent().catch(() => '');
                    log('INFO', `Clicking submit button: "${text.trim()}" (${sel})`, accountNum);
                    await btn.click({ timeout: 5000 });
                    submitClicked = true;
                    break;
                }
            } catch (e) {}
        }

        // Fallback: StencilReactButton (skip cookie consent and navigation buttons)
        if (!submitClicked) {
            try {
                const stencilBtns = await page.$$('button[data-test-component="StencilReactButton"]');
                // Click the last visible enabled one that's not cookie consent
                for (let i = stencilBtns.length - 1; i >= 0; i--) {
                    if (await stencilBtns[i].isVisible() && await stencilBtns[i].isEnabled()) {
                        const text = (await stencilBtns[i].textContent().catch(() => '')).trim().toLowerCase();
                        // Skip cookie consent and navigation buttons
                        if (text.includes('consent') || text.includes('accept') || text === '' || text.includes('sign in') || text.includes('log in')) continue;
                        log('INFO', `Clicking StencilReactButton: "${text}"`, accountNum);
                        await stencilBtns[i].click({ timeout: 5000 });
                        submitClicked = true;
                        break;
                    }
                }
            } catch (e) {}
        }

        // Last fallback: clickContinueButton
        if (!submitClicked) {
            await clickContinueButton(page, accountNum);
        }

        await page.waitForTimeout(3000);

        // Step 5b: Check for "already registered" errors
        // ONLY check error elements, NOT full page text (registration page has "Already have an account?" link)
        const alreadyRegistered = await page.evaluate(() => {
            const errorEls = document.querySelectorAll('[role="alert"], .error-message, [class*="error-text"], [class*="errorMessage"], .form-error, .field-error');
            const errorTexts = Array.from(errorEls).map(e => e.textContent.toLowerCase()).join(' ');

            if (errorTexts.includes('already registered') || errorTexts.includes('already exists') ||
                errorTexts.includes('email already') || errorTexts.includes('already in use') ||
                errorTexts.includes('duplicate') || errorTexts.includes('already been registered') ||
                errorTexts.includes('account with this email')) {
                return errorTexts.substring(0, 200);
            }
            return null;
        });

        if (alreadyRegistered) {
            log('WARNING', `Account already registered: ${accountData.email} — error: "${alreadyRegistered}" — SKIPPING`, accountNum);
            await context.close();
            return { success: false, email: accountData.email, error: 'Already registered', skipped: true };
        }

        // Step 6: Handle CAPTCHA if it appears (CAPTCHA comes after filling details on signup too)
        log('INFO', 'Checking for CAPTCHA...', accountNum);
        const captchaModal = await page.$('#captchaModal');
        const wafCaptcha = await page.$('awswaf-captcha');
        if (captchaModal || wafCaptcha) {
            log('INFO', 'CAPTCHA detected, solving...', accountNum);
            const maxAttempts = config.captcha ? config.captcha.max_attempts || 3 : 3;
            let solved = false;
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                solved = await solveCaptcha(page, nopecha, accountNum);
                if (solved) break;
                log('WARNING', `CAPTCHA attempt ${attempt} failed, retrying...`, accountNum);
                await page.waitForTimeout(2000);
            }
            if (!solved) {
                log('ERROR', 'Failed to solve CAPTCHA', accountNum);
                await context.close();
                return { success: false, email: accountData.email, error: 'CAPTCHA failed' };
            }
        }

        // Step 7: Click any remaining continue buttons (multiple rounds)
        for (let i = 0; i < 5; i++) {
            await page.waitForTimeout(2000);

            // Check again for "already registered" after each step
            const regError = await page.evaluate(() => {
                const text = document.body.innerText.toLowerCase();
                return text.includes('already registered') || text.includes('already exists') ||
                       text.includes('already have an account') || text.includes('email already');
            });
            if (regError) {
                log('WARNING', `Account already registered (detected at step ${i + 1}): ${accountData.email}`, accountNum);
                await context.close();
                return { success: false, email: accountData.email, error: 'Already registered', skipped: true };
            }

            // Check for another CAPTCHA (can appear again at different steps)
            const captcha2 = await page.$('#captchaModal');
            const waf2 = await page.$('awswaf-captcha');
            if (captcha2 || waf2) {
                log('INFO', `CAPTCHA appeared again at step ${i + 1}, solving...`, accountNum);
                await solveCaptcha(page, nopecha, accountNum);
                await page.waitForTimeout(2000);
            }

            const clicked = await clickContinueButton(page, accountNum);
            if (!clicked) break;
            log('INFO', `Post-submit continue button ${i + 1} clicked`, accountNum);
        }

        // Step 8: Handle OTP verification
        log('INFO', 'Checking for OTP verification step...', accountNum);
        await page.waitForTimeout(2000);

        // Look for OTP input field
        const otpSelectors = [
            'input[name="otp"]',
            'input[name="verificationCode"]',
            'input[name="code"]',
            'input[placeholder*="code" i]',
            'input[placeholder*="otp" i]',
            'input[placeholder*="verification" i]',
            '#verificationCode',
            '#otp',
            '#code',
        ];

        let otpFieldFound = false;
        for (const sel of otpSelectors) {
            try {
                const el = await page.$(sel);
                if (el && await el.isVisible()) {
                    otpFieldFound = true;
                    log('INFO', `OTP field found: ${sel}`, accountNum);
                    break;
                }
            } catch (e) {}
        }

        if (otpFieldFound && config.email_imap) {
            log('INFO', 'Waiting for OTP email...', accountNum);
            try {
                const otp = await getOtpFromEmail(config.email_imap, accountData.email, 120000);
                log('INFO', `OTP retrieved: ${otp}`, accountNum);

                // Fill OTP
                for (const sel of otpSelectors) {
                    try {
                        const el = await page.$(sel);
                        if (el && await el.isVisible()) {
                            await el.fill(otp);
                            log('INFO', 'OTP filled', accountNum);
                            break;
                        }
                    } catch (e) {}
                }

                await page.waitForTimeout(500);

                // Click verify/submit button
                const verifyClicked = await clickContinueButton(page, accountNum);
                log('INFO', `Verify button clicked: ${verifyClicked}`, accountNum);
                await page.waitForTimeout(3000);

                // After OTP verify, Amazon may show additional Continue button(s)
                // Loop to click them until we leave auth page or no more buttons
                for (let postOtpRound = 1; postOtpRound <= 5; postOtpRound++) {
                    const curUrl = page.url();
                    if (!curUrl.includes('auth.hiring.amazon')) {
                        log('INFO', 'Left auth page after OTP — success!', accountNum);
                        break;
                    }
                    log('INFO', `Post-OTP button round ${postOtpRound}/5, URL: ${curUrl}`, accountNum);
                    try {
                        await page.waitForLoadState('networkidle', { timeout: 5000 });
                    } catch (e) {}
                    const clicked = await clickContinueButton(page, accountNum);
                    if (clicked) {
                        log('INFO', `Post-OTP button ${postOtpRound} clicked`, accountNum);
                        await page.waitForTimeout(3000);
                    } else {
                        log('INFO', 'No more post-OTP buttons', accountNum);
                        break;
                    }
                }

            } catch (e) {
                log('ERROR', `OTP retrieval failed: ${e.message}`, accountNum);
                await context.close();
                return { success: false, email: accountData.email, error: 'OTP failed' };
            }
        } else if (otpFieldFound) {
            log('WARNING', 'OTP field found but no IMAP config — manual OTP entry needed', accountNum);
        }

        // Step 9: Final check
        const finalUrl = page.url();
        log('INFO', `Final URL: ${finalUrl}`, accountNum);

        // Check if account was created (not on registration/error page)
        const isSuccess = !finalUrl.includes('create') && !finalUrl.includes('register') && !finalUrl.includes('error');

        if (isSuccess) {
            log('INFO', `Account created successfully: ${accountData.email}`, accountNum);
        } else {
            // Check for error messages
            const errorText = await page.evaluate(() => {
                const errors = document.querySelectorAll('.error, [role="alert"], .alert-danger, .error-message');
                return Array.from(errors).map(e => e.textContent.trim()).join('; ');
            });
            if (errorText) {
                log('WARNING', `Error on page: ${errorText}`, accountNum);
            }
        }

        await context.close();
        return { success: isSuccess, email: accountData.email };

    } catch (error) {
        log('ERROR', `Account creation error: ${error.message}`, accountNum);
        await context.close().catch(() => {});
        return { success: false, email: accountData.email, error: error.message };
    }
}

/**
 * Generate account data from config.
 *
 * Two modes:
 * 1. Static email/phone: Same email and phone for ALL accounts (client uses email forwarding).
 *    Uses email_template with {} replaced by index, OR explicit emails list.
 * 2. Explicit list: Provide a list of emails to register.
 *
 * The email and phone are "static" (same forwarding inbox receives all OTPs).
 */
/**
 * Generate a random US phone number (10 digits, area code 200-999)
 */
function generateRandomPhone() {
    const areaCode = Math.floor(Math.random() * 800) + 200; // 200-999
    const prefix = Math.floor(Math.random() * 900) + 100;   // 100-999
    const line = Math.floor(Math.random() * 9000) + 1000;    // 1000-9999
    return `${areaCode}${prefix}${line}`;
}

function generateAccounts(config) {
    const accounts = [];
    const count = config.create.count || 100;
    const emailTemplate = config.create.email_template; // e.g., "user{}@gmail.com"
    const pin = config.create.default_pin || '112233';
    const firstName = config.create.first_name || 'John';
    const lastName = config.create.last_name || 'Doe';
    const phone = config.create.phone || ''; // Static phone, or empty for random
    const randomPhone = config.create.random_phone !== false; // Default: true — generate random phone for each account
    const startIndex = config.create.start_index || 1;

    if (config.create.emails && Array.isArray(config.create.emails)) {
        // Use explicit email list
        for (const email of config.create.emails) {
            accounts.push({
                email: email,
                pin: pin,
                confirmPin: pin,
                firstName: firstName,
                lastName: lastName,
                phone: randomPhone ? generateRandomPhone() : phone,
            });
        }
    } else if (emailTemplate) {
        // Generate from template — e.g., "kush+{}@gmail.com" → kush+1@gmail.com, kush+2@gmail.com, etc.
        for (let i = startIndex; i < startIndex + count; i++) {
            accounts.push({
                email: emailTemplate.replace('{}', i),
                pin: pin,
                confirmPin: pin,
                firstName: firstName,
                lastName: lastName,
                phone: randomPhone ? generateRandomPhone() : phone,
            });
        }
    }

    log('INFO', `Generated ${accounts.length} accounts (random_phone: ${randomPhone})`);
    return accounts;
}

// Main entry point
async function main() {
    const configPath = process.argv[2] || 'create_config.json';

    if (!fs.existsSync(configPath)) {
        log('ERROR', `Config file not found: ${configPath}`);
        log('INFO', 'Creating example config: create_config.json.example');

        const exampleConfig = {
            create: {
                count: 100,
                email_template: "youremail+{}@gmail.com",
                default_pin: "112233",
                first_name: "John",
                last_name: "Doe",
                phone: "+1234567890",
                start_index: 1,
                emails: null
            },
            email_imap: {
                user: "your-email@gmail.com",
                password: "your-app-password",
                host: "imap.gmail.com",
                port: 993
            },
            captcha: {
                solver: "nopecha",
                api_key: "YOUR_NOPECHA_API_KEY",
                max_attempts: 3,
                timeout: 60000
            },
            timing: {
                delay_between_accounts: 5000,
                concurrent_limit: 3,
                page_load_timeout: 30000
            }
        };

        fs.writeFileSync('create_config.json.example', JSON.stringify(exampleConfig, null, 2));
        log('INFO', 'Edit create_config.json with your settings and run again');
        process.exit(1);
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    // Load proxies
    let proxies = [];
    try {
        if (fs.existsSync('proxies.json')) {
            proxies = JSON.parse(fs.readFileSync('proxies.json', 'utf8'));
            log('INFO', `Loaded ${proxies.length} proxies`);
        }
    } catch (e) {}

    // Init NopeCHA
    let nopecha = null;
    if (config.captcha && config.captcha.api_key) {
        try {
            const nopechaConfig = new Configuration({ apiKey: config.captcha.api_key });
            nopecha = new NopeCHAApi(nopechaConfig);
            log('INFO', 'NopeCHA initialized');
        } catch (e) {
            log('WARNING', `NopeCHA init failed: ${e.message}`);
        }
    }

    // Generate accounts
    const accounts = generateAccounts(config);
    log('INFO', `Generated ${accounts.length} accounts to create`);

    if (accounts.length === 0) {
        log('ERROR', 'No accounts to create. Check your config.');
        process.exit(1);
    }

    // Launch browser
    const headless = process.env.HEADLESS === 'true';
    const browser = await chromium.launch({
        headless: headless,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
        ]
    });

    log('INFO', `Browser launched (headless: ${headless})`);

    // Process accounts
    const concurrentLimit = (config.timing && config.timing.concurrent_limit) || 3;
    const delayBetween = (config.timing && config.timing.delay_between_accounts) || 5000;
    const results = [];

    // Process in batches
    for (let i = 0; i < accounts.length; i += concurrentLimit) {
        const batch = accounts.slice(i, i + concurrentLimit);
        const batchNum = Math.floor(i / concurrentLimit) + 1;
        log('INFO', `\n=== Batch ${batchNum}: accounts ${i + 1} to ${i + batch.length} ===`);

        const batchResults = await Promise.allSettled(
            batch.map((acc, idx) => createAccount(browser, config, acc, i + idx + 1, proxies, nopecha))
        );

        for (const result of batchResults) {
            if (result.status === 'fulfilled') {
                results.push(result.value);
            } else {
                results.push({ success: false, error: result.reason?.message });
            }
        }

        // Delay between batches
        if (i + concurrentLimit < accounts.length) {
            log('INFO', `Waiting ${delayBetween / 1000}s before next batch...`);
            await new Promise(r => setTimeout(r, delayBetween));
        }
    }

    // Summary
    const successful = results.filter(r => r.success).length;
    const failed = results.length - successful;

    log('INFO', `\n=== CREATION SUMMARY ===`);
    log('INFO', `Total: ${results.length}`);
    log('INFO', `Successful: ${successful}`);
    log('INFO', `Failed: ${failed}`);

    // Save results
    const resultsFile = 'creation_results.json';
    fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
    log('INFO', `Results saved to ${resultsFile}`);

    // Save successful accounts to a file that auto_login.js can use
    const successfulAccounts = results.filter(r => r.success).map(r => ({
        email: r.email,
        pin: config.create.default_pin || '112233'
    }));

    if (successfulAccounts.length > 0) {
        const accountsFile = 'created_accounts.json';
        fs.writeFileSync(accountsFile, JSON.stringify(successfulAccounts, null, 2));
        log('INFO', `Successful accounts saved to ${accountsFile} — add these to config.json for auto-login`);
    }

    await browser.close();
    log('INFO', 'Done');
}

main().catch(error => {
    log('ERROR', `Fatal error: ${error.message}`);
    process.exit(1);
});
