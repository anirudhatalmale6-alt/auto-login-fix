/**
 * Proxy Manager — Sticky IP assignment with centralized locking.
 * Each candidate gets a unique IP. Create + WS + Update all use the same IP.
 * On 429/403, the IP is released and a fresh one is assigned.
 */
const { HttpsProxyAgent } = require('https-proxy-agent');
const log = require('../utils/logger');

class ProxyManager {
  constructor() {
    this.proxies = [];          // Array of proxy URL strings
    this.stickyMap = new Map(); // candidateId -> { agent, proxyUrl, assignedAt }
    this.lockedIPs = new Set(); // Currently assigned proxy URLs
  }

  updateProxies(proxyList) {
    this.proxies = proxyList.filter(p => p && p.trim().length > 0);
    log.info('ProxyMgr', `Pool updated: ${this.proxies.length} proxies available`);
  }

  /**
   * Get sticky agent for a candidate. Reuses existing assignment or assigns new.
   * Returns { agent, proxyUrl } or null if no proxies available.
   */
  getStickyAgent(candidateId) {
    if (this.proxies.length === 0) return null;

    // Reuse existing assignment if still valid
    const existing = this.stickyMap.get(candidateId);
    if (existing && this.proxies.includes(existing.proxyUrl)) {
      return existing;
    }

    // Rebuild locked IPs from current assignments
    this.lockedIPs.clear();
    for (const val of this.stickyMap.values()) {
      this.lockedIPs.add(val.proxyUrl);
    }

    // Pick an unlocked proxy
    const available = this.proxies.filter(p => !this.lockedIPs.has(p));
    let proxyUrl;

    if (available.length > 0) {
      proxyUrl = available[Math.floor(Math.random() * available.length)];
    } else {
      // All IPs in use — pick random (overlap)
      log.warn('ProxyMgr', `Pool exhausted (${this.proxies.length} IPs, ${this.stickyMap.size} assigned). Overlap for ${candidateId}`);
      proxyUrl = this.proxies[Math.floor(Math.random() * this.proxies.length)];
    }

    const agent = new HttpsProxyAgent(proxyUrl, {
      keepAlive: true,
      keepAliveMsecs: 60000,
      maxSockets: 256,
      maxFreeSockets: 256,
      scheduling: 'lifo',
    });

    const entry = { agent, proxyUrl, assignedAt: Date.now() };
    this.stickyMap.set(candidateId, entry);
    this.lockedIPs.add(proxyUrl);

    log.info('ProxyMgr', `Assigned ${proxyUrl} -> ${candidateId}`);
    return entry;
  }

  /**
   * Release a candidate's IP (on 429/403 or rotation timer).
   * The agent is destroyed after a grace period.
   */
  release(candidateId) {
    const existing = this.stickyMap.get(candidateId);
    if (!existing) return;

    this.stickyMap.delete(candidateId);
    this.lockedIPs.delete(existing.proxyUrl);
    log.info('ProxyMgr', `Released ${existing.proxyUrl} from ${candidateId}`);

    // Destroy agent after keep-alive expires
    setTimeout(() => {
      try { existing.agent.destroy(); } catch (e) {}
    }, 65000);
  }

  /**
   * Get a direct proxy URL for WebSocket connections (no agent needed).
   */
  getProxyUrlForCandidate(candidateId) {
    const entry = this.stickyMap.get(candidateId);
    return entry ? entry.proxyUrl : null;
  }

  getStats() {
    return {
      totalProxies: this.proxies.length,
      assignedIPs: this.stickyMap.size,
      availableIPs: this.proxies.length - this.lockedIPs.size,
    };
  }
}

module.exports = ProxyManager;
