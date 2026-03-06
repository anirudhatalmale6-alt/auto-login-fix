FROM mcr.microsoft.com/playwright/node:v1.40.0-focal

WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies
RUN npm install --production

# Install Playwright browsers
RUN npx playwright install chromium
RUN npx playwright install-deps chromium

# Copy application files
COPY . .

# Set environment variables for headless operation
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Run the auto-login script
CMD ["npm", "start"]
