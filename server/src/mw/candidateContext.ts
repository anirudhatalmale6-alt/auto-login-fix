import { Request, Response, NextFunction } from 'express';
import { SessionStore } from '../store/sessionStore';

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      ctx?: {
        candidate?: {
          candidateId: string;
          session: any;
        };
      };
    }
  }
}

// [NEW] Zero-Latency Local RAM Cache
// Stores session data in memory so we don't spam Redis on every 0ms request
const localSessionCache = new Map<string, { data: any, cachedAt: number }>();
const CACHE_TTL_MS = 30000; // Cache valid for 30 seconds to prevent stale data

export function createCandidateContextMiddleware(sessionStore: SessionStore) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      let candidateId: string | null = null;

      // Try to extract from JSON body
      if (req.body && typeof req.body === 'object') {
        candidateId = req.body.candidate_id || req.body.candidateId || null;
      }

      // Fallback to header
      if (!candidateId) {
        candidateId = req.headers['x-candidate-id'] as string || null;
      }

      // Fallback to query parameter
      if (!candidateId) {
        candidateId = req.query.candidate_id as string || req.query.candidateId as string || null;
      }

      if (!candidateId) {
        return res.status(400).json({ error: 'unknown_candidate', message: 'candidate_id not provided' });
      }

      const now = Date.now();
      let session = null;

      // [FAST PATH] 1. Try to get session from 0ms RAM Cache first
      const cached = localSessionCache.get(candidateId);
      if (cached && (now - cached.cachedAt < CACHE_TTL_MS)) {
        session = cached.data;
      } else {
        // [SLOW PATH] 2. Fallback to Redis only if cache is missing or older than 30s
        session = await sessionStore.getCandidateSession(candidateId);
        
        if (session) {
          // Save it to RAM cache for the next 30 seconds of aggressive polling
          localSessionCache.set(candidateId, { data: session, cachedAt: now });
        }
      }
      
      if (!session) {
        return res.status(400).json({ error: 'unknown_candidate', message: `No session found for candidate ${candidateId}` });
      }

      // Attach to request context
      if (!req.ctx) {
        req.ctx = {};
      }
      
      req.ctx.candidate = {
        candidateId,
        session
      };

      next();
    } catch (error) {
      console.error('Candidate context middleware error:', error);
      res.status(500).json({ error: 'internal_error', message: 'Failed to load candidate context' });
    }
  };
}