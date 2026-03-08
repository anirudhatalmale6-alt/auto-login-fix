import { Router, Request, Response } from 'express';
import { SessionStore, Cookie } from '../store/sessionStore';
import { createClient, RedisClientType } from 'redis';

export function createSessionsRouter(sessionStore: SessionStore): Router {
  const router = Router();

  // POST /bootstrap - Record a candidate session
  router.post('/bootstrap', async (req: Request, res: Response) => {
    try {
      const { candidateId, accessToken, cookies, csrf } = req.body;

      if (!candidateId || !accessToken || !cookies || !Array.isArray(cookies)) {
        return res.status(400).json({
          error: 'invalid_request',
          message: 'candidateId, accessToken, and cookies array are required'
        });
      }

      await sessionStore.upsertCandidateSession(candidateId, {
        accessToken,
        cookies: cookies as Cookie[],
        csrf,
        ttlSeconds: 86400 * 7 // 7 days default
      });

      res.json({ ok: true });
    } catch (error) {
      console.error('Bootstrap error:', error);
      res.status(500).json({
        error: 'internal_error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // GET /sessions - List all candidate sessions
  router.get('/sessions', async (req: Request, res: Response) => {
    try {
      // Disable caching for live session data - prevent 304 Not Modified responses
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.set('Pragma', 'no-cache');
      res.set('Expires', '0');
      res.removeHeader('ETag');
      
      const sessions = await sessionStore.listCandidateSessions();
      
      const pausedUntilMap = new Map<string, number | null>();
      
      // Check pause status for each candidate
      await Promise.all(sessions.map(async (session) => {
        const pausedUntil = await sessionStore.getPausedUntil(session.candidateId);
        pausedUntilMap.set(session.candidateId, pausedUntil);
      }));

      const result = sessions.map(session => {
        const pausedUntil = pausedUntilMap.get(session.candidateId) || null;
        const now = Date.now();
        const isExpired = session.expiresAt ? session.expiresAt * 1000 < now : false;
        const isPaused = pausedUntil !== null && pausedUntil > now;

        return {
          candidateId: session.candidateId,
          updatedAt: session.updatedAt,
          expiresAt: session.expiresAt,
          pausedUntil: isPaused ? pausedUntil : null,
          status: isExpired ? 'expired' : isPaused ? 'paused' : 'active'
        };
      });

      // Always return 200 OK with full body (never 304)
      res.status(200).json(result);
    } catch (error) {
      console.error('List sessions error:', error);
      res.status(500).json({
        error: 'internal_error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // DELETE /sessions/:candidateId - Delete a candidate session
  router.delete('/sessions/:candidateId', async (req: Request, res: Response) => {
    try {
      const { candidateId } = req.params;
      
      if (!candidateId) {
        return res.status(400).json({
          error: 'invalid_request',
          message: 'candidateId is required'
        });
      }

      const existed = await sessionStore.deleteCandidateSession(candidateId);
      
      // Publish event for SSE
      const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
      const publisher = createClient({ url: redisUrl });
      try {
        await publisher.connect();
        await publisher.publish('sess:events', JSON.stringify({
          type: 'session:expire',
          candidateId,
          timestamp: Math.floor(Date.now() / 1000)
        }));
        await publisher.quit();
      } catch (pubError) {
        console.error('Failed to publish delete event:', pubError);
        // Continue even if publish fails
      }

      return res.status(existed ? 200 : 204).end();
    } catch (error) {
      console.error('Delete session error:', error);
      res.status(500).json({
        error: 'internal_error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // GET /sessions/events - Server-Sent Events for session updates
  router.get('/sessions/events', async (req: Request, res: Response) => {
    // Set headers for SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Send initial connection message
    res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: Date.now() })}\n\n`);

    // Subscribe to Redis pub/sub for session events
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    const subscriber = createClient({ url: redisUrl });
    
    try {
      await subscriber.connect();
      await subscriber.subscribe('sess:events', (message) => {
        try {
          const event = JSON.parse(message);
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch (err) {
          console.error('Failed to parse SSE event:', err);
        }
      });

      // Keep connection alive with heartbeat
      const heartbeat = setInterval(() => {
        res.write(`: heartbeat\n\n`);
      }, 30000); // Every 30 seconds

      // Cleanup on client disconnect
      req.on('close', () => {
        clearInterval(heartbeat);
        subscriber.unsubscribe('sess:events').catch(console.error);
        subscriber.quit().catch(console.error);
      });
    } catch (error) {
      console.error('SSE setup error:', error);
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'Failed to setup event stream' })}\n\n`);
      res.end();
    }
  });

  return router;
}
