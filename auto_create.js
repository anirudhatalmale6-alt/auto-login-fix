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

        // Click audio button
        const audioBtn = await page.$('#amzn-btn-audio-internal');
        if (audioBtn) {
            await audioBtn.click({ force: true });
            log('INFO', 'Audio button clicked', accountNum);
            await page.waitForTimeout(3000);
        } else {
            log('WARNING', 'Audio button not found', accountNum);
            return false;
        }

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
        await page.goto('https://hiring.amazon.ca/', { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(2000);

        // Dismiss any popups
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

        // Step 4: Fill in registration form
        log('INFO', 'Filling registration form...', accountNum);

        // Fill name fields
        const nameSelectors = {
            firstName: ['#firstName', 'input[name="firstName"]', 'input[name="first_name"]', 'input[placeholder*="first" i]'],
            lastName: ['#lastName', 'input[name="lastName"]', 'input[name="last_name"]', 'input[placeholder*="last" i]'],
            email: ['#email', '#login', 'input[name="email"]', 'input[name="login EmailId"]', 'input[type="email"]', 'input[placeholder*="email" i]'],
            phone: ['#phoneNumber', 'input[name="phone"]', 'input[name="phoneNumber"]', 'input[type="tel"]'],
            pin: ['#pin', 'input[name="pin"]', 'input[type="password"]'],
            confirmPin: ['#confirmPin', 'input[name="confirmPin"]', '#confirm-pin', 'input[name="confirm_pin"]'],
        };

        // Fill each field
        for (const [field, selectors] of Object.entries(nameSelectors)) {
            const value = accountData[field];
            if (!value) continue;

            for (const sel of selectors) {
                try {
                    const el = await page.$(sel);
                    if (el && await el.isVisible()) {
                        await el.fill(value);
                        log('INFO', `Filled ${field}: ${field === 'pin' || field === 'confirmPin' ? '***' : value}`, accountNum);
                        await page.waitForTimeout(300);
                        break;
                    }
                } catch (e) {}
            }
        }

        // Handle any checkboxes (terms, privacy, etc.)
        try {
            const checkboxes = await page.$$('input[type="checkbox"]');
            for (const cb of checkboxes) {
                if (await cb.isVisible() && !(await cb.isChecked())) {
                    await cb.check();
                    log('INFO', 'Checked checkbox (terms/privacy)', accountNum);
                }
            }
        } catch (e) {}

        await page.waitForTimeout(1000);

        // Step 5: Click submit/create account button
        log('INFO', 'Clicking submit/create button...', accountNum);
        await clickContinueButton(page, accountNum);
        await page.waitForTimeout(3000);

        // Step 5b: Check for "already registered" or other errors — skip if so
        const alreadyRegistered = await page.evaluate(() => {
            const pageText = document.body.innerText.toLowerCase();
            const errorEls = document.querySelectorAll('.error, [role="alert"], .alert-danger, .error-message, [class*="error"], [class*="alert"]');
            const errorTexts = Array.from(errorEls).map(e => e.textContent.toLowerCase()).join(' ');
            const allText = pageText + ' ' + errorTexts;

            if (allText.includes('already registered') || allText.includes('already exists') ||
                allText.includes('already have an account') || allText.includes('account already') ||
                allText.includes('email already') || allText.includes('already in use') ||
                allText.includes('duplicate') || allText.includes('already been registered')) {
                return true;
            }
            return false;
        });

        if (alreadyRegistered) {
            log('WARNING', `Account already registered: ${accountData.email} — SKIPPING`, accountNum);
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

                // Click verify/submit
                await clickContinueButton(page, accountNum);
                await page.waitForTimeout(3000);

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
function generateAccounts(config) {
    const accounts = [];
    const count = config.create.count || 100;
    const emailTemplate = config.create.email_template; // e.g., "user{}@gmail.com"
    const pin = config.create.default_pin || '112233';
    const firstName = config.create.first_name || 'John';
    const lastName = config.create.last_name || 'Doe';
    const phone = config.create.phone || ''; // Static phone number for all accounts
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
                phone: phone,
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
                phone: phone,
            });
        }
    }

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
