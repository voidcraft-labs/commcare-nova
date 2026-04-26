/**
 * Catch-all that re-exports the bare-path handler so the
 * `MCP_RESOURCE_METADATA_URL` constructed in `lib/hostnames.ts` resolves
 * regardless of suffix:
 *   - prod: `/.well-known/oauth-protected-resource/mcp`
 *   - dev:  `/.well-known/oauth-protected-resource/api/mcp`
 *
 * The metadata document doesn't depend on the path segments — every
 * caller gets the same document.
 */
export { GET } from "../route";
