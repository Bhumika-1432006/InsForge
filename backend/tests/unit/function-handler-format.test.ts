import { readFileSync } from 'fs';
import { join } from 'path';
import vm from 'vm';
import { describe, expect, it } from 'vitest';

/**
 * `functions/handler-format.js` is plain JS with no import/export of its own
 * (see file header) so it can be concatenated ahead of `worker-template.js`
 * for the Deno worker. Load its real source here via `vm` — rather than
 * re-implementing the regex in this test — so the test tracks the exact code
 * that ships, with no risk of drifting from it.
 */
function loadNormalizeHandlerFormat(): (code: string) => string {
  const source = readFileSync(join(__dirname, '../../../functions/handler-format.js'), 'utf-8');
  const context: { normalizeHandlerFormat?: (code: string) => string } = {};
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.normalizeHandlerFormat = normalizeHandlerFormat;`, context);
  if (typeof context.normalizeHandlerFormat !== 'function') {
    throw new Error('normalizeHandlerFormat was not defined by handler-format.js');
  }
  return context.normalizeHandlerFormat;
}

describe('normalizeHandlerFormat (functions/handler-format.js)', () => {
  const normalizeHandlerFormat = loadNormalizeHandlerFormat();

  it('leaves legacy module.exports handlers untouched', () => {
    const code = `module.exports = async function (request) {
  return new Response("hi");
};`;
    expect(normalizeHandlerFormat(code)).toBe(code);
  });

  it('rewrites the documented "export default" handler into module.exports', () => {
    const code = `import { createClient } from 'npm:@insforge/sdk';

export default async function (req) {
  return new Response("hi");
}`;

    const result = normalizeHandlerFormat(code);

    expect(result).not.toMatch(/\bimport\b/);
    expect(result).not.toMatch(/\bexport\s+default\b/);
    expect(result).toContain('module.exports = async function (req) {');

    // The rewritten source must actually be usable by `new Function(...)`,
    // the same execution path worker-template.js uses.
    const wrapper = new Function('exports', 'module', result);
    const exportsObj: Record<string, unknown> = {};
    const moduleObj = { exports: exportsObj };
    wrapper(exportsObj, moduleObj);
    expect(typeof moduleObj.exports).toBe('function');
  });

  it('rewrites a named "export default function handler"', () => {
    const code = `export default async function handler(req) {
  return new Response("hi");
}`;

    const result = normalizeHandlerFormat(code);
    expect(result).toBe(`module.exports = async function handler(req) {
  return new Response("hi");
}`);
  });

  it('rewrites an "export default" arrow function', () => {
    const code = `export default async (req) => new Response("hi");`;
    const result = normalizeHandlerFormat(code);
    expect(result).toBe('module.exports = async (req) => new Response("hi");');
  });

  it('strips the base64 std import alongside the SDK import', () => {
    const code = `import { createClient } from 'npm:@insforge/sdk';
import { encodeBase64, decodeBase64 } from 'https://deno.land/std@0.224.0/encoding/base64.ts';

export default async function (req) {
  return new Response(encodeBase64(new Uint8Array()));
}`;

    const result = normalizeHandlerFormat(code);
    expect(result).not.toMatch(/\bimport\b/);
    expect(result).toContain('module.exports = async function (req) {');
  });

  it('leaves unrecognized imports untouched (not silently swallowed)', () => {
    const code = `import { something } from 'npm:some-other-package';

export default async function (req) {
  return new Response(something());
}`;

    const result = normalizeHandlerFormat(code);
    expect(result).toContain("import { something } from 'npm:some-other-package';");
    expect(result).toContain('module.exports = async function (req) {');
  });

  // Regression coverage for review findings on the PR that introduced this
  // file — each of these previously produced a `new Function` SyntaxError or
  // ReferenceError under the documented format.

  it('strips the documented TypeScript-typed signature (parameter and return types)', () => {
    const code = `import { createClient } from 'npm:@insforge/sdk';

export default async function (req: Request): Promise<Response> {
  return new Response("hi");
}`;

    const result = normalizeHandlerFormat(code);
    expect(result).not.toMatch(/:\s*Request/);
    expect(result).not.toMatch(/Promise<Response>/);

    const wrapper = new Function('exports', 'module', 'createClient', result);
    const exportsObj: Record<string, unknown> = {};
    const moduleObj = { exports: exportsObj };
    wrapper(exportsObj, moduleObj, () => ({}));
    expect(typeof moduleObj.exports).toBe('function');
  });

  it('strips types from multiple parameters, including a generic with an internal comma', async () => {
    const code = `export default async function (req: Request, opts: Record<string, string> = {}): Promise<Response> {
  return new Response(JSON.stringify(opts));
}`;

    const result = normalizeHandlerFormat(code);
    const wrapper = new Function('exports', 'module', result);
    const exportsObj: Record<string, unknown> = {};
    const moduleObj = { exports: exportsObj };
    wrapper(exportsObj, moduleObj);
    const handler = moduleObj.exports as (req: unknown) => Promise<{ text(): Promise<string> }>;
    expect(typeof handler).toBe('function');
    const response = await handler({});
    expect(await response.text()).toBe('{}');
  });

  it('strips types from a typed arrow-function handler', () => {
    const code = `export default async (req: Request): Promise<Response> => {
  return new Response("hi");
};`;

    const result = normalizeHandlerFormat(code);
    const wrapper = new Function('exports', 'module', result);
    const exportsObj: Record<string, unknown> = {};
    const moduleObj = { exports: exportsObj };
    wrapper(exportsObj, moduleObj);
    expect(typeof moduleObj.exports).toBe('function');
  });

  it('does not skip normalization when "module.exports" only appears in a comment', () => {
    const code = `// previously: module.exports = async function (req) { ... }
export default async function (req: Request): Promise<Response> {
  return new Response("hi");
}`;

    const result = normalizeHandlerFormat(code);
    expect(result).toMatch(/^\/\/ previously:/);
    expect(result).toContain('module.exports = async function');
    expect(result).not.toMatch(/export\s+default/);

    const wrapper = new Function('exports', 'module', result);
    const exportsObj: Record<string, unknown> = {};
    const moduleObj = { exports: exportsObj };
    wrapper(exportsObj, moduleObj);
    expect(typeof moduleObj.exports).toBe('function');
  });

  it('rewrites an aliased SDK import into a local const binding', async () => {
    const code = `import { createClient as makeClient } from 'npm:@insforge/sdk';

export default async function (req: Request): Promise<Response> {
  const client = makeClient({});
  return new Response(typeof client);
}`;

    const result = normalizeHandlerFormat(code);
    expect(result).not.toMatch(/\bimport\b/);
    expect(result).toContain('const makeClient = createClient;');

    const wrapper = new Function('exports', 'module', 'createClient', result);
    const exportsObj: Record<string, unknown> = {};
    const moduleObj = { exports: exportsObj };
    wrapper(exportsObj, moduleObj, () => ({}));
    const handler = moduleObj.exports as (req: unknown) => Promise<{ text(): Promise<string> }>;
    const response = await handler({});
    expect(await response.text()).toBe('object');
  });

  it('leaves the whole import untouched when it mixes a known and unknown SDK binding', () => {
    const code = `import { createClient, somethingElse } from 'npm:@insforge/sdk';

export default async function (req: Request): Promise<Response> {
  return new Response(somethingElse());
}`;

    const result = normalizeHandlerFormat(code);
    expect(result).toContain("import { createClient, somethingElse } from 'npm:@insforge/sdk';");
    expect(result).toContain('module.exports = async function');
  });

  it('leaves an unparseable/unrecognized signature completely untouched', () => {
    // Not a function/arrow expression at all — normalizeHandlerFormat should
    // bail out rather than guess, reproducing the pre-existing plain error.
    const code = `export default someModule.handler;`;
    const result = normalizeHandlerFormat(code);
    expect(result).toBe('module.exports = someModule.handler;');
  });

  // Round-2 regression coverage: a second review pass on the fixes above
  // found further edge cases in the type-annotation stripping and the
  // string/comment-unaware regex matching. Each of these previously either
  // produced invalid JavaScript or was incorrectly rewritten/skipped.

  it('does not corrupt a ternary expression used as a parameter default value', async () => {
    const code = `export default async function (req: Request, opts: string = true ? "a" : "b"): Promise<Response> {
  return new Response(opts);
}`;

    const result = normalizeHandlerFormat(code);
    const wrapper = new Function('exports', 'module', result);
    const exportsObj: Record<string, unknown> = {};
    const moduleObj = { exports: exportsObj };
    wrapper(exportsObj, moduleObj);
    const handler = moduleObj.exports as (req: unknown) => Promise<{ text(): Promise<string> }>;
    const response = await handler({});
    expect(await response.text()).toBe('a');
  });

  it("does not treat a function-type parameter's arrow as a default-value marker", () => {
    const code = `export default async function (req: Request, cb: () => void): Promise<Response> {
  cb();
  return new Response("hi");
}`;

    const result = normalizeHandlerFormat(code);
    const wrapper = new Function('exports', 'module', result);
    const exportsObj: Record<string, unknown> = {};
    const moduleObj = { exports: exportsObj };
    wrapper(exportsObj, moduleObj);
    const handler = moduleObj.exports as (req: unknown, cb: () => void) => unknown;
    let called = false;
    handler({}, () => {
      called = true;
    });
    expect(called).toBe(true);
  });

  it('strips a return type that itself contains an object-literal type', () => {
    const code = `export default async function (req: Request): Promise<{ status: number }> {
  return { status: 200 };
}`;

    const result = normalizeHandlerFormat(code);
    expect(result).not.toMatch(/Promise</);
    const wrapper = new Function('exports', 'module', result);
    const exportsObj: Record<string, unknown> = {};
    const moduleObj = { exports: exportsObj };
    wrapper(exportsObj, moduleObj);
    const handler = moduleObj.exports as (req: unknown) => Promise<{ status: number }>;
    expect(typeof handler).toBe('function');
  });

  it('does not rewrite import-shaped text inside a template literal', async () => {
    const code = `export default async function (req: Request): Promise<Response> {
  const msg = \`import { createClient } from 'npm:@insforge/sdk';\`;
  return new Response(msg);
}`;

    const result = normalizeHandlerFormat(code);
    expect(result).toContain("const msg = `import { createClient } from 'npm:@insforge/sdk';`;");
    const wrapper = new Function('exports', 'module', result);
    const exportsObj: Record<string, unknown> = {};
    const moduleObj = { exports: exportsObj };
    wrapper(exportsObj, moduleObj);
    const handler = moduleObj.exports as (req: unknown) => Promise<{ text(): Promise<string> }>;
    const response = await handler({});
    expect(await response.text()).toBe("import { createClient } from 'npm:@insforge/sdk';");
  });

  it('does not skip normalization when "module.exports =" only appears in a string literal', async () => {
    const code = `export default async function (req: Request): Promise<Response> {
  const msg = 'module.exports = fake';
  return new Response(msg);
}`;

    const result = normalizeHandlerFormat(code);
    expect(result).toMatch(/^module\.exports = async function/);
    const wrapper = new Function('exports', 'module', result);
    const exportsObj: Record<string, unknown> = {};
    const moduleObj = { exports: exportsObj };
    wrapper(exportsObj, moduleObj);
    const handler = moduleObj.exports as (req: unknown) => Promise<{ text(): Promise<string> }>;
    const response = await handler({});
    expect(await response.text()).toBe('module.exports = fake');
  });
});
