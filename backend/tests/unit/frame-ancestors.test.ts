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
 * Also a regression test for a follow-up finding: the middleware is mounted
 * globally ahead of every route (including health checks), so it must never
 * block a request on the outbound fetch to config.insforge.dev — it serves
 * from cache synchronously and refreshes in the background.
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

  it('defaults to self only on the very first request, before any fetch has completed', async () => {
    // A fetch that never resolves within the test: proves the response
    // does not wait on it.
    global.fetch = vi.fn().mockReturnValue(new Promise(() => {})) as unknown as typeof fetch;

    const res = await request(await buildApp()).get('/ping');

    expect(res.headers['content-security-policy']).toBe("frame-ancestors 'self'");
  });

  it('includes partner origins from the partnership config once a background fetch resolves', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ partner_sites: ['https://partner.example.com/embed'] }),
    }) as unknown as typeof fetch;

    const app = await buildApp();
    // First request triggers the background fetch (and gets 'self' only,
    // since it hasn't resolved yet); wait for it, then request again.
    await request(app).get('/ping');
    await new Promise((resolve) => setImmediate(resolve));
    const res = await request(app).get('/ping');

    expect(res.headers['content-security-policy']).toBe(
      "frame-ancestors 'self' https://partner.example.com"
    );
  });

  it('ignores malformed entries in partner_sites instead of failing the whole policy', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ partner_sites: ['not-a-valid-url', 'https://good.example.com'] }),
    }) as unknown as typeof fetch;

    const app = await buildApp();
    await request(app).get('/ping');
    await new Promise((resolve) => setImmediate(resolve));
    const res = await request(app).get('/ping');

    expect(res.headers['content-security-policy']).toBe(
      "frame-ancestors 'self' https://good.example.com"
    );
  });

  it('degrades to self only, without throwing, when the background fetch fails and nothing was cached yet', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network error')) as unknown as typeof fetch;

    const app = await buildApp();
    const firstRes = await request(app).get('/ping');
    await new Promise((resolve) => setImmediate(resolve));
    const secondRes = await request(app).get('/ping');

    expect(firstRes.headers['content-security-policy']).toBe("frame-ancestors 'self'");
    expect(secondRes.headers['content-security-policy']).toBe("frame-ancestors 'self'");
  });

  it('does not re-fetch within the TTL window', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ partner_sites: ['https://partner.example.com'] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const app = await buildApp();
    await request(app).get('/ping');
    await new Promise((resolve) => setImmediate(resolve));
    await request(app).get('/ping');
    await request(app).get('/ping');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
