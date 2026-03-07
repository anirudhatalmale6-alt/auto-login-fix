/**
 * Session Manager — Manages candidate sessions (candidateId + accessToken + cookies).
 * Handles pause/resume, expiry tracking, and round-robin selection.
 */
const log = require('../utils/logger');

class SessionManager {
  constructor() {
    this.sessions = new Map();    // candidateId -> { accessToken, cookies, csrf, updatedAt, expiresAt }
    this.pausedUntil = new Map(); // candidateId -> timestamp
    this.inUse = new Set();       // candidateIds currently locked by a poller
  }

  /**
   * Register or update a candidate session.
   */
  upsert(candidateId, { accessToken, cookies, csrf }) {
    this.sessions.set(candidateId, {
      accessToken,
      cookies: cookies || [],
      csrf: csrf || '',
      updatedAt: Date.now(),
      expiresAt: Date.now() + 7200000, // 2 hour default TTL
    });
    log.info('Sessions', `Upserted session: ${candidateId} (total: ${this.sessions.size})`);
  }

  /**
   * Load sessions from config array.
   * Each entry: { candidateId, accessToken, cookies, csrf }
   */
  loadFromConfig(sessionsArray) {
    for (const s of sessionsArray) {
      if (s.candidateId && s.accessToken) {
        this.upsert(s.candidateId, s);
      }
    }
    log.info('Sessions', `Loaded ${this.sessions.size} sessions from config`);
  }

  /**
   * Get session data for a candidate.
   */
  get(candidateId) {
    return this.sessions.get(candidateId);
  }

  /**
   * Remove a session (expired or deleted).
   */
  remove(candidateId) {
    this.sessions.delete(candidateId);
    this.pausedUntil.delete(candidateId);
    this.inUse.delete(candidateId);
    log.info('Sessions', `Removed session: ${candidateId}`);
  }

  /**
   * Pause a candidate for a duration (after 429/403).
   * Uses exponential backoff.
   */
  pause(candidateId, durationMs) {
    const currentPause = this.pausedUntil.get(candidateId);
    const now = Date.now();

    // Exponential backoff: double previous pause, cap at settings max
    let newDuration = durationMs;
    if (currentPause && currentPause > now) {
      const remaining = currentPause - now;
      newDuration = Math.min(remaining * 2, 300000); // Max 5 min
    }

    this.pausedUntil.set(candidateId, now + newDuration);
    log.warn('Sessions', `Paused ${candidateId} for ${Math.ceil(newDuration / 1000)}s`);
  }

  /**
   * Check if a candidate is currently paused.
   */
  isPaused(candidateId) {
    const until = this.pausedUntil.get(candidateId);
    if (!until) return false;
    if (Date.now() >= until) {
      this.pausedUntil.delete(candidateId);
      return false;
    }
    return true;
  }

  /**
   * Get time remaining on pause (ms), or 0 if not paused.
   */
  getPauseRemaining(candidateId) {
    const until = this.pausedUntil.get(candidateId);
    if (!until) return 0;
    const remaining = until - Date.now();
    return remaining > 0 ? remaining : 0;
  }

  /**
   * Lock a candidate (mark as in-use by a poller).
   */
  lock(candidateId) {
    this.inUse.add(candidateId);
  }

  /**
   * Unlock a candidate (poller released it).
   */
  unlock(candidateId) {
    this.inUse.delete(candidateId);
  }

  /**
   * Select next available candidate: not paused, not expired, not in-use.
   * Returns candidateId or null.
   */
  selectNext(previousCandidateId = null) {
    // Release previous lock
    if (previousCandidateId) {
      this.inUse.delete(previousCandidateId);
    }

    const now = Date.now();
    const candidates = Array.from(this.sessions.entries());

    // Filter to available candidates
    const available = candidates.filter(([id, session]) => {
      if (this.inUse.has(id)) return false;
      if (this.isPaused(id)) return false;
      if (session.expiresAt && session.expiresAt < now) return false;
      return true;
    });

    if (available.length > 0) {
      const [selectedId] = available[0];
      this.inUse.add(selectedId);
      return selectedId;
    }

    // All paused — find shortest pause and wait
    const paused = candidates.filter(([id]) => this.isPaused(id));
    if (paused.length > 0) {
      const shortest = paused.reduce((min, [id]) => {
        const remaining = this.getPauseRemaining(id);
        return remaining < min.remaining ? { id, remaining } : min;
      }, { id: null, remaining: Infinity });

      return { waitMs: shortest.remaining, candidateId: shortest.id };
    }

    return null;
  }

  /**
   * Get all session IDs.
   */
  getAllIds() {
    return Array.from(this.sessions.keys());
  }

  getStats() {
    const now = Date.now();
    let active = 0, paused = 0, expired = 0, inUse = 0;
    for (const [id, session] of this.sessions) {
      if (session.expiresAt && session.expiresAt < now) { expired++; continue; }
      if (this.isPaused(id)) { paused++; continue; }
      if (this.inUse.has(id)) { inUse++; active++; continue; }
      active++;
    }
    return { total: this.sessions.size, active, paused, expired, inUse };
  }
}

module.exports = SessionManager;
