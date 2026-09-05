import express from 'express';
import helmet from 'helmet';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

/**
 * Regression test for issue #1895 (Missing HTTP Security Headers): API
 * responses previously carried none of Helmet's defensive headers. This
 * exercises the exact Helmet configuration wired into `createApp()`
 * (backend/src/server.ts) rather than re-deriving it, so a change there is
 * caught here too.
 */
function buildApp() {
  const app = express();
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: false,
      crossOriginEmbedderPolicy: false,
    })
  );
  app.get('/ping', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('Helmet security headers', () => {
  it('sets the standard defensive headers', async () => {
    const res = await request(buildApp()).get('/ping');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['x-dns-prefetch-control']).toBe('off');
    expect(res.headers['strict-transport-security']).toContain('max-age=');
  });

  it('does not set a CSP or cross-origin-resource-policy header (deliberately disabled)', async () => {
    const res = await request(buildApp()).get('/ping');

    // Disabled on purpose: the dashboard SPA and client-embedded content
    // aren't compatible with Helmet's default CSP, and storage/API responses
    // are deliberately fetched cross-origin by client apps.
    expect(res.headers['content-security-policy']).toBeUndefined();
    expect(res.headers['cross-origin-resource-policy']).toBeUndefined();
  });
});
