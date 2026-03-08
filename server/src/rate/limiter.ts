import { createClient, RedisClientType } from 'redis';

export interface RateLimitResult {
  ok: boolean;
  retryAfterMs?: number;
}

export class RateLimiter {
  private client: RedisClientType;
  private connected: boolean = false;
  private perIdRps: number;
  private perIdBurst: number;
  private globalRps: number;
  private globalBurst: number;

  constructor(
    redisUrl: string = 'redis://localhost:6379',
    perIdRps: number = 9,
    perIdBurst: number = 18,
    globalRps: number = 40,
    globalBurst: number = 80
  ) {
    this.client = createClient({ url: redisUrl });
    this.client.on('error', (err) => console.error('Redis Client Error:', err));
    this.perIdRps = perIdRps;
    this.perIdBurst = perIdBurst;
    this.globalRps = globalRps;
    this.globalBurst = globalBurst;
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

  /**
   * Token bucket algorithm for per-candidate rate limiting
   */
  async take(candidateId: string, rps?: number, burst?: number): Promise<RateLimitResult> {
    await this.connect();
    
    const rate = rps || this.perIdRps;
    const maxTokens = burst || this.perIdBurst;
    const key = `rate:cand:${candidateId}`;
    
    const now = Date.now();
    const windowMs = 1000; // 1 second window
    
    // Use Redis Lua script for atomic token bucket
    const lua = `
      local key = KEYS[1]
      local now = tonumber(ARGV[1])
      local rate = tonumber(ARGV[2])
      local maxTokens = tonumber(ARGV[3])
      local windowMs = tonumber(ARGV[4])
      
      local data = redis.call('GET', key)
      local tokens = maxTokens
      local lastRefill = now
      
      if data then
        local parts = {}
        for part in string.gmatch(data, "[^:]+") do
          table.insert(parts, part)
        end
        tokens = tonumber(parts[1])
        lastRefill = tonumber(parts[2])
      end
      
      -- Refill tokens based on time elapsed
      local elapsed = (now - lastRefill) / windowMs
      tokens = math.min(maxTokens, tokens + (rate * elapsed))
      
      if tokens >= 1 then
        tokens = tokens - 1
        local newData = tostring(tokens) .. ":" .. tostring(now)
        redis.call('SETEX', key, 60, newData)
        return {1, tokens, 0}
      else
        -- Calculate retry after
        local needTokens = 1 - tokens
        local waitTime = (needTokens / rate) * windowMs
        return {0, tokens, math.ceil(waitTime)}
      end
    `;
    
    try {
      const result = await this.client.eval(lua, {
        keys: [key],
        arguments: [
          now.toString(),
          rate.toString(),
          maxTokens.toString(),
          windowMs.toString()
        ]
      }) as [number, number, number];
      
      const [allowed, remainingTokens, retryAfterMs] = result;
      
      if (allowed === 1) {
        return { ok: true };
      } else {
        return { ok: false, retryAfterMs };
      }
    } catch (error) {
      console.error('Rate limit error:', error);
      // On error, allow the request
      return { ok: true };
    }
  }

  /**
   * Token bucket algorithm for global rate limiting
   */
  async takeGlobal(rps?: number, burst?: number): Promise<RateLimitResult> {
    await this.connect();
    
    const rate = rps || this.globalRps;
    const maxTokens = burst || this.globalBurst;
    const key = 'global:rate';
    
    const now = Date.now();
    const windowMs = 1000; // 1 second window
    
    // Use Redis Lua script for atomic token bucket
    const lua = `
      local key = KEYS[1]
      local now = tonumber(ARGV[1])
      local rate = tonumber(ARGV[2])
      local maxTokens = tonumber(ARGV[3])
      local windowMs = tonumber(ARGV[4])
      
      local data = redis.call('GET', key)
      local tokens = maxTokens
      local lastRefill = now
      
      if data then
        local parts = {}
        for part in string.gmatch(data, "[^:]+") do
          table.insert(parts, part)
        end
        tokens = tonumber(parts[1])
        lastRefill = tonumber(parts[2])
      end
      
      -- Refill tokens based on time elapsed
      local elapsed = (now - lastRefill) / windowMs
      tokens = math.min(maxTokens, tokens + (rate * elapsed))
      
      if tokens >= 1 then
        tokens = tokens - 1
        local newData = tostring(tokens) .. ":" .. tostring(now)
        redis.call('SETEX', key, 60, newData)
        return {1, tokens, 0}
      else
        -- Calculate retry after
        local needTokens = 1 - tokens
        local waitTime = (needTokens / rate) * windowMs
        return {0, tokens, math.ceil(waitTime)}
      end
    `;
    
    try {
      const result = await this.client.eval(lua, {
        keys: [key],
        arguments: [
          now.toString(),
          rate.toString(),
          maxTokens.toString(),
          windowMs.toString()
        ]
      }) as [number, number, number];
      
      const [allowed, remainingTokens, retryAfterMs] = result;
      
      if (allowed === 1) {
        return { ok: true };
      } else {
        return { ok: false, retryAfterMs };
      }
    } catch (error) {
      console.error('Global rate limit error:', error);
      // On error, allow the request
      return { ok: true };
    }
  }
}



