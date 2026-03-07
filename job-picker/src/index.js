/**
 * Amazon Job Picker — Standalone Node.js Service
 *
 * High-speed job picker with:
 * - 100+ candidate sessions with auto-rotation
 * - Sticky proxy per candidate (create + WS + update same IP)
 * - Zero 429 by design: pause + rotate on rate limit
 * - 40+ schedule combinations in parallel
 * - Telegram notifications on job pick
 *
 * Usage:
 *   node src/index.js [config.json]
 */
const fs = require('fs');
const path = require('path');
const log = require('./utils/logger');
const ProxyManager = require('./proxy/proxyManager');
const SessionManager = require('./sessions/sessionManager');
const JobPoller = require('./poller/jobPoller');
const TelegramNotifier = require('./telegram/notifier');

async function main() {
  log.info('Main', '========================================');
  log.info('Main', '  Amazon Job Picker v2.0');
  log.info('Main', '========================================');

  // Load config
  const configPath = process.argv[2] || path.join(__dirname, '..', 'config.json');
  if (!fs.existsSync(configPath)) {
    log.error('Main', `Config not found: ${configPath}`);
    log.info('Main', 'Copy config.json.example to config.json and fill in your settings');
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const settings = config.settings || {};

  // Initialize Proxy Manager
  const proxyManager = new ProxyManager();
  if (config.proxies && config.proxies.length > 0) {
    proxyManager.updateProxies(config.proxies);
  } else {
    log.warn('Main', 'No proxies configured! Requests will go direct.');
  }

  // Initialize Session Manager
  const sessionManager = new SessionManager();
  if (config.sessions && config.sessions.length > 0) {
    sessionManager.loadFromConfig(config.sessions);
  } else {
    log.warn('Main', 'No sessions configured! Add candidateId + accessToken to config.sessions[]');
  }

  // Initialize Telegram Notifier
  const telegram = new TelegramNotifier(
    config.telegram?.bot_token || '',
    config.telegram?.chat_id || ''
  );

  // Build job+schedule combinations
  const combinations = [];
  for (const job of (config.jobs || [])) {
    for (const scheduleId of (job.scheduleIds || [])) {
      combinations.push({ jobId: job.jobId, scheduleId });
    }
  }

  if (combinations.length === 0) {
    log.error('Main', 'No job+schedule combinations configured!');
    process.exit(1);
  }

  log.info('Main', `Combinations: ${combinations.length}`);
  log.info('Main', `Sessions: ${sessionManager.getStats().total}`);
  log.info('Main', `Proxies: ${proxyManager.getStats().totalProxies}`);

  // Job pick callback
  const onJobPicked = async (details) => {
    log.success('Main', `===== JOB PICKED =====`);
    log.success('Main', `  Job: ${details.jobId}`);
    log.success('Main', `  Schedule: ${details.scheduleId}`);
    log.success('Main', `  Candidate: ${details.candidateId}`);
    log.success('Main', `  Requests: ${details.requestCount}`);
    log.success('Main', `  Time: ${details.elapsedSeconds}s`);
    log.success('Main', `======================`);

    // Save to picked_jobs.json
    const pickedFile = path.join(__dirname, '..', 'picked_jobs.json');
    let picked = [];
    try {
      if (fs.existsSync(pickedFile)) {
        picked = JSON.parse(fs.readFileSync(pickedFile, 'utf8'));
      }
    } catch (e) {}
    picked.push({ ...details, timestamp: new Date().toISOString() });
    fs.writeFileSync(pickedFile, JSON.stringify(picked, null, 2));

    // Telegram notification
    await telegram.notifyJobPicked(details);
  };

  // Start pollers — one per combination
  const pollers = [];
  for (const combo of combinations) {
    const poller = new JobPoller({
      jobId: combo.jobId,
      scheduleId: combo.scheduleId,
      sessionManager,
      proxyManager,
      settings,
      onJobPicked,
    });
    pollers.push(poller);
  }

  log.info('Main', `Starting ${pollers.length} pollers...`);

  // Start all pollers concurrently
  const pollerPromises = pollers.map(p => p.start());

  // Notify Telegram on startup
  await telegram.notifyStatus(
    `Job Picker started: ${combinations.length} combos, ${sessionManager.getStats().total} sessions, ${proxyManager.getStats().totalProxies} proxies`
  );

  // Status reporter — every 60 seconds
  const statusInterval = setInterval(() => {
    const sessionStats = sessionManager.getStats();
    const proxyStats = proxyManager.getStats();
    const runningPollers = pollers.filter(p => p.isRunning).length;
    const totalReqs = pollers.reduce((sum, p) => sum + p.requestCount, 0);

    log.info('Status', `Pollers: ${runningPollers}/${pollers.length} | Sessions: ${sessionStats.active} active, ${sessionStats.paused} paused | Proxies: ${proxyStats.assignedIPs}/${proxyStats.totalProxies} | Total reqs: ${totalReqs}`);
  }, 60000);

  // Graceful shutdown
  process.on('SIGINT', () => {
    log.info('Main', 'Shutting down...');
    clearInterval(statusInterval);
    pollers.forEach(p => p.stop());
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    log.info('Main', 'Shutting down...');
    clearInterval(statusInterval);
    pollers.forEach(p => p.stop());
    process.exit(0);
  });

  // Wait for all pollers (they run indefinitely until stopped)
  await Promise.allSettled(pollerPromises);
}

main().catch(err => {
  log.error('Main', `Fatal: ${err.message}`);
  process.exit(1);
});
