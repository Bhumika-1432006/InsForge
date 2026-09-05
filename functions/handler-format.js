/**
 * Handler format normalization (Cloud / self-hosted parity — issue #1906)
 *
 * On Cloud, function code is deployed as a real ES module (see
 * `deno-subhosting.provider.ts`'s `transformUserCode`), so the documented
 * handler format everywhere in the public docs is:
 *
 *   import { createClient } from 'npm:@insforge/sdk';
 *   export default async function(req: Request) { ... }
 *
 * Locally, `worker-template.js` runs the code inside `new Function(...)` —
 * a plain script scope chosen so the worker never needs network/file import
 * permissions at request time (secrets and the SDK are injected as call
 * arguments instead, see the worker template's security notes). `import`
 * and `export` are syntax errors in that scope, so only the legacy
 * `module.exports = ...` form used to work there, silently breaking every
 * function written in the documented `export default` format as soon as it
 * left Cloud.
 *
 * This file is plain, Deno/Node-independent JavaScript (no import/export
 * statements of its own) so it can be:
 *   - concatenated ahead of `worker-template.js` by `server.ts` before the
 *     combined source is handed to `new Function`/`Worker`, and
 *   - loaded directly in unit tests via `vm` without any Deno globals.
 */
function normalizeHandlerFormat(code) {
  // Legacy CommonJS-style handlers already run as-is under `new Function(...)`.
  if (/\bmodule\.exports\b/.test(code)) {
    return code;
  }

  // Strip imports whose only exports are already injected as wrapper
  // parameters (createClient, encodeBase64, decodeBase64). Any other
  // top-level import is left untouched and will surface as a clear syntax
  // error, same as before this change.
  const KNOWN_IMPORT_PATTERNS = [
    /^[ \t]*import\s*\{[^}]*\}\s*from\s*['"]npm:@insforge\/sdk['"]\s*;?[ \t]*\r?\n?/m,
    /^[ \t]*import\s*\{[^}]*\}\s*from\s*['"]https:\/\/deno\.land\/std[^'"]*\/encoding\/base64\.ts['"]\s*;?[ \t]*\r?\n?/m,
  ];

  let normalized = code;
  for (const pattern of KNOWN_IMPORT_PATTERNS) {
    normalized = normalized.replace(new RegExp(pattern.source, 'gm'), '');
  }

  // Rewrite the documented `export default <handler>` into the equivalent
  // CommonJS assignment so it runs under `new Function(...)`.
  normalized = normalized.replace(/(^|\n)([ \t]*)export\s+default\s+/, '$1$2module.exports = ');

  return normalized;
}
