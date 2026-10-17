/**
 * KV-backed quotas and the privacy-friendly daily unique-visitor counter.
 * KV is eventually consistent, so the shared daily pool is approximate (per-isolate counts flushed every FLUSH_EVERY
 * checks). Every KV write goes through kvWriteAllowed() so writes per isolate per UTC day are capped (DAILY_KV_WRITES).
 * Nothing here ever sees or stores submitted content.
 */
export const FLUSH_EVERY = 25;
export const POOL_TTL_S = 3 * 86400;
export const VISITOR_TTL_S = 9 * 86400; // long enough for Monday weekly reports
const DEFAULT_MARKERS = 'fleet-bot,richproof-qc,smitherybot,cloudflare-healthchecks';

export const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
const secondsToUtcMidnight = (now = Date.now()) => Math.max(1, Math.ceil((86400000 - (now % 86400000)) / 1000));

let state = { day: '', pending: 0, base: 0, baseAt: 0, kvWrites: 0, visitors: new Set() };
export function _resetQuota() { state = { day: '', pending: 0, base: 0, baseAt: 0, kvWrites: 0, visitors: new Set() }; }
function roll(now) { const d = utcDay(now); if (state.day !== d) state = { day: d, pending: 0, base: 0, baseAt: 0, kvWrites: 0, visitors: new Set() }; return d; }

export function kvWriteAllowed(L) {
  if (state.kvWrites >= L.dailyKvWrites) return false;
  state.kvWrites++; return true;
}

/** Charge one check against the shared daily pool. Returns { ok, remaining, retryAfter }. */
export async function chargeDailyPool(env, ctx, L, now = Date.now()) {
  const day = roll(now);
  const kv = env.SG_KV;
  if (kv && now - state.baseAt > 60_000) {
    try { state.base = Number(await kv.get(`pool:${day}`)) || state.base; } catch { /* keep last value */ }
    state.baseAt = now;
  }
  const used = state.base + state.pending;
  if (used >= L.dailyPool) return { ok: false, remaining: 0, retryAfter: secondsToUtcMidnight(now) };
  state.pending++;
  if (kv && state.pending >= FLUSH_EVERY && kvWriteAllowed(L)) {
    const total = state.base + state.pending;
    state.base = total; state.pending = 0;
    const p = kv.put(`pool:${day}`, String(total), { expirationTtl: POOL_TTL_S }).catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(p);
  }
  return { ok: true, remaining: Math.max(0, L.dailyPool - used - 1), retryAfter: 0 };
}

export function isExcludedTraffic(request, env) {
  if (request.headers.get('x-fleet-traffic')) return true;
  const ua = (request.headers.get('user-agent') || '').toLowerCase();
  const markers = String(env.FLEET_UA_MARKERS || DEFAULT_MARKERS).toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  return markers.some((m) => ua.includes(m));
}

async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Hash(salt | UTC day | IP bucket) → KV key uv:<day>:<16 hex>. No IP, UA or content is stored. Fire-and-forget. */
export function countVisitor(request, env, ctx, ip, L, now = Date.now()) {
  const kv = env.SG_KV;
  if (!kv || !env.VISITOR_SALT || isExcludedTraffic(request, env)) return; // No salt secret → no counting
  const day = roll(now);
  const bucket = ip.includes(':') && !ip.includes('::/64') ? ipBucketLite(ip) : ip;
  const p = (async () => {
    const h = (await sha256hex(`${env.VISITOR_SALT}|${day}|${bucket}`)).slice(0, 16);
    if (state.visitors.has(h)) return;
    if (state.visitors.size > 20000) state.visitors.clear();
    state.visitors.add(h);
    const key = `uv:${day}:${h}`;
    if (await kv.get(key) !== null) return;
    if (!kvWriteAllowed(L)) return;
    await kv.put(key, '1', { expirationTtl: VISITOR_TTL_S });
  })().catch(() => {});
  if (ctx && ctx.waitUntil) ctx.waitUntil(p);
  return p;
}
function ipBucketLite(ip) {
  const s = ip.toLowerCase();
  if (s.includes('.')) return s.slice(s.lastIndexOf(':') + 1);
  const [h, t] = s.split('::'), head = h ? h.split(':') : [], tail = t ? t.split(':') : [];
  const parts = t === undefined ? head : [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
  return parts.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '') || '0').join(':') + '::/64';
}
