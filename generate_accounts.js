/**
 * Helper script to generate 100 accounts in config.json
 * Usage: node generate_accounts.js
 */

const fs = require('fs');

function generateAccounts(count = 100) {
    const accounts = [];
    for (let i = 1; i <= count; i++) {
        accounts.push({
            email: `account${i}@example.com`,
            pin: `pin${i}`
        });
    }
    return accounts;
}

// Read existing config
let config;
try {
    const configData = fs.readFileSync('config.json.example', 'utf8');
    config = JSON.parse(configData);
} catch (error) {
    console.error('Error reading config.json.example:', error.message);
    process.exit(1);
}

// Generate 100 accounts
config.accounts = generateAccounts(100);

// Write to config.json
fs.writeFileSync('config.json', JSON.stringify(config, null, 2));
console.log('✅ Generated config.json with 100 accounts');
console.log('⚠️  Remember to update the email and pin values with real credentials!');
