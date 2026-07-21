// Public read API: CORS open to all origins, no credentials.
export const CORS_HEADERS: Record<string, string> = { 'Access-Control-Allow-Origin': '*' };

function headers(extra?: Record<string, string>): Headers {
  return new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    ...CORS_HEADERS,
    ...(extra ?? {}),
  });
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: headers() });
}

export function errorJson(
  status: number,
  message: string,
  extra?: Record<string, string>,
): Response {
  return new Response(JSON.stringify({ error: message }), { status, headers: headers(extra) });
}
