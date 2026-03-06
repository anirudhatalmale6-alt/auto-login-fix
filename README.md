# Auto-Login Service

An automated login service that keeps **100 accounts** logged in by refreshing sessions every 2 hours. Designed to run continuously on AWS for 24-hour operation.

**Target Website**: Amazon Hiring Portal (`auth.hiring.amazon.com`)

**Supports**: Multiple accounts (up to 100+) with concurrent processing

## Features

- 🤖 **Multi-Account Support**: Manages 100+ accounts simultaneously
- ⚡ **Concurrent Processing**: Processes accounts in batches for efficiency
- ⏰ **Scheduled Refresh**: Keeps all users logged in by refreshing every 2 hours
- 🔄 **Token Expiration Handling**: Automatically detects token expiration and re-logs in
- 🔁 **Auto-Refresh on Updates**: Automatically reloads configuration and restarts on code changes
- ☁️ **AWS Compatible**: Runs in headless mode, perfect for AWS EC2, ECS, or Lambda
- 📝 **Configurable**: Easy-to-edit JSON configuration file with account array
- 📊 **Logging**: Comprehensive logging with account-specific tracking

## Prerequisites

- Node.js 14.0 or higher
- npm or yarn
- Playwright browser automation library
- AWS account (for deployment)

## Installation

### Local Setup

1. **Clone or download this repository**

2. **Install Node.js dependencies:**
   ```bash
   npm install
   ```

3. **Install Playwright browsers:**
   ```bash
   npm run install-browsers
   ```
   Or:
   ```bash
   npx playwright install chromium
   ```

4. **Configure the application:**
   ```bash
   cp config.json.example config.json
   ```
   
   Edit `config.json` with your website details:
   - Website URL (default: `https://auth.hiring.amazon.com/#/login`)
   - **Accounts array**: Add all your accounts with email and PIN
   - CSS selectors for form fields and buttons
   - Timing configuration (including `concurrent_limit` for batch processing)
   
   **Quick setup for 100 accounts:**
   ```bash
   node generate_accounts.js
   # Then edit config.json to add real credentials
   ```

## Configuration

Edit `config.json` to match your target website:

```json
{
  "website": {
    "url": "https://auth.hiring.amazon.com/#/login"
  },
  "accounts": [
    {
      "email": "account1@example.com",
      "pin": "pin1"
    },
    {
      "email": "account2@example.com",
      "pin": "pin2"
    }
  ],
  "selectors": {
    "email_field": "#login[name='login EmailId'], #login, input[name='login EmailId']",
    "pin_field": "#pin, input[type='password'], input[name='pin']",
    "login_button": "button[type='submit'], button:has-text('Sign in')",
    "logout_button": "#logout",
    "logged_in_indicator": ".user-menu, [data-testid='user-menu']"
  },
  "timing": {
    "login_interval_hours": 2,
    "max_runtime_hours": 24,
    "page_load_timeout": 30000,
    "action_delay": 1000,
    "concurrent_limit": 10
  }
}
```

### Quick Setup for 100 Accounts

Use the helper script to generate a config with 100 account placeholders:

```bash
node generate_accounts.js
```

This creates `config.json` with 100 accounts. Then edit the file to add your real email and PIN values.

### Finding CSS Selectors

1. Open your website in a browser
2. Right-click on the element you want to target
3. Select "Inspect" or "Inspect Element"
4. In the developer tools, right-click the HTML element
5. Select "Copy" > "Copy selector"
6. Paste the selector into your `config.json`

## Usage

### Local Execution

**Production mode:**
```bash
npm start
```

**Development mode (with auto-restart on file changes):**
```bash
npm run dev
```

Or directly:
```bash
node auto_login.js
```

The service will:
- Log in immediately
- Refresh the session every 2 hours
- Run for 24 hours (configurable)
- Automatically handle token expiration
- **Auto-reload configuration** when `config.json` changes (no restart needed)
- **Auto-restart** when code files change (in development mode)

### Docker Execution

Build the Docker image:
```bash
docker build -t auto-login .
```

Run the container:
```bash
docker run -v $(pwd)/config.json:/app/config.json auto-login
```

### Docker Compose

Run with docker-compose:
```bash
docker-compose up -d
```

## AWS Deployment

### Option 1: AWS EC2

1. **Launch an EC2 instance** (Ubuntu or Amazon Linux)
2. **SSH into the instance**
3. **Install Docker:**
   ```bash
   sudo yum install docker -y  # Amazon Linux
   # or
   sudo apt-get install docker.io -y  # Ubuntu
   sudo service docker start
   sudo usermod -a -G docker ec2-user
   ```

4. **Clone and build:**
   ```bash
   git clone <your-repo>
   cd auto-login
   docker build -t auto-login .
   ```

5. **Create config.json** with your credentials

6. **Run the container:**
   ```bash
   docker run -d --restart=always -v $(pwd)/config.json:/app/config.json auto-login
   ```

### Option 2: AWS ECS (Elastic Container Service)

1. **Push Docker image to ECR:**
   ```bash
   aws ecr create-repository --repository-name auto-login
   docker tag auto-login:latest <account-id>.dkr.ecr.<region>.amazonaws.com/auto-login:latest
   docker push <account-id>.dkr.ecr.<region>.amazonaws.com/auto-login:latest
   ```

2. **Create ECS Task Definition** with:
   - Image: Your ECR image
   - Memory: 1024 MB (minimum)
   - CPU: 512 units
   - Environment variables or mounted config.json

3. **Run ECS Task** with desired count of 1

### Option 3: AWS Lambda (with Container Image)

1. **Build and push to ECR** (as above)
2. **Create Lambda function** using container image
3. **Set timeout** to maximum (15 minutes) or use Step Functions for longer runs
4. **Configure EventBridge** to trigger every 2 hours

## How It Works

1. **Initialization**: Launches a headless Chromium browser
2. **Account Setup**: Creates separate browser contexts for each account (100 accounts = 100 contexts)
3. **File Watching**: Monitors `config.json` and code files for changes
4. **Batch Processing**: Processes accounts in batches (default: 10 concurrent) to avoid overwhelming the server
5. **Login**: For each account, navigates to login page, fills email/PIN, submits form
6. **Verification**: Checks for logged-in indicator to confirm success for each account
7. **Monitoring**: Every 2 hours, checks all accounts if still logged in
8. **Refresh**: If logged in, refreshes page; if not, performs new login
9. **Token Expiration**: Detects when redirected to login page (token expired) for each account
10. **Auto-Reload**: Automatically reloads configuration when `config.json` changes
11. **Auto-Restart**: Automatically restarts when code files change (development mode)
12. **Cleanup**: After 24 hours, logs out all accounts and shuts down gracefully

### Concurrent Processing

- Accounts are processed in batches to manage resources efficiently
- Default: 10 accounts processed concurrently (configurable via `concurrent_limit`)
- Each account has its own isolated browser context (no cookie/session conflicts)
- Failed accounts are logged but don't stop other accounts from processing

## Logging

Logs are written to:
- Console (stdout)
- `auto_login.log` file

Log levels:
- `INFO`: Normal operations
- `WARNING`: Non-critical issues (e.g., token expiration)
- `ERROR`: Failures that are handled

## Security Best Practices

1. **Never commit `config.json`** with real credentials
2. **Use environment variables** for sensitive data:
   ```bash
   export LOGIN_EMAIL="your_email@example.com"
   export LOGIN_PIN="your_personal_pin"
   export LOGIN_URL="https://auth.hiring.amazon.com/#/login"
   ```
3. **Use AWS Secrets Manager** for production deployments
4. **Restrict IAM permissions** on AWS resources
5. **Use VPC** for network isolation if needed

## Troubleshooting

### Login Fails
- Check CSS selectors in `config.json`
- Verify email and PIN are correct
- Increase `page_load_timeout` if page loads slowly
- Check logs for specific error messages
- For Amazon Hiring Portal, ensure you're using the correct selectors
- The code tries multiple selector options automatically (comma-separated in config)

### Browser Issues on AWS
- Ensure Docker image includes Playwright browsers
- Check that headless mode is enabled
- Verify sufficient memory allocation (minimum 512MB)

### Token Expiration Not Detected
- Update `logged_in_indicator` selector to match your site
- Check if site uses different redirect patterns

## Customization

### Change Login Interval
Edit `login_interval_hours` in `config.json` (default: 2 hours)

### Change Max Runtime
Edit `max_runtime_hours` in `config.json` (default: 24 hours)

### Adjust Concurrent Processing
Edit `concurrent_limit` in `config.json` (default: 10)
- Lower value = slower but less resource-intensive
- Higher value = faster but uses more memory/CPU
- Recommended: 5-15 for 100 accounts

### Add Additional Actions
Modify `auto_login.js` to add custom actions after login:
```javascript
async customAction() {
    await this.page.click('#some-button');
    await this.page.fill('#some-field', 'value');
}
```

## Amazon Hiring Portal Notes

The default configuration is set for `auth.hiring.amazon.com`. You may need to:
- Inspect the login page to find the correct CSS selectors
- Handle any additional authentication steps (2FA, etc.)
- Adjust timeouts based on page load times

## License

MIT License - feel free to use and modify as needed.

## Support

For issues or questions:
1. Check the logs in `auto_login.log`
2. Verify your `config.json` settings
3. Test selectors manually in browser console
