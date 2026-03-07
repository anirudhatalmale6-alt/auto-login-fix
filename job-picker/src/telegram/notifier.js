/**
 * Telegram Notifier — Sends job pick notifications to a Telegram chat.
 */
const https = require('https');
const log = require('../utils/logger');

class TelegramNotifier {
  constructor(botToken, chatId) {
    this.botToken = botToken;
    this.chatId = chatId;
    this.enabled = !!(botToken && chatId);

    if (this.enabled) {
      log.info('Telegram', `Notifications enabled (chat: ${chatId})`);
    } else {
      log.info('Telegram', 'Notifications disabled (no bot_token or chat_id)');
    }
  }

  /**
   * Send a job pick notification.
   */
  async notifyJobPicked({ jobId, scheduleId, candidateId, applicationId, requestCount, elapsedSeconds, ip }) {
    if (!this.enabled) return;

    const message = [
      '🎯 *JOB PICKED!*',
      '',
      `*Job ID:* \`${jobId}\``,
      `*Schedule ID:* \`${scheduleId}\``,
      `*Candidate:* \`${candidateId}\``,
      `*Application:* \`${applicationId}\``,
      `*Requests:* ${requestCount}`,
      `*Time:* ${elapsedSeconds}s`,
      `*IP:* \`${ip}\``,
      `*Timestamp:* ${new Date().toISOString()}`,
    ].join('\n');

    await this._send(message);
  }

  /**
   * Send a status update.
   */
  async notifyStatus(message) {
    if (!this.enabled) return;
    await this._send(`📊 ${message}`);
  }

  /**
   * Send a message via Telegram Bot API.
   */
  _send(text) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        chat_id: this.chatId,
        text,
        parse_mode: 'Markdown',
      });

      const options = {
        hostname: 'api.telegram.org',
        path: `/bot${this.botToken}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve();
          } else {
            log.warn('Telegram', `Send failed: ${res.statusCode} — ${data}`);
            resolve(); // Don't reject — notifications are non-critical
          }
        });
      });

      req.on('error', (err) => {
        log.warn('Telegram', `Request error: ${err.message}`);
        resolve();
      });

      req.write(body);
      req.end();
    });
  }
}

module.exports = TelegramNotifier;
