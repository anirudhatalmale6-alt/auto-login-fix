# How to Test Auto-Login Locally

This guide will help you verify that the auto-login service works correctly on your local machine.

## Quick Test Steps

### 1. **Prepare a Test Account**

Edit `config.json` to use just **one test account** first:

```json
{
  "accounts": [
    {
      "email": "your-test-email@example.com",
      "pin": "your-test-pin"
    }
  ]
}
```

**Why test with one account first?**
- Easier to debug issues
- Faster to see results
- Less resource-intensive

### 2. **Run in Test Mode (Non-Headless)**

The service runs in headless mode by default (no visible browser). To see what's happening, run with test mode:

**Windows PowerShell:**
```powershell
$env:HEADLESS="false"; node auto_login.js
```

**Windows Command Prompt:**
```cmd
set HEADLESS=false && node auto_login.js
```

**Linux/Mac:**
```bash
HEADLESS=false node auto_login.js
```

**What you'll see:**
- Browser window opens
- You can watch the login process
- See if selectors are found correctly
- Verify login success visually

### 3. **Check the Logs**

The service logs to both:
- **Console** (terminal output)
- **`auto_login.log`** file

**Look for these success indicators:**
```
INFO - Login successful [Account 1]
INFO - Browser context initialized [Account 1]
INFO - Login appears successful (redirected) [Account 1]
```

**Watch for errors:**
```
ERROR - Login failed - still on login page [Account 1]
ERROR - Email input field not found [Account 1]
ERROR - Login error: ... [Account 1]
```

### 4. **Verify Login Success**

The service checks for login success by:
1. Looking for the `logged_in_indicator` selector (from config.json)
2. Checking if URL no longer contains "login"
3. Logging success/failure messages

**Success signs:**
- ✅ Log shows "Login successful"
- ✅ Browser shows you're logged in (if running non-headless)
- ✅ URL changed from login page
- ✅ No error messages in logs

### 5. **Test with Multiple Accounts**

Once single account works, test with multiple:

```json
{
  "accounts": [
    { "email": "account1@example.com", "pin": "pin1" },
    { "email": "account2@example.com", "pin": "pin2" },
    { "email": "account3@example.com", "pin": "pin3" }
  ]
}
```

## Testing Methods

### Method 1: Quick Test (Single Login)

1. **Start the service:**

   **Windows PowerShell:**
   ```powershell
   $env:HEADLESS="false"; node auto_login.js
   ```

   **Linux/Mac:**
   ```bash
   HEADLESS=false node auto_login.js
   ```

2. **Watch the browser window:**
   - Should navigate to login page
   - Fill email and PIN
   - Click login button
   - Should redirect to logged-in page

3. **Check logs:**
   ```bash
   # In another terminal, watch the log file
   Get-Content auto_login.log -Wait
   ```

4. **Stop after first login:**
   - Press `Ctrl+C` to stop
   - Or let it run to test the refresh cycle (every 2 hours)

### Method 2: Test with Shorter Intervals

For faster testing, temporarily change `config.json`:

```json
{
  "timing": {
    "login_interval_hours": 0.05,  // 3 minutes instead of 2 hours
    "max_runtime_hours": 0.1,       // 6 minutes total runtime
    "concurrent_limit": 1           // Process one at a time
  }
}
```

This lets you see the refresh cycle much faster!

### Method 3: Check Log File

After running, check the log file:

```bash
# View entire log
Get-Content auto_login.log

# View last 50 lines
Get-Content auto_login.log -Tail 50

# Search for errors
Select-String -Path auto_login.log -Pattern "ERROR"

# Search for successful logins
Select-String -Path auto_login.log -Pattern "Login successful"
```

## Common Issues & Solutions

### Issue: "Email input field not found"

**Solution:**
1. Run in non-headless mode: `HEADLESS=false node auto_login.js`
2. Check if the page loaded correctly
3. Verify selectors in `config.json` match the actual page
4. The code tries multiple selectors automatically, but you may need to update them

### Issue: "Login failed - still on login page"

**Possible causes:**
- Wrong email or PIN
- Website requires CAPTCHA (not supported)
- Website requires 2FA (may need manual intervention)
- Selectors are incorrect

**Solution:**
1. Test login manually in a browser first
2. Verify credentials are correct
3. Check if website has additional security steps

### Issue: Browser doesn't open (headless mode)

**This is normal!** The service runs in headless mode by default. To see the browser:

**Windows PowerShell:**
```powershell
$env:HEADLESS="false"; node auto_login.js
```

**Linux/Mac:**
```bash
HEADLESS=false node auto_login.js
```

### Issue: "Login successful" but you're not sure

**Verify by:**
1. Running in non-headless mode to see the browser
2. Checking the URL after login (should not contain "login")
3. Looking for the `logged_in_indicator` element on the page
4. Checking if session persists (refresh page manually)

## Testing Checklist

- [ ] Dependencies installed (`npm install`)
- [ ] Playwright browsers installed (`npm run install-browsers`)
- [ ] `config.json` has at least one test account
- [ ] Email and PIN are correct
- [ ] CSS selectors are correct (test in browser DevTools)
- [ ] Run in non-headless mode to see browser
- [ ] Check console logs for success messages
- [ ] Check `auto_login.log` file
- [ ] Verify login visually (if non-headless)
- [ ] Test with multiple accounts
- [ ] Test refresh cycle (wait for next interval)

## Advanced: Debug Mode

To get even more detailed logging, you can modify the code temporarily to add more console.log statements, or check the browser console in non-headless mode.

## Next Steps

Once local testing works:
1. Test with all your accounts
2. Verify it runs for the full duration
3. Deploy to AWS (see README.md for deployment instructions)
