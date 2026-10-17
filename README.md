# RichProof

Validate JSON-LD structured data against the Schema.org vocabulary. Free; never fetches URLs.

## Live service

- Web app and API: https://richproof.mike-tusa.workers.dev/
- Pricing and plans: https://richproof.mike-tusa.workers.dev/
- Support: digitalpromohub.support@gmail.com

## Use it from an AI assistant (MCP)

RichProof is a remote MCP server (Streamable HTTP) at `https://richproof.mike-tusa.workers.dev/mcp`. Tools: `validate_jsonld`.

Most MCP clients (Claude Desktop, Cursor, Cline, Windsurf) accept this config:

```json
{
  "mcpServers": {
    "richproof": {
      "type": "http",
      "url": "https://richproof.mike-tusa.workers.dev/mcp"
    }
  }
}
```

Clients that only support stdio can bridge with `npx mcp-remote https://richproof.mike-tusa.workers.dev/mcp`. VS Code uses a `servers` key instead of `mcpServers`.

The `server.json` file is the [MCP Registry](https://registry.modelcontextprotocol.io) manifest for this server.

## Run your own copy

Requires Node.js 20+ and a Cloudflare account.

```bash
npm install
npx wrangler dev        # local dev server
```

`wrangler.toml` is a template: create your own KV namespaces / D1 databases / rate-limit namespaces and replace the `<PLACEHOLDER>` values before `npx wrangler deploy`. Any secrets the Worker reads go in `wrangler secret put` (or `.dev.vars` locally), never in the repo.

## Third-party data

The code in this repository is licensed under MIT. The vocabulary file `src/lib/vocab.js` is NOT MIT: it is generated from the Schema.org vocabulary, (c) Schema.org, and is licensed under CC BY-SA 3.0 (https://creativecommons.org/licenses/by-sa/3.0/). See [NOTICE](NOTICE) and https://schema.org/docs/terms.html.

## License

Code: MIT (c) Digital Promo Hub, see [LICENSE](LICENSE). Vocabulary file `src/lib/vocab.js`: CC BY-SA 3.0, (c) Schema.org, see [NOTICE](NOTICE).
