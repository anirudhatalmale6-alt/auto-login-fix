import { Router, Request, Response, NextFunction } from 'express';
import { createCandidateContextMiddleware } from '../mw/candidateContext';
import { createUpstreamForwarder } from '../proxy/upstream';
import { RateLimiter } from '../rate/limiter';
import { SessionStore } from '../store/sessionStore';
import { ProxyManager } from '../rate/proxyManager'; // [Import Added]

// [NEW] In-memory rate limit caches to eliminate Redis I/O blocking
// This allows the proxy to instantly drop blocked requests without waiting for Redis
const localRateLimitCache = new Map<string, number>(); // candidateId -> unblock timestamp
let globalRateLimitUnblockTime = 0;

export function createProxyRouter(
  sessionStore: SessionStore,
  rateLimiter: RateLimiter,
  proxyManager: ProxyManager // [Argument Added]
): Router {
  const router = Router();
  
  const candidateContext = createCandidateContextMiddleware(sessionStore);
  
  // [Update] Pass proxyManager to the upstream forwarder so it can assign IPs
  const forwardWithJar = createUpstreamForwarder(sessionStore, proxyManager);

  // [UPDATED] ZERO-LATENCY RATE LIMITER (Fire and Forget)
  // Removed "async" - we no longer wait for Redis
  const rateLimitMiddleware = (req: Request, res: Response, next: NextFunction) => {
    const candidateId = req.ctx?.candidate?.candidateId;
    
    if (!candidateId) {
      return next();
    }

    const now = Date.now();

    // 1. FAST PATH: Check memory cache first (0ms latency)
    if (globalRateLimitUnblockTime > now) {
      return res.status(429).json({
        error: 'rate_limited',
        message: 'Global rate limit exceeded',
        retryAfter: Math.ceil((globalRateLimitUnblockTime - now) / 1000)
      });
    }

    const userUnblockTime = localRateLimitCache.get(candidateId) || 0;
    if (userUnblockTime > now) {
      return res.status(429).json({
        error: 'rate_limited',
        message: 'Per-candidate rate limit exceeded',
        retryAfter: Math.ceil((userUnblockTime - now) / 1000)
      });
    }

    // 2. FIRE AND FORGET: Trigger Redis checks in the background
    // We DO NOT await these. We let the request pass through instantly.
    // If Redis says we hit the limit, it flags the memory cache to block the *next* request.
    rateLimiter.take(candidateId).then(perIdResult => {
      if (!perIdResult.ok && perIdResult.retryAfterMs) {
        localRateLimitCache.set(candidateId, Date.now() + perIdResult.retryAfterMs);
      }
    }).catch(() => { /* Ignore background errors to keep console clean */ });

    rateLimiter.takeGlobal().then(globalResult => {
      if (!globalResult.ok && globalResult.retryAfterMs) {
        globalRateLimitUnblockTime = Date.now() + globalResult.retryAfterMs;
      }
    }).catch(() => { /* Ignore background errors */ });

    // 3. IMMEDIATELY PROCEED (Zero Redis I/O Wait)
    next();
  };

  // Proxy routes - preserve exact paths as they exist
  // /application/*
  router.all('/application/*', candidateContext, rateLimitMiddleware, forwardWithJar);

  // /candidate-application/*
  router.all('/candidate-application/*', candidateContext, rateLimitMiddleware, forwardWithJar);

  // Any other hiring endpoints
  router.all('/api/*', candidateContext, rateLimitMiddleware, forwardWithJar);

  return router;
}