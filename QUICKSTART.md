# Quick Start Guide

Get your auto-login service running in 5 minutes!

## Step 1: Install Dependencies

```bash
npm install
npm run install-browsers
```

Or install browsers separately:
```bash
npx playwright install chromium
```

## Step 2: Configure

**Option A: Generate 100 account template**
```bash
node generate_accounts.js
```
This creates `config.json` with 100 account placeholders. Then edit it to add real credentials.

**Option B: Manual setup**
```bash
cp config.json.example config.json
```

Edit `config.json` with your website details:
- Update the `url` (default: `https://auth.hiring.amazon.com/#/login`)
- Add all your accounts in the `accounts` array with `email` and `pin`
- Update CSS selectors (see below for how to find them)
- Adjust `concurrent_limit` if needed (default: 10 accounts per batch)

## Step 3: Find CSS Selectors

1. Open `https://auth.hiring.amazon.com/#/login` in Chrome/Firefox
2. Press F12 to open Developer Tools
3. Click the element selector tool (top-left icon)
4. Click on the email field
5. In the Elements tab, right-click the highlighted element
6. Choose "Copy" → "Copy selector"
7. Paste into `config.json`

Repeat for PIN field and login button.

**Example selectors for Amazon Hiring Portal:**
- Email field: `#login[name="login EmailId"]` (primary) - This is the specific input with id="login" and name="login EmailId"
- PIN field: `#pin`, `input[type="password"]`, or `input[name="pin"]`
- Login button: `button[type="submit"]` or `button:has-text("Sign in")`

**Note:** 
- The email field specifically looks for `id="login"` and `name="login EmailId"` as the primary selector
- The config supports multiple selectors (comma-separated) - the code will try each one until it finds a match
- All login actions happen at `https://auth.hiring.amazon.com/#/login`

## Step 4: Test Locally

**Production mode:**
```bash
npm start
```

**Development mode (auto-restart on changes):**
```bash
npm run dev
```

Watch the logs to see if login succeeds!

**Auto-Refresh Feature:**
- The service automatically reloads `config.json` when you save changes (no restart needed)
- In development mode (`npm run dev`), the service auto-restarts when code files change
- You can update selectors, timing, or credentials without manually restarting!

## Step 5: Deploy to AWS

### Option A: Docker on EC2

```bash
docker build -t auto-login .
docker run -d --restart=always -v $(pwd)/config.json:/app/config.json auto-login
```

### Option B: Docker Compose

```bash
docker-compose up -d
```

### Option C: Using Environment Variables (More Secure)

```bash
export LOGIN_EMAIL="your_email@example.com"
export LOGIN_PIN="your_personal_pin"
export LOGIN_URL="https://auth.hiring.amazon.com/#/login"
docker run -d --restart=always \
  -e LOGIN_EMAIL \
  -e LOGIN_PIN \
  -e LOGIN_URL \
  auto-login
```

## Common Issues

**"Login failed"**
- Check your selectors are correct
- Verify email and PIN are correct
- Check if website requires CAPTCHA (not supported)
- For Amazon Hiring Portal, ensure you're using the correct email and personal PIN

**"Timeout"**
- Increase `page_load_timeout` in config.json
- Check your internet connection
- Amazon Hiring Portal may require additional time to load

**"Selector not found"**
- Website structure may have changed
- Use browser DevTools to find new selectors
- Try using different selector strategies (ID, class, attribute)

**"Browser not found"**
- Run `npm run install-browsers` or `npx playwright install chromium`
- Ensure Playwright is properly installed

## Need Help?

Check `auto_login.log` for detailed error messages!

For Amazon Hiring Portal specific issues:
- Ensure you're using valid email and personal PIN
- Check if 2FA is enabled (may require manual intervention)
- Verify the login URL is correct: `https://auth.hiring.amazon.com/#/login`
- The code automatically tries multiple selector options, so you can provide comma-separated selectors in config.json
