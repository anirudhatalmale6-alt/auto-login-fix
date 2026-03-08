import { Request, Response, NextFunction } from 'express';
import { SessionStore, Cookie } from '../store/sessionStore';
import { ProxyManager } from '../rate/proxyManager'; // [Added Import]

const https = require('https');
const http = require('http');
const { URL } = require('url');

interface UpstreamRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | Buffer;
}

// [NEW] CPU Optimization: In-Memory Cookie String Cache
// Prevents heavy array filtering and string joining on every 0ms request
const cookieStringCache = new Map<string, { value: string, cachedAt: number }>();
const COOKIE_CACHE_TTL_MS = 30000; // 30 seconds

/**
 * Serialize cookies from jar to Cookie header string
 */
function serializeCookies(cookies: Cookie[], domain: string): string {
  const relevantCookies = cookies.filter(cookie => {
    // Match domain (exact or subdomain)
    const cookieDomain = cookie.domain.replace(/^\./, '');
    const requestDomain = domain.replace(/^\./, '');
    
    if (cookie.domain.startsWith('.')) {
      // Subdomain match
      return requestDomain.endsWith(cookieDomain);
    } else {
      // Exact match
      return cookieDomain === requestDomain;
    }
  });

  // Filter expired cookies
  const now = Math.floor(Date.now() / 1000);
  const validCookies = relevantCookies.filter(cookie => {
    if (cookie.expires && cookie.expires < now) {
      return false;
    }
    return true;
  });

  return validCookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

/**
 * Forward request to upstream Amazon hiring API with cookie jar injection
 * [Updated] Now accepts proxyManager to handle IP rotation via Sticky Sessions
 */
export function createUpstreamForwarder(sessionStore: SessionStore, proxyManager: ProxyManager) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.ctx?.candidate) {
      return res.status(400).json({ error: 'missing_candidate_context' });
    }

    const { candidateId, session } = req.ctx.candidate;

    try {
      // Determine upstream URL from the original request path
      // Preserve the path exactly as received
      const upstreamPath = req.originalUrl || req.url;
      
      // Determine domain based on path or job ID if available
      // Default to hiring.amazon.com if US job, hiring.amazon.ca if CA job
      let domain = 'hiring.amazon.com';
      
      // Try to infer from body if available
      if (req.body && typeof req.body === 'object') {
        const jobId = req.body.jobId || req.body.params?.jobId;
        if (jobId && typeof jobId === 'string') {
          domain = jobId.includes('JOB-US-') ? 'hiring.amazon.com' : 'hiring.amazon.ca';
        }
      }
      
      // Build upstream URL
      const upstreamUrl = `https://${domain}${upstreamPath}`;
      const urlObj = new URL(upstreamUrl);

      // [NEW] Check for Rule 2: Force IP Rotation
      const forceIpRotation = req.headers['x-force-ip-rotation'] === 'true';

      // Build headers - preserve all original headers except Cookie and Authorization
      const upstreamHeaders: Record<string, string> = {};
      
      // Copy all original headers
      Object.keys(req.headers).forEach(key => {
        const lowerKey = key.toLowerCase();
        // Skip cookie, authorization, host, and our custom rotation header
        if (lowerKey !== 'cookie' && lowerKey !== 'authorization' && lowerKey !== 'host' && lowerKey !== 'x-force-ip-rotation') {
          const value = req.headers[key];
          if (typeof value === 'string') {
            upstreamHeaders[key] = value;
          } else if (Array.isArray(value)) {
            upstreamHeaders[key] = value.join(', ');
          }
        }
      });

      // [OPTIMIZATION] Force Keep-Alive to reuse the TCP connection to the proxy
      // This is critical for reducing latency with residential proxies
      upstreamHeaders['Connection'] = 'keep-alive';

      // [OPTIMIZATION] Use Cookie RAM Cache instead of CPU-heavy array filtering
      const now = Date.now();
      const cacheKey = `${candidateId}-${domain}`;
      let cookieString = '';
      
      const cachedCookie = cookieStringCache.get(cacheKey);
      if (cachedCookie && (now - cachedCookie.cachedAt < COOKIE_CACHE_TTL_MS)) {
        cookieString = cachedCookie.value; // Instant 0ms fetch
      } else {
        cookieString = serializeCookies(session.cookies, domain);
        cookieStringCache.set(cacheKey, { value: cookieString, cachedAt: now });
      }

      if (cookieString) {
        upstreamHeaders['Cookie'] = cookieString;
      }

      // Inject authorization from session
      if (session.accessToken) {
        upstreamHeaders['Authorization'] = session.accessToken;
      }

      // Ensure referer is preserved (Express lowercases headers, so check both cases)
      const referer = req.headers['referer'] || req.headers['Referer'];
      if (referer && typeof referer === 'string') {
        upstreamHeaders['referer'] = referer; // Use lowercase for consistency
      }

      // Get body
      let body: string | Buffer | undefined;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        if (Buffer.isBuffer(req.body)) {
          body = req.body;
        } else if (typeof req.body === 'object') {
          body = JSON.stringify(req.body);
          upstreamHeaders['Content-Type'] = upstreamHeaders['Content-Type'] || 'application/json;charset=UTF-8';
        } else if (typeof req.body === 'string') {
          body = req.body;
        }
      }

      // [NEW] Trigger Rule 2 IP detachment before fetching the agent
      if (forceIpRotation) {
        console.log(`[Rule 2 Triggered] Detaching IP for candidate ${candidateId} due to jittered timer.`);
        proxyManager.clearStickySession(candidateId);
      }

      // [Updated] Get the STICKY proxy agent AND the IP address for logging
      const stickyData = proxyManager.getStickyAgent(candidateId);
      const agent = stickyData?.agent;
      const proxyIp = stickyData?.proxyUrl || 'unknown';

      // [New] Send the used IP back to the client in a header
      // This allows background.js to log "Old IP" vs "New IP" on rotation
      res.setHeader('X-Executor-IP', proxyIp);

      // Make upstream request
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || 443,
        path: urlObj.pathname + urlObj.search,
        method: req.method,
        headers: upstreamHeaders,
        agent: agent // Inject the sticky agent
      };

      return new Promise<void>((resolve, reject) => {
        const protocol = urlObj.protocol === 'https:' ? https : http;
        const upstreamReq = protocol.request(options, (upstreamRes: any) => {
          // Handle 401/419 - expired session
          if (upstreamRes.statusCode === 401 || upstreamRes.statusCode === 419) {
            console.log(`[${candidateId}] Upstream returned ${upstreamRes.statusCode}, marking session as expired`);
            // Mark session for refresh (client should re-login)
            sessionStore.deleteCandidateSession(candidateId).catch(err => {
              console.error('Failed to delete expired session:', err);
            });
            
            return res.status(upstreamRes.statusCode).json({
              error: 'session_expired',
              message: 'Session expired, please re-login'
            });
          }

          // Handle 429 - rate limit or 403 - Forbidden
          if (upstreamRes.statusCode === 429 || upstreamRes.statusCode === 403) {

            // LATENCY FIX: Only rotate IP on 403 (IP is burned/blocked by Amazon)
            // For 429 (rate limit), keep the warm connection alive — rate limits are
            // time-based (not IP-based), so rotating IP just causes a cold connection
            // restart (~300-500ms penalty for DNS + TCP + TLS through CONNECT tunnel)
            if (upstreamRes.statusCode === 403) {
              proxyManager.clearStickySession(candidateId);
            }

            const retryAfter = upstreamRes.headers['retry-after'];
            const backoffMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 30000;
            
            // Exponential backoff: 30s → 60s → 120s (cap 5 min)
            const maxBackoffMs = 300000; // 5 minutes
            
            // Get current pause time if exists
            sessionStore.getPausedUntil(candidateId).then(currentPausedUntil => {
              const currentBackoffMs = currentPausedUntil ? currentPausedUntil - Date.now() : 0;
              
              // Double the backoff, but cap at max
              const newBackoffMs = Math.min(
                Math.max(backoffMs, currentBackoffMs * 2 || 30000),
                maxBackoffMs
              );
              
              sessionStore.pauseCandidate(candidateId, newBackoffMs).then(() => {
                const pausedUntil = new Date(Date.now() + newBackoffMs);
                res.setHeader('X-Candidate-Paused-Until', pausedUntil.toISOString());
                res.setHeader('Retry-After', Math.ceil(newBackoffMs / 1000).toString());
                
                res.status(429).json({
                  error: 'rate_limited',
                  message: 'Rate limited by upstream',
                  retryAfter: Math.ceil(newBackoffMs / 1000),
                  pausedUntil: pausedUntil.toISOString()
                });
                resolve();
              }).catch(err => {
                console.error('Failed to pause candidate:', err);
                res.status(429).json({
                  error: 'rate_limited',
                  message: 'Rate limited by upstream'
                });
                resolve();
              });
            }).catch(err => {
              console.error('Failed to get paused until:', err);
              // Fallback to simple backoff
              sessionStore.pauseCandidate(candidateId, Math.min(backoffMs, maxBackoffMs)).then(() => {
                const pausedUntil = new Date(Date.now() + Math.min(backoffMs, maxBackoffMs));
                res.setHeader('X-Candidate-Paused-Until', pausedUntil.toISOString());
                res.status(429).json({
                  error: 'rate_limited',
                  message: 'Rate limited by upstream'
                });
                resolve();
              });
            });
            
            return; // Don't continue with normal response
          }

          // Forward response
          res.status(upstreamRes.statusCode);
          
          // Copy response headers
          Object.keys(upstreamRes.headers).forEach(key => {
            res.setHeader(key, upstreamRes.headers[key]);
          });

          // Stream response body
          upstreamRes.on('data', (chunk: Buffer) => {
            res.write(chunk);
          });

          upstreamRes.on('end', () => {
            res.end();
            resolve();
          });
        });

        // [NEW STRICT TIMEOUT] Drop the connection instantly if 2.5 seconds pass without a response
        upstreamReq.setTimeout(2500, () => {
          upstreamReq.destroy(new Error('UPSTREAM_TIMEOUT'));
        });

        // [MAX SPEED OPTIMIZATION] Disable Nagle's algorithm and enforce keep-alive on the raw socket
        upstreamReq.on('socket', (socket: any) => {
          socket.setNoDelay(true); // Sends packets immediately, bypasses Node's buffer
          socket.setKeepAlive(true, 30000);
        });

        upstreamReq.on('error', (error: Error) => {
          // Ignore standard timeout log spam to keep console clean
          if (error.message !== 'UPSTREAM_TIMEOUT') {
             console.error(`[${candidateId}] Upstream request error:`, error);
          }
          if (!res.headersSent) {
            // Return 504 Gateway Timeout on 2.5s limit, otherwise 502 Bad Gateway
            const statusCode = error.message === 'UPSTREAM_TIMEOUT' ? 504 : 502;
            res.status(statusCode).json({
              error: error.message === 'UPSTREAM_TIMEOUT' ? 'upstream_timeout' : 'upstream_error',
              message: error.message
            });
          }
          reject(error);
        });

        // Send body if present
        if (body) {
          upstreamReq.write(body);
        }

        upstreamReq.end();
      });
    } catch (error) {
      console.error(`[${candidateId}] Forwarder error:`, error);
      if (!res.headersSent) {
        res.status(500).json({
          error: 'forwarder_error',
          message: error instanceof Error ? error.message : 'Unknown error'
        });
      }
      next(error);
    }
  };
}