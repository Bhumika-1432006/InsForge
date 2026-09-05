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
});
