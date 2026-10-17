import { TOOLS, SUPPORTED_VERSIONS, DISCOVERY_PER_MIN, MAX_BODY_BYTES } from './mcp.js';
import { VERSION, MAX_NESTING } from './validate.js';

export const CONTACT = 'digitalpromohub.support@gmail.com';
export const ATTRIBUTION = 'Schema.org vocabulary © Schema.org, used under the Creative Commons Attribution-ShareAlike 3.0 license (CC BY-SA 3.0): https://schema.org/docs/terms.html. RichProof is not affiliated with or endorsed by Schema.org or its sponsors.';
export const mcpClientConfig = (origin) => ({ mcpServers: { richproof: { type: 'http', url: `${origin}/mcp` } } });

export const llmsTxt = (origin, L) => `# RichProof

> Validate JSON-LD structured data against the Schema.org vocabulary: syntax, structure, unknown types and properties with suggestions, and value types. Paste markup, never a URL (RichProof never fetches URLs). Free paste tool, JSON API and a remote MCP server for AI agents.

## For AI agents

- [MCP server](${origin}/mcp): remote MCP over Streamable HTTP (POST only, stateless, JSON responses). Protocol versions: ${SUPPORTED_VERSIONS.join(', ')}. Tool \`${TOOLS[0].name}\` (input: JSON-LD or HTML text; optional include_raw). Read-only. Client config (most MCP clients accept this; some use a different format, for example VS Code uses a \`servers\` key): \`${JSON.stringify(mcpClientConfig(origin))}\`
- [OpenAPI 3.1 spec](${origin}/openapi.json): machine-readable description of the JSON API

## JSON API

- \`POST ${origin}/api/validate\`: body is the raw JSON-LD or HTML (any content type), or \`{"input": "<text>"}\`. Max ${MAX_BODY_BYTES} bytes. Response: { valid, summary { errors, warnings, infos, blocks, nodes, types, source }, issues [ { level, code, path, message, suggestion? } ], meta }. Errors: { "error": { "code", "message" } } with 400 invalid_input (empty input, or brackets nested deeper than ${MAX_NESTING} levels; rejected before any quota is used), 404 not_found, 405 method_not_allowed, 413 too_large, 429 rate_limited / daily_limit.
- \`GET ${origin}/api/health\`: { ok, version, day }.

## Limits, keys and pricing

- Free, no key. About ${L.anonPerMin} validations/min per IP and a shared pool of about ${L.dailyPool} validations per UTC day. The MCP endpoint uses the same counters: each \`tools/call\` is one validation. Non-validation MCP messages don't count as validations, but are capped at about ${DISCOVERY_PER_MIN}/min per IP (HTTP 429 + Retry-After).
- Submitted content is processed in memory only and never stored or logged.

## Optional

- [Privacy](${origin}/#privacy)
- Attribution: ${ATTRIBUTION}
- Contact: ${CONTACT}
`;

const err = (desc) => ({ description: desc, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } });
const rpc = (desc) => ({ description: desc, content: { 'application/json': { schema: { type: 'object', description: 'JSON-RPC 2.0 response (or batch array)' } } } });

export function openApiSpec(origin, L) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'RichProof', version: VERSION,
      description: `Validate JSON-LD against the Schema.org vocabulary. Never fetches URLs. Free: about ${L.anonPerMin}/min per IP, shared daily pool about ${L.dailyPool}. ${ATTRIBUTION}`,
      contact: { email: CONTACT },
    },
    servers: [{ url: origin }],
    paths: {
      '/api/validate': {
        post: {
          operationId: 'validateJsonLd', summary: 'Validate JSON-LD or HTML containing JSON-LD',
          requestBody: { required: true, content: {
            'application/ld+json': { schema: { type: 'string', maxLength: MAX_BODY_BYTES } },
            'text/html': { schema: { type: 'string', maxLength: MAX_BODY_BYTES } },
            'text/plain': { schema: { type: 'string', maxLength: MAX_BODY_BYTES } },
            'application/json': { schema: { oneOf: [{ type: 'object', properties: { input: { type: 'string', maxLength: MAX_BODY_BYTES } }, required: ['input'], additionalProperties: false }, { type: 'object', description: 'Raw JSON-LD document' }] } },
          } },
          responses: {
            200: { description: 'Validation report', headers: { 'X-RichProof-Quota-Remaining': { schema: { type: 'string' }, description: 'Approximate validations left in the shared daily pool' } }, content: { 'application/json': { schema: { $ref: '#/components/schemas/Report' } } } },
            400: err(`invalid_input: empty input, or JSON nested deeper than ${MAX_NESTING} levels (rejected before rate limits or the daily pool are charged)`), 413: err('too_large'),
            429: { ...err('rate_limited or daily_limit'), headers: { 'Retry-After': { schema: { type: 'string' } } } },
            500: err('internal_error'),
          },
        },
        get: { operationId: 'validateGetNotAllowed', summary: 'Not supported (content must not go in URLs)', responses: { 405: err('method_not_allowed') } },
      },
      '/api/health': { get: { operationId: 'health', summary: 'Health and version', responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, version: { type: 'string' }, day: { type: 'string' } } } } } } } } },
      '/mcp': {
        post: {
          operationId: 'mcp', summary: 'Remote MCP server (JSON-RPC 2.0 over Streamable HTTP, stateless)',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', description: 'JSON-RPC 2.0 request, notification or batch (max 10, at most one tools/call)' } } } },
          responses: { 200: rpc('JSON-RPC result'), 202: { description: 'Notification or client response accepted (empty body)' }, 400: rpc('Parse error, invalid request or protocol/header mismatch'), 403: rpc('Origin not allowed'), 404: rpc('Method not found (2026-07-28 requests)'), 413: rpc('Body too large'), 429: rpc('Too many MCP requests (Retry-After)'), 500: { description: 'Internal error' } },
        },
        get: { operationId: 'mcpGet', summary: 'Not supported (no SSE stream)', responses: { 405: { description: 'Method not allowed', headers: { Allow: { schema: { type: 'string', const: 'POST, OPTIONS' } } } } } },
        delete: { operationId: 'mcpDelete', summary: 'Not supported (no sessions)', responses: { 405: { description: 'Method not allowed', headers: { Allow: { schema: { type: 'string', const: 'POST, OPTIONS' } } } } } },
      },
    },
    components: {
      schemas: {
        Error: { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string', enum: ['invalid_input', 'too_large', 'rate_limited', 'daily_limit', 'method_not_allowed', 'not_found', 'internal_error'] }, message: { type: 'string' } }, required: ['code', 'message'] } }, required: ['error'] },
        Issue: { type: 'object', properties: { level: { type: 'string', enum: ['error', 'warning', 'info'] }, code: { type: 'string' }, path: { type: 'string' }, message: { type: 'string' }, suggestion: { type: 'string' } }, required: ['level', 'code', 'path', 'message'] },
        Report: { type: 'object', properties: {
          valid: { type: 'boolean' },
          summary: { type: 'object', properties: { errors: { type: 'integer' }, warnings: { type: 'integer' }, infos: { type: 'integer' }, blocks: { type: 'integer' }, nodes: { type: 'integer' }, types: { type: 'object', additionalProperties: { type: 'integer' } }, source: { type: 'string', enum: ['json', 'html'] } } },
          issues: { type: 'array', items: { $ref: '#/components/schemas/Issue' } },
          truncated: { type: 'boolean' },
          meta: { type: 'object', properties: { version: { type: 'string' }, vocabulary: { type: 'string' }, vocabularyLicense: { type: 'string' }, fetchesUrls: { type: 'boolean', const: false } } },
        }, required: ['valid', 'summary', 'issues', 'meta'] },
      },
    },
  };
}
