/**
 * Render an error for a log line INCLUDING its `cause` chain. Node's fetch
 * (undici) reports every network-level failure as a bare `TypeError: fetch
 * failed` and hides the actionable reason — ConnectTimeoutError, ENOTFOUND, a
 * TLS reset — in `error.cause` (sometimes an AggregateError carrying one error
 * per attempted address), so a log built from `.message` alone is
 * undiagnosable. The chain is depth-capped so a cyclic cause can never loop.
 *
 * Shape: `<message> (<code>) — caused by <Name>: <message> (<code>) — …`.
 * The first segment is the bare message (no class name), so existing log
 * formats like `FAILURE (fetch failed…)` keep their familiar prefix.
 */
export function describeError(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;

  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    if (!(current instanceof Error)) {
      parts.push(String(current));
      break;
    }
    parts.push(depth === 0 ? messageWithCode(current) : namedMessage(current));
    current = current.cause;
  }

  return parts.join(' — caused by ');
}

/** `<message> (<code>)[: sub; sub]` — code and AggregateError subs optional. */
function messageWithCode(e: Error): string {
  const code = (e as { code?: unknown }).code;
  const codeStr = typeof code === 'string' || typeof code === 'number' ? ` (${String(code)})` : '';
  return `${e.message}${codeStr}${aggregateSuffix(e)}`;
}

/** `<Name>: <message> (<code>)` — the form used for every cause segment. */
function namedMessage(e: Error): string {
  return `${e.name}: ${messageWithCode(e)}`;
}

/**
 * An AggregateError's real detail lives in `.errors` (undici raises one when
 * every address of a multi-A/AAAA host fails, one error per attempt) — surface
 * up to three, since the per-family reasons often differ.
 */
function aggregateSuffix(e: Error): string {
  const errors = (e as { errors?: unknown }).errors;
  if (!Array.isArray(errors) || errors.length === 0) return '';
  const shown = errors
    .slice(0, 3)
    .map((sub) => (sub instanceof Error ? namedMessage(sub) : String(sub)));
  const more = errors.length > 3 ? `; +${errors.length - 3} more` : '';
  return ` [${shown.join('; ')}${more}]`;
}
