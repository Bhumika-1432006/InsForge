import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestHandler } from 'express';

/**
 * Regression test for the clickjacking regression flagged on top of issue
 * #1895's Helmet hardening: disabling `frameguard` outright (to allow the
 * cloud-hosting partner's cross-origin iframe embed) let *any* origin frame
 * the dashboard. This middleware restores real protection via a scoped
 * `frame-ancestors` CSP directive instead.
 *
 * The middleware caches the fetched partner-origin list at module scope, so
 * each test resets the module registry and re-imports it fresh — otherwise
 * the first test's cached result would leak into later tests within the
 * TTL window.
 */
async function buildApp() {
  vi.resetModules();
  const { frameAncestorsMiddleware } =
    (await import('../../src/api/middlewares/frame-ancestors.js')) as {
      frameAncestorsMiddleware: RequestHandler;
    };

  const app = express();
  app.use(frameAncestorsMiddleware);
  app.get('/ping', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('frame-ancestors middleware', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('always includes self, plus any partner origins from the partnership config', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ partner_sites: ['https://partner.example.com/embed'] }),
    }) as unknown as typeof fetch;

    const res = await request(await buildApp()).get('/ping');

    expect(res.headers['content-security-policy']).toBe(
      "frame-ancestors 'self' https://partner.example.com"
    );
  });

  it('falls back to self only when the partnership config fetch fails and no cache exists', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network error')) as unknown as typeof fetch;

    const res = await request(await buildApp()).get('/ping');

    expect(res.headers['content-security-policy']).toBe("frame-ancestors 'self'");
  });

  it('ignores malformed entries in partner_sites instead of failing the whole policy', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ partner_sites: ['not-a-valid-url', 'https://good.example.com'] }),
    }) as unknown as typeof fetch;

    const res = await request(await buildApp()).get('/ping');

    expect(res.headers['content-security-policy']).toBe(
      "frame-ancestors 'self' https://good.example.com"
    );
  });

  it('caches the partner list and does not re-fetch within the TTL window', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ partner_sites: ['https://partner.example.com'] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const app = await buildApp();
    await request(app).get('/ping');
    await request(app).get('/ping');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
