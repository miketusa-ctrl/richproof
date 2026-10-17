/**
 * RichProof JSON-LD validator. Pure function: no I/O, no URL fetching (remote @context URLs are never dereferenced;
 * only the Schema.org context is recognised, from a built-in copy of the vocabulary).
 */
import { TYPES, PROPS, ENUM_MEMBERS, SUPERSEDED } from './vocab.js';

export const VERSION = '0.1.5';
export const MAX_INPUT_BYTES = 64 * 1024;
export const MAX_NODES = 2000;
export const MAX_DEPTH = 32;
export const MAX_ISSUES = 200;
export const MAX_BLOCKS = 20;

const DATATYPES = new Set(['Text', 'Number', 'Boolean', 'Date', 'DateTime', 'Time', 'URL', 'Integer', 'Float', 'CssSelectorType', 'XPathType', 'PronounceableText', 'DataType']);
const LDJSON_TYPE = /\btype\s*=\s*["']?application\/ld\+json\b/i;
const SCHEMA_CTX = /^https?:\/\/schema\.org\/?$/i;
const KEYWORDS = new Set(['@context', '@id', '@type', '@graph', '@value', '@language', '@list', '@set', '@reverse', '@index', '@base', '@vocab', '@nest', '@included', '@direction', '@json', '@none']);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const clip = (s, n = 120) => { s = String(s); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

const ancestorsCache = new Map();
export function ancestors(t) {
  if (ancestorsCache.has(t)) return ancestorsCache.get(t);
  const seen = new Set(), stack = [t];
  while (stack.length) { const x = stack.pop(); if (seen.has(x)) continue; seen.add(x); for (const p of TYPES[x] || []) stack.push(p); }
  ancestorsCache.set(t, seen);
  return seen;
}
const isSubtype = (t, of) => ancestors(t).has(of);
const isEnumMember = (v) => has(ENUM_MEMBERS, v);

function stripSchema(s) {
  if (typeof s !== 'string') return null;
  const m = /^(?:https?:\/\/schema\.org\/|schema:)(.+)$/i.exec(s);
  return m ? m[1] : s;
}

/** Find "did you mean" with simple edit distance over a candidate list (bounded work). */
const suggestCache = new Map();
export const MAX_SUGGESTIONS = 30; // per request; bounds CPU on adversarial input
function suggest(name, pool, budget) {
  const ck = (pool === TYPE_NAMES ? 't:' : 'p:') + name;
  if (suggestCache.has(ck)) return suggestCache.get(ck);
  if (!budget || budget.left <= 0) return undefined;
  budget.left--;
  const r = suggestRaw(name, pool);
  if (suggestCache.size > 2000) suggestCache.clear();
  suggestCache.set(ck, r);
  return r;
}
function suggestRaw(name, pool) {
  const lower = name.toLowerCase();
  for (const c of pool) if (c.toLowerCase() === lower) return c;
  if (name.length > 40) return undefined;
  let best, bestD = 3;
  for (const c of pool) {
    if (Math.abs(c.length - name.length) >= bestD) continue;
    const d = lev(lower, c.toLowerCase(), bestD);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}
function lev(a, b, cap) {
  // Optimal string alignment distance (adjacent transpositions cost 1), early exit at cap.
  let pp = null, prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (pp && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], pp[j - 2] + 1);
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin >= cap) return cap;
    pp = prev; prev = cur;
  }
  return prev[b.length];
}
const TYPE_NAMES = Object.keys(TYPES), PROP_NAMES = Object.keys(PROPS);

/** Max bracket nesting outside JSON strings (linear). Used to reject absurd nesting before quota is charged. */
export const MAX_NESTING = 256;
export function maxNesting(text) {
  let d = 0, max = 0, inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inStr) { if (c === 92) i++; else if (c === 34) inStr = false; continue; }
    if (c === 34) inStr = true;
    else if (c === 91 || c === 123) { if (++d > max) max = d; }
    else if (c === 93 || c === 125) d--;
  }
  return max;
}

/** Extract JSON-LD blocks from input text: raw JSON, or HTML with <script type="application/ld+json"> tags. */
export function extractBlocks(text) {
  const t = text.replace(/^\uFEFF/, '').trim();
  if (t.startsWith('{') || t.startsWith('[')) return { source: 'json', blocks: [t] };
  // Linear scanner. Each indexOf moves forward; no backtracking.
  const lower = t.toLowerCase();
  const blocks = []; let pos = 0;
  while (blocks.length < MAX_BLOCKS + 1) {
    const i = lower.indexOf('<script', pos); if (i < 0) break;
    const gt = t.indexOf('>', i); if (gt < 0) break;
    if (!LDJSON_TYPE.test(t.slice(i, gt))) { pos = gt + 1; continue; }
    const end = lower.indexOf('</script', gt); if (end < 0) break;
    blocks.push(t.slice(gt + 1, end).trim());
    pos = end + 8;
  }
  return { source: 'html', blocks };
}

function checkValueForRange(v, ranges) {
  // v is a primitive. Returns true if compatible with at least one expected range (lenient, like most validators).
  if (!ranges.length) return true;
  for (const r of ranges) {
    if (r === 'Text' || isSubtype(r, 'Text') || r === 'DataType') return true;
    if (DATATYPES.has(r) || isSubtype(r, 'Number') || isSubtype(r, 'Text')) {
      if ((r === 'Number' || r === 'Integer' || r === 'Float') && (typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v.trim())))) return true;
      if (r === 'Boolean' && (typeof v === 'boolean' || /^(https?:\/\/schema\.org\/)?(True|False)$/i.test(String(v)))) return true;
      if (r === 'URL' && typeof v === 'string' && /^(https?:\/\/|\/|#|[a-z][a-z0-9+.-]*:)/i.test(v)) return true;
      if (r === 'Date' && typeof v === 'string' && /^\d{4}(-\d{2}(-\d{2})?)?$/.test(v)) return true;
      if (r === 'DateTime' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(v)) return true;
      if (r === 'Time' && typeof v === 'string' && /^\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(v)) return true;
      continue;
    }
    // Thing-valued range: strings are allowed (Google and Schema.org accept text/URL for things), enum members too.
    if (typeof v === 'string') {
      const s = stripSchema(v);
      if (isEnumMember(s) && ENUM_MEMBERS[s].some((et) => isSubtype(et, r))) return true;
      if (isSubtype(r, 'Enumeration')) continue; // an enumeration expects a member
      return true;
    }
  }
  return false;
}

/**
 * Validate input text (JSON-LD or HTML). Returns a JSON-serialisable report.
 */
export function validate(text) {
  const issues = [];
  let truncated = false;
  const budget = { left: MAX_SUGGESTIONS };
  const add = (level, code, path, message, extra) => {
    if (issues.length >= MAX_ISSUES) { truncated = true; return; }
    issues.push({ level, code, path, message, ...(extra || {}) });
  };
  const stats = { blocks: 0, nodes: 0, types: {} };
  const { source, blocks } = extractBlocks(text);
  if (!blocks.length) add('error', 'no_jsonld', '$', source === 'html' ? 'No <script type="application/ld+json"> blocks found in the HTML.' : 'Input is empty.');
  if (blocks.length > MAX_BLOCKS) { add('warning', 'too_many_blocks', '$', `Only the first ${MAX_BLOCKS} JSON-LD blocks were checked.`); blocks.length = MAX_BLOCKS; }

  const ids = new Map(); // @id -> count of defining nodes
  const refs = [];
  blocks.forEach((raw, bi) => {
    stats.blocks++;
    const bp = source === 'html' ? `$[block ${bi}]` : '$';
    let data;
    try { data = JSON.parse(raw); } catch (e) {
      const pos = /position (\d+)/.exec(e.message);
      add('error', 'invalid_json', bp, `Not valid JSON${pos ? ` (near character ${pos[1]})` : ''}.`);
      return;
    }
    const roots = Array.isArray(data) ? data.map((d, i) => [d, `${bp}[${i}]`]) : [[data, bp]];
    for (const [root, rp] of roots) {
      if (!root || typeof root !== 'object' || Array.isArray(root)) { add('error', 'not_object', rp, 'Top-level JSON-LD must be an object (or an array of objects).'); continue; }
      const ctx = contextInfo(root['@context']);
      if (!has(root, '@context')) add('error', 'missing_context', rp, 'Missing "@context". Use "https://schema.org".');
      else if (!ctx.schema) add('warning', 'non_schema_context', `${rp}.@context`, 'No Schema.org context found. RichProof only checks the Schema.org vocabulary and never fetches remote contexts.');
      else if (ctx.http) add('info', 'http_context', `${rp}.@context`, 'The context uses http://schema.org. https://schema.org is preferred.');
      walk(root, rp, 0, ctx.schema, null);
    }
  });

  function contextInfo(c) {
    const out = { schema: false, http: false };
    for (const x of Array.isArray(c) ? c : [c]) {
      if (typeof x === 'string' && SCHEMA_CTX.test(x.trim())) { out.schema = true; out.http ||= /^http:/i.test(x.trim()); }
      else if (x && typeof x === 'object' && typeof x['@vocab'] === 'string' && SCHEMA_CTX.test(x['@vocab'].trim())) out.schema = true;
    }
    return out;
  }

  function walk(node, path, depth, schema, parentProp) {
    if (depth > MAX_DEPTH) { add('error', 'too_deep', path, `Nesting deeper than ${MAX_DEPTH} levels; not checked further.`); return; }
    if (++stats.nodes > MAX_NODES) { if (stats.nodes === MAX_NODES + 1) add('warning', 'too_many_nodes', path, `More than ${MAX_NODES} nodes; the rest were not checked.`); return; }
    if (has(node, '@context') && depth > 0) { const c = contextInfo(node['@context']); schema = schema || c.schema; }
    if (has(node, '@graph')) {
      const g = node['@graph'];
      if (!Array.isArray(g)) add('error', 'graph_not_array', `${path}.@graph`, '"@graph" must be an array.');
      else g.forEach((n, i) => { if (n && typeof n === 'object' && !Array.isArray(n)) walk(n, `${path}.@graph[${i}]`, depth + 1, schema, null); else add('error', 'not_object', `${path}.@graph[${i}]`, '@graph items must be objects.'); });
    }
    if (has(node, '@value')) return;
    // Types
    const rawTypes = has(node, '@type') ? (Array.isArray(node['@type']) ? node['@type'] : [node['@type']]) : [];
    const types = [];
    for (const t of rawTypes) {
      if (typeof t !== 'string') { add('error', 'invalid_type_value', `${path}.@type`, '"@type" must be a string or array of strings.'); continue; }
      const name = stripSchema(t);
      if (/^[a-z][a-z0-9+.-]*:/i.test(name) && !/^schema:/i.test(t)) { add('info', 'external_type', `${path}.@type`, `Type "${clip(t)}" is outside Schema.org and was not checked.`); continue; }
      if (!has(TYPES, name) || DATATYPES.has(name)) {
        const s = has(TYPES, name) ? undefined : (issues.length < MAX_ISSUES ? suggest(name, TYPE_NAMES, budget) : undefined);
        add('error', 'unknown_type', `${path}.@type`, `"${clip(name)}" is not a Schema.org type.${s ? ` Did you mean "${s}"?` : ''}`, s ? { suggestion: s } : undefined);
        continue;
      }
      if (has(SUPERSEDED, name)) add('warning', 'superseded_type', `${path}.@type`, `"${name}" is superseded${SUPERSEDED[name] ? ` by "${SUPERSEDED[name]}"` : ''}.`);
      types.push(name);
      stats.types[name] = (stats.types[name] || 0) + 1;
    }
    const isGraphOnly = has(node, '@graph') && Object.keys(node).every((k) => k === '@graph' || k === '@context' || k === '@id');
    if (!rawTypes.length && !isGraphOnly && depth === 0 && !has(node, '@id')) add('warning', 'missing_type', path, 'Node has no "@type".');
    else if (!rawTypes.length && !isGraphOnly && !has(node, '@id') && parentProp === null) add('warning', 'missing_type', path, 'Node has no "@type".');
    if (has(node, '@id')) {
      if (typeof node['@id'] !== 'string') add('error', 'invalid_id', `${path}.@id`, '"@id" must be a string.');
      else {
        const keys = Object.keys(node).filter((k) => k !== '@id');
        if (keys.length) ids.set(node['@id'], (ids.get(node['@id']) || 0) + 1);
        else refs.push([node['@id'], path]);
      }
    }
    // Properties
    for (const [k, v] of Object.entries(node)) {
      const kp = `${path}.${/^[A-Za-z_@][\w@-]*$/.test(k) ? k : JSON.stringify(clip(k, 60))}`;
      if (k.startsWith('@')) {
        if (!KEYWORDS.has(k)) add('error', 'unknown_keyword', kp, `"${clip(k)}" is not a JSON-LD keyword.`);
        continue;
      }
      if (!schema) continue;
      const pname = stripSchema(k);
      if (/^[a-z][a-z0-9+.-]*:/i.test(pname) && !/^schema:/i.test(k)) { add('info', 'external_property', kp, `Property "${clip(k)}" is outside Schema.org and was not checked.`); continue; }
      const def = has(PROPS, pname) ? PROPS[pname] : null;
      if (!def) {
        const s = (issues.length < MAX_ISSUES ? suggest(pname, PROP_NAMES, budget) : undefined);
        add('error', 'unknown_property', kp, `"${clip(pname)}" is not a Schema.org property.${s ? ` Did you mean "${s}"?` : ''}`, s ? { suggestion: s } : undefined);
        walkValues(v, kp, depth, schema, pname, []);
        continue;
      }
      if (has(SUPERSEDED, pname)) add('warning', 'superseded_property', kp, `"${pname}" is superseded${SUPERSEDED[pname] ? ` by "${SUPERSEDED[pname]}"` : ''}.`);
      const [domains, ranges] = def;
      if (types.length && domains.length && !types.some((t) => domains.some((d) => isSubtype(t, d)))) {
        add('warning', 'property_not_expected', kp, `"${pname}" is not expected on ${types.join('/')} (expected on: ${clip(domains.join(', '), 200)}).`);
      }
      walkValues(v, kp, depth, schema, pname, ranges);
    }
  }

  function walkValues(v, kp, depth, schema, pname, ranges) {
    if (depth > MAX_DEPTH) { add('error', 'too_deep', kp, `Nesting deeper than ${MAX_DEPTH} levels; not checked further.`); return; }
    const list = Array.isArray(v) ? v : [v];
    list.forEach((item, i) => {
      const ip = Array.isArray(v) ? `${kp}[${i}]` : kp;
      if (item === null) { add('warning', 'null_value', ip, 'Null value.'); return; }
      if (Array.isArray(item)) { add('warning', 'nested_array', ip, 'Nested arrays are flattened by JSON-LD; use a single array.'); walkValues(item, ip, depth + 1, schema, pname, ranges); return; }
      if (typeof item === 'object') {
        if (has(item, '@value')) { if (!checkValueForRange(item['@value'], ranges)) add('warning', 'unexpected_value', ip, `Value does not match the expected type for "${pname}" (${clip(ranges.join(', '), 150)}).`); return; }
        if (has(item, '@list') || has(item, '@set')) { walkValues(item['@list'] ?? item['@set'], ip, depth + 1, schema, pname, ranges); return; }
        walk(item, ip, depth + 1, schema, pname);
        const its = (Array.isArray(item['@type']) ? item['@type'] : [item['@type']]).filter((t) => typeof t === 'string').map(stripSchema).filter((t) => has(TYPES, t));
        if (its.length && ranges.length && !ranges.some((r) => r === 'Text' || r === 'URL') && !its.some((t) => ranges.some((r) => isSubtype(t, r)))) {
          add('warning', 'unexpected_type', `${ip}.@type`, `${its.join('/')} is not an expected type for "${pname}" (expected: ${clip(ranges.join(', '), 150)}).`);
        }
        return;
      }
      if (typeof item === 'string' && item.trim() === '') { add('warning', 'empty_value', ip, 'Empty string value.'); return; }
      if (!checkValueForRange(item, ranges)) add('warning', 'unexpected_value', ip, `Value ${clip(JSON.stringify(item), 60)} does not match the expected type for "${pname}" (${clip(ranges.join(', '), 150)}).`);
    });
  }

  for (const [id, p] of refs) if (!ids.has(id) && (id.startsWith('#') || id.startsWith('_:'))) add('warning', 'dangling_reference', `${p}.@id`, `Reference "${clip(id)}" points to no node in this input.`);
  for (const [id, n] of ids) if (n > 1) add('info', 'duplicate_id', '$', `"${clip(id)}" is defined by ${n} nodes (JSON-LD merges them).`);

  const counts = { error: 0, warning: 0, info: 0 };
  for (const i of issues) counts[i.level]++;
  return {
    valid: counts.error === 0 && stats.blocks > 0,
    summary: { errors: counts.error, warnings: counts.warning, infos: counts.info, blocks: stats.blocks, nodes: Math.min(stats.nodes, MAX_NODES), types: stats.types, source },
    issues,
    ...(truncated ? { truncated: true } : {}),
    meta: { version: VERSION, vocabulary: 'Schema.org (CC BY-SA 3.0)', vocabularyLicense: 'https://schema.org/docs/terms.html', fetchesUrls: false },
  };
}
