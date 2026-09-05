import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression tests for issue #1895 (Over-Permissive CORS Configuration):
 * `cors({ origin: true, credentials: true })` reflected any Origin header and
 * allowed credentialed cross-origin requests from it, so any website could
 * make authenticated calls against this API using a visitor's cookies.
 */

const authConfigMock = vi.hoisted(() => ({ getAuthConfig: vi.fn() }));

vi.mock('../../src/services/auth/auth-config.service.js', () => ({
  AuthConfigService: { getInstance: () => authConfigMock },
}));

vi.mock('../../src/utils/environment.js', () => ({
  getApiBaseUrl: () => 'https://api.example.com',
}));

vi.mock('../../src/utils/logger.js', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

async function buildApp() {
  vi.resetModules();
  const { corsMiddleware } = await import('../../src/api/middlewares/cors.js');
  const app = express();
  app.use(corsMiddleware);
  app.get('/ping', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('corsMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows the API base origin', async () => {
    authConfigMock.getAuthConfig.mockResolvedValue({ allowedRedirectUrls: [] });
    const app = await buildApp();

    const res = await request(app).get('/ping').set('Origin', 'https://api.example.com');

    expect(res.headers['access-control-allow-origin']).toBe('https://api.example.com');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('allows any origin when no allowlist is configured (unchanged default)', async () => {
    authConfigMock.getAuthConfig.mockResolvedValue({ allowedRedirectUrls: [] });
    const app = await buildApp();

    const res = await request(app).get('/ping').set('Origin', 'https://anything.example');

    expect(res.headers['access-control-allow-origin']).toBe('https://anything.example');
  });

  it('rejects an origin not covered by a configured allowlist', async () => {
    authConfigMock.getAuthConfig.mockResolvedValue({
      allowedRedirectUrls: ['https://app.example.com/auth/callback'],
    });
    const app = await buildApp();

    const res = await request(app).get('/ping').set('Origin', 'https://evil.example');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows an origin matching a configured allowlist entry', async () => {
    authConfigMock.getAuthConfig.mockResolvedValue({
      allowedRedirectUrls: ['https://app.example.com/auth/callback'],
    });
    const app = await buildApp();

    const res = await request(app).get('/ping').set('Origin', 'https://app.example.com');

    expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
  });

  it('allows a subdomain-wildcard allowlist entry', async () => {
    authConfigMock.getAuthConfig.mockResolvedValue({
      allowedRedirectUrls: ['https://*.example.com/**'],
    });
    const app = await buildApp();

    const res = await request(app).get('/ping').set('Origin', 'https://tenant.example.com');

    expect(res.headers['access-control-allow-origin']).toBe('https://tenant.example.com');
  });

  it('rejects a scheme mismatch against an otherwise-matching host', async () => {
    authConfigMock.getAuthConfig.mockResolvedValue({
      allowedRedirectUrls: ['https://app.example.com/callback'],
    });
    const app = await buildApp();

    const res = await request(app).get('/ping').set('Origin', 'http://app.example.com');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows requests without an Origin header through (non-browser clients)', async () => {
    authConfigMock.getAuthConfig.mockResolvedValue({
      allowedRedirectUrls: ['https://app.example.com/callback'],
    });
    const app = await buildApp();

    const res = await request(app).get('/ping');

    expect(res.status).toBe(200);
  });

  it('fails closed (relative to a configured allowlist) if the config lookup errors', async () => {
    authConfigMock.getAuthConfig.mockRejectedValue(new Error('db down'));
    const app = await buildApp();

    const res = await request(app).get('/ping').set('Origin', 'https://app.example.com');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('originMatchesPattern', () => {
  it('matches exact origins case-insensitively', async () => {
    const { originMatchesPattern } = await import('../../src/api/middlewares/cors.js');
    expect(originMatchesPattern('https://App.Example.com', 'https://app.example.com')).toBe(true);
  });

  it('matches a single leading subdomain wildcard', async () => {
    const { originMatchesPattern } = await import('../../src/api/middlewares/cors.js');
    expect(originMatchesPattern('https://*.example.com', 'https://a.b.example.com')).toBe(true);
    expect(originMatchesPattern('https://*.example.com', 'https://example.com')).toBe(false);
  });

  it('rejects a port mismatch', async () => {
    const { originMatchesPattern } = await import('../../src/api/middlewares/cors.js');
    expect(originMatchesPattern('https://example.com:8443', 'https://example.com')).toBe(false);
  });

  it('rejects an unparseable pattern', async () => {
    const { originMatchesPattern } = await import('../../src/api/middlewares/cors.js');
    expect(originMatchesPattern('not-a-url', 'https://example.com')).toBe(false);
  });
});
