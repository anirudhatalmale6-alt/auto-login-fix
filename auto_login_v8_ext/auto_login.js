/**
 * Auto-login script that keeps multiple users logged in by refreshing every 2 hours.
 * Handles token expiration and automatic re-login for 100 accounts.
 */

const SCRIPT_VERSION = 'v8.0';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');
const chokidar = require('chokidar');
const { Configuration, NopeCHAApi } = require('nopecha');
const Imap = require('imap');

// Configure logging
const logFile = fs.createWriteStream('auto_login.log', { flags: 'a' });

function log(level, message, accountId = null) {
    const timestamp = new Date().toISOString();
    const accountPrefix = accountId !== null ? `[Account ${accountId}] ` : '';
    const logMessage = `${timestamp} - ${level} - ${accountPrefix}${message}`;
    console.log(logMessage);
    logFile.write(logMessage + '\n');
}

// Helper function to parse proxy string format: host:port:username:password
function parseProxy(proxyString) {
    if (!proxyString) return null;
    
    const parts = proxyString.split(':');
    if (parts.length !== 4) {
        log('WARNING', `Invalid proxy format: ${proxyString}. Expected format: host:port:username:password`);
        return null;
    }
    
    const [host, port, username, password] = parts;
    
    // Playwright proxy authentication: use separate username/password fields
    // Pass credentials as-is - Playwright will handle encoding for HTTP Basic Auth
    // Special characters in password (like +) should be passed literally
    // Playwright will automatically encode them when creating Proxy-Authorization header
    return {
        server: `http://${host}:${port}`,
        username: username,
        password: password
    };
}

/**
 * Retrieve OTP from Gmail via IMAP.
 * Searches for the latest Amazon verification email and extracts the code.
 */
function getOtpFromEmail(imapConfig, targetEmail, timeout = 120000) {
    return new Promise((resolve, reject) => {
        const startTime = Date.now();
        let attempts = 0;

        function tryFetch() {
            attempts++;
            if (Date.now() - startTime > timeout) {
                return reject(new Error(`OTP retrieval timed out after ${attempts} attempts`));
            }

            const imap = new Imap({
                user: imapConfig.user,
                password: imapConfig.password,
                host: imapConfig.host || 'imap.gmail.com',
                port: imapConfig.port || 993,
                tls: true,
                tlsOptions: { rejectUnauthorized: false },
                connTimeout: 10000,
                authTimeout: 10000,
            });

            imap.once('ready', () => {
                imap.openBox('INBOX', false, (err, box) => {
                    if (err) {
                        imap.end();
                        setTimeout(tryFetch, 5000);
                        return;
                    }

                    // Search for recent emails from Amazon
                    const since = new Date(Date.now() - 5 * 60 * 1000);
                    const searchCriteria = [
                        ['SINCE', since],
                        ['OR',
                            ['FROM', 'amazon'],
                            ['FROM', 'hiring.amazon']
                        ]
                    ];

                    if (targetEmail) {
                        searchCriteria.push(['TO', targetEmail]);
                    }

                    imap.search(searchCriteria, (err, results) => {
                        if (err || !results || results.length === 0) {
                            imap.end();
                            log('DEBUG', `OTP email not found yet (attempt ${attempts}), retrying in 5s...`);
                            setTimeout(tryFetch, 5000);
                            return;
                        }

                        const latestId = results[results.length - 1];
                        const f = imap.fetch([latestId], { bodies: ['TEXT', 'HEADER.FIELDS (SUBJECT FROM TO DATE)'] });

                        let emailBody = '';

                        f.on('message', (msg) => {
                            msg.on('body', (stream, info) => {
                                let buffer = '';
                                stream.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
                                stream.on('end', () => {
                                    if (info.which === 'TEXT') {
                                        emailBody = buffer;
                                    }
                                });
                            });
                        });

                        f.once('end', () => {
                            imap.end();

                            // Extract OTP — look for 6-digit code first, then 4-8 digit
                            const otpMatch = emailBody.match(/\b(\d{6})\b/);
                            if (otpMatch) {
                                resolve(otpMatch[1]);
                            } else {
                                const codeMatch = emailBody.match(/(?:code|otp|verification|pin)[:\s]*(\d{4,8})/i);
                                if (codeMatch) {
                                    resolve(codeMatch[1]);
                                } else {
                                    log('DEBUG', `No OTP code found in email (attempt ${attempts}), retrying...`);
                                    setTimeout(tryFetch, 5000);
                                }
                            }
                        });

                        f.once('error', () => {
                            imap.end();
                            setTimeout(tryFetch, 5000);
                        });
                    });
                });
            });

            imap.once('error', (err) => {
                log('DEBUG', `IMAP error: ${err.message}, retrying...`);
                setTimeout(tryFetch, 5000);
            });

            imap.connect();
        }

        tryFetch();
    });
}

// Single account session manager
class AccountSession {
    constructor(accountId, account, config, browser, proxy = null, extensionPath = null) {
        this.accountId = accountId;
        this.account = account;
        this.config = config;
        this.browser = browser; // null in extension mode
        this.proxy = proxy ? parseProxy(proxy) : null;
        this.extensionPath = extensionPath; // Path to unpacked extension folder
        this.isPersistentContext = false; // Track if using persistent context
        this.context = null;
        this.page = null;
        this.lastLoginTime = null;
        this.csrfToken = null; // Store CSRF token for requests

        // Initialize NopeCHA solver if configured
        this.nopecha = null;
        if (config.captcha && config.captcha.api_key) {
            try {
                const nopechaConfig = new Configuration({
                    apiKey: config.captcha.api_key,
                });
                this.nopecha = new NopeCHAApi(nopechaConfig);
                log('INFO', 'NopeCHA CAPTCHA solver initialized', this.accountId);
            } catch (e) {
                log('WARNING', `Failed to initialize NopeCHA: ${e.message}`, this.accountId);
            }
        }
    }

    async initContext() {
        // Generate realistic viewport (1280x720 ± small delta)
        // Common resolutions: 1280x720, 1366x768, 1920x1080, 1440x900
        const viewports = [
            { width: 1366, height: 768 },
        ];
        const randomViewport = viewports[Math.floor(Math.random() * viewports.length)];
        // Add small random variation (±20px)
        const viewport = {
            width: randomViewport.width + Math.floor(Math.random() * 41) - 20,
            height: randomViewport.height + Math.floor(Math.random() * 41) - 20
        };
        
        // Use current Chrome version (145) matching the request headers
        const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
        
        // Determine locale and timezone based on proxy region
        // Default to North America (en-US, America/New_York) if no proxy or unknown
        let locale = 'en-US';
        let timezoneId = 'America/New_York';
        
        if (this.proxy && this.proxy.server) {
            // Try to infer region from proxy hostname
            const proxyHost = this.proxy.server.toLowerCase();
            if (proxyHost.includes('.ca') || proxyHost.includes('canada')) {
                locale = 'en-CA';
                timezoneId = 'America/Toronto';
            } else if (proxyHost.includes('.uk') || proxyHost.includes('united-kingdom')) {
                locale = 'en-GB';
                timezoneId = 'Europe/London';
            } else if (proxyHost.includes('.de') || proxyHost.includes('germany')) {
                locale = 'de-DE';
                timezoneId = 'Europe/Berlin';
            } else if (proxyHost.includes('.fr') || proxyHost.includes('france')) {
                locale = 'fr-FR';
                timezoneId = 'Europe/Paris';
            } else if (proxyHost.includes('.jp') || proxyHost.includes('japan')) {
                locale = 'ja-JP';
                timezoneId = 'Asia/Tokyo';
            }
            // Default to en-US for US proxies or unknown
        }
        
        // Add proxy if available
        if (this.proxy) {
            log('INFO', `Using proxy: ${this.proxy.server}`, this.accountId);
            log('DEBUG', `Proxy username: ${this.proxy.username ? this.proxy.username.substring(0, 3) + '***' : 'not set'}`, this.accountId);
            log('DEBUG', `Proxy password: ${this.proxy.password ? '***' : 'not set'}`, this.accountId);
            log('DEBUG', `Locale: ${locale}, Timezone: ${timezoneId} (inferred from proxy)`, this.accountId);
        } else {
            log('INFO', 'No proxy configured for this account', this.accountId);
            log('DEBUG', `Locale: ${locale}, Timezone: ${timezoneId} (default)`, this.accountId);
        }

        log('DEBUG', `Viewport: ${viewport.width}x${viewport.height}`, this.accountId);
        log('DEBUG', `User-Agent: ${userAgent}`, this.accountId);

        if (this.extensionPath) {
            // ===== EXTENSION MODE: launchPersistentContext =====
            // Each account gets its own browser + Chrome profile with extension loaded
            const userDataDir = path.join(os.tmpdir(), `chrome-ext-profile-account-${this.accountId}`);

            // Clean profile directory to avoid restore dialogs
            if (fs.existsSync(userDataDir)) {
                try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) {}
            }
            fs.mkdirSync(userDataDir, { recursive: true });

            const extPath = path.resolve(this.extensionPath);
            log('INFO', `Extension mode: loading extension from ${extPath}`, this.accountId);
            log('INFO', `Chrome profile: ${userDataDir}`, this.accountId);

            const launchOptions = {
                headless: false, // Extensions REQUIRE headed mode
                viewport: viewport,
                userAgent: userAgent,
                locale: locale,
                timezoneId: timezoneId,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-blink-features=AutomationControlled',
                    '--disable-features=IsolateOrigins,site-per-process',
                    `--disable-extensions-except=${extPath}`,
                    `--load-extension=${extPath}`,
                ]
            };

            if (this.proxy) {
                launchOptions.proxy = this.proxy;
            }

            this.context = await chromium.launchPersistentContext(userDataDir, launchOptions);
            this.isPersistentContext = true;

            // Persistent context may already have a page open
            const existingPages = this.context.pages();
            this.page = existingPages.length > 0 ? existingPages[0] : await this.context.newPage();

            log('INFO', `Persistent context launched with extension (${existingPages.length} existing pages)`, this.accountId);
        } else {
            // ===== STANDARD MODE: shared browser + newContext =====
            const contextOptions = {
                viewport: viewport,
                userAgent: userAgent,
                locale: locale,
                timezoneId: timezoneId
            };

            if (this.proxy) {
                contextOptions.proxy = this.proxy;
            }

            this.context = await this.browser.newContext(contextOptions);
            this.page = await this.context.newPage();
        }

        // Set geolocation to deny location access
        await this.context.setGeolocation({ latitude: 0, longitude: 0 });
        await this.context.setExtraHTTPHeaders({
            'Accept-Language': `${locale},${locale.split('-')[0]};q=0.9`
        });
        
        // IMPORTANT: Do NOT use page.route() to intercept/modify requests.
        // Playwright's route.continue({ headers }) REPLACES all browser-managed headers,
        // which strips cookies (including aws-waf-token), Origin, and Referer.
        // This causes AWS CloudFront WAF to return 403.
        // Instead, let the browser handle all requests naturally — it will automatically
        // include all cookies, Origin, Referer, and Sec-Fetch-* headers correctly.

        // Use passive response monitoring for debugging only
        this.page.on('response', async (response) => {
            const url = response.url();
            const status = response.status();
            const method = response.request().method();

            if (method === 'POST' && (url.includes('sign-in') || url.includes('authentication'))) {
                log('INFO', `POST ${url.substring(0, 100)} → ${status}`, this.accountId);
                if (status === 403) {
                    log('ERROR', `403 on POST request — WAF or server blocked the request`, this.accountId);
                    try {
                        const body = await response.text();
                        log('DEBUG', `403 body (first 300 chars): ${body.substring(0, 300)}`, this.accountId);
                    } catch (e) {}
                }
            }
        });
        
        // Stealth evasions — hide automation signals from WAF/bot detection
        await this.page.addInitScript(() => {
            // Remove webdriver flag
            Object.defineProperty(navigator, 'webdriver', { get: () => false });

            // Override geolocation API
            if (navigator.geolocation) {
                navigator.geolocation.getCurrentPosition = function(success, error) {
                    if (error) error({ code: 1, message: 'User denied Geolocation' });
                };
                navigator.geolocation.watchPosition = function(success, error) {
                    if (error) error({ code: 1, message: 'User denied Geolocation' });
                };
            }

            // Fix chrome.runtime to look like a real browser
            window.chrome = window.chrome || {};
            window.chrome.runtime = window.chrome.runtime || {};

            // Fix permissions API
            const originalQuery = window.navigator.permissions?.query;
            if (originalQuery) {
                window.navigator.permissions.query = (parameters) =>
                    parameters.name === 'notifications'
                        ? Promise.resolve({ state: Notification.permission })
                        : originalQuery(parameters);
            }

            // Fix plugins to look like real Chrome
            Object.defineProperty(navigator, 'plugins', {
                get: () => [1, 2, 3, 4, 5]
            });

            // Fix languages
            Object.defineProperty(navigator, 'languages', {
                get: () => ['en-US', 'en']
            });
        });
        
        log('INFO', `Browser context initialized with location access blocked and request headers configured`, this.accountId);
    }

    async _findSelector(selectorString, timeout = 5000) {
        const selectors = selectorString.split(',').map(s => s.trim());
        for (const selector of selectors) {
            try {
                await this.page.waitForSelector(selector, { timeout, state: 'visible' });
                const element = await this.page.$(selector);
                if (element) {
                    return selector;
                }
            } catch (error) {
                // Continue to next selector
            }
        }
        return selectors[0];
    }

    async _waitForWafToken(maxWaitTime = 10000) {
        // Wait specifically for the aws-waf-token cookie — this is what CloudFront WAF checks.
        // Other tracking cookies (Adobe, mbox, etc.) are NOT required for the sign-in POST.
        const startTime = Date.now();

        while (Date.now() - startTime < maxWaitTime) {
            const cookies = await this.context.cookies();
            const wafToken = cookies.find(c => c.name === 'aws-waf-token');

            if (wafToken) {
                log('INFO', `aws-waf-token found (${cookies.length} total cookies)`, this.accountId);
                return true;
            }

            await this.page.waitForTimeout(500);
        }

        log('WARNING', `aws-waf-token not found after ${maxWaitTime}ms`, this.accountId);
        return false;
    }

    async login() {
        try {
            log('INFO', '=== LOGIN FUNCTION CALLED ===', this.accountId);
            log('INFO', `Page object exists: ${this.page !== null}`, this.accountId);
            
            if (!this.page) {
                log('ERROR', 'Page is null, cannot proceed with login', this.accountId);
                throw new Error('Page not initialized');
            }
            
            // Step 1: Navigate to hiring.amazon.ca first
            const hiringUrl = 'https://hiring.amazon.ca';
            log('INFO', `Step 1: Navigating to ${hiringUrl}`, this.accountId);
            
            // Add response listener to check for errors
            let responseError = null;
            const responseHandler = async (response) => {
                const status = response.status();
                const url = response.url();
                if (status >= 400) {
                    responseError = {
                        status: status,
                        url: url,
                        statusText: response.statusText()
                    };
                    
                    // Special handling for 407 Proxy Authentication Required
                    if (status === 407) {
                        log('ERROR', `HTTP 407 Proxy Authentication Required when loading ${url}`, this.accountId);
                        log('ERROR', 'This indicates the proxy credentials are incorrect or not being sent properly', this.accountId);
                        if (this.proxy) {
                            log('ERROR', `Proxy server: ${this.proxy.server}`, this.accountId);
                            log('ERROR', `Proxy username: ${this.proxy.username ? this.proxy.username.substring(0, 3) + '***' : 'not set'}`, this.accountId);
                            log('ERROR', 'Please verify your proxy credentials in proxies.json are correct', this.accountId);
                            log('ERROR', 'You can test the proxy with: curl -x http://username:password@host:port https://httpbin.org/ip', this.accountId);
                        } else {
                            log('ERROR', 'No proxy configured but received 407 error - this is unexpected', this.accountId);
                        }
                    } else if (url.includes('hiring.amazon.ca') && status >= 400) {
                        log('ERROR', `HTTP ${status} error when loading ${url}: ${response.statusText()}`, this.accountId);
                    }
                }
            };
            this.page.on('response', responseHandler);
            
            // Try navigation with retry logic
            let navigationSuccess = false;
            const maxRetries = 3;
            let lastError = null;
            
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    log('INFO', `Navigation attempt ${attempt}/${maxRetries}`, this.accountId);
                    responseError = null; // Reset error for this attempt
                    
                    // Try different wait strategies based on attempt
                    const waitStrategy = attempt === 1 ? 'domcontentloaded' : 
                                       attempt === 2 ? 'load' : 
                                       'commit';
                    
                    const response = await this.page.goto(hiringUrl, {
                        waitUntil: waitStrategy,
                        timeout: this.config.timing.page_load_timeout
                    });
                    
                    // Check response status
                    if (response) {
                        const status = response.status();
                        log('INFO', `Navigation response status: ${status}`, this.accountId);
                        
                        if (status >= 400) {
                            const errorMsg = `Page returned error status ${status}: ${response.statusText()}`;
                            log('ERROR', errorMsg, this.accountId);
                            throw new Error(errorMsg);
                        }
                    }
                    
                    // Check if responseError was set
                    if (responseError) {
                        throw new Error(`HTTP ${responseError.status} error: ${responseError.statusText}`);
                    }
                    
                    // Wait a bit and check if page actually loaded
                    await this.page.waitForTimeout(2000);
                    const pageUrl = this.page.url();
                    
                    // Check for error messages in the page
                    try {
                        const pageText = await this.page.textContent('body').catch(() => '');
                        if (pageText.toLowerCase().includes('page is not working') || 
                            pageText.toLowerCase().includes('this site can\'t be reached') ||
                            pageText.toLowerCase().includes('err_')) {
                            log('ERROR', `Page shows error message. Attempt ${attempt}/${maxRetries}`, this.accountId);
                            if (attempt < maxRetries) {
                                log('INFO', 'Retrying navigation...', this.accountId);
                                await this.page.waitForTimeout(3000); // Wait before retry
                                continue;
                            } else {
                                throw new Error('Page is not working - connection or server error');
                            }
                        }
                    } catch (checkError) {
                        // If we can't check, continue anyway
                        log('DEBUG', `Could not verify page content: ${checkError.message}`, this.accountId);
                    }
                    
                    navigationSuccess = true;
                    log('INFO', 'Navigation to hiring.amazon.ca completed successfully', this.accountId);
                    break;
                    
                } catch (navError) {
                    lastError = navError;
                    log('WARNING', `Navigation attempt ${attempt} failed: ${navError.message}`, this.accountId);
                    
                    if (attempt < maxRetries) {
                        log('INFO', `Retrying navigation (attempt ${attempt + 1}/${maxRetries})...`, this.accountId);
                        await this.page.waitForTimeout(3000); // Wait before retry
                    } else {
                        // Last attempt failed, check page content for error messages
                        try {
                            const pageText = await this.page.textContent('body').catch(() => '');
                            const currentUrl = this.page.url();
                            
                            log('INFO', `Current URL after failed navigation: ${currentUrl}`, this.accountId);
                            
                            // Check for common error messages in page
                            const errorIndicators = [
                                'page is not working',
                                'this site can\'t be reached',
                                'connection refused',
                                'timeout',
                                'error',
                                'not available',
                                '502',
                                '503',
                                '504'
                            ];
                            
                            const lowerText = pageText.toLowerCase();
                            for (const indicator of errorIndicators) {
                                if (lowerText.includes(indicator)) {
                                    log('ERROR', `Page contains error indicator: "${indicator}"`, this.accountId);
                                    break;
                                }
                            }
                            
                            // Log page title for debugging
                            const title = await this.page.title().catch(() => '');
                            log('INFO', `Page title: ${title}`, this.accountId);
                            
                        } catch (contentError) {
                            log('WARNING', `Could not check page content: ${contentError.message}`, this.accountId);
                        }
                    }
                }
            }
            
            // Remove response handler after navigation
            this.page.off('response', responseHandler);
            
            // If navigation failed after all retries, throw error
            if (!navigationSuccess) {
                log('ERROR', `Navigation to hiring.amazon.ca failed after ${maxRetries} attempts`, this.accountId);
                throw lastError || new Error('Navigation failed after all retries');
            }
            
            // Wait for page to load
            await this.page.waitForTimeout(2000);
            
            // Check if page actually loaded successfully
            const pageUrl = this.page.url();
            log('INFO', `Page loaded, current URL: ${pageUrl}`, this.accountId);
            
            // Verify we're on the right page
            if (!pageUrl.includes('hiring.amazon.ca') && !pageUrl.includes('auth.hiring.amazon.com')) {
                log('WARNING', `Unexpected URL after navigation: ${pageUrl}`, this.accountId);
            }
            
            // Check for error messages in the page
            try {
                const pageText = await this.page.textContent('body').catch(() => '');
                if (pageText.toLowerCase().includes('page is not working') || 
                    pageText.toLowerCase().includes('this site can\'t be reached')) {
                    log('ERROR', 'Page shows error message: "page is not working"', this.accountId);
                    throw new Error('Page is not working - connection or server error');
                }
            } catch (checkError) {
                // If we can't check, continue anyway
                log('DEBUG', `Could not verify page content: ${checkError.message}`, this.accountId);
            }
            
            // Find and click consent button if it exists - MUST be done before navigation
            log('INFO', 'Step 1.5: Looking for consent button with id="consentBtn"...', this.accountId);
            let consentButtonClicked = false;
            let consentButtonFound = false;
            
            try {
                // Wait for consent button to appear (with timeout)
                try {
                    await this.page.waitForSelector('#consentBtn', {
                        timeout: 5000,
                        state: 'attached'
                    });
                    consentButtonFound = true;
                } catch (e) {
                    log('DEBUG', 'Consent button not found in DOM (may not be present)', this.accountId);
                }
                
                if (consentButtonFound) {
                    // Try multiple times to click the consent button
                    const maxConsentAttempts = 3;
                    for (let attempt = 1; attempt <= maxConsentAttempts; attempt++) {
                        try {
                            const consentButton = await this.page.$('#consentBtn');
                            if (consentButton) {
                                const isVisible = await consentButton.isVisible();
                                const isEnabled = await consentButton.isEnabled();
                                log('INFO', `Consent button attempt ${attempt}/${maxConsentAttempts} - visible=${isVisible}, enabled=${isEnabled}`, this.accountId);
                                
                                if (isVisible && isEnabled) {
                                    await consentButton.scrollIntoViewIfNeeded();
                                    await this.page.waitForTimeout(500);
                                    log('INFO', 'Clicking consent button...', this.accountId);
                                    
                                    // Try clicking with multiple methods
                                    try {
                                        await consentButton.click({ timeout: 5000 });
                                    } catch (clickError) {
                                        if (clickError.message.includes('intercepts') || clickError.message.includes('backdrop')) {
                                            log('WARNING', 'Click blocked, trying force click...', this.accountId);
                                            await consentButton.click({ force: true, timeout: 5000 });
                                        } else {
                                            throw clickError;
                                        }
                                    }
                                    
                                    // Wait for button to disappear or become hidden (indicating it was processed)
                                    log('INFO', 'Waiting for consent button to be processed...', this.accountId);
                                    await this.page.waitForTimeout(1000);
                                    
                                    // Verify consent button is gone or hidden
                                    const consentButtonAfter = await this.page.$('#consentBtn');
                                    if (consentButtonAfter) {
                                        const stillVisible = await consentButtonAfter.isVisible();
                                        if (!stillVisible) {
                                            log('INFO', 'Consent button clicked successfully (button is now hidden)', this.accountId);
                                            consentButtonClicked = true;
                                            break;
                                        } else {
                                            log('WARNING', `Consent button still visible after click (attempt ${attempt})`, this.accountId);
                                            if (attempt < maxConsentAttempts) {
                                                await this.page.waitForTimeout(1000);
                                                continue;
                                            }
                                        }
                                    } else {
                                        log('INFO', 'Consent button clicked successfully (button removed from DOM)', this.accountId);
                                        consentButtonClicked = true;
                                        break;
                                    }
                                } else {
                                    if (!isVisible && !isEnabled) {
                                        log('INFO', 'Consent button found but already processed (not visible/enabled)', this.accountId);
                                        consentButtonClicked = true;
                                        break;
                                    }
                                }
                            } else {
                                // Button no longer exists - likely already clicked
                                log('INFO', 'Consent button no longer exists (likely already processed)', this.accountId);
                                consentButtonClicked = true;
                                break;
                            }
                        } catch (attemptError) {
                            log('WARNING', `Consent button click attempt ${attempt} failed: ${attemptError.message}`, this.accountId);
                            if (attempt < maxConsentAttempts) {
                                await this.page.waitForTimeout(1000);
                            }
                        }
                    }
                    
                    if (!consentButtonClicked) {
                        log('WARNING', 'Consent button was found but could not be clicked after all attempts', this.accountId);
                        log('WARNING', 'Proceeding anyway, but navigation may fail if consent is required', this.accountId);
                    }
                } else {
                    log('INFO', 'Consent button not found - may not be required for this page', this.accountId);
                    consentButtonClicked = true; // No consent needed
                }
            } catch (consentError) {
                log('WARNING', `Error handling consent button: ${consentError.message}`, this.accountId);
                log('WARNING', 'Proceeding anyway, but navigation may fail if consent is required', this.accountId);
            }
            
            // Wait additional time after consent to ensure page is ready
            if (consentButtonClicked) {
                log('INFO', 'Consent handled, waiting for page to be ready...', this.accountId);
                await this.page.waitForTimeout(1000);
            }
            
            // Handle location permission popup if it appears
            log('INFO', 'Checking for location permission popup...', this.accountId);
            try {
                // Wait a bit for popup to appear
                await this.page.waitForTimeout(1500);
                
                // Try multiple methods to dismiss the location popup
                let popupDismissed = false;
                
                // Method 1: Look for "Never allow" button (most common)
                try {
                    const neverAllowButton = await this.page.$('button:has-text("Never allow")');
                    if (neverAllowButton) {
                        const isVisible = await neverAllowButton.isVisible();
                        if (isVisible) {
                            log('INFO', 'Found "Never allow" button, clicking...', this.accountId);
                            await neverAllowButton.click();
                            popupDismissed = true;
                            await this.page.waitForTimeout(1000);
                        }
                    }
                } catch (e) {
                    log('DEBUG', 'Could not find "Never allow" button', this.accountId);
                }
                
                // Method 2: Look for close button (X) in popup
                if (!popupDismissed) {
                    try {
                        // Look for X button in various positions
                        const closeButtons = await this.page.$$('button[aria-label*="close" i], button[aria-label*="dismiss" i], [role="button"][aria-label*="close" i]');
                        for (const btn of closeButtons) {
                            if (await btn.isVisible()) {
                                log('INFO', 'Found close button, clicking...', this.accountId);
                                await btn.click();
                                popupDismissed = true;
                                await this.page.waitForTimeout(1000);
                                break;
                            }
                        }
                    } catch (e) {
                        log('DEBUG', 'Could not find close button', this.accountId);
                    }
                }
                
                // Method 3: Press Escape key
                if (!popupDismissed) {
                    try {
                        log('INFO', 'Pressing Escape to dismiss popup...', this.accountId);
                        await this.page.keyboard.press('Escape');
                        await this.page.waitForTimeout(1000);
                        popupDismissed = true;
                    } catch (e) {
                        log('DEBUG', 'Escape key did not work', this.accountId);
                    }
                }
                
                // Method 4: Click outside popup (click on a safe area like top navigation)
                if (!popupDismissed) {
                    try {
                        log('INFO', 'Clicking outside popup area...', this.accountId);
                        // Click on navigation bar area (should be safe)
                        await this.page.click('body', { 
                            position: { x: 500, y: 50 },
                            force: true 
                        });
                        await this.page.waitForTimeout(1000);
                    } catch (e) {
                        log('DEBUG', 'Click outside did not work', this.accountId);
                    }
                }
                
                log('INFO', 'Location popup handling completed', this.accountId);
            } catch (error) {
                log('WARNING', `Error handling location popup: ${error.message}`, this.accountId);
                // Continue anyway - popup might not be present or already dismissed
            }
            
            // Additional wait to ensure popup is gone
            await this.page.waitForTimeout(1000);
            
            // Step 2: Find and click "My Account" link with data-test-id="topPanelMyAccountLink"
            log('INFO', 'Step 2: Looking for topPanelMyAccountLink', this.accountId);
            try {
                await this.page.waitForSelector('[data-test-id="topPanelMyAccountLink"]', {
                    timeout: 15000,
                    state: 'visible'
                });
                log('INFO', 'topPanelMyAccountLink found, clicking...', this.accountId);
                await this.page.click('[data-test-id="topPanelMyAccountLink"]');
                log('INFO', 'topPanelMyAccountLink clicked', this.accountId);
                await this.page.waitForTimeout(1000);
            } catch (error) {
                log('ERROR', `Failed to find/click topPanelMyAccountLink: ${error.message}`, this.accountId);
                throw new Error(`Could not click My Account link: ${error.message}`);
            }
            
            // Step 3: Find and click "Sign In" link with data-test-id="topPanelSigninLink"
            log('INFO', 'Step 3: Looking for topPanelSigninLink', this.accountId);
            try {
                await this.page.waitForSelector('[data-test-id="topPanelSigninLink"]', {
                    timeout: 15000,
                    state: 'visible'
                });
                log('INFO', 'topPanelSigninLink found, clicking...', this.accountId);
                await this.page.click('[data-test-id="topPanelSigninLink"]');
                log('INFO', 'topPanelSigninLink clicked', this.accountId);
                await this.page.waitForTimeout(2000);
                
                // Wait for navigation to login page
                log('INFO', 'Waiting for navigation to login page...', this.accountId);
                await this.page.waitForNavigation({
                    waitUntil: 'networkidle',
                    timeout: 15000
                }).catch(() => {
                    // Navigation might already be complete
                    log('INFO', 'Navigation may have already completed', this.accountId);
                });
                
                log('INFO', 'Current URL after sign in click: ' + this.page.url(), this.accountId);
            } catch (error) {
                log('ERROR', `Failed to find/click topPanelSigninLink: ${error.message}`, this.accountId);
                throw new Error(`Could not click Sign In link: ${error.message}`);
            }
            
            // Step 4: Verify we're on the login page, if not navigate directly
            const currentUrl = this.page.url();
            if (!currentUrl.includes('auth.hiring.amazon.com') && !currentUrl.includes('/login')) {
                log('WARNING', `Not on login page (${currentUrl}), navigating directly...`, this.accountId);
                const loginUrl = 'https://auth.hiring.amazon.com/#/login';
                await this.page.goto(loginUrl, {
                    waitUntil: 'networkidle',
                    timeout: this.config.timing.page_load_timeout
                });
                log('INFO', 'Direct navigation to login page completed', this.accountId);
            } else {
                log('INFO', 'Already on login page', this.accountId);
            }

            // Wait for page to fully load
            log('INFO', 'Waiting for page to stabilize...', this.accountId);
            await this.page.waitForTimeout(2000);
            log('INFO', 'Page loaded, current URL: ' + this.page.url(), this.accountId);

            // Find email input with id="login" and name="login EmailId"
            log('INFO', 'Looking for email input (id="login", name="login EmailId")', this.accountId);
            let emailSelector = '#login[name="login EmailId"]';
            
            try {
                await this.page.waitForSelector(emailSelector, {
                    timeout: 15000,
                    state: 'visible'
                });
                log('INFO', 'Email input found with primary selector', this.accountId);
            } catch (error) {
                // Try alternative selectors if the specific one doesn't work
                log('WARNING', 'Primary email selector not found, trying alternatives', this.accountId);
                const altSelectors = [
                    '#login',
                    'input[name="login EmailId"]',
                    'input#login',
                    ...this.config.selectors.email_field.split(',').map(s => s.trim())
                ];
                
                let found = false;
                for (const selector of altSelectors) {
                    try {
                        await this.page.waitForSelector(selector, { timeout: 3000, state: 'visible' });
                        emailSelector = selector;
                        found = true;
                        log('INFO', `Using alternative email selector: ${selector}`, this.accountId);
                        break;
                    } catch (e) {
                        log('DEBUG', `Selector ${selector} not found, trying next...`, this.accountId);
                        continue;
                    }
                }
                
                if (!found) {
                    log('ERROR', 'Email input field not found after trying all selectors', this.accountId);
                    log('ERROR', `Tried selectors: ${emailSelector}, ${altSelectors.join(', ')}`, this.accountId);
                    throw new Error('Email input field not found');
                }
            }

            // Fill email
            log('INFO', `Email selector found: ${emailSelector}`, this.accountId);
            log('INFO', `Filling email: ${this.account.email}`, this.accountId);
            await this.page.fill(emailSelector, this.account.email);
            log('INFO', 'Email filled successfully', this.accountId);
            await this.page.waitForTimeout(this.config.timing.action_delay);

            // Click continue button after email - find within #pageRouter element
            // Use specific selector: data-test-id="button-continue" with class "e4s171p0 css-gehx51"
            log('INFO', 'Looking for continue button within #pageRouter element', this.accountId);
            
            let continueButtonClicked = false;
            
            // Wait for pageRouter element to be present first
            try {
                await this.page.waitForSelector('#pageRouter', {
                    timeout: 10000,
                    state: 'attached'
                });
                log('INFO', '#pageRouter element found', this.accountId);
            } catch (error) {
                log('WARNING', `#pageRouter element not found: ${error.message}`, this.accountId);
            }
            
            // Wait a bit for any modals/backdrops to settle
            await this.page.waitForTimeout(1000);
            
            // Try to dismiss any modal backdrop that might be blocking
            try {
                const backdrop = await this.page.$('[data-test-component="StencilModalBackdrop"]');
                if (backdrop) {
                    log('INFO', 'Modal backdrop detected, attempting to dismiss...', this.accountId);
                    // Try clicking outside or pressing Escape
                    await this.page.keyboard.press('Escape');
                    await this.page.waitForTimeout(500);
                }
            } catch (e) {
                // Ignore if backdrop not found
            }
            
            // Try multiple selector strategies
            const selectors = [
                '#pageRouter button[data-test-id="button-continue"].e4s171p0.css-gehx51',
                '#pageRouter button[data-test-id="button-continue"][class*="e4s171p0"][class*="css-gehx51"]',
                '#pageRouter button[data-test-id="button-continue"]',
                'button[data-test-id="button-continue"].e4s171p0.css-gehx51',
                'button[data-test-id="button-continue"][class*="e4s171p0"][class*="css-gehx51"]',
                'button[data-test-id="button-continue"]'
            ];
            
            for (const selector of selectors) {
                if (continueButtonClicked) break;
                
                try {
                    log('INFO', `Trying selector: ${selector}`, this.accountId);
                    
                    await this.page.waitForSelector(selector, {
                        timeout: 5000,
                        state: 'visible'
                    });
                    
                    const button = await this.page.$(selector);
                    if (button) {
                        // Scroll button into view
                        await button.scrollIntoViewIfNeeded();
                        await this.page.waitForTimeout(500);
                        
                        // Check if button is enabled and visible
                        const isEnabled = await button.isEnabled();
                        const isVisible = await button.isVisible();
                        log('INFO', `Button found - enabled=${isEnabled}, visible=${isVisible}`, this.accountId);
                        
                        if (isEnabled && isVisible) {
                            // Try normal click first
                            try {
                                log('INFO', 'Attempting normal click...', this.accountId);
                                await button.click({ timeout: 3000 });
                                log('INFO', 'Continue button clicked successfully', this.accountId);
                                continueButtonClicked = true;
                                break;
                            } catch (clickError) {
                                // If normal click fails due to backdrop, try force click
                                if (clickError.message.includes('intercepts pointer events') || 
                                    clickError.message.includes('backdrop')) {
                                    log('WARNING', 'Normal click blocked by backdrop, trying force click...', this.accountId);
                                    try {
                                        await button.click({ force: true, timeout: 3000 });
                                        log('INFO', 'Continue button clicked with force', this.accountId);
                                        continueButtonClicked = true;
                                        break;
                                    } catch (forceError) {
                                        log('WARNING', `Force click also failed: ${forceError.message}`, this.accountId);
                                    }
                                } else {
                                    throw clickError;
                                }
                            }
                        }
                    }
                } catch (error) {
                    log('DEBUG', `Selector ${selector} failed: ${error.message}`, this.accountId);
                    continue;
                }
            }
            
            // If still not clicked, try JavaScript click as last resort
            if (!continueButtonClicked) {
                try {
                    log('INFO', 'Trying JavaScript click as last resort...', this.accountId);
                    await this.page.evaluate(() => {
                        const button = document.querySelector('#pageRouter button[data-test-id="button-continue"]') ||
                                     document.querySelector('button[data-test-id="button-continue"]');
                        if (button) {
                            button.click();
                            return true;
                        }
                        return false;
                    });
                    log('INFO', 'JavaScript click executed', this.accountId);
                    continueButtonClicked = true;
                    await this.page.waitForTimeout(1000);
                } catch (jsError) {
                    log('WARNING', `JavaScript click failed: ${jsError.message}`, this.accountId);
                }
            }
            
            if (continueButtonClicked) {
                await this.page.waitForTimeout(this.config.timing.action_delay);
            } else {
                log('WARNING', 'Continue button not clicked, proceeding to PIN field anyway...', this.accountId);
            }

            // Wait for PIN field to appear after clicking continue (page doesn't refresh, components change)
            log('INFO', 'Waiting for PIN field to appear (components are changing)...', this.accountId);
            await this.page.waitForTimeout(2000);
            
            // Find PIN input with id="pin" and name="pin"
            log('INFO', 'Looking for PIN input with id="pin" and name="pin"', this.accountId);
            let pinSelector = '#pin[name="pin"]';
            let pinFound = false;
            
            try {
                await this.page.waitForSelector(pinSelector, {
                    timeout: 15000,
                    state: 'visible'
                });
                log('INFO', 'PIN input found with primary selector', this.accountId);
                pinFound = true;
            } catch (error) {
                log('WARNING', 'Primary PIN selector not found, trying alternatives', this.accountId);
                // Try alternative selectors
                const altPinSelectors = [
                    '#pin',
                    'input[name="pin"]',
                    'input#pin',
                    ...this.config.selectors.pin_field.split(',').map(s => s.trim())
                ];
                
                for (const selector of altPinSelectors) {
                    try {
                        await this.page.waitForSelector(selector, { timeout: 3000, state: 'visible' });
                        pinSelector = selector;
                        pinFound = true;
                        log('INFO', `Using alternative PIN selector: ${selector}`, this.accountId);
                        break;
                    } catch (e) {
                        continue;
                    }
                }
            }
            
            if (!pinFound) {
                log('ERROR', 'PIN input field not found after trying all selectors', this.accountId);
                throw new Error('PIN input field not found');
            }

            // Fill PIN
            log('INFO', `PIN selector found: ${pinSelector}`, this.accountId);
            log('INFO', `Filling PIN: ${this.account.pin}`, this.accountId);
            await this.page.fill(pinSelector, this.account.pin);
            log('INFO', 'PIN filled successfully', this.accountId);
            await this.page.waitForTimeout(this.config.timing.action_delay);
            
            // Find and click continue button again (for PIN submission)
            // Button has class "e4s171p0 gehx51" and data-test-id "button-continue"
            log('INFO', 'Looking for continue button after PIN entry (class "e4s171p0 gehx51")', this.accountId);
            let pinContinueButtonClicked = false;
            
            // Wait a bit for button to be ready
            await this.page.waitForTimeout(500);
            
            // Try multiple selector strategies for the PIN continue button
            const pinContinueSelectors = [
                '#pageRouter button[data-test-id="button-continue"].e4s171p0.gehx51',
                '#pageRouter button[data-test-id="button-continue"][class*="e4s171p0"][class*="gehx51"]',
                'button[data-test-id="button-continue"].e4s171p0.gehx51',
                'button[data-test-id="button-continue"][class*="e4s171p0"][class*="gehx51"]',
                '#pageRouter button[data-test-id="button-continue"]',
                'button[data-test-id="button-continue"]'
            ];
            
            for (const selector of pinContinueSelectors) {
                if (pinContinueButtonClicked) break;
                
                try {
                    log('INFO', `Trying PIN continue button selector: ${selector}`, this.accountId);
                    
                    await this.page.waitForSelector(selector, {
                        timeout: 5000,
                        state: 'visible'
                    });
                    
                    const button = await this.page.$(selector);
                    if (button) {
                        await button.scrollIntoViewIfNeeded();
                        await this.page.waitForTimeout(500);
                        
                        const isEnabled = await button.isEnabled();
                        const isVisible = await button.isVisible();
                        log('INFO', `PIN continue button found - enabled=${isEnabled}, visible=${isVisible}`, this.accountId);
                        
                        if (isEnabled && isVisible) {
                            try {
                                log('INFO', 'Clicking PIN continue button...', this.accountId);
                                await button.click({ timeout: 5000 });
                                log('INFO', 'PIN continue button clicked successfully', this.accountId);
                                pinContinueButtonClicked = true;
                                break;
                            } catch (clickError) {
                                if (clickError.message.includes('intercepts pointer events') || 
                                    clickError.message.includes('backdrop')) {
                                    log('WARNING', 'Click blocked, trying force click...', this.accountId);
                                    await button.click({ force: true, timeout: 5000 });
                                    log('INFO', 'PIN continue button clicked with force', this.accountId);
                                    pinContinueButtonClicked = true;
                                    break;
                                } else {
                                    throw clickError;
                                }
                            }
                        }
                    }
                } catch (error) {
                    log('DEBUG', `PIN continue selector ${selector} failed: ${error.message}`, this.accountId);
                    continue;
                }
            }
            
            // JavaScript click as fallback
            if (!pinContinueButtonClicked) {
                try {
                    log('INFO', 'Trying JavaScript click for PIN continue button...', this.accountId);
                    await this.page.evaluate(() => {
                        const button = document.querySelector('#pageRouter button[data-test-id="button-continue"]') ||
                                     document.querySelector('button[data-test-id="button-continue"]');
                        if (button) {
                            button.click();
                            return true;
                        }
                        return false;
                    });
                    log('INFO', 'PIN continue button clicked via JavaScript', this.accountId);
                    pinContinueButtonClicked = true;
                    await this.page.waitForTimeout(1000);
                } catch (jsError) {
                    log('WARNING', `JavaScript click for PIN continue failed: ${jsError.message}`, this.accountId);
                }
            }
            
            if (pinContinueButtonClicked) {
                await this.page.waitForTimeout(this.config.timing.action_delay);
                
                // Wait for components to change (no page refresh, but different components shown)
                log('INFO', 'Waiting for components to change after PIN continue...', this.accountId);
                await this.page.waitForTimeout(2000);
            } else {
                log('WARNING', 'PIN continue button not clicked', this.accountId);
            }

            // Find and click button with aria-describedby="send_code_hint"
            // This appears after PIN continue button is clicked
            log('INFO', 'Looking for button with aria-describedby="send_code_hint"', this.accountId);
            let sendCodeButtonClicked = false;
            
            try {
                const sendCodeButtonSelector = 'button[aria-describedby="send_code_hint"]';
                
                await this.page.waitForSelector(sendCodeButtonSelector, {
                    timeout: 10000,
                    state: 'visible'
                });
                
                const sendCodeButton = await this.page.$(sendCodeButtonSelector);
                if (sendCodeButton) {
                    await sendCodeButton.scrollIntoViewIfNeeded();
                    await this.page.waitForTimeout(500);
                    
                    const isEnabled = await sendCodeButton.isEnabled();
                    const isVisible = await sendCodeButton.isVisible();
                    log('INFO', `Send code button found - enabled=${isEnabled}, visible=${isVisible}`, this.accountId);
                    
                    if (isEnabled && isVisible) {
                        try {
                            // Wait for aws-waf-token cookie (critical for WAF to allow the POST)
                            log('INFO', 'Waiting for aws-waf-token cookie...', this.accountId);
                            const wafTokenReady = await this._waitForWafToken(10000);
                            if (!wafTokenReady) {
                                log('WARNING', 'aws-waf-token not found, proceeding anyway', this.accountId);
                            }

                            // Wait for network to be idle (WAF challenges must complete)
                            try {
                                await this.page.waitForLoadState('networkidle', { timeout: 5000 });
                            } catch (e) {
                                log('DEBUG', 'Network idle timeout, continuing', this.accountId);
                            }

                            // Human-like delay before clicking
                            await this.page.waitForTimeout(1000 + Math.random() * 1000);

                            // Move mouse to button like a human would
                            try {
                                const box = await sendCodeButton.boundingBox();
                                if (box) {
                                    await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
                                    await this.page.waitForTimeout(200 + Math.random() * 300);
                                }
                            } catch (e) {
                                // Ignore mouse move errors
                            }

                            // Log cookie count for debugging
                            const finalCookies = await this.context.cookies();
                            log('INFO', `Cookie count before click: ${finalCookies.length}`, this.accountId);
                            const wafCookie = finalCookies.find(c => c.name === 'aws-waf-token');
                            log('INFO', `aws-waf-token present: ${!!wafCookie}`, this.accountId);

                            log('INFO', 'Clicking send code button...', this.accountId);
                            await sendCodeButton.click({ timeout: 5000 });

                            // Wait for the POST response
                            await this.page.waitForTimeout(3000);
                            sendCodeButtonClicked = true;
                        } catch (clickError) {
                            if (clickError.message.includes('intercepts pointer events') || 
                                clickError.message.includes('backdrop')) {
                                log('WARNING', 'Click blocked, trying force click...', this.accountId);
                                await sendCodeButton.click({ force: true, timeout: 5000 });
                                log('INFO', 'Send code button clicked with force', this.accountId);
                                sendCodeButtonClicked = true;
                            } else {
                                throw clickError;
                            }
                        }
                    }
                }
            } catch (error) {
                log('WARNING', `Send code button not found or click failed: ${error.message}`, this.accountId);
                
                // Try JavaScript click as fallback
                try {
                    log('INFO', 'Trying JavaScript click for send code button...', this.accountId);
                    await this.page.evaluate(() => {
                        const button = document.querySelector('button[aria-describedby="send_code_hint"]');
                        if (button) {
                            button.click();
                            return true;
                        }
                        return false;
                    });
                    log('INFO', 'Send code button clicked via JavaScript', this.accountId);
                    sendCodeButtonClicked = true;
                    await this.page.waitForTimeout(1000);
                } catch (jsError) {
                    log('WARNING', `JavaScript click for send code button failed: ${jsError.message}`, this.accountId);
                }
            }
            
            if (sendCodeButtonClicked) {
                await this.page.waitForTimeout(this.config.timing.action_delay);
                log('INFO', 'Waiting for captcha modal to appear...', this.accountId);
                await this.page.waitForTimeout(2000);
            } else {
                log('WARNING', 'Send code button not clicked, proceeding anyway...', this.accountId);
            }

            // Handle captcha modal - wait for modal with id "captchaModal" to appear
            log('INFO', 'Looking for captcha modal with id="captchaModal"', this.accountId);
            let captchaModalFound = false;
            let captchaAudioButtonClicked = false;
            
            try {
                // First check if modal exists in DOM (might be hidden initially)
                await this.page.waitForSelector('#captchaModal', {
                    timeout: 15000,
                    state: 'attached'
                });
                log('INFO', 'Captcha modal element found in DOM', this.accountId);
                
                // Wait for it to become visible
                try {
                    await this.page.waitForSelector('#captchaModal', {
                        timeout: 10000,
                        state: 'visible'
                    });
                    log('INFO', 'Captcha modal is now visible', this.accountId);
                    captchaModalFound = true;
                } catch (visibilityError) {
                    // Modal exists but might be hidden - try to make it visible or wait longer
                    log('WARNING', 'Captcha modal exists but not visible, waiting longer...', this.accountId);
                    await this.page.waitForTimeout(2000);
                    
                    // Check if it's visible now
                    const modal = await this.page.$('#captchaModal');
                    if (modal) {
                        const isVisible = await modal.isVisible();
                        if (isVisible) {
                            log('INFO', 'Captcha modal became visible after wait', this.accountId);
                            captchaModalFound = true;
                        } else {
                            log('WARNING', 'Captcha modal still hidden, trying to interact anyway', this.accountId);
                            captchaModalFound = true; // Try anyway
                        }
                    }
                }
                
                // Wait a bit for modal content to fully load
                await this.page.waitForTimeout(1000);
                
                // Find and click button with id "amzn-btn-audio-internal" within the modal
                log('INFO', 'Looking for captcha audio button with id="amzn-btn-audio-internal" in modal', this.accountId);
                
                try {
                    // Try finding within the modal first
                    const captchaButtonSelector = '#captchaModal #amzn-btn-audio-internal';
                    await this.page.waitForSelector(captchaButtonSelector, {
                        timeout: 10000,
                        state: 'visible'
                    });
                    
                    const captchaButton = await this.page.$(captchaButtonSelector);
                    if (captchaButton) {
                        await captchaButton.scrollIntoViewIfNeeded();
                        await this.page.waitForTimeout(500);
                        
                        const isEnabled = await captchaButton.isEnabled();
                        const isVisible = await captchaButton.isVisible();
                        log('INFO', `Captcha audio button found - enabled=${isEnabled}, visible=${isVisible}`, this.accountId);
                        
                        if (isEnabled && isVisible) {
                            try {
                                log('INFO', 'Clicking captcha audio button...', this.accountId);
                                await captchaButton.click({ timeout: 5000 });
                                log('INFO', 'Captcha audio button clicked successfully', this.accountId);
                                captchaAudioButtonClicked = true;
                            } catch (clickError) {
                                if (clickError.message.includes('intercepts pointer events') || 
                                    clickError.message.includes('backdrop')) {
                                    log('WARNING', 'Click blocked, trying force click...', this.accountId);
                                    await captchaButton.click({ force: true, timeout: 5000 });
                                    log('INFO', 'Captcha audio button clicked with force', this.accountId);
                                    captchaAudioButtonClicked = true;
                                } else {
                                    throw clickError;
                                }
                            }
                        }
                    }
                } catch (error) {
                    log('WARNING', `Captcha audio button not found in modal: ${error.message}`, this.accountId);
                    
                    // Try without modal scope (button might be outside modal structure)
                    try {
                        log('INFO', 'Trying to find button without modal scope...', this.accountId);
                        const globalButtonSelector = '#amzn-btn-audio-internal';
                        await this.page.waitForSelector(globalButtonSelector, {
                            timeout: 5000,
                            state: 'visible'
                        });
                        
                        const globalButton = await this.page.$(globalButtonSelector);
                        if (globalButton) {
                            await globalButton.scrollIntoViewIfNeeded();
                            await this.page.waitForTimeout(500);
                            
                            const isEnabled = await globalButton.isEnabled();
                            const isVisible = await globalButton.isVisible();
                            log('INFO', `Captcha audio button found (global) - enabled=${isEnabled}, visible=${isVisible}`, this.accountId);
                            
                            if (isEnabled && isVisible) {
                                try {
                                    log('INFO', 'Clicking captcha audio button (global)...', this.accountId);
                                    await globalButton.click({ timeout: 5000 });
                                    log('INFO', 'Captcha audio button clicked successfully', this.accountId);
                                    captchaAudioButtonClicked = true;
                                } catch (clickError) {
                                    if (clickError.message.includes('intercepts pointer events') || 
                                        clickError.message.includes('backdrop')) {
                                        log('WARNING', 'Click blocked, trying force click...', this.accountId);
                                        await globalButton.click({ force: true, timeout: 5000 });
                                        log('INFO', 'Captcha audio button clicked with force', this.accountId);
                                        captchaAudioButtonClicked = true;
                                    } else {
                                        throw clickError;
                                    }
                                }
                            }
                        }
                    } catch (globalError) {
                        log('WARNING', `Global captcha button search also failed: ${globalError.message}`, this.accountId);
                    }
                }
                
                // JavaScript click as fallback
                if (!captchaAudioButtonClicked) {
                    try {
                        log('INFO', 'Trying JavaScript click for captcha audio button...', this.accountId);
                        const clicked = await this.page.evaluate(() => {
                            // Try within modal first
                            const modal = document.querySelector('#captchaModal');
                            if (modal) {
                                const button = modal.querySelector('#amzn-btn-audio-internal');
                                if (button) {
                                    button.click();
                                    return true;
                                }
                            }
                            // Try globally
                            const globalButton = document.querySelector('#amzn-btn-audio-internal');
                            if (globalButton) {
                                globalButton.click();
                                return true;
                            }
                            return false;
                        });
                        
                        if (clicked) {
                            log('INFO', 'Captcha audio button clicked via JavaScript', this.accountId);
                            captchaAudioButtonClicked = true;
                            await this.page.waitForTimeout(1000);
                        } else {
                            log('WARNING', 'Captcha audio button not found in DOM', this.accountId);
                        }
                    } catch (jsError) {
                        log('WARNING', `JavaScript click for captcha audio button failed: ${jsError.message}`, this.accountId);
                    }
                }
                
            } catch (error) {
                log('WARNING', `Captcha modal not found or error: ${error.message}`, this.accountId);
                log('INFO', 'Proceeding without captcha handling...', this.accountId);
            }
            
            // Solve CAPTCHA using NopeCHA if audio button was clicked
            let captchaSolved = false;
            if (captchaAudioButtonClicked) {
                await this.page.waitForTimeout(this.config.timing.action_delay);
                log('INFO', 'Audio button clicked, now solving CAPTCHA...', this.accountId);

                const maxCaptchaAttempts = (this.config.captcha && this.config.captcha.max_attempts) || 3;
                const captchaTimeout = (this.config.captcha && this.config.captcha.timeout) || 60000;

                for (let attempt = 1; attempt <= maxCaptchaAttempts; attempt++) {
                    try {
                        log('INFO', `CAPTCHA solve attempt ${attempt}/${maxCaptchaAttempts}`, this.accountId);
                        captchaSolved = await this._solveCaptchaAudio(captchaTimeout);
                        if (captchaSolved) {
                            log('INFO', 'CAPTCHA solved successfully!', this.accountId);
                            break;
                        } else {
                            log('WARNING', `CAPTCHA solve attempt ${attempt} failed`, this.accountId);
                            if (attempt < maxCaptchaAttempts) {
                                // Try refreshing the audio challenge
                                log('INFO', 'Requesting new audio challenge...', this.accountId);
                                const refreshBtn = await this.page.$('#captchaModal button[aria-label="Get a new challenge"], #captchaModal .refresh-button, #captchaModal [data-test-id="refresh"]');
                                if (refreshBtn) {
                                    await refreshBtn.click({ force: true });
                                    await this.page.waitForTimeout(2000);
                                }
                                // Re-click audio button
                                const audioBtn = await this.page.$('#amzn-btn-audio-internal');
                                if (audioBtn) {
                                    await audioBtn.click({ force: true });
                                    await this.page.waitForTimeout(2000);
                                }
                            }
                        }
                    } catch (solveError) {
                        log('ERROR', `CAPTCHA solve error (attempt ${attempt}): ${solveError.message}`, this.accountId);
                    }
                }
            } else if (captchaModalFound) {
                log('WARNING', 'Captcha modal found but audio button not clicked', this.accountId);
            }

            // Wait for captcha overlay to clear after solving
            if (captchaSolved) {
                log('INFO', 'Waiting for CAPTCHA overlay to clear...', this.accountId);
                try {
                    await this.page.waitForFunction(() => {
                        const overlay = document.querySelector('#captchaModalOverlay');
                        if (!overlay) return true;
                        const style = window.getComputedStyle(overlay);
                        return style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none';
                    }, { timeout: 15000 });
                    log('INFO', 'CAPTCHA overlay cleared', this.accountId);
                    await this.page.waitForTimeout(1000);
                } catch (e) {
                    log('WARNING', 'CAPTCHA overlay did not clear, trying to proceed anyway...', this.accountId);
                }
            }

            // Click all continue/submit buttons until login completes.
            // After CAPTCHA, there may be multiple steps (e.g., send code → continue → OTP → continue).
            // We loop up to 5 times, clicking any visible continue/submit button each time.
            const maxButtonClicks = 5;
            for (let clickRound = 1; clickRound <= maxButtonClicks; clickRound++) {
                log('INFO', `Post-CAPTCHA button click round ${clickRound}/${maxButtonClicks}`, this.accountId);

                // First check if we're already logged in (not on login page anymore)
                const currentUrl = this.page.url();
                if (!currentUrl.includes('auth.hiring.amazon') && !currentUrl.includes('/login') && !currentUrl.includes('#/login')) {
                    log('INFO', 'No longer on login page — login appears successful!', this.accountId);
                    this.lastLoginTime = new Date();
                    return true;
                }

                // Check for logged-in indicator
                try {
                    const indicator = await this.page.$(this.config.selectors.logged_in_indicator);
                    if (indicator) {
                        log('INFO', 'Login successful — logged-in indicator found', this.accountId);
                        this.lastLoginTime = new Date();
                        return true;
                    }
                } catch (e) {}

                // Check for OTP input field — Amazon may ask for a verification code
                // Strategy 1: Named/attributed selectors
                const otpSelectors = [
                    'input[name="otp"]', 'input[name="verificationCode"]', 'input[name="code"]',
                    'input[name="otpCode"]', 'input[name="verifyCode"]', 'input[name="confirmCode"]',
                    'input[placeholder*="code" i]', 'input[placeholder*="otp" i]',
                    'input[placeholder*="verification" i]', 'input[placeholder*="enter" i]',
                    '#verificationCode', '#otp', '#code', '#otpCode',
                    'input[aria-label*="code" i]', 'input[aria-label*="verification" i]',
                    'input[aria-label*="otp" i]',
                    'input[type="tel"]', 'input[type="number"]',
                    'input[data-test-id*="otp" i]', 'input[data-test-id*="code" i]',
                    'input[data-test-id*="verify" i]',
                ];

                let otpFieldFound = false;
                let otpFieldSelector = null;
                for (const sel of otpSelectors) {
                    try {
                        const el = await this.page.$(sel);
                        if (el && await el.isVisible()) {
                            otpFieldFound = true;
                            otpFieldSelector = sel;
                            break;
                        }
                    } catch (e) {}
                }

                // Strategy 2: Check page text for OTP-related keywords
                if (!otpFieldFound) {
                    try {
                        const pageText = await this.page.evaluate(() => document.body.innerText.toLowerCase());
                        const isOtpPage = pageText.includes('verification code') || pageText.includes('enter code') ||
                            pageText.includes('enter the code') || pageText.includes('enter otp') ||
                            pageText.includes('we sent') || pageText.includes('we\'ve sent') ||
                            pageText.includes('sent a code') || pageText.includes('verify your') ||
                            pageText.includes('one-time') || pageText.includes('one time');

                        if (isOtpPage) {
                            log('INFO', 'Page text suggests OTP screen, looking for any visible text input...', this.accountId);
                            // Find any visible text/tel/number input that's not email/password
                            const genericInput = await this.page.evaluate(() => {
                                const inputs = document.querySelectorAll('input');
                                for (const inp of inputs) {
                                    if (inp.offsetParent === null) continue; // hidden
                                    const t = inp.type.toLowerCase();
                                    if (t === 'hidden' || t === 'password' || t === 'email' || t === 'checkbox' || t === 'radio') continue;
                                    const n = (inp.name || '').toLowerCase();
                                    if (n === 'email' || n === 'login emailid' || n === 'username') continue;
                                    return { found: true, name: inp.name, id: inp.id, type: inp.type };
                                }
                                return { found: false };
                            });
                            if (genericInput.found) {
                                // Build a selector for this input
                                if (genericInput.id) {
                                    otpFieldSelector = `#${genericInput.id}`;
                                } else if (genericInput.name) {
                                    otpFieldSelector = `input[name="${genericInput.name}"]`;
                                } else {
                                    otpFieldSelector = `input[type="${genericInput.type}"]`;
                                }
                                otpFieldFound = true;
                                log('INFO', `Found OTP input via page text detection: ${otpFieldSelector} (name=${genericInput.name}, id=${genericInput.id})`, this.accountId);
                            }
                        }
                    } catch (e) {
                        log('DEBUG', `Page text OTP detection error: ${e.message}`, this.accountId);
                    }
                }

                if (otpFieldFound && this.config.email_imap) {
                    log('INFO', `OTP input detected (${otpFieldSelector}), fetching OTP from email...`, this.accountId);

                    // Take debug screenshot before OTP
                    try {
                        await this.page.screenshot({ path: 'debug_otp_screen.png' });
                        log('INFO', 'Debug screenshot saved: debug_otp_screen.png', this.accountId);
                    } catch (e) {}

                    try {
                        const otp = await getOtpFromEmail(this.config.email_imap, this.account.email, 120000);
                        log('INFO', `OTP retrieved: ${otp}`, this.accountId);

                        // Fill OTP
                        const otpInput = await this.page.$(otpFieldSelector);
                        if (otpInput) {
                            await otpInput.fill(otp);
                            log('INFO', 'OTP filled into input field', this.accountId);
                            await this.page.waitForTimeout(1500);
                        }

                        // Take debug screenshot after OTP fill
                        try {
                            await this.page.screenshot({ path: 'debug_otp_filled.png' });
                            log('INFO', 'Debug screenshot saved: debug_otp_filled.png', this.accountId);
                        } catch (e) {}

                        // Click Verify/Continue button after OTP
                        log('INFO', 'Looking for Verify/Continue button after OTP...', this.accountId);
                        let verifyClicked = false;

                        // Log all buttons on page for debugging
                        try {
                            const allButtons = await this.page.evaluate(() => {
                                const btns = document.querySelectorAll('button, [role="button"], input[type="submit"], a.btn, a.button');
                                return Array.from(btns).map(b => ({
                                    tag: b.tagName,
                                    text: (b.textContent || b.value || '').trim().substring(0, 60),
                                    visible: b.offsetParent !== null,
                                    disabled: b.disabled,
                                    testComponent: b.getAttribute('data-test-component'),
                                    testId: b.getAttribute('data-test-id'),
                                    classes: b.className.substring(0, 100)
                                }));
                            });
                            log('INFO', `All buttons on page after OTP: ${JSON.stringify(allButtons)}`, this.accountId);
                        } catch (e) {}

                        // Try Playwright text-based selectors (case-insensitive matching)
                        const verifySelectors = [
                            'button:has-text("Verify")',
                            'button:has-text("Submit")',
                            'button:has-text("Confirm")',
                            'button:has-text("Continue")',
                            'button:has-text("Done")',
                            'button:has-text("Next")',
                            '[role="button"]:has-text("Verify")',
                            '[role="button"]:has-text("Continue")',
                            '[role="button"]:has-text("Submit")',
                        ];

                        for (const sel of verifySelectors) {
                            try {
                                const btn = await this.page.$(sel);
                                if (btn && await btn.isVisible() && await btn.isEnabled()) {
                                    const btnText = await btn.textContent().catch(() => '');
                                    log('INFO', `Clicking verify button: "${btnText.trim()}" (${sel})`, this.accountId);
                                    try {
                                        await btn.click({ timeout: 5000 });
                                    } catch (e) {
                                        await btn.click({ force: true, timeout: 5000 });
                                    }
                                    verifyClicked = true;
                                    break;
                                }
                            } catch (e) {}
                        }

                        // Fallback 1: JS click on any button with matching text
                        if (!verifyClicked) {
                            log('INFO', 'Trying JS fallback for verify button...', this.accountId);
                            const jsClicked = await this.page.evaluate(() => {
                                const elements = document.querySelectorAll('button, [role="button"], input[type="submit"], a.btn, a.button, div[onclick], span[onclick]');
                                const keywords = ['verify', 'submit', 'confirm', 'continue', 'done', 'next', 'send'];
                                for (const el of elements) {
                                    if (el.offsetParent === null || el.disabled) continue;
                                    const text = (el.textContent || el.value || '').toLowerCase().trim();
                                    if (keywords.some(kw => text.includes(kw))) {
                                        el.click();
                                        return (el.textContent || el.value || '').trim().substring(0, 60);
                                    }
                                }
                                return null;
                            });
                            if (jsClicked) {
                                log('INFO', `Clicked verify button via JS: "${jsClicked}"`, this.accountId);
                                verifyClicked = true;
                            }
                        }

                        // Fallback 2: click StencilReactButton (Amazon's standard button)
                        if (!verifyClicked) {
                            log('INFO', 'Trying StencilReactButton fallback...', this.accountId);
                            try {
                                const stencilBtns = await this.page.$$('button[data-test-component="StencilReactButton"]');
                                for (const btn of stencilBtns) {
                                    if (await btn.isVisible() && await btn.isEnabled()) {
                                        const text = await btn.textContent().catch(() => '');
                                        log('INFO', `Clicking StencilReactButton as verify: "${text.trim()}"`, this.accountId);
                                        await btn.click({ timeout: 5000 }).catch(() => btn.click({ force: true }));
                                        verifyClicked = true;
                                        break;
                                    }
                                }
                            } catch (e) {}
                        }

                        // Fallback 3: LAST RESORT — click ANY visible, enabled button on the page
                        if (!verifyClicked) {
                            log('INFO', 'Last resort: clicking any visible button on OTP page...', this.accountId);
                            const lastResort = await this.page.evaluate(() => {
                                const buttons = document.querySelectorAll('button, input[type="submit"]');
                                for (const btn of buttons) {
                                    if (btn.offsetParent === null || btn.disabled) continue;
                                    const text = (btn.textContent || btn.value || '').trim();
                                    // Skip obvious non-verify buttons
                                    const lower = text.toLowerCase();
                                    if (lower.includes('resend') || lower.includes('back') || lower.includes('cancel')) continue;
                                    btn.click();
                                    return text.substring(0, 60);
                                }
                                return null;
                            });
                            if (lastResort) {
                                log('INFO', `Clicked button via last resort: "${lastResort}"`, this.accountId);
                                verifyClicked = true;
                            }
                        }

                        if (verifyClicked) {
                            log('INFO', 'Verify button clicked after OTP, waiting for response...', this.accountId);

                            // Wait for the verify API call to complete
                            await this.page.waitForTimeout(3000);
                            try {
                                await this.page.waitForLoadState('networkidle', { timeout: 10000 });
                            } catch (e) {}

                            // Take debug screenshot after verify response
                            try {
                                await this.page.screenshot({ path: 'debug_after_verify.png' });
                                log('INFO', 'Debug screenshot saved: debug_after_verify.png', this.accountId);
                            } catch (e) {}

                            // After OTP verify → 200, Amazon often shows a "Continue" button.
                            // We must click it to complete the login redirect.
                            // Loop up to 5 times to click any remaining buttons until redirected.
                            for (let postVerifyRound = 1; postVerifyRound <= 5; postVerifyRound++) {
                                const currentPostUrl = this.page.url();
                                log('INFO', `Post-verify round ${postVerifyRound}/5, URL: ${currentPostUrl}`, this.accountId);

                                // If we've left the auth page, login is complete
                                if (!currentPostUrl.includes('auth.hiring.amazon')) {
                                    log('INFO', 'Redirected away from auth page — login successful!', this.accountId);
                                    this.lastLoginTime = new Date();
                                    return true;
                                }

                                // Look for and click any Continue/Submit/Next button
                                let postBtnClicked = false;

                                // Log all buttons for debugging
                                try {
                                    const btns = await this.page.evaluate(() => {
                                        return Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'))
                                            .filter(b => b.offsetParent !== null)
                                            .map(b => ({
                                                text: (b.textContent || b.value || '').trim().substring(0, 60),
                                                disabled: b.disabled,
                                                tag: b.tagName,
                                                testComponent: b.getAttribute('data-test-component')
                                            }));
                                    });
                                    log('INFO', `Visible buttons (post-verify round ${postVerifyRound}): ${JSON.stringify(btns)}`, this.accountId);
                                } catch (e) {}

                                // Strategy 1: Playwright text selectors
                                const postVerifySelectors = [
                                    'button:has-text("Continue")',
                                    'button:has-text("Done")',
                                    'button:has-text("Next")',
                                    'button:has-text("Proceed")',
                                    'button:has-text("Submit")',
                                    'button:has-text("OK")',
                                    'button:has-text("Go")',
                                    '[role="button"]:has-text("Continue")',
                                    '[role="button"]:has-text("Done")',
                                ];

                                for (const sel of postVerifySelectors) {
                                    try {
                                        const btn = await this.page.$(sel);
                                        if (btn && await btn.isVisible() && await btn.isEnabled()) {
                                            const btnText = await btn.textContent().catch(() => '');
                                            log('INFO', `Clicking post-verify button: "${btnText.trim()}" (${sel})`, this.accountId);
                                            try {
                                                await btn.click({ timeout: 5000 });
                                            } catch (e) {
                                                await btn.click({ force: true, timeout: 5000 });
                                            }
                                            postBtnClicked = true;
                                            break;
                                        }
                                    } catch (e) {}
                                }

                                // Strategy 2: StencilReactButton
                                if (!postBtnClicked) {
                                    try {
                                        const stencilBtns = await this.page.$$('button[data-test-component="StencilReactButton"]');
                                        for (const btn of stencilBtns) {
                                            if (await btn.isVisible() && await btn.isEnabled()) {
                                                const text = await btn.textContent().catch(() => '');
                                                const lower = text.toLowerCase().trim();
                                                // Skip sign-in buttons — clicking those would break the session
                                                if (lower.includes('sign in') || lower.includes('login') || lower.includes('log in')) continue;
                                                log('INFO', `Clicking StencilReactButton post-verify: "${text.trim()}"`, this.accountId);
                                                await btn.click({ timeout: 5000 }).catch(() => btn.click({ force: true }));
                                                postBtnClicked = true;
                                                break;
                                            }
                                        }
                                    } catch (e) {}
                                }

                                // Strategy 3: JS click any button (except sign-in/resend/back/cancel)
                                if (!postBtnClicked) {
                                    const jsResult = await this.page.evaluate(() => {
                                        const buttons = document.querySelectorAll('button, [role="button"], input[type="submit"]');
                                        for (const btn of buttons) {
                                            if (btn.offsetParent === null || btn.disabled) continue;
                                            const text = (btn.textContent || btn.value || '').toLowerCase().trim();
                                            if (text.includes('sign in') || text.includes('login') || text.includes('log in')) continue;
                                            if (text.includes('resend') || text.includes('back') || text.includes('cancel')) continue;
                                            if (text.length === 0) continue;
                                            btn.click();
                                            return (btn.textContent || btn.value || '').trim().substring(0, 60);
                                        }
                                        return null;
                                    });
                                    if (jsResult) {
                                        log('INFO', `Clicked post-verify button via JS: "${jsResult}"`, this.accountId);
                                        postBtnClicked = true;
                                    }
                                }

                                if (postBtnClicked) {
                                    // Wait for page to respond after clicking
                                    await this.page.waitForTimeout(3000);
                                    try {
                                        await this.page.waitForLoadState('networkidle', { timeout: 10000 });
                                    } catch (e) {}
                                    await this.page.waitForTimeout(2000);
                                } else {
                                    log('INFO', 'No more post-verify buttons to click', this.accountId);
                                    break;
                                }
                            }

                            // Take final screenshot
                            const postOtpUrl = this.page.url();
                            log('INFO', `Post-OTP final URL: ${postOtpUrl}`, this.accountId);
                            try {
                                await this.page.screenshot({ path: 'debug_post_otp_final.png' });
                                log('INFO', 'Debug screenshot saved: debug_post_otp_final.png', this.accountId);
                            } catch (e) {}

                            // If we're no longer on the auth page, login is complete
                            if (!postOtpUrl.includes('auth.hiring.amazon')) {
                                log('INFO', 'OTP verified and redirected — login successful!', this.accountId);
                                this.lastLoginTime = new Date();
                                return true;
                            }

                            // Last resort: navigate to hiring.amazon.ca to check session
                            log('INFO', 'Still on auth page, navigating to hiring.amazon.ca...', this.accountId);
                            await this.page.goto('https://hiring.amazon.ca/', { waitUntil: 'networkidle', timeout: 30000 });
                            await this.page.waitForTimeout(3000);

                            log('INFO', `Final URL after navigation: ${this.page.url()}`, this.accountId);
                            this.lastLoginTime = new Date();
                            return true;
                        } else {
                            log('WARNING', 'No verify button found after OTP — check debug_otp_filled.png', this.accountId);
                            // Take screenshot to debug
                            try {
                                await this.page.screenshot({ path: 'debug_no_verify_btn.png' });
                                log('INFO', 'Debug screenshot saved: debug_no_verify_btn.png', this.accountId);
                            } catch (e) {}
                        }

                    } catch (otpErr) {
                        log('ERROR', `OTP retrieval/filling failed: ${otpErr.message}`, this.accountId);
                        try {
                            await this.page.screenshot({ path: 'debug_otp_error.png' });
                        } catch (e) {}
                    }
                } else if (otpFieldFound) {
                    log('WARNING', 'OTP input found but no email_imap config — cannot auto-fill OTP', this.accountId);
                    log('WARNING', 'Add "email_imap" section to config.json with Gmail IMAP credentials', this.accountId);
                }

                // Look for visible, enabled continue/submit buttons
                let buttonClicked = false;
                await this.page.waitForTimeout(1000);

                // Strategy 1: StencilReactButton
                try {
                    const buttons = await this.page.$$('button[data-test-component="StencilReactButton"]');
                    log('INFO', `Found ${buttons.length} StencilReactButton(s) on page`, this.accountId);

                    for (let i = 0; i < buttons.length; i++) {
                        const isVisible = await buttons[i].isVisible();
                        const isEnabled = await buttons[i].isEnabled();
                        if (isVisible && isEnabled) {
                            const text = await buttons[i].textContent().catch(() => '');
                            log('INFO', `Clicking StencilReactButton ${i + 1}: "${text.trim()}"`, this.accountId);
                            try {
                                await buttons[i].click({ timeout: 5000 });
                            } catch (clickErr) {
                                if (clickErr.message.includes('intercepts pointer events')) {
                                    await buttons[i].click({ force: true, timeout: 5000 });
                                } else {
                                    throw clickErr;
                                }
                            }
                            buttonClicked = true;
                            break;
                        }
                    }
                } catch (error) {
                    log('DEBUG', `StencilReactButton search error: ${error.message}`, this.accountId);
                }

                // Strategy 2: data-test-id="button-continue"
                if (!buttonClicked) {
                    try {
                        const contBtns = await this.page.$$('button[data-test-id="button-continue"]');
                        for (const btn of contBtns) {
                            if (await btn.isVisible() && await btn.isEnabled()) {
                                const text = await btn.textContent().catch(() => '');
                                log('INFO', `Clicking button-continue: "${text.trim()}"`, this.accountId);
                                try {
                                    await btn.click({ timeout: 5000 });
                                } catch (clickErr) {
                                    await btn.click({ force: true, timeout: 5000 });
                                }
                                buttonClicked = true;
                                break;
                            }
                        }
                    } catch (e) {
                        log('DEBUG', `button-continue search error: ${e.message}`, this.accountId);
                    }
                }

                // Strategy 3: Any visible submit/continue button via JS
                if (!buttonClicked) {
                    try {
                        const clicked = await this.page.evaluate(() => {
                            const selectors = [
                                'button[data-test-component="StencilReactButton"]',
                                'button[data-test-id="button-continue"]',
                                'button[type="submit"]',
                                'button:not([disabled])'
                            ];
                            for (const sel of selectors) {
                                const buttons = document.querySelectorAll(sel);
                                for (const btn of buttons) {
                                    if (btn.offsetParent !== null && !btn.disabled) {
                                        const text = (btn.textContent || '').toLowerCase();
                                        if (text.includes('continue') || text.includes('submit') || text.includes('sign in') || text.includes('login') || text.includes('verify') || text.includes('next')) {
                                            btn.click();
                                            return btn.textContent.trim().substring(0, 60);
                                        }
                                    }
                                }
                            }
                            return null;
                        });
                        if (clicked) {
                            log('INFO', `Clicked button via JS: "${clicked}"`, this.accountId);
                            buttonClicked = true;
                        }
                    } catch (e) {
                        log('DEBUG', `JS button click failed: ${e.message}`, this.accountId);
                    }
                }

                // Strategy 4: Config-based login button selector
                if (!buttonClicked) {
                    try {
                        const loginButtonSelector = await this._findSelector(this.config.selectors.login_button, 5000);
                        log('INFO', `Using config login button selector: ${loginButtonSelector}`, this.accountId);
                        await this.page.click(loginButtonSelector);
                        buttonClicked = true;
                    } catch (error) {
                        log('DEBUG', `Config login button not found: ${error.message}`, this.accountId);
                    }
                }

                if (!buttonClicked) {
                    log('INFO', 'No more clickable buttons found', this.accountId);
                    break;
                }

                // Wait for page to respond after button click
                log('INFO', 'Waiting for page to respond after button click...', this.accountId);
                await this.page.waitForTimeout(3000);

                // Wait for any navigation
                try {
                    await this.page.waitForLoadState('networkidle', { timeout: 5000 });
                } catch (e) {}
            }

            // Final login check
            try {
                await this.page.waitForSelector(this.config.selectors.logged_in_indicator, {
                    timeout: 15000
                });
                log('INFO', 'Login successful', this.accountId);
                this.lastLoginTime = new Date();
                return true;
            } catch (error) {
                const currentUrl = this.page.url();
                if (currentUrl.toLowerCase().includes('login') || currentUrl.includes('#/login')) {
                    log('ERROR', 'Login failed - still on login page', this.accountId);
                    return false;
                }
                log('INFO', 'Login appears successful (redirected)', this.accountId);
                this.lastLoginTime = new Date();
                return true;
            }
        } catch (error) {
            log('ERROR', `Login error: ${error.message}`, this.accountId);
            return false;
        }
    }

    /**
     * Solve the AWS WAF audio CAPTCHA using NopeCHA API.
     * Flow: extract audio base64 → send to NopeCHA → get transcription → type answer → submit
     */
    async _solveCaptchaAudio(timeout = 60000) {
        if (!this.nopecha) {
            log('ERROR', 'NopeCHA not configured - set captcha.api_key in config.json', this.accountId);
            return false;
        }

        try {
            // AWS WAF CAPTCHA uses <awswaf-captcha> custom element with Shadow DOM.
            // All internal elements (audio, input, buttons) are inside the shadow root.
            // We must pierce the Shadow DOM to access them.

            // Step 1: Wait for the shadow root to be available and find audio
            log('INFO', 'Waiting for awswaf-captcha shadow DOM and audio data...', this.accountId);

            let audioData = null;
            const startTime = Date.now();

            while (Date.now() - startTime < 20000) {
                audioData = await this.page.evaluate(() => {
                    // Helper: recursively search through shadow roots for audio elements
                    function findAudioInShadow(root) {
                        // Check direct audio elements
                        const audioElements = root.querySelectorAll('audio');
                        for (const audio of audioElements) {
                            const src = audio.src || audio.currentSrc;
                            if (src && src.startsWith('data:audio')) {
                                const base64Match = src.match(/^data:audio\/[^;]+;base64,(.+)$/);
                                if (base64Match) return base64Match[1];
                            }
                            // Check <source> children
                            const sources = audio.querySelectorAll('source');
                            for (const source of sources) {
                                if (source.src && source.src.startsWith('data:audio')) {
                                    const base64Match = source.src.match(/^data:audio\/[^;]+;base64,(.+)$/);
                                    if (base64Match) return base64Match[1];
                                }
                            }
                        }

                        // Recurse into shadow roots of child elements
                        const allElements = root.querySelectorAll('*');
                        for (const el of allElements) {
                            if (el.shadowRoot) {
                                const result = findAudioInShadow(el.shadowRoot);
                                if (result) return result;
                            }
                        }
                        return null;
                    }

                    // Start from document and <awswaf-captcha> elements
                    // First try the awswaf-captcha element directly
                    const wafCaptcha = document.querySelector('awswaf-captcha');
                    if (wafCaptcha && wafCaptcha.shadowRoot) {
                        const result = findAudioInShadow(wafCaptcha.shadowRoot);
                        if (result) return result;
                    }

                    // Also search in #captchaModal and its children
                    const modal = document.querySelector('#captchaModal');
                    if (modal) {
                        const allElsInModal = modal.querySelectorAll('*');
                        for (const el of allElsInModal) {
                            if (el.shadowRoot) {
                                const result = findAudioInShadow(el.shadowRoot);
                                if (result) return result;
                            }
                        }
                    }

                    // Fallback: search entire document
                    return findAudioInShadow(document);
                });

                if (audioData) {
                    log('INFO', `Audio data extracted from Shadow DOM (${audioData.length} chars base64)`, this.accountId);
                    break;
                }
                await this.page.waitForTimeout(500);
            }

            // If still no audio, try clicking the audio/play button inside the shadow DOM
            if (!audioData) {
                log('WARNING', 'No audio data yet, trying to click play button inside shadow DOM...', this.accountId);

                const clicked = await this.page.evaluate(() => {
                    function findAndClickInShadow(root) {
                        // Look for play/audio buttons
                        const buttons = root.querySelectorAll('button, [role="button"], [aria-label*="play" i], [aria-label*="audio" i], [aria-label*="listen" i]');
                        for (const btn of buttons) {
                            const text = (btn.textContent || '').toLowerCase();
                            const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
                            if (text.includes('play') || text.includes('audio') || text.includes('listen') ||
                                ariaLabel.includes('play') || ariaLabel.includes('audio') || ariaLabel.includes('listen')) {
                                btn.click();
                                return true;
                            }
                        }
                        // Recurse into shadow roots
                        const allElements = root.querySelectorAll('*');
                        for (const el of allElements) {
                            if (el.shadowRoot) {
                                const result = findAndClickInShadow(el.shadowRoot);
                                if (result) return result;
                            }
                        }
                        return false;
                    }

                    const wafCaptcha = document.querySelector('awswaf-captcha');
                    if (wafCaptcha && wafCaptcha.shadowRoot) {
                        return findAndClickInShadow(wafCaptcha.shadowRoot);
                    }
                    return false;
                });

                if (clicked) {
                    log('INFO', 'Clicked play button inside shadow DOM, waiting for audio...', this.accountId);
                    await this.page.waitForTimeout(3000);

                    // Try extracting audio again
                    audioData = await this.page.evaluate(() => {
                        function findAudioInShadow(root) {
                            const audioElements = root.querySelectorAll('audio');
                            for (const audio of audioElements) {
                                const src = audio.src || audio.currentSrc;
                                if (src && src.startsWith('data:audio')) {
                                    const match = src.match(/^data:audio\/[^;]+;base64,(.+)$/);
                                    if (match) return match[1];
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
                        const wafCaptcha = document.querySelector('awswaf-captcha');
                        if (wafCaptcha && wafCaptcha.shadowRoot) {
                            return findAudioInShadow(wafCaptcha.shadowRoot);
                        }
                        return findAudioInShadow(document);
                    });

                    if (audioData) {
                        log('INFO', `Audio data extracted after play click (${audioData.length} chars base64)`, this.accountId);
                    }
                }
            }

            if (!audioData) {
                log('ERROR', 'Could not extract audio data from CAPTCHA Shadow DOM', this.accountId);

                // Debug: dump what's in the shadow root
                const debugInfo = await this.page.evaluate(() => {
                    const wafCaptcha = document.querySelector('awswaf-captcha');
                    if (!wafCaptcha) return 'awswaf-captcha element not found';
                    if (!wafCaptcha.shadowRoot) return 'awswaf-captcha has no shadow root (closed)';

                    const sr = wafCaptcha.shadowRoot;
                    const info = {
                        childCount: sr.children.length,
                        innerHTML: sr.innerHTML.substring(0, 3000),
                        audioCount: sr.querySelectorAll('audio').length,
                        inputCount: sr.querySelectorAll('input').length,
                        buttonCount: sr.querySelectorAll('button').length,
                    };
                    return JSON.stringify(info);
                });
                log('DEBUG', `Shadow DOM debug: ${debugInfo}`, this.accountId);
                return false;
            }

            // Step 2: Send audio to NopeCHA for transcription
            log('INFO', 'Sending audio to NopeCHA for transcription...', this.accountId);

            let answer = null;
            try {
                const result = await this.nopecha.solveRecognition({
                    type: 'awscaptcha',
                    audio_data: [audioData],
                });

                if (result && result.length > 0) {
                    answer = result[0];
                    log('INFO', `NopeCHA transcription: "${answer}"`, this.accountId);
                } else {
                    log('ERROR', 'NopeCHA returned empty result', this.accountId);
                    return false;
                }
            } catch (nopechaError) {
                log('ERROR', `NopeCHA API error: ${nopechaError.message}`, this.accountId);
                return false;
            }

            // Step 3: Find the input field inside shadow DOM and type the answer
            log('INFO', 'Typing CAPTCHA answer into input field (Shadow DOM)...', this.accountId);

            const inputTyped = await this.page.evaluate((answer) => {
                function findInputInShadow(root) {
                    const selectors = [
                        'input[type="text"]',
                        'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="button"])',
                        'input[placeholder]',
                    ];
                    for (const sel of selectors) {
                        const inputs = root.querySelectorAll(sel);
                        for (const input of inputs) {
                            // Set value using native setter to trigger framework events
                            input.value = '';
                            input.focus();
                            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                            nativeInputValueSetter.call(input, answer);
                            input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                            input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                            input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, composed: true }));
                            return { success: true, id: input.id, placeholder: input.placeholder };
                        }
                    }
                    // Recurse into nested shadow roots
                    const allElements = root.querySelectorAll('*');
                    for (const el of allElements) {
                        if (el.shadowRoot) {
                            const result = findInputInShadow(el.shadowRoot);
                            if (result) return result;
                        }
                    }
                    return null;
                }

                // Search in awswaf-captcha shadow root first
                const wafCaptcha = document.querySelector('awswaf-captcha');
                if (wafCaptcha && wafCaptcha.shadowRoot) {
                    const result = findInputInShadow(wafCaptcha.shadowRoot);
                    if (result) return result;
                }

                // Fallback: search regular DOM too
                const modal = document.querySelector('#captchaModal');
                if (modal) {
                    const allEls = modal.querySelectorAll('*');
                    for (const el of allEls) {
                        if (el.shadowRoot) {
                            const result = findInputInShadow(el.shadowRoot);
                            if (result) return result;
                        }
                    }
                }

                return { success: false };
            }, answer);

            if (!inputTyped || !inputTyped.success) {
                log('WARNING', 'Could not find input in Shadow DOM, trying Playwright piercing selector...', this.accountId);
                // Playwright can pierce shadow DOM with >> syntax
                const piercingSelectors = [
                    'awswaf-captcha >> input[type="text"]',
                    'awswaf-captcha >> input',
                    '#captchaForm >> input[type="text"]',
                    '#captchaForm >> input',
                ];
                let filled = false;
                for (const sel of piercingSelectors) {
                    try {
                        const input = await this.page.$(sel);
                        if (input) {
                            await input.fill(answer);
                            log('INFO', `Typed answer using Playwright piercing selector (${sel})`, this.accountId);
                            filled = true;
                            break;
                        }
                    } catch (e) {
                        continue;
                    }
                }
                if (!filled) {
                    log('ERROR', 'Could not find CAPTCHA input field in Shadow DOM', this.accountId);
                    return false;
                }
            } else {
                log('INFO', `Typed answer into Shadow DOM input (id: ${inputTyped.id}, placeholder: ${inputTyped.placeholder})`, this.accountId);
            }

            await this.page.waitForTimeout(500);

            // Step 4: Click the CAPTCHA verify/submit button inside shadow DOM
            log('INFO', 'Looking for CAPTCHA submit button in Shadow DOM...', this.accountId);

            const captchaSubmitted = await this.page.evaluate(() => {
                function findSubmitInShadow(root) {
                    const buttons = root.querySelectorAll('button, [role="button"]');
                    for (const btn of buttons) {
                        const text = (btn.textContent || '').toLowerCase().trim();
                        const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
                        if (text.includes('submit') || text.includes('verify') || text.includes('confirm') ||
                            ariaLabel.includes('submit') || ariaLabel.includes('verify') || ariaLabel.includes('confirm')) {
                            btn.click();
                            return { success: true, text: text.substring(0, 50) };
                        }
                    }
                    // Recurse into nested shadow roots
                    const allElements = root.querySelectorAll('*');
                    for (const el of allElements) {
                        if (el.shadowRoot) {
                            const result = findSubmitInShadow(el.shadowRoot);
                            if (result) return result;
                        }
                    }
                    return null;
                }

                const wafCaptcha = document.querySelector('awswaf-captcha');
                if (wafCaptcha && wafCaptcha.shadowRoot) {
                    const result = findSubmitInShadow(wafCaptcha.shadowRoot);
                    if (result) return result;
                }
                return { success: false };
            });

            if (!captchaSubmitted || !captchaSubmitted.success) {
                log('WARNING', 'Could not find CAPTCHA submit in Shadow DOM, trying piercing selectors...', this.accountId);
                // Try Playwright piercing selectors
                const submitSelectors = [
                    'awswaf-captcha >> button[type="submit"]',
                    'awswaf-captcha >> button:has-text("Submit")',
                    'awswaf-captcha >> button:has-text("Verify")',
                    'awswaf-captcha >> button',
                ];
                let clicked = false;
                for (const sel of submitSelectors) {
                    try {
                        const btn = await this.page.$(sel);
                        if (btn) {
                            await btn.click({ force: true });
                            log('INFO', `Clicked CAPTCHA submit via piercing selector (${sel})`, this.accountId);
                            clicked = true;
                            break;
                        }
                    } catch (e) {
                        continue;
                    }
                }
                if (!clicked) {
                    // Last resort: press Enter
                    try {
                        await this.page.keyboard.press('Enter');
                        log('INFO', 'Pressed Enter to submit CAPTCHA', this.accountId);
                    } catch (e) {
                        log('WARNING', `Enter key failed: ${e.message}`, this.accountId);
                    }
                }
            } else {
                log('INFO', `CAPTCHA submit clicked in Shadow DOM (text: "${captchaSubmitted.text}")`, this.accountId);
            }

            // Step 5: Wait for CAPTCHA to be verified
            log('INFO', 'Waiting for CAPTCHA verification...', this.accountId);
            await this.page.waitForTimeout(5000);

            // Check if CAPTCHA overlay is gone (indicating success)
            const overlayGone = await this.page.evaluate(() => {
                const overlay = document.querySelector('#captchaModalOverlay');
                if (!overlay) return true;
                const style = window.getComputedStyle(overlay);
                return style.display === 'none' || style.visibility === 'hidden' ||
                       style.pointerEvents === 'none' || style.opacity === '0';
            });

            if (overlayGone) {
                log('INFO', 'CAPTCHA overlay is gone - CAPTCHA appears solved!', this.accountId);
                return true;
            }

            // Check if modal is still visible
            const modalStillVisible = await this.page.evaluate(() => {
                const modal = document.querySelector('#captchaModal');
                if (!modal) return false;
                const style = window.getComputedStyle(modal);
                return style.display !== 'none' && style.visibility !== 'hidden';
            });

            if (!modalStillVisible) {
                log('INFO', 'CAPTCHA modal disappeared - CAPTCHA appears solved!', this.accountId);
                return true;
            }

            log('WARNING', 'CAPTCHA overlay still present after submission', this.accountId);
            return false;

        } catch (error) {
            log('ERROR', `CAPTCHA solving error: ${error.message}`, this.accountId);
            return false;
        }
    }

    async checkLoggedIn() {
        try {
            // Check if page exists
            if (!this.page) {
                log('WARNING', 'Page not initialized, assuming not logged in', this.accountId);
                return false;
            }

            // Check for logged in indicator
            try {
                const indicator = await this.page.$(this.config.selectors.logged_in_indicator);
                if (indicator) {
                    log('DEBUG', 'Logged in indicator found', this.accountId);
                    return true;
                }
            } catch (error) {
                log('DEBUG', `Could not find logged in indicator: ${error.message}`, this.accountId);
            }

            // Check URL
            try {
                const currentUrl = this.page.url();
                log('DEBUG', `Current URL: ${currentUrl}`, this.accountId);
                if (currentUrl.toLowerCase().includes('login')) {
                    log('DEBUG', 'Still on login page, not logged in', this.accountId);
                    return false;
                }
                // If not on login page, might be logged in
                log('DEBUG', 'Not on login page, might be logged in', this.accountId);
                return false; // Default to false to force login attempt
            } catch (error) {
                log('WARNING', `Error checking URL: ${error.message}`, this.accountId);
                return false;
            }
        } catch (error) {
            log('WARNING', `Error in checkLoggedIn: ${error.message}`, this.accountId);
            return false; // Default to false to force login attempt
        }
    }

    async runCycle() {
        try {
            // Ensure page is initialized
            if (!this.page) {
                log('ERROR', 'Page not initialized, cannot run cycle', this.accountId);
                return false;
            }

            log('INFO', 'Starting runCycle', this.accountId);

            // Amazon hiring tokens expire after ~2 hours.
            // Always perform a full re-login to get a fresh token/session.
            // This keeps the account continuously logged in.
            const timeSinceLogin = this.lastLoginTime
                ? (Date.now() - this.lastLoginTime.getTime()) / 1000 / 60
                : Infinity;

            log('INFO', `Time since last login: ${timeSinceLogin.toFixed(1)} minutes`, this.accountId);

            // If we logged in recently (< 30 min), just reload to keep session alive
            if (timeSinceLogin < 30) {
                log('INFO', 'Recent login, doing a page reload to keep session alive...', this.accountId);
                try {
                    await this.page.reload({ waitUntil: 'networkidle', timeout: 15000 });
                    log('INFO', 'Page reloaded successfully', this.accountId);
                    return true;
                } catch (e) {
                    log('WARNING', `Reload failed: ${e.message}, will re-login`, this.accountId);
                }
            }

            // Full re-login to refresh the token before it expires
            log('INFO', 'Performing full re-login to refresh session token...', this.accountId);
            const result = await this.login();
            log('INFO', `Login result: ${result}`, this.accountId);
            return result;
        } catch (error) {
            log('ERROR', `Cycle error: ${error.message}`, this.accountId);
            log('ERROR', `Stack trace: ${error.stack}`, this.accountId);
            return false;
        }
    }

    async logout() {
        try {
            const logoutBtn = await this.page.$(this.config.selectors.logout_button);
            if (logoutBtn) {
                await logoutBtn.click();
                await this.page.waitForTimeout(2000);
            }
        } catch (error) {
            // Ignore logout errors
        }
    }

    async cleanup() {
        try {
            if (this.page) {
                await this.logout();
            }
            if (this.context) {
                await this.context.close();
                // For persistent context, close() also closes the underlying browser
                if (this.isPersistentContext) {
                    log('INFO', 'Persistent context + browser closed', this.accountId);
                }
            }
        } catch (error) {
            log('ERROR', `Cleanup error: ${error.message}`, this.accountId);
        }
    }
}

// Multi-account manager
class AutoLoginManager {
    constructor(configPath = 'config.json') {
        this.configPath = configPath;
        this.config = this._loadConfig(configPath);
        this.browser = null;
        this.accounts = [];
        this.proxies = this._loadProxies();
        this.startTime = new Date();
        this.maxRuntime = this.config.timing.max_runtime_hours * 60 * 60 * 1000;
        this.watcher = null;
        this.shouldRestart = false;
        this.isRunning = false;
        this.concurrentLimit = this.config.timing.concurrent_limit || 10;

        // Extension mode: if extension_path is set in config, load extension in each browser
        this.extensionPath = this.config.extension_path || null;
        if (this.extensionPath) {
            const resolvedPath = path.resolve(this.extensionPath);
            if (!fs.existsSync(resolvedPath)) {
                log('ERROR', `Extension path not found: ${resolvedPath}`);
                log('ERROR', 'Set "extension_path" to the folder containing your extension manifest.json');
                throw new Error(`Extension path not found: ${resolvedPath}`);
            }
            const manifestPath = path.join(resolvedPath, 'manifest.json');
            if (!fs.existsSync(manifestPath)) {
                log('ERROR', `No manifest.json found in extension path: ${resolvedPath}`);
                throw new Error(`No manifest.json found in: ${resolvedPath}`);
            }
            this.extensionPath = resolvedPath;
            log('INFO', `Extension mode enabled: ${this.extensionPath}`);
            log('INFO', 'Each account will launch its own browser with the extension loaded');
            log('INFO', 'Note: Extensions require headed mode (headless: false)');
        }
    }
    
    _loadProxies() {
        try {
            const proxiesPath = 'proxies.json';
            if (fs.existsSync(proxiesPath)) {
                const proxiesData = fs.readFileSync(proxiesPath, 'utf8');
                const proxies = JSON.parse(proxiesData);
                log('INFO', `Loaded ${proxies.length} proxies from ${proxiesPath}`);
                return proxies;
            } else {
                log('WARNING', `Proxies file ${proxiesPath} not found. Running without proxies.`);
                return [];
            }
        } catch (error) {
            if (error.code === 'ENOENT') {
                log('WARNING', 'Proxies file not found. Running without proxies.');
                return [];
            } else if (error instanceof SyntaxError) {
                log('ERROR', `Invalid JSON in proxies file: ${error.message}`);
                return [];
            } else {
                log('ERROR', `Error loading proxies: ${error.message}`);
                return [];
            }
        }
    }

    _loadConfig(configPath) {
        try {
            const configData = fs.readFileSync(configPath, 'utf8');
            const config = JSON.parse(configData);
            log('INFO', `Configuration loaded from ${configPath}`);

            // Support both single account (legacy) and multiple accounts
            if (config.accounts && Array.isArray(config.accounts)) {
                log('INFO', `Found ${config.accounts.length} accounts in configuration`);
            } else if (config.website && config.website.email) {
                // Convert single account to array format
                config.accounts = [{
                    email: config.website.email,
                    pin: config.website.pin
                }];
                log('INFO', 'Converted single account format to array format');
            }

            // Override with environment variables if present
            if (process.env.LOGIN_URL) {
                config.website.url = process.env.LOGIN_URL;
            }

            return config;
        } catch (error) {
            if (error.code === 'ENOENT') {
                log('ERROR', `Configuration file ${configPath} not found`);
                throw error;
            } else if (error instanceof SyntaxError) {
                log('ERROR', `Invalid JSON in configuration file: ${error.message}`);
                throw error;
            } else {
                throw error;
            }
        }
    }

    async initBrowser() {
        // In extension mode, each account launches its own browser via launchPersistentContext
        // No shared browser needed
        if (this.extensionPath) {
            log('INFO', 'Extension mode: skipping shared browser (each account gets its own browser)');
            return;
        }

        // Auto-detect dev mode: check for nodemon in process title or NODE_ENV
        const isDevMode = process.title.toLowerCase().includes('nodemon') ||
                         process.env.NODE_ENV === 'development' ||
                         process.env.npm_lifecycle_event === 'dev';

        const headless = process.env.HEADLESS === 'true';

        // Check if browser is installed
        try {
            const executablePath = chromium.executablePath();
            if (!executablePath || !fs.existsSync(executablePath)) {
                throw new Error('Browser executable not found');
            }
        } catch (error) {
            log('ERROR', 'Playwright browser not found. Run: npx playwright install chromium');
            throw new Error('Playwright browsers not installed.');
        }

        try {
            this.browser = await chromium.launch({
                headless: headless,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-blink-features=AutomationControlled',
                    '--disable-features=IsolateOrigins,site-per-process'
                ]
            });
            log('INFO', `Browser initialized (headless: ${headless}${isDevMode ? ', dev mode' : ''})`);
        } catch (error) {
            if (error.message.includes('Executable doesn\'t exist') || error.message.includes('executable')) {
                log('ERROR', 'Playwright browser not found. Run: npx playwright install chromium');
                throw new Error('Playwright browsers not installed.');
            }
            throw error;
        }
    }

    async initAccounts() {
        log('INFO', `Initializing ${this.config.accounts.length} accounts...`);
        
        // Assign proxies to accounts (random selection from available proxies)
        const accountCount = this.config.accounts.length;
        const proxyCount = this.proxies.length;
        
        if (proxyCount > 0) {
            log('INFO', `Assigning random proxies to ${accountCount} accounts (${proxyCount} proxies available)`);
            if (accountCount > proxyCount) {
                log('INFO', `More accounts (${accountCount}) than proxies (${proxyCount}). Proxies will be randomly reused.`);
            }
        } else {
            log('WARNING', 'No proxies available. All accounts will run without proxies.');
        }
        
        // Initialize all account sessions
        for (let i = 0; i < this.config.accounts.length; i++) {
            const account = this.config.accounts[i];
            // Randomly select a proxy from available proxies
            const proxy = this.proxies.length > 0 
                ? this.proxies[Math.floor(Math.random() * this.proxies.length)] 
                : null;
            
            if (proxy) {
                const proxyInfo = proxy.split(':');
                log('INFO', `Account ${i + 1} assigned random proxy: ${proxyInfo[0]}:${proxyInfo[1]}`);
            }
            
            const session = new AccountSession(i + 1, account, this.config, this.browser, proxy, this.extensionPath);
            await session.initContext();
            this.accounts.push(session);

            // Small delay between browser launches in extension mode to avoid resource spikes
            if (this.extensionPath && i < this.config.accounts.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
        
        log('INFO', `All ${this.accounts.length} accounts initialized`);
    }

    async processAccountsBatch(accounts, batchNumber) {
        log('INFO', `Processing batch ${batchNumber} (${accounts.length} accounts)...`);
        
        const results = await Promise.allSettled(
            accounts.map(async (account) => {
                try {
                    log('INFO', `Starting runCycle for account ${account.accountId}`, account.accountId);
                    const result = await account.runCycle();
                    log('INFO', `runCycle completed for account ${account.accountId}, result: ${result}`, account.accountId);
                    return result;
                } catch (error) {
                    log('ERROR', `Error in runCycle for account ${account.accountId}: ${error.message}`, account.accountId);
                    log('ERROR', `Stack: ${error.stack}`, account.accountId);
                    throw error;
                }
            })
        );

        // Log detailed results
        results.forEach((result, index) => {
            const account = accounts[index];
            if (result.status === 'fulfilled') {
                log('INFO', `Account ${account.accountId} result: ${result.value}`, account.accountId);
            } else {
                log('ERROR', `Account ${account.accountId} failed: ${result.reason?.message || 'Unknown error'}`, account.accountId);
            }
        });

        const successful = results.filter(r => r.status === 'fulfilled' && r.value).length;
        const failed = results.length - successful;
        
        log('INFO', `Batch ${batchNumber} completed: ${successful} successful, ${failed} failed`);
        
        return results;
    }

    async processAllAccounts() {
        const batches = [];
        for (let i = 0; i < this.accounts.length; i += this.concurrentLimit) {
            const batch = this.accounts.slice(i, i + this.concurrentLimit);
            batches.push(batch);
        }

        log('INFO', `Processing ${this.accounts.length} accounts in ${batches.length} batches (${this.concurrentLimit} concurrent)`);

        for (let i = 0; i < batches.length; i++) {
            await this.processAccountsBatch(batches[i], i + 1);
            // Small delay between batches to avoid overwhelming the server
            if (i < batches.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
    }

    startFileWatcher() {
        const configWatcher = chokidar.watch(this.configPath, {
            persistent: true,
            ignoreInitial: true
        });

        configWatcher.on('change', async (path) => {
            log('INFO', `Configuration file ${path} changed, reloading...`);
            try {
                const newConfig = this._loadConfig(this.configPath);
                this.config = newConfig;
                this.maxRuntime = this.config.timing.max_runtime_hours * 60 * 60 * 1000;
                log('INFO', 'Configuration reloaded successfully');
            } catch (error) {
                log('ERROR', `Failed to reload configuration: ${error.message}`);
            }
        });

        const codeWatcher = chokidar.watch(['*.js', '*.json'], {
            persistent: true,
            ignoreInitial: true,
            ignored: ['node_modules/**', '*.log', 'package-lock.json']
        });

        codeWatcher.on('change', async (path) => {
            log('INFO', `Code file ${path} changed, restarting service...`);
            this.shouldRestart = true;
            await this.cleanup();
            process.exit(0);
        });

        this.watcher = { configWatcher, codeWatcher };
        log('INFO', 'File watcher started');
    }

    async run() {
        try {
            this.isRunning = true;
            this.startFileWatcher();

            await this.initBrowser();
            await this.initAccounts();

            const loginInterval = this.config.timing.login_interval_hours * 60 * 60 * 1000;
            let nextLoginTime = new Date();

            log('INFO', 'Starting multi-account auto-login service');
            log('INFO', `Managing ${this.accounts.length} accounts`);
            log('INFO', `Mode: ${this.extensionPath ? 'EXTENSION (each account has own browser + extension)' : 'STANDARD (shared browser)'}`);
            if (this.extensionPath) {
                log('INFO', `Extension: ${this.extensionPath}`);
            }
            log('INFO', `Max runtime: ${this.config.timing.max_runtime_hours === 0 ? 'UNLIMITED (until you close)' : this.config.timing.max_runtime_hours + ' hours'}`);
            log('INFO', `Re-login interval: ${this.config.timing.login_interval_hours} hours (Amazon tokens expire at 2h)`);
            log('INFO', `Concurrent limit: ${this.concurrentLimit} accounts per batch`);

            // Initial login for all accounts
            log('INFO', 'Performing initial login for all accounts...');
            await this.processAllAccounts();
            nextLoginTime = new Date(Date.now() + loginInterval);

            while (true) {
                if (this.shouldRestart) {
                    log('INFO', 'Restart requested, shutting down...');
                    break;
                }

                // max_runtime_hours: 0 means run forever (until user closes)
                if (this.maxRuntime > 0) {
                    const runtime = Date.now() - this.startTime.getTime();
                    if (runtime >= this.maxRuntime) {
                        log('INFO', `Maximum runtime reached (${this.config.timing.max_runtime_hours}h), stopping...`);
                        break;
                    }
                }

                const waitTime = nextLoginTime.getTime() - Date.now();
                if (waitTime > 0) {
                    log('INFO', `Waiting ${(waitTime / 60000).toFixed(1)} minutes until next cycle...`);
                    const checkInterval = 5000;
                    let remainingTime = waitTime;
                    while (remainingTime > 0 && !this.shouldRestart) {
                        const sleepTime = Math.min(checkInterval, remainingTime);
                        await new Promise(resolve => setTimeout(resolve, sleepTime));
                        remainingTime -= sleepTime;
                    }
                    if (this.shouldRestart) break;
                }

                log('INFO', 'Starting login cycle for all accounts...');
                await this.processAllAccounts();

                nextLoginTime = new Date(Date.now() + loginInterval);
            }
        } catch (error) {
            log('ERROR', `Fatal error in run loop: ${error.message}`);
        } finally {
            this.isRunning = false;
            await this.cleanup();
        }
    }

    async cleanup() {
        try {
            if (this.watcher) {
                if (this.watcher.configWatcher) {
                    await this.watcher.configWatcher.close();
                }
                if (this.watcher.codeWatcher) {
                    await this.watcher.codeWatcher.close();
                }
            }

            log('INFO', 'Cleaning up all account sessions...');
            await Promise.allSettled(
                this.accounts.map(account => account.cleanup())
            );

            // Only close shared browser in standard mode
            // In extension mode, each account's cleanup() closes its own browser
            if (this.browser && !this.extensionPath) {
                await this.browser.close();
            }

            log('INFO', 'Cleanup completed');
            if (!this.shouldRestart) {
                logFile.end();
            }
        } catch (error) {
            log('ERROR', `Error during cleanup: ${error.message}`);
        }
    }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
    log('INFO', 'Received SIGINT, shutting down gracefully...');
    process.exit(0);
});

process.on('SIGTERM', async () => {
    log('INFO', 'Received SIGTERM, shutting down gracefully...');
    process.exit(0);
});

// Main entry point
async function main() {
    log('INFO', `========================================`);
    log('INFO', `Auto-Login Script ${SCRIPT_VERSION}`);
    log('INFO', `========================================`);
    const manager = new AutoLoginManager();
    await manager.run();
}

main().catch(error => {
    log('ERROR', `Fatal error: ${error.message}`);
    process.exit(1);
});
