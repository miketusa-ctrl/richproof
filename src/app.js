/**
 * RichProof Worker router. Never logs, stores or echoes submitted content; never fetches URLs.
 * Routes: GET / (paste tool), POST /api/validate, GET /api/health, POST /mcp, GET /llms.txt, GET /openapi.json,
 * GET /robots.txt, GET /favicon.svg.
 */
import { validate, VERSION, MAX_INPUT_BYTES, maxNesting, MAX_NESTING } from './lib/validate.js';
import { handleMcp, MCP_CORS, MAX_BODY_BYTES } from './lib/mcp.js';
import { llmsTxt, openApiSpec } from './lib/agentdocs.js';
import { homepage, FAVICON } from './lib/page.js';
import { countVisitor, chargeDailyPool, utcDay } from './lib/quota.js';

export { VERSION };
// Glama connector ownership claim, served at /.well-known/glama.json. Replace the placeholder with your own claim token from glama.ai.
export const GLAMA_CLAIM = "{\"$schema\":\"https://glama.ai/mcp/schemas/connector.json\",\"claim\":\"<GLAMA_CLAIM_TOKEN>\"}";
export const SECURITY = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};
export const API_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-expose-headers': 'retry-after, x-richproof-quota-remaining',
  'access-control-max-age': '86400',
};
const CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const int = (v, d) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; };
export function limitsFor(env = {}) {
  return {
    anonPerMin: int(env.CHECK_LIMIT_PER_MIN, 30),
    dailyPool: int(env.DAILY_CHECK_POOL, 20000),
    dailyKvWrites: int(env.DAILY_KV_WRITES, 2000),
    maxBytes: MAX_INPUT_BYTES,
  };
}

export function ipBucket(ip) { // IPv4 as is; IPv6 → its /64. Same output as workdayapi's (agent-ready recipe §1).
  const s = String(ip || 'unknown').trim().toLowerCase();
  if (!s.includes(':')) return s;
  if (s.includes('.')) return s.slice(s.lastIndexOf(':') + 1);
  const [h, t] = s.split('::'), head = h ? h.split(':') : [], tail = t ? t.split(':') : [];
  const parts = t === undefined ? head : [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
  return parts.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '') || '0').join(':') + '::/64';
}

// Per-isolate sliding counter (MCP discovery cap, fallback when no ratelimit binding exists).
const mem = new Map();
export function memLimit(key, limit, windowMs, now = Date.now()) {
  if (mem.size > 5000) mem.clear();
  const e = mem.get(key);
  if (!e || now - e.t >= windowMs) { mem.set(key, { t: now, n: 1 }); return true; }
  return ++e.n <= limit;
}
export function _resetMem() { mem.clear(); }

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...API_CORS, ...SECURITY, ...headers },
});
export const apiError = (status, code, message, headers = {}) => json({ error: { code, message } }, status, headers);

/** No API keys in v0.1: everyone is anonymous. Kept as a function so /api and /mcp share one gate (recipe §1). */
export async function authenticate() { return { ok: true, tier: 'anonymous' }; }

/** Shared by POST /api/validate and MCP tools/call: per-minute limiter → daily pool → validate. */
export async function runCheck({ input, env, ctx, ip, request }) {
  const L = limitsFor(env);
  if (typeof input !== 'string' || !input.trim()) return { ok: false, status: 400, code: 'invalid_input', message: 'Send JSON-LD or HTML containing <script type="application/ld+json"> blocks.', headers: {} };
  if (new TextEncoder().encode(input).byteLength > MAX_INPUT_BYTES) return { ok: false, status: 413, code: 'too_large', message: `Input exceeds ${MAX_INPUT_BYTES} bytes.`, headers: {} };
  if (maxNesting(input) > MAX_NESTING) return { ok: false, status: 400, code: 'invalid_input', message: `Input nests deeper than ${MAX_NESTING} levels.`, headers: {} };
  const key = ipBucket(ip);
  let allowed = true;
  if (env.CHECK_LIMITER) { try { allowed = (await env.CHECK_LIMITER.limit({ key })).success; } catch { allowed = memLimit(`chk:${key}`, L.anonPerMin, 60_000); } }
  else allowed = memLimit(`chk:${key}`, L.anonPerMin, 60_000);
  if (!allowed) return { ok: false, status: 429, code: 'rate_limited', message: `Too many validations from your IP (about ${L.anonPerMin} per minute).`, headers: { 'retry-after': '60' } };
  const pool = await chargeDailyPool(env, ctx, L);
  if (!pool.ok) return { ok: false, status: 429, code: 'daily_limit', message: 'The free daily validation pool is used up. It resets at 00:00 UTC.', headers: { 'retry-after': String(pool.retryAfter) } };
  const body = validate(input);
  if (request) countVisitor(request, env, ctx, ip, L);
  return { ok: true, body, headers: { 'x-richproof-quota-remaining': String(pool.remaining) }, cached: false };
}

async function readCapped(request, cap) {
  const cl = Number(request.headers.get('content-length'));
  if (Number.isFinite(cl) && cl > cap) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) { try { await reader.cancel(); } catch { /* ignore */ } return null; }
    chunks.push(value);
  }
  const buf = new Uint8Array(size); let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
  return new TextDecoder().decode(buf);
}

/** Body: raw JSON-LD / HTML (any content type), or {"input": "<text>"} (only key). */
export function inputFromBody(text) {
  const t = text.trim();
  if (t.startsWith('{')) {
    try { const o = JSON.parse(t); if (o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === 1 && typeof o.input === 'string') return o.input; } catch { /* raw input */ }
  }
  return text;
}

const isPublic = (env) => env.PUBLIC_LAUNCH === 'true';
const doc = (body, type, env, extra = {}) => new Response(body, {
  headers: { 'content-type': type, 'cache-control': 'public, max-age=3600', ...SECURITY, ...(isPublic(env) ? {} : { 'x-robots-tag': 'noindex, nofollow' }), ...extra },
});
const onlyGet = (request) => (['GET', 'HEAD'].includes(request.method) ? null
  : request.method === 'OPTIONS' ? new Response(null, { status: 204, headers: { allow: 'GET, HEAD, OPTIONS', ...API_CORS } })
    : new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD, OPTIONS', ...SECURITY } }));

export async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const noindex = isPublic(env) ? {} : { 'x-robots-tag': 'noindex, nofollow' };
  const withNoindex = (res) => { if (!isPublic(env)) res.headers.set('x-robots-tag', 'noindex, nofollow'); return res; };

  if (path === '/mcp') {
    const L = limitsFor(env);
    // Discovery cap: per-isolate memLimit (synchronous, as mcp.js expects) plus the MCP_LIMITER binding per request.
    if (env.MCP_LIMITER && request.method === 'POST') {
      let ok = true; try { ok = (await env.MCP_LIMITER.limit({ key: ipBucket(ip) })).success; } catch { /* fall back to memLimit */ }
      if (!ok) return withNoindex(new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Too many MCP requests from your IP. Retry in a minute.', data: { code: 'rate_limited', retryAfterSeconds: 60 } } }), { status: 429, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '60', ...MCP_CORS, ...SECURITY } }));
    }
    return withNoindex(await handleMcp(request, env, ctx, {
      authenticate, runCheck, ip: ipBucket(ip), request, origin: url.origin, memLimit, security: SECURITY, cors: MCP_CORS,
      allowedOrigins: env.MCP_ALLOWED_ORIGINS, anonPerMin: L.anonPerMin,
    }));
  }
  if (path === '/api/validate') {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: API_CORS });
    if (request.method !== 'POST') return withNoindex(apiError(405, 'method_not_allowed', 'POST the JSON-LD or HTML as the request body. GET is not supported so content never ends up in URLs or logs.', { allow: 'POST, OPTIONS' }));
    const text = await readCapped(request, MAX_BODY_BYTES);
    if (text === null) return withNoindex(apiError(413, 'too_large', `Request body exceeds ${MAX_BODY_BYTES} bytes.`));
    const r = await runCheck({ input: inputFromBody(text), env, ctx, ip, request });
    if (!r.ok) return withNoindex(apiError(r.status, r.code, r.message, r.headers));
    return withNoindex(json(r.body, 200, r.headers));
  }
  if (path === '/api/health') {
    const m = onlyGet(request); if (m) return m;
    return json({ ok: true, version: VERSION, day: utcDay() }, 200, noindex);
  }
  if (path === '/llms.txt') { const m = onlyGet(request); if (m) return m; return doc(llmsTxt(url.origin, limitsFor(env)), 'text/plain; charset=utf-8', env); }
  if (path === '/openapi.json') { const m = onlyGet(request); if (m) return m; return doc(JSON.stringify(openApiSpec(url.origin, limitsFor(env)), null, 2), 'application/json; charset=utf-8', env, { 'access-control-allow-origin': '*' }); }
  if (path === '/.well-known/glama.json') {
    const m = onlyGet(request); if (m) return m;
    return new Response(request.method === 'HEAD' ? null : GLAMA_CLAIM, { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600', ...SECURITY } });
  }
  if (path === '/.well-known/mcp-registry-auth') {
    // Official MCP Registry HTTP-domain ownership proof (DnsGuard pattern). PUBLIC key record only; 404 unless well-formed.
    const m = onlyGet(request); if (m) return m;
    const proof = String(env.MCP_REGISTRY_AUTH || '').trim();
    if (/^v=MCPv1; k=(ed25519|ecdsap384); p=[A-Za-z0-9+/=]{20,120}$/.test(proof)) {
      return new Response(request.method === 'HEAD' ? null : `${proof}\n`, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...SECURITY } });
    }
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', ...SECURITY } });
  }
  if (path === '/robots.txt') {
    const m = onlyGet(request); if (m) return m;
    return doc(isPublic(env) ? 'User-agent: *\nAllow: /\n' : 'User-agent: *\nDisallow: /\n', 'text/plain; charset=utf-8', env);
  }
  if (path === '/favicon.svg' || path === '/favicon.ico') { const m = onlyGet(request); if (m) return m; return doc(FAVICON, 'image/svg+xml', env); }
  if (path === '/') {
    const m = onlyGet(request); if (m) return m;
    if (request.method === 'GET') countVisitor(request, env, ctx, ip, limitsFor(env));
    return doc(homepage(limitsFor(env)), 'text/html; charset=utf-8', env, { 'content-security-policy': CSP, 'cache-control': 'public, max-age=300' });
  }
  if (path.startsWith('/api/')) return withNoindex(apiError(404, 'not_found', 'Unknown API route. See /openapi.json.'));
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', ...SECURITY, ...noindex } });
}
