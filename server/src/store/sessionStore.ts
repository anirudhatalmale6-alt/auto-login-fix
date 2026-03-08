import { createClient, RedisClientType } from 'redis';

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
}

export interface CandidateSession {
  candidateId: string;
  accessToken: string;
  cookies: Cookie[];
  csrf?: string;
  updatedAt: number;
  expiresAt?: number;
}

export class SessionStore {
  private client: RedisClientType;
  private connected: boolean = false;

  constructor(redisUrl: string = 'redis://localhost:6379') {
    this.client = createClient({ url: redisUrl });
    this.client.on('error', (err) => console.error('Redis Client Error:', err));
  }

  async connect(): Promise<void> {
    if (!this.connected) {
      await this.client.connect();
      this.connected = true;
    }
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.client.quit();
      this.connected = false;
    }
  }

  private normalizeCookies(cookies: Cookie[]): Cookie[] {
    const now = Math.floor(Date.now() / 1000);
    return cookies.filter(cookie => {
      // Filter expired cookies
      if (cookie.expires && cookie.expires < now) {
        return false;
      }
      // Ensure required fields
      return cookie.name && cookie.value && cookie.domain;
    }).map(cookie => ({
      ...cookie,
      path: cookie.path || '/',
      httpOnly: cookie.httpOnly !== undefined ? cookie.httpOnly : true,
      secure: cookie.secure !== undefined ? cookie.secure : true,
      sameSite: cookie.sameSite || 'Lax'
    }));
  }

  async upsertCandidateSession(
    candidateId: string,
    data: {
      accessToken: string;
      cookies: Cookie[];
      csrf?: string;
      ttlSeconds?: number;
    }
  ): Promise<void> {
    await this.connect();
    
    const now = Math.floor(Date.now() / 1000);
    const normalizedCookies = this.normalizeCookies(data.cookies);
    const ttl = data.ttlSeconds || 86400 * 7; // Default 7 days
    
    const session: CandidateSession = {
      candidateId,
      accessToken: data.accessToken,
      cookies: normalizedCookies,
      csrf: data.csrf,
      updatedAt: now,
      expiresAt: now + ttl
    };

    const key = `sess:cand:${candidateId}`;
    await this.client.setEx(key, ttl, JSON.stringify(session));
    
    // Add to set of all candidate IDs
    await this.client.sAdd('sess:list', candidateId);
    
    // Emit event (SSE will pick this up)
    await this.client.publish('sess:events', JSON.stringify({
      type: 'session:upsert',
      candidateId,
      timestamp: now
    }));
  }

  async getCandidateSession(candidateId: string): Promise<CandidateSession | null> {
    await this.connect();
    
    const key = `sess:cand:${candidateId}`;
    const data = await this.client.get(key);
    
    if (!data) {
      return null;
    }

    const session: CandidateSession = JSON.parse(data);
    // Re-normalize cookies to filter expired ones
    session.cookies = this.normalizeCookies(session.cookies);
    
    // If session is expired, return null
    if (session.expiresAt && session.expiresAt < Math.floor(Date.now() / 1000)) {
      await this.deleteCandidateSession(candidateId);
      return null;
    }

    return session;
  }

  async listCandidateSessions(): Promise<CandidateSession[]> {
    await this.connect();
    
    const candidateIds = await this.client.sMembers('sess:list');
    const sessions: CandidateSession[] = [];
    
    for (const candidateId of candidateIds) {
      const session = await this.getCandidateSession(candidateId);
      if (session) {
        sessions.push(session);
      }
    }

    // Sort by updatedAt desc
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async deleteCandidateSession(candidateId: string): Promise<boolean> {
    await this.connect();
    
    const key = `sess:cand:${candidateId}`;
    const pauseKey = `pause:cand:${candidateId}`;
    
    // Check if session exists
    const existed = await this.client.exists(key);
    
    // Delete session key
    if (existed) {
      await this.client.del(key);
    }
    
    // Delete pause/backoff key
    await this.client.del(pauseKey);
    
    // Remove from candidate list
    await this.client.sRem('sess:list', candidateId);
    
    // Emit event (publishing is handled by the route handler)
    
    return existed === 1;
  }

  async isPaused(candidateId: string): Promise<boolean> {
    await this.connect();
    
    const key = `pause:cand:${candidateId}`;
    const pausedUntil = await this.client.get(key);
    
    if (!pausedUntil) {
      return false;
    }

    const until = parseInt(pausedUntil, 10);
    const now = Date.now();
    
    if (now >= until) {
      // Pause expired, clean up
      await this.client.del(key);
      return false;
    }

    return true;
  }

  async getPausedUntil(candidateId: string): Promise<number | null> {
    await this.connect();
    
    const key = `pause:cand:${candidateId}`;
    const pausedUntil = await this.client.get(key);
    
    if (!pausedUntil) {
      return null;
    }

    const until = parseInt(pausedUntil, 10);
    const now = Date.now();
    
    if (now >= until) {
      await this.client.del(key);
      return null;
    }

    return until;
  }

  async pauseCandidate(candidateId: string, ms: number): Promise<void> {
    await this.connect();
    
    const key = `pause:cand:${candidateId}`;
    const pausedUntil = Date.now() + ms;
    
    // Store as milliseconds timestamp
    await this.client.setEx(key, Math.ceil(ms / 1000), pausedUntil.toString());
    
    // Emit event
    await this.client.publish('sess:events', JSON.stringify({
      type: 'session:pause',
      candidateId,
      pausedUntil,
      timestamp: Math.floor(Date.now() / 1000)
    }));
  }

  async resumeCandidate(candidateId: string): Promise<void> {
    await this.connect();
    
    const key = `pause:cand:${candidateId}`;
    await this.client.del(key);
    
    // Emit event
    await this.client.publish('sess:events', JSON.stringify({
      type: 'session:resume',
      candidateId,
      timestamp: Math.floor(Date.now() / 1000)
    }));
  }
}



