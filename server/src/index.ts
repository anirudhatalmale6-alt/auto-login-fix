import express from 'express';
import cors from 'cors';
import { SessionStore } from './store/sessionStore';
import { RateLimiter } from './rate/limiter';
import { createSessionsRouter } from './routes/sessions';
import { createProxyRouter } from './routes/proxy';
import { ProxyManager } from './rate/proxyManager'; // [Import Added]

const app = express();
const PORT = process.env.PORT || 8080;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// Environment variables for rate limiting
const PER_ID_RPS = parseInt(process.env.PER_ID_RPS || '9', 10);
const PER_ID_BURST = parseInt(process.env.PER_ID_BURST || '18', 10);
const GLOBAL_RPS = parseInt(process.env.GLOBAL_RPS || '40', 10);
const GLOBAL_BURST = parseInt(process.env.GLOBAL_BURST || '80', 10);

// Initialize stores
const sessionStore = new SessionStore(REDIS_URL);
const rateLimiter = new RateLimiter(REDIS_URL, PER_ID_RPS, PER_ID_BURST, GLOBAL_RPS, GLOBAL_BURST);

// Initialize Proxy Manager with the provided static residential IPs
// NOTE: All URLs MUST use http:// (not https://). The CONNECT tunnel handles encryption.
// Using https:// causes double TLS handshake, adding ~100-200ms latency per request.
const initialProxies = [
  'http://user-spntuun66n-ip-82.23.109.163:ke_B9M4otq9yl9weUK@isp.decodo.com:10001',
  'http://user-spntuun66n-ip-82.23.106.57:ke_B9M4otq9yl9weUK@isp.decodo.com:10001',
  'http://user-spntuun66n-ip-66.227.120.126:ke_B9M4otq9yl9weUK@isp.decodo.com:10001'
];
const proxyManager = new ProxyManager(initialProxies);

// Disable ETag generation globally to prevent 304 responses
app.disable('etag');

// Middleware
app.use(cors({
  origin: '*',
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const candidateId = req.ctx?.candidate?.candidateId || 'unknown';
    console.log(`${req.method} ${req.path} [${candidateId}] ${res.statusCode} ${duration}ms`);
  });
  next();
});

// Health check
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Metrics endpoint (basic)
app.get('/metrics', async (req, res) => {
  try {
    const sessions = await sessionStore.listCandidateSessions();
    const activeSessions = sessions.filter(s => {
      const now = Date.now();
      return !s.expiresAt || s.expiresAt * 1000 > now;
    });

    res.json({
      sessions: {
        total: sessions.length,
        active: activeSessions.length,
        expired: sessions.length - activeSessions.length
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get metrics' });
  }
});

// [Task 2] Add endpoint for Side Panel to save/update IPs dynamically
app.post('/config/proxies', (req, res) => {
  const { proxies } = req.body;
  
  if (!Array.isArray(proxies)) {
    return res.status(400).json({ 
      error: 'invalid_format', 
      message: 'Expected "proxies" to be an array of strings' 
    });
  }

  // Update the pool (ProxyManager normalizes URLs internally: https→http, trim)
  proxyManager.updateProxies(proxies);

  // Pre-warm DNS for any new proxy hostnames
  proxyManager.warmDNS().catch(() => {});

  res.json({
    success: true,
    count: proxyManager.getProxyCount(),
    message: 'Proxy list updated successfully'
  });
});

// Session management routes
app.use('/', createSessionsRouter(sessionStore));

// Proxy routes - [Updated] Pass proxyManager to enable IP rotation logic
app.use('/', createProxyRouter(sessionStore, rateLimiter, proxyManager));

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'not_found', path: req.path });
});

// Error handler
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'internal_error',
    message: err.message
  });
});

// Graceful shutdown
async function shutdown() {
  console.log('Shutting down...');
  await sessionStore.disconnect();
  await rateLimiter.disconnect();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start server
async function start() {
  try {
    await sessionStore.connect();
    await rateLimiter.connect();
    console.log('Connected to Redis');

    // Pre-warm DNS cache for proxy hostnames at startup
    await proxyManager.warmDNS();

    app.listen(PORT, () => {
      console.log(`🚀 Proxy server running on http://localhost:${PORT}`);
      console.log(`📊 Rate limits: ${PER_ID_RPS} rps per candidate, ${GLOBAL_RPS} rps global`);
      console.log(`🔌 Initialized with ${initialProxies.length} proxies`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();