/**
 * RichProof remote MCP server (adapted from DnsGuard v0.7.2 mcp.js). Hand-rolled JSON-RPC 2.0 over Streamable HTTP; no SDK, no dependencies.
 *
 * Dual-era and stateless:
 *  - Modern (MCP 2026-07-28): every request carries params._meta["io.modelcontextprotocol/protocolVersion"] plus the
 *    MCP-Protocol-Version / Mcp-Method / Mcp-Name headers. Methods: server/discover, tools/list, tools/call.
 *  - Legacy (2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05): initialize handshake, notifications/initialized, ping,
 *    tools/list, tools/call. JSON-RPC batches (max 10 messages, at most one tools/call) are accepted for legacy clients.
 *  - No sessions: no Mcp-Session-Id is ever issued; one sent by a client is ignored. GET/DELETE → 405 (no SSE stream).
 *  - Responses are always application/json (no SSE).
 *
 * Limits are NOT implemented here: the router passes in authenticate() (an anonymous-only stub in v0.1; no API keys)
 * and runCheck() from app.js, the exact functions behind POST /api/validate, so every rate and daily-pool counter is
 * shared. There is no result cache. One tools/call = one check. initialize / tools/list / ping / server/discover never touch check quota;
 * they have a light per-isolate cap per IP (DISCOVERY_PER_MIN).
 *
 * To adapt for another Worker: replace TOOLS + callTool() (and SERVER_INFO). Everything else is generic.
 */
import { VERSION, MAX_INPUT_BYTES } from './validate.js';

export const MODERN_VERSIONS = ['2026-07-28'];
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_BATCH = 10;
export const MAX_CHECKS_PER_REQUEST = 1; // bounds CPU per invocation (cpu_ms = 100) and keeps 1 HTTP request ≈ 1 check
export const DISCOVERY_PER_MIN = 120; // per IP per isolate, for non-check messages (initialize, tools/list, ping, …)
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CAPS = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER = 'io.modelcontextprotocol/serverInfo';

// JSON-RPC / MCP error codes
export const E = {
  PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603,
  SERVER: -32000, // implementation-defined (auth, rate limit, body too large, forbidden origin)
  HEADER_MISMATCH: -32020, UNSUPPORTED_VERSION: -32022,
};

export const MCP_CORS = {
  // No cookies or credentials are used, so a wildcard origin is safe and lets
  // browser-based MCP inspectors work. Same policy as /api/validate.
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS', // GET/DELETE → 405 (no SSE stream, no sessions)
  'access-control-allow-headers': 'content-type, accept, authorization, x-api-key, mcp-protocol-version, mcp-method, mcp-name',
  'access-control-expose-headers': 'mcp-protocol-version, retry-after, x-richproof-quota-remaining',
  'access-control-max-age': '86400',
};

export const SERVER_INFO = { name: 'richproof', title: 'RichProof', version: VERSION };
const instructions = (anonPerMin = 30) => 'RichProof validates JSON-LD structured data against the Schema.org vocabulary: JSON syntax, JSON-LD structure (@context, @type, @id, @graph), unknown types and properties (with did-you-mean suggestions), properties used on unexpected types, and value types (dates, numbers, URLs, enumeration members). Call validate_jsonld with the JSON-LD text, or with HTML that contains <script type="application/ld+json"> blocks. It never fetches URLs: paste the markup itself. Input is limited to ' + MAX_INPUT_BYTES + ' bytes. Submitted content is not stored or logged. Anonymous use is limited to about ' + anonPerMin + ' validations per minute per IP. Schema.org vocabulary: CC BY-SA 3.0.';

const issueSchema = { type: 'object', properties: { level: { type: 'string', enum: ['error', 'warning', 'info'] }, code: { type: 'string' }, path: { type: 'string' }, message: { type: 'string' }, suggestion: { type: 'string' } }, required: ['level', 'code', 'path', 'message'] };
export const MAX_TOOL_ISSUES = 25;

export const TOOLS = [{
  name: 'validate_jsonld',
  title: 'Validate JSON-LD structured data (Schema.org)',
  description: 'Validate JSON-LD structured data against the Schema.org vocabulary. Accepts raw JSON-LD or an HTML snippet/page containing <script type="application/ld+json"> blocks (pass the text, not a URL: this tool never fetches anything). Returns valid true/false, error/warning/info counts, the Schema.org types found, and up to ' + 25 + ' issues with JSON paths, messages and did-you-mean suggestions. Read-only. Same engine as the RichProof JSON API (POST /api/validate).',
  inputSchema: {
    type: 'object',
    properties: {
      input: { type: 'string', minLength: 1, maxLength: 60000, description: 'JSON-LD text (e.g. {"@context":"https://schema.org","@type":"Product","name":"…"}) or HTML containing <script type="application/ld+json"> blocks.' },
      include_raw: { type: 'boolean', default: false, description: 'Also return the full /api/validate JSON (all issues) in structuredContent.raw.' },
    },
    required: ['input'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      valid: { type: 'boolean' },
      errors: { type: 'number' },
      warnings: { type: 'number' },
      infos: { type: 'number' },
      blocks: { type: 'number' },
      types: { type: 'array', items: { type: 'string' } },
      issues: { type: 'array', items: issueSchema },
      issuesOmitted: { type: 'number' },
      version: { type: 'string' },
      raw: { type: 'object', description: 'Full /api/validate response (only when include_raw is true)' },
    },
    required: ['valid', 'errors', 'warnings', 'infos', 'issues', 'version'],
  },
  annotations: { title: 'Validate JSON-LD', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}];
const TOOL_ARGS = new Set(Object.keys(TOOLS[0].inputSchema.properties)); // inputSchema says additionalProperties: false; enforced in callTool

const clip = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Concise, schema-conforming summary of a full /api/validate body (issues capped and clipped). */
export function summarize(body, { includeRaw }) {
  const issues = body.issues.slice(0, MAX_TOOL_ISSUES).map((i) => ({ level: i.level, code: i.code, path: clip(i.path, 200), message: clip(i.message, 300), ...(i.suggestion ? { suggestion: clip(i.suggestion, 80) } : {}) }));
  const out = {
    valid: body.valid, errors: body.summary.errors, warnings: body.summary.warnings, infos: body.summary.infos,
    blocks: body.summary.blocks, types: Object.keys(body.summary.types).slice(0, 50), issues,
    ...(body.issues.length > issues.length ? { issuesOmitted: body.issues.length - issues.length } : {}),
    version: body.meta.version,
  };
  if (includeRaw) out.raw = body;
  return out;
}

export function summaryText(s) {
  const lines = [`RichProof: ${s.valid ? 'VALID' : 'INVALID'} — ${s.errors} error(s), ${s.warnings} warning(s), ${s.infos} info. Types: ${s.types.join(', ') || 'none'}.`];
  for (const i of s.issues) lines.push(`- [${i.level}] ${i.path}: ${i.message}`);
  if (s.issuesOmitted) lines.push(`(${s.issuesOmitted} more issue(s); pass include_raw for all.)`);
  return lines.join('\n');
}

function toolError(message, data, extra = {}) {
  return { content: [{ type: 'text', text: message }], isError: true, ...(data ? { _meta: { 'richproof/error': data } } : {}), ...extra };
}

/** tools/call for validate_jsonld. Returns { result } or { error } (protocol error), plus HTTP headers to surface. */
async function callTool(params, deps, auth) {
  const { name } = params;
  const args = params.arguments === undefined ? {} : params.arguments;
  if (name !== 'validate_jsonld') return { error: { code: E.INVALID_PARAMS, message: `Unknown tool: ${clip(String(name), 80)}` } };
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { error: { code: E.INVALID_PARAMS, message: 'arguments must be an object' } };
  const unknown = Object.keys(args).filter((k) => !TOOL_ARGS.has(k));
  if (unknown.length) {
    return { result: toolError(`Unknown argument(s): ${clip(unknown.slice(0, 5).join(', '), 80)}. Allowed: ${[...TOOL_ARGS].join(', ')}.`, { code: 'invalid_arguments', httpStatus: 400 }) };
  }
  if (typeof args.input !== 'string' || !args.input.trim()) return { result: toolError('input must be a non-empty string (JSON-LD or HTML).', { code: 'invalid_input', httpStatus: 400 }) };
  if (args.include_raw !== undefined && typeof args.include_raw !== 'boolean') return { result: toolError('include_raw must be a boolean.', { code: 'invalid_arguments', httpStatus: 400 }) };
  const r = await deps.runCheck({ input: args.input, auth, env: deps.env, ctx: deps.ctx, ip: deps.ip, request: deps.request });
  const headers = { ...(r.headers || {}) };
  if (!r.ok) {
    const retry = r.headers && r.headers['retry-after'] ? Number(r.headers['retry-after']) : undefined;
    const msg = `${r.message}${retry ? ` (retry after ${retry} seconds)` : ''}`;
    return { result: toolError(msg, { code: r.code, httpStatus: r.status, ...(retry ? { retryAfterSeconds: retry } : {}) }), headers };
  }
  const summary = summarize(r.body, { includeRaw: args.include_raw === true });
  return { result: { content: [{ type: 'text', text: summaryText(summary) }], structuredContent: summary, isError: false }, headers };
}

// ---------- transport helpers ----------

/** Origin policy: absent = OK (CLI / server-side clients). Present: must be a bare https origin or an http loopback
 * origin, or (if MCP_ALLOWED_ORIGINS is set) same-origin / listed. Malformed, "null" and plain-http remote → 403. */
export function originAllowed(origin, selfOrigin, allowList) {
  if (origin === null || origin === undefined) return true;
  if (origin === selfOrigin) return true;
  if (allowList) return String(allowList).split(',').map((s) => s.trim()).filter(Boolean).includes(origin);
  let u;
  try { u = new URL(origin); } catch { return false; }
  if (u.origin !== origin) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
}

async function readCapped(request, cap) {
  const cl = Number(request.headers.get('content-length'));
  if (Number.isFinite(cl) && cl > cap) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) { try { await reader.cancel(); } catch { /* ignore */ } return null; }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
  return new TextDecoder().decode(buf);
}

function decodeHeaderValue(v) {
  if (v == null) return v;
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(v);
  if (!m) return v;
  try { return new TextDecoder().decode(Uint8Array.from(atob(m[1]), (ch) => ch.charCodeAt(0))); } catch { return null; }
}

const isId = (id) => typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), error: { code, message, ...(data !== undefined ? { data } : {}) } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

/**
 * Handle one JSON-RPC message. Returns { response?, status?, headers?, isCheck? }.
 * `response` undefined = notification accepted (202 when it's the whole request).
 */
async function handleMessage(msg, { modern, request, deps, auth, checkBudget }) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { response: rpcError(null, E.INVALID_REQUEST, 'Invalid Request'), status: 400 };
  const hasId = Object.prototype.hasOwnProperty.call(msg, 'id');
  if (msg.jsonrpc !== '2.0') return { response: rpcError(hasId && isId(msg.id) ? msg.id : null, E.INVALID_REQUEST, 'Invalid Request: jsonrpc must be "2.0"'), status: 400 };
  if (typeof msg.method !== 'string') {
    // A JSON-RPC response or garbage. Legacy clients may POST responses → accept like a notification.
    if (!modern && hasId && ('result' in msg || 'error' in msg)) return {};
    return { response: rpcError(hasId && isId(msg.id) ? msg.id : null, E.INVALID_REQUEST, 'Invalid Request: method is required'), status: 400 };
  }
  if (!hasId) return {}; // notification (notifications/initialized, cancelled, …): accepted, nothing to do
  if (!isId(msg.id)) return { response: rpcError(null, E.INVALID_REQUEST, 'Invalid Request: id must be a string or number'), status: 400 };
  const { id, method } = msg;
  const params = msg.params === undefined ? {} : msg.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return { response: rpcError(id, E.INVALID_PARAMS, 'params must be an object') };

  const done = (result) => ({ response: rpcResult(id, modern ? { resultType: 'complete', ...result, _meta: { ...(result._meta || {}), [META_SERVER]: SERVER_INFO } } : result) });
  const notFound = () => ({ response: rpcError(id, E.METHOD_NOT_FOUND, `Method not found: ${clip(method, 80)}`), status: modern ? 404 : 200 });

  if (modern) {
    // MCP 2026-07-28 per-request validation (version, capabilities, mirrored headers).
    const hName = decodeHeaderValue(request.headers.get('mcp-name'));
    if (request.headers.get('mcp-method') !== method) return { response: rpcError(id, E.HEADER_MISMATCH, 'Header mismatch: Mcp-Method header is missing or does not match the body method'), status: 400 };
    if (!params._meta || typeof params._meta[META_CAPS] !== 'object' || params._meta[META_CAPS] === null) {
      return { response: rpcError(id, E.INVALID_PARAMS, `Missing required _meta field ${META_CAPS}`), status: 400 };
    }
    if (method === 'tools/call' && hName !== params.name) return { response: rpcError(id, E.HEADER_MISMATCH, 'Header mismatch: Mcp-Name header is missing or does not match params.name'), status: 400 };
    if (method === 'server/discover') {
      return done({ supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: { listChanged: false } }, instructions: instructions(deps.anonPerMin), ttlMs: 3_600_000, cacheScope: 'public' });
    }
    if (method === 'tools/list') return done({ tools: TOOLS, ttlMs: 3_600_000, cacheScope: 'public' });
    if (method !== 'tools/call') return notFound(); // includes initialize and ping (removed in 2026-07-28)
  } else {
    if (method === 'initialize') {
      const req = params.protocolVersion;
      const protocolVersion = LEGACY_VERSIONS.includes(req) ? req : LEGACY_VERSIONS[0];
      return done({ protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: instructions(deps.anonPerMin) });
    }
    if (method === 'ping') return done({});
    if (method === 'tools/list') return done({ tools: TOOLS });
    if (method === 'server/discover') return done({ supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: instructions(deps.anonPerMin) });
    if (method !== 'tools/call') return notFound();
  }

  // tools/call
  if (typeof params.name !== 'string') return { response: rpcError(id, E.INVALID_PARAMS, 'params.name (tool name) is required') };
  if (checkBudget.used >= MAX_CHECKS_PER_REQUEST) {
    return { response: rpcError(id, E.INVALID_REQUEST, `At most ${MAX_CHECKS_PER_REQUEST} tools/call per HTTP request; send each call as its own request.`) };
  }
  checkBudget.used++;
  const r = await callTool(params, deps, auth);
  if (r.error) return { response: rpcError(id, r.error.code, r.error.message), isCheck: true };
  return { ...done(r.result), headers: r.headers, isCheck: true };
}

/** Entry point from the router for every request to /mcp. */
export async function handleMcp(request, env, ctx, deps) {
  const base = { ...deps.cors, ...deps.security };
  const reply = (status, body, extra = {}) => new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { ...(body === null ? {} : { 'content-type': 'application/json; charset=utf-8' }), 'cache-control': 'no-store', ...base, ...extra },
  });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...deps.cors } });
  if (!originAllowed(request.headers.get('origin'), deps.origin, deps.allowedOrigins)) {
    return reply(403, rpcError(undefined, E.SERVER, 'Forbidden: Origin not allowed'));
  }
  if (request.method !== 'POST') {
    return reply(405, rpcError(undefined, E.SERVER, 'Method not allowed. This MCP endpoint is stateless: POST JSON-RPC messages (no SSE stream, no sessions). Docs: /llms.txt'), { allow: 'POST, OPTIONS' });
  }
  const text = await readCapped(request, MAX_BODY_BYTES);
  if (text === null) return reply(413, rpcError(undefined, E.INVALID_REQUEST, `Request body too large (max ${MAX_BODY_BYTES} bytes)`));
  let payload;
  try { payload = JSON.parse(text); } catch { return reply(400, rpcError(null, E.PARSE, 'Parse error: body must be valid JSON')); }

  // Era detection. Modern = per-request _meta version or a modern MCP-Protocol-Version header.
  const hVer = request.headers.get('mcp-protocol-version');
  const single = !Array.isArray(payload);
  const metaVer = single && payload && typeof payload === 'object' && payload.params && typeof payload.params === 'object'
    && payload.params._meta && typeof payload.params._meta === 'object' ? payload.params._meta[META_VERSION] : undefined;
  const modern = metaVer !== undefined || MODERN_VERSIONS.includes(hVer);
  const idOf = (p) => (p && typeof p === 'object' && isId(p.id) ? p.id : null);
  if (modern) {
    if (!single) return reply(400, rpcError(null, E.INVALID_REQUEST, 'JSON-RPC batches are not supported in protocol 2026-07-28; send one message per POST'));
    if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'id')) {
      if (metaVer === undefined && typeof payload.method === 'string') {
        return reply(400, rpcError(idOf(payload), E.INVALID_PARAMS, `Missing required _meta field ${META_VERSION}`));
      }
      if (metaVer !== undefined && !SUPPORTED_VERSIONS.includes(metaVer)) {
        return reply(400, rpcError(idOf(payload), E.UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested: clip(String(metaVer), 40) }));
      }
      if (metaVer !== undefined && !MODERN_VERSIONS.includes(metaVer)) {
        return reply(400, rpcError(idOf(payload), E.UNSUPPORTED_VERSION, `Protocol version ${metaVer} uses the initialize handshake; per-request _meta requires one of: ${MODERN_VERSIONS.join(', ')}`, { supported: SUPPORTED_VERSIONS, requested: metaVer }));
      }
      if (hVer !== metaVer) return reply(400, rpcError(idOf(payload), E.HEADER_MISMATCH, 'Header mismatch: MCP-Protocol-Version header is missing or does not match _meta protocolVersion'));
    }
  } else if (hVer && !LEGACY_VERSIONS.includes(hVer)) {
    return reply(400, rpcError(single ? idOf(payload) : null, E.UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested: clip(hVer, 40) }));
  }

  const msgs = single ? [payload] : payload;
  if (!msgs.length) return reply(400, rpcError(null, E.INVALID_REQUEST, 'Invalid Request: empty batch'));
  if (msgs.length > MAX_BATCH) return reply(400, rpcError(null, E.INVALID_REQUEST, `Batch too large (max ${MAX_BATCH} messages)`));

  // Light per-IP cap on non-check messages (checks are governed by the /api/validate limits inside runCheck).
  const nonCheck = msgs.filter((m) => !(m && m.method === 'tools/call')).length;
  for (let i = 0; i < nonCheck; i++) {
    if (!deps.memLimit(`mcp:${deps.ip}`, DISCOVERY_PER_MIN, 60_000)) {
      return reply(429, rpcError(single ? idOf(payload) : null, E.SERVER, `Too many MCP requests from your IP (about ${DISCOVERY_PER_MIN} per minute). Retry in a minute.`, { code: 'rate_limited', retryAfterSeconds: 60 }), { 'retry-after': '60' });
    }
  }

  // Same gate as /api/validate, evaluated once per HTTP request (v0.1 has no keys, so this always passes; kept for parity).
  const auth = await deps.authenticate(request, env);
  if (!auth.ok) {
    // No WWW-Authenticate on /mcp (no OAuth offered).
    const extra = { ...(auth.headers || {}) };
    return reply(auth.status, rpcError(single ? idOf(payload) : null, E.SERVER, auth.message, { code: auth.code, httpStatus: auth.status }), extra);
  }

  const mdeps = { ...deps, env, ctx };
  const checkBudget = { used: 0 };
  const responses = [];
  let status = 200;
  let headers = {};
  for (const m of msgs) {
    let out;
    try {
      out = await handleMessage(m, { modern, request, deps: mdeps, auth, checkBudget });
    } catch {
      out = { response: rpcError(idOf(m), E.INTERNAL, 'Internal error') };
    }
    if (out.response) responses.push(out.response);
    if (single) status = out.status || 200;
    if (out.headers) headers = out.headers; // tools/call headers (Retry-After, quota) surface for batches too
  }
  if (!responses.length) return reply(202, null);
  const exposed = {};
  for (const h of ['retry-after', 'x-richproof-quota-remaining']) if (headers[h]) exposed[h] = headers[h];
  return reply(status, single ? responses[0] : responses, exposed);
}
