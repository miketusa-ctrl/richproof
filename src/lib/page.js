import { ATTRIBUTION, CONTACT } from './agentdocs.js';
import { VERSION } from './validate.js';

export const FAVICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#1e3a8a"/><text x="16" y="22" font-family="monospace" font-size="15" fill="#fff" text-anchor="middle">{✓}</text></svg>';
const SAMPLE = '{\n  "@context": "https://schema.org",\n  "@type": "Product",\n  "name": "Example Mug",\n  "offers": {\n    "@type": "Offer",\n    "price": "12.00",\n    "priceCurrency": "USD",\n    "availability": "https://schema.org/InStock"\n  }\n}';
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const homepage = (L) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>RichProof: free JSON-LD and Schema.org validator</title>
<meta name="description" content="Paste JSON-LD or HTML and check it against the Schema.org vocabulary. Free, no sign-up, nothing stored. JSON API and MCP server for AI agents.">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="alternate" type="text/plain" href="/llms.txt" title="llms.txt">
<link rel="service-desc" type="application/json" href="/openapi.json" title="OpenAPI 3.1">
<style>
body{font:16px/1.5 system-ui,sans-serif;margin:0;color:#111;background:#f8fafc}.wrap{max-width:860px;margin:0 auto;padding:16px}
h1{font-size:1.6rem;margin:.4em 0}textarea{width:100%;box-sizing:border-box;min-height:260px;font:13px/1.4 ui-monospace,monospace;padding:8px;border:1px solid #cbd5e1;border-radius:6px}
button{background:#1e3a8a;color:#fff;border:0;border-radius:6px;padding:10px 18px;font-size:1rem;cursor:pointer}
.small{font-size:.85rem;color:#475569}pre{background:#0f172a;color:#e2e8f0;padding:10px;border-radius:6px;overflow-x:auto}
.iss{border-left:4px solid #94a3b8;padding:4px 8px;margin:6px 0;background:#fff}.error{border-color:#dc2626}.warning{border-color:#d97706}.info{border-color:#2563eb}
code{font-family:ui-monospace,monospace;word-break:break-word}footer{border-top:1px solid #e2e8f0;margin-top:24px}
@media (max-width:560px){#mcp-config{white-space:pre-wrap;word-break:break-all}}
</style></head><body>
<main class="wrap">
<h1>RichProof</h1>
<p>Paste JSON-LD, or HTML containing <code>&lt;script type="application/ld+json"&gt;</code> blocks, and check it against the Schema.org vocabulary: JSON syntax, <code>@context</code>/<code>@type</code>/<code>@graph</code> structure, unknown types and properties (with suggestions), properties on unexpected types, and value types. RichProof never fetches URLs, and nothing you paste is stored or logged.</p>
<form id="f"><label for="in" class="small">JSON-LD or HTML (max ${Math.round(L.maxBytes / 1024)} KB)</label>
<textarea id="in" spellcheck="false">${esc(SAMPLE)}</textarea>
<p><button type="submit">Validate</button> <span id="st" class="small" role="status"></span></p></form>
<div id="out" aria-live="polite"></div>

<section id="api"><h2>JSON API</h2>
<pre><code>curl -s -X POST https://richproof.mike-tusa.workers.dev/api/validate \\
  -H 'content-type: application/ld+json' --data-binary @page.jsonld</code></pre>
<p class="small">Free, no key: about ${L.anonPerMin} validations per minute per IP. <a href="/openapi.json">OpenAPI 3.1 spec</a></p></section>

<section id="agents"><h2>For AI agents (MCP)</h2>
<p>RichProof is also a remote <a href="https://modelcontextprotocol.io/" target="_blank" rel="noopener noreferrer">Model Context Protocol</a> (MCP) server. Most MCP clients accept this config; some use a different format (for example, VS Code uses a <code>servers</code> key). Clients with a settings screen just need the URL <code>https://richproof.mike-tusa.workers.dev/mcp</code>.</p>
<pre><code id="mcp-config">{ "mcpServers": { "richproof": { "type": "http", "url": "https://richproof.mike-tusa.workers.dev/mcp" } } }</code></pre>
<p class="small">Machine-readable docs: <a href="/llms.txt">llms.txt</a> · <a href="/openapi.json">OpenAPI 3.1 spec</a></p></section>

<section id="privacy"><h2>Privacy</h2>
<p class="small">Submitted markup is validated in memory and discarded. It is never written to storage or logs, and RichProof never fetches URLs. For rate limits and an anonymous daily visitor count we use a one-way hash of your network address and the date; the address itself is not stored and the hash expires after 9 days.</p></section>
</main>
<footer class="wrap small"><p>${esc(ATTRIBUTION).replace('https://schema.org/docs/terms.html', '<a href="https://schema.org/docs/terms.html" target="_blank" rel="noopener noreferrer">schema.org/docs/terms.html</a>').replace('(CC BY-SA 3.0)', '(<a href="https://creativecommons.org/licenses/by-sa/3.0/" target="_blank" rel="noopener noreferrer">CC BY-SA 3.0</a>)')}</p>
<p>RichProof v${VERSION} · Contact: ${CONTACT}</p></footer>
<script>
document.getElementById('mcp-config').textContent = JSON.stringify({ mcpServers: { richproof: { type: 'http', url: location.origin + '/mcp' } } }, null, 2);
const f = document.getElementById('f'), out = document.getElementById('out'), st = document.getElementById('st');
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; e.textContent = text; return e; };
f.addEventListener('submit', async (ev) => {
  ev.preventDefault(); st.textContent = 'Checking…'; out.replaceChildren();
  try {
    const r = await fetch('/api/validate', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: document.getElementById('in').value });
    const j = await r.json();
    if (!r.ok) { st.textContent = ''; out.append(el('p', 'iss error', (j.error && j.error.message) || 'Error')); return; }
    const s = j.summary; st.textContent = '';
    out.append(el('h2', '', (j.valid ? 'Valid' : 'Invalid') + ': ' + s.errors + ' error(s), ' + s.warnings + ' warning(s), ' + s.infos + ' info'));
    out.append(el('p', 'small', 'Types: ' + (Object.keys(s.types).join(', ') || 'none') + ' · blocks: ' + s.blocks + ' · nodes: ' + s.nodes));
    for (const i of j.issues) { const d = el('div', 'iss ' + i.level, ''); d.append(el('strong', '', i.level.toUpperCase() + ' '), el('code', '', i.path), el('div', '', i.message)); out.append(d); }
  } catch { st.textContent = 'Request failed.'; }
});
</script></body></html>`;
