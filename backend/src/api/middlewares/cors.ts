import cors, { CorsOptions } from 'cors';
import { RequestHandler } from 'express';
import { AuthConfigService } from '@/services/auth/auth-config.service.js';
import { getApiBaseUrl } from '@/utils/environment.js';
import logger from '@/utils/logger.js';

/**
 * Dynamic CORS allowlist, replacing the previous `origin: true` (reflect any
 * origin) + `credentials: true` combination, which let any website make
 * authenticated, cookie-bearing requests against this API.
 *
 * An origin is allowed when it is either:
 *   - the API's own base URL (same-origin dashboard/self-host deployments), or
 *   - a match for one of the project's configured `allowedRedirectUrls`
 *     (the same allowlist OAuth/email-verification redirects already use).
 *
 * When no `allowedRedirectUrls` are configured, this falls back to the prior
 * permissive behavior (allow all) — matching `AuthConfigService.validateRedirectUrl`'s
 * own "no policy configured" default — so a fresh install or a project that
 * hasn't set one up yet keeps working exactly as before. Configuring an
 * allowlist is what turns real enforcement on.
 */

const ALLOWLIST_CACHE_MS = 30_000;

let cache: { allowedRedirectUrls: string[]; fetchedAt: number } | null = null;
let refreshPromise: Promise<string[]> | null = null;

async function getAllowedRedirectUrls(): Promise<string[]> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < ALLOWLIST_CACHE_MS) {
    return cache.allowedRedirectUrls;
  }

  // Coalesce concurrent refreshes into a single DB read.
  if (!refreshPromise) {
    refreshPromise = AuthConfigService.getInstance()
      .getAuthConfig()
      .then((config) => {
        const urls = config.allowedRedirectUrls ?? [];
        cache = { allowedRedirectUrls: urls, fetchedAt: Date.now() };
        return urls;
      })
      .catch((error) => {
        // A known-good list from a previous fetch is safe to keep serving
        // (stale allowlist beats treating a transient DB error as "no
        // allowlist configured", which the caller reads as allow-all). With
        // no prior successful fetch there is nothing safe to fall back to,
        // so the error propagates and the caller fails closed instead.
        if (cache) {
          logger.error('Failed to refresh CORS allowlist; keeping previous list', { error });
          return cache.allowedRedirectUrls;
        }
        throw error;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

/**
 * Extracts `scheme://host[:port]` from a redirect-URL pattern, discarding any
 * path/query — an `Origin` header never carries either. `host` may contain a
 * single leading `*.` wildcard (subdomain match), the same shape
 * `AuthConfigService.validateRedirectUrl` documents for its glob patterns;
 * broader glob forms (`**`, `?`, `[...]`) don't have a meaningful analogue for
 * an origin and are intentionally not supported here.
 */
function originFromPattern(pattern: string): { scheme: string; host: string } | null {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]+)/.exec(pattern);
  return match ? { scheme: match[1].toLowerCase(), host: match[2].toLowerCase() } : null;
}

export function originMatchesPattern(pattern: string, origin: string): boolean {
  const parsedPattern = originFromPattern(pattern);
  if (!parsedPattern) {
    return false;
  }

  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  if (originUrl.protocol !== `${parsedPattern.scheme}:`) {
    return false;
  }

  const originHost = originUrl.host.toLowerCase(); // includes port
  if (!parsedPattern.host.includes('*')) {
    return parsedPattern.host === originHost;
  }
  if (parsedPattern.host.startsWith('*.')) {
    // Matches only actual subdomains, not the bare apex — consistent with
    // how the same `*.host` shape behaves under `matchesGlobPattern`
    // (picomatch requires the literal "." before the base host to be
    // present, so "*.example.com" does not match "example.com" itself).
    const baseHost = parsedPattern.host.slice(2);
    return originHost.endsWith(`.${baseHost}`);
  }
  return false;
}

const corsOriginCallback: NonNullable<CorsOptions['origin']> = (origin, callback) => {
  // No Origin header: same-origin browser requests, curl, mobile/server
  // clients. The browser CORS check this option controls doesn't apply to them.
  if (!origin) {
    return callback(null, true);
  }

  if (origin === getApiBaseUrl()) {
    return callback(null, true);
  }

  getAllowedRedirectUrls()
    .then((allowedRedirectUrls) => {
      const allowed =
        allowedRedirectUrls.length === 0 ||
        allowedRedirectUrls.some((pattern) => originMatchesPattern(pattern, origin));
      callback(null, allowed);
    })
    .catch((error) => {
      logger.error('CORS origin check failed, rejecting request', { error, origin });
      callback(null, false);
    });
};

export const corsMiddleware: RequestHandler = cors({
  origin: corsOriginCallback,
  credentials: true,
  exposedHeaders: ['Content-Range', 'Preference-Applied'],
});
