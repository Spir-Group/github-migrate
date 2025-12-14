// Rate limit tracking for GitHub API calls
// GitHub returns rate limit info in response headers:
// - x-ratelimit-limit: Maximum requests allowed
// - x-ratelimit-remaining: Requests remaining in window
// - x-ratelimit-reset: Unix timestamp when limit resets
// - x-ratelimit-used: Requests used in window
// - x-ratelimit-resource: Which resource pool (core, graphql, search, etc.)

import { serverLog } from './logger';

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  used: number;
  resetAt: string;  // ISO timestamp
  resource: string;
  percentUsed: number;
  updatedAt: string;
}

export interface HostRateLimits {
  host: string;
  resources: Record<string, RateLimitInfo>;
  updatedAt: string;
}

// Track rate limits per host (github.com, ghes.company.com, etc.)
const rateLimits: Map<string, HostRateLimits> = new Map();

/**
 * Parse rate limit headers from a fetch Response
 */
export function parseRateLimitHeaders(response: Response, host: string): RateLimitInfo | null {
  const limit = response.headers.get('x-ratelimit-limit');
  const remaining = response.headers.get('x-ratelimit-remaining');
  const reset = response.headers.get('x-ratelimit-reset');
  const used = response.headers.get('x-ratelimit-used');
  const resource = response.headers.get('x-ratelimit-resource');

  if (!limit || !remaining || !reset) {
    return null;
  }

  const limitNum = parseInt(limit, 10);
  const remainingNum = parseInt(remaining, 10);
  const usedNum = used ? parseInt(used, 10) : (limitNum - remainingNum);
  const resetTimestamp = parseInt(reset, 10) * 1000;  // Convert to ms

  return {
    limit: limitNum,
    remaining: remainingNum,
    used: usedNum,
    resetAt: new Date(resetTimestamp).toISOString(),
    resource: resource || 'core',
    percentUsed: Math.round((usedNum / limitNum) * 100),
    updatedAt: new Date().toISOString()
  };
}

/**
 * Parse rate limit info from gh CLI stderr output
 * The gh CLI outputs rate limit info in verbose mode or when rate limited
 */
export function parseRateLimitFromGhOutput(stderr: string, host: string): Partial<RateLimitInfo> | null {
  // gh CLI may output: "gh: API rate limit exceeded" or similar
  if (stderr.toLowerCase().includes('rate limit')) {
    // Try to extract reset time if present
    const resetMatch = stderr.match(/reset(?:s)?\s+(?:at|in)\s+(\d+)/i);
    if (resetMatch) {
      const resetTimestamp = parseInt(resetMatch[1], 10) * 1000;
      return {
        remaining: 0,
        resetAt: new Date(resetTimestamp).toISOString(),
        resource: 'core',
        updatedAt: new Date().toISOString()
      };
    }
    return {
      remaining: 0,
      resource: 'core',
      updatedAt: new Date().toISOString()
    };
  }
  return null;
}

/**
 * Update rate limit info for a host
 */
export function updateRateLimit(host: string, info: RateLimitInfo): void {
  const normalizedHost = normalizeHost(host);
  let hostLimits = rateLimits.get(normalizedHost);
  
  if (!hostLimits) {
    hostLimits = {
      host: normalizedHost,
      resources: {},
      updatedAt: new Date().toISOString()
    };
    rateLimits.set(normalizedHost, hostLimits);
  }

  hostLimits.resources[info.resource] = info;
  hostLimits.updatedAt = new Date().toISOString();

  // Log warning if rate limit is getting low
  if (info.remaining < 100 && info.percentUsed > 80) {
    serverLog.warn(`Rate limit warning for ${normalizedHost}/${info.resource}: ${info.remaining}/${info.limit} remaining (${info.percentUsed}% used), resets at ${info.resetAt}`);
  }
}

/**
 * Get rate limit info for a specific host
 */
export function getRateLimits(host?: string): HostRateLimits[] {
  if (host) {
    const normalizedHost = normalizeHost(host);
    const limits = rateLimits.get(normalizedHost);
    return limits ? [limits] : [];
  }
  return Array.from(rateLimits.values());
}

/**
 * Get all rate limits as a summary object
 */
export function getRateLimitSummary(): {
  hosts: HostRateLimits[];
  warnings: Array<{ host: string; resource: string; remaining: number; percentUsed: number; resetAt: string }>;
} {
  const hosts = Array.from(rateLimits.values());
  const warnings: Array<{ host: string; resource: string; remaining: number; percentUsed: number; resetAt: string }> = [];

  for (const hostLimits of hosts) {
    for (const [resource, info] of Object.entries(hostLimits.resources)) {
      // Consider it a warning if >50% used or <500 remaining
      if (info.percentUsed > 50 || info.remaining < 500) {
        warnings.push({
          host: hostLimits.host,
          resource,
          remaining: info.remaining,
          percentUsed: info.percentUsed,
          resetAt: info.resetAt
        });
      }
    }
  }

  // Sort warnings by percent used (highest first)
  warnings.sort((a, b) => b.percentUsed - a.percentUsed);

  return { hosts, warnings };
}

/**
 * Normalize host string
 */
function normalizeHost(host: string): string {
  // Remove protocol if present
  return host.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
}

/**
 * Wrapper for fetch that tracks rate limits
 */
export async function fetchWithRateLimitTracking(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const response = await fetch(url, options);
  
  // Extract host from URL
  const urlObj = new URL(url);
  const host = urlObj.hostname;
  
  // Parse and update rate limit info
  const rateLimitInfo = parseRateLimitHeaders(response, host);
  if (rateLimitInfo) {
    updateRateLimit(host, rateLimitInfo);
  }
  
  return response;
}

/**
 * Clear rate limit cache (for testing)
 */
export function clearRateLimits(): void {
  rateLimits.clear();
}
