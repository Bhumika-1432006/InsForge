import { RequestHandler } from 'express';
import logger from '@/utils/logger.js';

/**
 * Restores frame-ancestors protection that plain `frameguard: false` removed
 * entirely. The cloud-hosting partner embeds the dashboard in a cross-origin
 * iframe (frontend/src/cloud-hosting/useCloudHosting.ts), so a blanket
 * X-Frame-Options/CSP frame-ancestors block would break that supported flow —
 * but allowing every origin to frame the authenticated dashboard is a
 * clickjacking hole. This builds a `frame-ancestors` CSP value scoped to
 * `'self'` plus the same trusted partner origins the frontend already reads
 * from `https://config.insforge.dev/partnership.json`
 * (frontend/src/cloud-hosting/partner.service.ts), so only that trusted
 * partner — not the entire web — can frame these pages.
 */

const PARTNERSHIP_CONFIG_URL = 'https://config.insforge.dev/partnership.json';
const PARTNER_ORIGINS_CACHE_MS = 30_000;
const FETCH_TIMEOUT_MS = 5_000;

let cache: { partnerOrigins: string[]; fetchedAt: number } | null = null;
let refreshPromise: Promise<string[]> | null = null;

async function fetchPartnerOrigins(): Promise<string[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(PARTNERSHIP_CONFIG_URL, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Unexpected status ${response.status}`);
    }
    const data = (await response.json()) as { partner_sites?: unknown };
    const sites = Array.isArray(data.partner_sites) ? data.partner_sites : [];
    const origins = new Set<string>();
    for (const site of sites) {
      if (typeof site !== 'string') {
        continue;
      }
      try {
        origins.add(new URL(site).origin);
      } catch {
        // Skip malformed entries rather than failing the whole fetch.
      }
    }
    return [...origins];
  } finally {
    clearTimeout(timeout);
  }
}

async function getPartnerOrigins(): Promise<string[]> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < PARTNER_ORIGINS_CACHE_MS) {
    return cache.partnerOrigins;
  }

  // Coalesce concurrent refreshes into a single outbound request.
  if (!refreshPromise) {
    refreshPromise = fetchPartnerOrigins()
      .then((partnerOrigins) => {
        cache = { partnerOrigins, fetchedAt: Date.now() };
        return partnerOrigins;
      })
      .catch((error) => {
        // A stale-but-known-good list is safer to keep serving than dropping
        // the partner from the policy (which would break the embed) or
        // failing the request outright. With no prior successful fetch there
        // is nothing to fall back to, so the caller gets an empty list and
        // the policy degrades to 'self' only until a fetch succeeds.
        if (cache) {
          logger.error(
            'Failed to refresh partner origins for frame-ancestors; keeping previous list',
            {
              error,
            }
          );
          cache.fetchedAt = Date.now();
          return cache.partnerOrigins;
        }
        logger.error(
          'Failed to fetch partner origins for frame-ancestors; defaulting to self only',
          {
            error,
          }
        );
        return [];
      })
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

export const frameAncestorsMiddleware: RequestHandler = (req, res, next) => {
  getPartnerOrigins()
    .then((partnerOrigins) => {
      const sources = ["'self'", ...partnerOrigins];
      res.setHeader('Content-Security-Policy', `frame-ancestors ${sources.join(' ')}`);
      next();
    })
    .catch(() => {
      // getPartnerOrigins already degrades internally and should not reject,
      // but fail closed to 'self' only rather than skip the header entirely.
      res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
      next();
    });
};
