import { HttpsProxyAgent } from 'https-proxy-agent';
import dns from 'dns';

// ─── DNS Cache ──────────────────────────────────────────────────────────────
// Eliminates repeated DNS lookups for proxy hostnames (~50-100ms saved per cold connection)
const dnsCache = new Map<string, { address: string, family: number, cachedAt: number }>();
const DNS_CACHE_TTL = 300000; // 5 minutes

function cachedDnsLookup(
  hostname: string,
  options: any,
  callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void
): void {
  // Handle overloaded signatures
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }

  const now = Date.now();
  const cached = dnsCache.get(hostname);
  if (cached && (now - cached.cachedAt < DNS_CACHE_TTL)) {
    process.nextTick(() => callback(null, cached.address, cached.family));
    return;
  }

  dns.lookup(hostname, options, (err: any, address: string, family: number) => {
    if (!err && address) {
      dnsCache.set(hostname, { address, family, cachedAt: now });
    }
    callback(err, address, family);
  });
}

// ─── URL Normalization ──────────────────────────────────────────────────────
// Force http:// for proxy connections — CONNECT tunnel handles end-to-end encryption
// Using https:// causes double TLS (TLS to proxy + TLS to target) adding ~100-200ms
function normalizeProxyUrl(url: string): string {
  return url.trim().replace(/^https:\/\//, 'http://');
}

// ─── Shared Agent Options ───────────────────────────────────────────────────
const AGENT_OPTS = {
  keepAlive: true,
  keepAliveMsecs: 30000,   // Send TCP keepalive probes every 30s (more aggressive than 60s)
  maxSockets: 10,           // 10 concurrent connections per agent (realistic for single candidate)
  maxFreeSockets: 10,
  scheduling: 'lifo' as const,
  lookup: cachedDnsLookup as any,  // Use cached DNS lookup
};

export class ProxyManager {
  private proxies: string[] = [];
  private currentIndex: number = 0;

  // Store the Agent Instance instead of just the string to enable connection reuse
  private stickyAgents: Map<string, { agent: HttpsProxyAgent<string>, proxyUrl: string }> = new Map();

  // Track globally locked IPs to prevent race conditions during concurrent assignments
  private lockedIPs: Set<string> = new Set();

  constructor(initialProxies: string[] = []) {
    this.updateProxies(initialProxies);
  }

  /**
   * Update the pool of available proxies
   */
  public updateProxies(proxyList: string[]) {
    // Normalize all URLs: trim whitespace, force http://
    this.proxies = proxyList
      .filter(p => p && p.trim().length > 0)
      .map(normalizeProxyUrl);
    this.currentIndex = 0;

    console.log(`🔌 Proxy pool updated: ${this.proxies.length} proxies available`);
  }

  /**
   * Pre-resolve DNS for all proxy hostnames to warm the cache
   */
  public async warmDNS(): Promise<void> {
    const hostnames = new Set<string>();
    for (const proxy of this.proxies) {
      try {
        const url = new URL(proxy);
        hostnames.add(url.hostname);
      } catch (e) { /* ignore */ }
    }

    for (const hostname of hostnames) {
      try {
        await new Promise<void>((resolve) => {
          cachedDnsLookup(hostname, {}, () => resolve());
        });
        console.log(`🌐 DNS pre-resolved: ${hostname}`);
      } catch (e) { /* ignore */ }
    }
  }

  /**
   * Get the next proxy in the rotation (Round-Robin)
   */
  public getNextAgent(): HttpsProxyAgent<string> | undefined {
    if (this.proxies.length === 0) {
      return undefined;
    }

    const proxyUrl = this.proxies[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.proxies.length;

    try {
      return new HttpsProxyAgent(proxyUrl, AGENT_OPTS);
    } catch (error) {
      console.error(`Failed to create agent for proxy ${proxyUrl}:`, error);
      return undefined;
    }
  }

  /**
   * Get a sticky agent for a specific session (Candidate ID) AND reuse the connection.
   * Enforces Centralized IP Locking to ensure concurrent pollers don't share IPs.
   */
  public getStickyAgent(sessionId: string): { agent: HttpsProxyAgent<string>, proxyUrl: string } | undefined {
    if (this.proxies.length === 0) {
      return undefined;
    }

    // 1. Check if we already have an active agent for this candidate
    const existing = this.stickyAgents.get(sessionId);

    // 2. If valid agent exists and the IP is still in our allowed pool, REUSE IT
    if (existing && this.proxies.includes(existing.proxyUrl)) {
      return existing;
    }

    // 3. Strict Centralized IP Locking
    this.lockedIPs.clear();
    for (const val of this.stickyAgents.values()) {
      this.lockedIPs.add(val.proxyUrl);
    }

    // 4. Select a new IP explicitly avoiding locked IPs
    const availableProxies = this.proxies.filter(p => !this.lockedIPs.has(p));
    let proxyUrl: string;

    if (availableProxies.length > 0) {
      proxyUrl = availableProxies[Math.floor(Math.random() * availableProxies.length)];
    } else {
      console.warn(`⚠️ Proxy pool exhausted! Forcing IP overlap for candidate ${sessionId}`);
      proxyUrl = this.proxies[Math.floor(Math.random() * this.proxies.length)];
    }

    try {
      const newAgent = new HttpsProxyAgent(proxyUrl, AGENT_OPTS);
      const result = { agent: newAgent, proxyUrl };

      // Store and Lock it
      this.stickyAgents.set(sessionId, result);
      this.lockedIPs.add(proxyUrl);

      console.log(`🔗 [New Connection] Assigned IP ${proxyUrl} to Candidate ${sessionId}`);

      return result;
    } catch (error) {
      console.error(`Failed to create agent for proxy ${proxyUrl}:`, error);
      return undefined;
    }
  }

  public getProxyCount(): number {
    return this.proxies.length;
  }

  /**
   * Clear sticky session — removes the IP assignment so the next request gets a new IP.
   * Agent is destroyed after a grace period to allow in-flight requests to complete.
   */
  public clearStickySession(sessionId: string): void {
    const existing = this.stickyAgents.get(sessionId);
    if (existing) {
      console.log(`[Graceful Detach] Candidate ${sessionId} detached from IP ${existing.proxyUrl}`);

      this.stickyAgents.delete(sessionId);
      this.lockedIPs.delete(existing.proxyUrl);

      // Destroy the old agent after keep-alive expires
      setTimeout(() => {
        try {
          if (typeof existing.agent.destroy === 'function') {
            existing.agent.destroy();
          }
        } catch (e) { /* ignore */ }
      }, 35000); // 35s (just past the 30s keepAlive)
    }
  }
}