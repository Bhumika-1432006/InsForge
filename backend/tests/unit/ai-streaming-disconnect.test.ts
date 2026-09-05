import http from 'http';
import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression test for issue #1895 (SSE Disconnect Token/Resource Leak): a
 * client disconnecting mid-stream from POST /api/ai/chat/completion used to
 * leave the server-side `for await` loop over the upstream provider stream
 * running to completion, continuing to consume AI tokens against a socket
 * nobody was reading.
 *
 * This spins up a real HTTP server (so the client can actually sever the
 * TCP connection) with a fake upstream generator standing in for the AI
 * provider stream, and asserts that destroying the client connection causes
 * the server to stop pulling further chunks from that generator.
 */

vi.hoisted(() => {
  process.env.JWT_SECRET = 'test-secret-long-enough-for-signing-32chars';
});

vi.mock('../../src/api/middlewares/auth.js', () => ({
  verifyAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
  verifyUser: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../src/utils/logger.js', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('../../src/services/ai/image-generation.service.js', () => ({
  ImageGenerationService: { getInstance: () => ({}) },
}));
vi.mock('../../src/services/ai/embedding.service.js', () => ({
  EmbeddingService: { getInstance: () => ({}) },
}));
vi.mock('../../src/services/ai/ai-model.service.js', () => ({
  AIModelService: { getInstance: () => ({}) },
}));
vi.mock('../../src/providers/ai/openrouter.provider.js', () => ({
  OpenRouterProvider: { getInstance: () => ({}) },
}));

// A plain async generator can't be preempted mid-await by `.return()` — the
// spec only lets `.return()` take effect once a call to `.next()` that's
// already in flight settles (verified empirically; see PR description). The
// real OpenAI SDK stream this route consumes isn't a plain generator: its
// `.return()` aborts the underlying fetch via an AbortController, which
// makes an *already pending* `.next()` settle early instead of producing a
// further chunk. Modelling that (rather than a plain `async function*`) is
// what actually exercises "does the route cancel promptly on disconnect".
const generatorState = vi.hoisted(() => ({
  returnCalled: false,
  producedSecondChunk: false,
}));

let releaseSecondChunk: (() => void) | null = null;
let cancelPending: (() => void) | null = null;

function createFakeUpstreamStream() {
  const secondChunkReady = new Promise<'chunk'>((resolve) => {
    releaseSecondChunk = () => resolve('chunk');
  });
  const cancelled = new Promise<'cancelled'>((resolve) => {
    cancelPending = () => resolve('cancelled');
  });

  let callCount = 0;
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      callCount += 1;
      if (callCount === 1) {
        return { value: { chunk: 'first' }, done: false };
      }
      const winner = await Promise.race([secondChunkReady, cancelled]);
      if (winner === 'cancelled') {
        return { value: undefined, done: true };
      }
      generatorState.producedSecondChunk = true;
      return { value: { chunk: 'second' }, done: false };
    },
    async return(value: unknown) {
      generatorState.returnCalled = true;
      cancelPending?.();
      return { value, done: true };
    },
  };
}

vi.mock('../../src/services/ai/chat-completion.service.js', () => ({
  ChatCompletionService: {
    getInstance: () => ({
      streamChat: () => createFakeUpstreamStream(),
    }),
  },
}));

describe('POST /api/ai/chat/completion — client disconnect mid-stream', () => {
  beforeEach(() => {
    generatorState.returnCalled = false;
    generatorState.producedSecondChunk = false;
  });

  it('stops pulling from the upstream stream once the client disconnects', async () => {
    const { aiRouter } = await import('../../src/api/routes/ai/index.routes.js');
    const app = express();
    app.use(express.json());
    app.use('/api/ai', aiRouter);

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected a bound TCP address');
    }

    try {
      const body = JSON.stringify({
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: true,
      });

      await new Promise<void>((resolve, reject) => {
        const clientReq = http.request(
          {
            host: '127.0.0.1',
            port: address.port,
            path: '/api/ai/chat/completion',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
            },
          },
          (res) => {
            res.on('data', () => {
              // Received the first SSE chunk — sever the connection now,
              // while the fake upstream's second `.next()` call is pending
              // (racing `secondChunkReady` against `cancelled`).
              clientReq.destroy();
            });
          }
        );
        clientReq.on('error', () => {
          // Expected: destroying the request surfaces as a socket error on
          // the client side (ECONNRESET or similar) — not a test failure.
          resolve();
        });
        clientReq.on('close', () => resolve());
        clientReq.on('timeout', () => reject(new Error('Request timed out')));
        clientReq.write(body);
        clientReq.end();
      });

      // Let the server-side 'close' listener run and call `.return()` before
      // asserting. Then release the "real chunk" side of the race too — if
      // the route had NOT cancelled, this is what would let a real upstream
      // eventually produce the second chunk; asserting first proves the
      // cancellation (not this release) is what ended the pending call.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(generatorState.returnCalled).toBe(true);
      expect(generatorState.producedSecondChunk).toBe(false);

      releaseSecondChunk?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(generatorState.producedSecondChunk).toBe(false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
