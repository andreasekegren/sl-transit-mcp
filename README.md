# Example Next.js MCP Server

**Uses `mcp-handler`**

## Usage

This sample app uses the [Vercel MCP Adapter](https://www.npmjs.com/package/mcp-handler) that allows you to drop in an MCP server on a group of routes in any Next.js project.

Update `app/[transport]/route.ts` with your tools, prompts, and resources following the [MCP TypeScript SDK documentation](https://github.com/modelcontextprotocol/typescript-sdk/tree/main?tab=readme-ov-file#server).

## SL Transit tools

This server exposes SL (Stockholm) departures via MCP tools:

- `sl_find_site` (search for SL site IDs)
- `sl_departures` (get departures by station name or siteId)

Requests require `MCP_API_KEY` sent as `Authorization: Bearer <key>` or `x-api-key: <key>`.

### How to use in Poke

Poke can connect to either endpoint:

- `/mcp`
- `/api/mcp` (alias for compatibility)

Example Poke prompts:

- “Find SL site IDs for T-Centralen.”
- “Show departures from T-Centralen, metro and train only.”
- “Departures from siteId 9001, max 10 results, destination contains ‘Södertälje’.”

### Manual test steps

1. Set `MCP_API_KEY` in your environment.
2. Start the dev server: `pnpm dev`
3. In Poke (or another MCP client), connect to `http://localhost:3000/mcp`.
4. Invoke `sl_find_site` and `sl_departures` with the prompts above.

## Notes for running on Vercel

- To use the SSE transport, requires a Redis attached to the project under `process.env.REDIS_URL` and toggling the `disableSse` flag to `false` in `app/mcp/route.ts`
- Make sure you have [Fluid compute](https://vercel.com/docs/functions/fluid-compute) enabled for efficient execution
- After enabling Fluid compute, open `app/route.ts` and adjust `maxDuration` to 800 if you using a Vercel Pro or Enterprise account
- [Deploy the Next.js MCP template](https://vercel.com/templates/next.js/model-context-protocol-mcp-with-next-js)

## Sample Client

`script/test-client.mjs` contains a sample client to try invocations.

```sh
node scripts/test-client.mjs https://mcp-for-next-js.vercel.app
```
