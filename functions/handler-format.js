/**
 * Handler format normalization (Cloud / self-hosted parity — issue #1906)
 *
 * On Cloud, function code is deployed as a real ES module (see
 * `deno-subhosting.provider.ts`'s `transformUserCode`), so the documented
 * handler format everywhere in the public docs is:
 *
 *   import { createClient } from 'npm:@insforge/sdk';
 *   export default async function(req: Request): Promise<Response> { ... }
 *
 * Locally, `worker-template.js` runs the code inside `new Function(...)` —
 * a plain script scope chosen so the worker never needs network/file import
 * permissions at request time (secrets and the SDK are injected as call
 * arguments instead, see the worker template's security notes). `import`
 * and `export` are syntax errors in that scope, and so are the TypeScript
 * type annotations the documented signature uses (`new Function` runs
 * through V8 directly — nothing transpiles it) — so only the legacy,
 * untyped `module.exports = ...` form used to work there, silently breaking
 * every function written in the documented `export default` format as soon
 * as it left Cloud.
 *
 * This file is plain, Deno/Node-independent JavaScript (no import/export
 * statements of its own) so it can be:
 *   - concatenated ahead of `worker-template.js` by `server.ts` before the
 *     combined source is handed to `new Function`/`Worker`, and
 *   - loaded directly in unit tests via `vm` without any Deno globals.
 *
 * Scope: this targets the one documented handler shape (a top-level
 * `export default` function/arrow expression, optionally typed, optionally
 * importing the injected SDK/base64 bindings) — not arbitrary TypeScript or
 * ESM. Anything outside that shape is left untouched, which reproduces
 * today's plain syntax error rather than silently miscompiling it.
 */

// Legacy CommonJS handlers are detected by an actual top-level assignment,
// not a bare substring search — `module.exports` appearing only inside a
// comment or string (e.g. a migration note like "// previously:
// module.exports = ...") must not skip normalization for what is otherwise
// a valid `export default` handler.
const LEGACY_ASSIGNMENT_PATTERN = /^[ \t]*module\.exports\s*=/m;

// Named bindings the worker wrapper injects as call arguments, keyed by the
// import specifier that provides them on Cloud. An import naming anything
// else from these sources can't be resolved locally and is left alone so it
// still surfaces as a clear syntax/reference error, rather than being
// partially rewritten into something subtly broken.
const INJECTABLE_BINDINGS_BY_SOURCE = [
  { source: 'npm:@insforge/sdk', names: ['createClient'] },
  {
    // Version-qualified URL — match the module, not one exact version string.
    sourcePattern: /^https:\/\/deno\.land\/std[^'"]*\/encoding\/base64\.ts$/,
    names: ['encodeBase64', 'decodeBase64'],
  },
];

const IMPORT_STATEMENT_PATTERN =
  /^[ \t]*import\s*\{([^}]*)\}\s*from\s*(['"])([^'"]*)\2\s*;?[ \t]*\r?\n?/gm;

/**
 * Rewrites the known-injectable imports in `code` in place:
 *  - a specifier matching its injected name exactly (`createClient`) is
 *    simply dropped — the wrapper already provides that identifier.
 *  - an aliased specifier (`createClient as makeClient`) is replaced with
 *    `const makeClient = createClient;` so the alias still resolves.
 *  - an import naming anything not in the injected set for that source, or
 *    from any other source, is left completely untouched.
 */
function resolveKnownImports(code) {
  return code.replace(IMPORT_STATEMENT_PATTERN, (fullMatch, specifierList, _quote, source) => {
    const known = INJECTABLE_BINDINGS_BY_SOURCE.find((entry) =>
      entry.source ? entry.source === source : entry.sourcePattern.test(source)
    );
    if (!known) {
      return fullMatch;
    }

    const specifiers = specifierList
      .split(',')
      .map((specifier) => specifier.trim())
      .filter(Boolean);

    const aliasDeclarations = [];
    for (const specifier of specifiers) {
      const aliasMatch = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(specifier);
      const importedName = aliasMatch ? aliasMatch[1] : specifier;
      const localName = aliasMatch ? aliasMatch[2] : specifier;

      if (!known.names.includes(importedName)) {
        // Not something the wrapper injects (e.g. a type-only import, or a
        // real export we don't provide locally) — bail on the whole
        // statement rather than guessing at a partial rewrite.
        return fullMatch;
      }
      if (localName !== importedName) {
        aliasDeclarations.push(`const ${localName} = ${importedName};`);
      }
    }

    return aliasDeclarations.length > 0 ? aliasDeclarations.join('\n') + '\n' : '';
  });
}

/**
 * Strips TypeScript type annotations from a handler's parameter list,
 * respecting bracket depth so a generic type's internal commas
 * (`opts: Record<string, string>`) aren't mistaken for parameter
 * separators, and default values (`opts: Options = {}`) are preserved.
 */
function stripParamTypeAnnotations(paramsSource) {
  let result = '';
  let depth = 0;
  let inType = false;

  for (const char of paramsSource) {
    if ('([{<'.includes(char)) {
      depth += 1;
      if (!inType) {
        result += char;
      }
      continue;
    }
    if (')]}>'.includes(char)) {
      depth = Math.max(0, depth - 1);
      if (!inType) {
        result += char;
      }
      continue;
    }
    if (depth === 0 && !inType && char === ':') {
      inType = true;
      continue;
    }
    if (depth === 0 && inType && (char === ',' || char === '=')) {
      inType = false;
      result += char;
      continue;
    }
    if (!inType) {
      result += char;
    }
  }

  return result;
}

/**
 * Strips type annotations from a handler's signature only — its parameter
 * list and return type — leaving the function body completely untouched.
 * Operates on `code` starting at `fromIndex` (right after the
 * `module.exports = ` this module just wrote) so it never has to reason
 * about the body, which may contain colons of its own (object literals,
 * ternaries, etc.) that are not type annotations.
 *
 * If the text at `fromIndex` isn't a recognizable function/arrow signature,
 * or its parameter list is unbalanced, `code` is returned unchanged rather
 * than guessed at.
 */
function stripHandlerSignatureTypes(code, fromIndex) {
  const rest = code.slice(fromIndex);

  const headerMatch = /^(\s*)(async\s+)?(function\s*[A-Za-z_$][\w$]*\s*|function\s*)?\(/.exec(rest);
  if (!headerMatch) {
    return code;
  }

  const parenStart = headerMatch[0].length - 1;
  let depth = 0;
  let parenEnd = -1;
  for (let i = parenStart; i < rest.length; i += 1) {
    const char = rest[i];
    if ('([{'.includes(char)) {
      depth += 1;
    } else if (')]}'.includes(char)) {
      depth -= 1;
      if (depth === 0) {
        parenEnd = i;
        break;
      }
    }
  }
  if (parenEnd === -1) {
    return code;
  }

  const paramsInner = rest.slice(parenStart + 1, parenEnd);
  const strippedParams = stripParamTypeAnnotations(paramsInner);

  let afterParams = rest.slice(parenEnd + 1);
  // A return-type annotation runs from ':' up to (not including) the body's
  // opening '{' or an arrow's '=>'. Only stripped when one of those actually
  // follows, so an unrelated ':' doesn't eat the rest of the file.
  afterParams = afterParams.replace(/^([ \t]*):[^{]*?(?=\{|=>)/, '$1');

  return (
    code.slice(0, fromIndex) + rest.slice(0, parenStart + 1) + strippedParams + ')' + afterParams
  );
}

function normalizeHandlerFormat(code) {
  if (LEGACY_ASSIGNMENT_PATTERN.test(code)) {
    return code;
  }

  let normalized = resolveKnownImports(code);

  const exportDefaultMatch = /(^|\n)([ \t]*)export\s+default\s+/.exec(normalized);
  if (!exportDefaultMatch) {
    return normalized;
  }

  const assignment = `${exportDefaultMatch[1]}${exportDefaultMatch[2]}module.exports = `;
  const handlerStart = exportDefaultMatch.index + exportDefaultMatch[0].length;
  normalized =
    normalized.slice(0, exportDefaultMatch.index) + assignment + normalized.slice(handlerStart);

  return stripHandlerSignatureTypes(normalized, exportDefaultMatch.index + assignment.length);
}
