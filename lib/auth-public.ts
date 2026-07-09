/**
 * Public auth constants importable from client components.
 *
 * `lib/auth.ts` runs Better Auth's `betterAuth(...)` factory which
 * transitively pulls in `pg`/`kysely` and Node-only modules. Client
 * components that need only the public *values* (scope vocabularies,
 * prefix literals) would otherwise force the bundler to ship those
 * server modules to the browser, which fails the build.
 *
 * This file is the seam: every constant here is plain data, no
 * runtime dependencies, safe to import from any execution context.
 * `lib/auth.ts` re-exports each one so server code that already
 * imports `@/lib/auth` doesn't have to change.
 */

/**
 * Wire prefix carried by every Nova-issued API key.
 *
 * Stripe-style (`sk-`) + product (`nova-`) + format version (`v1-`).
 * The version segment lets future key-format changes (different
 * entropy, embedded key id, different encoding) dispatch unambiguously
 * — same pattern Anthropic uses (`sk-ant-api03-`). Removing or
 * shortening this prefix breaks the prefix-peek fork in the MCP route
 * dispatcher.
 */
export const NOVA_API_KEY_PREFIX = "sk-nova-v1-";

/**
 * Mintable scope vocabulary for Nova API keys.
 *
 * Subset of `NOVA_OAUTH_SCOPES` that excludes the OIDC / refresh-token
 * scopes (`openid` / `profile` / `email` / `offline_access`). Those
 * exist for OIDC discovery and refresh-token issuance — concepts that
 * don't apply to a static bearer credential. A user minting a key
 * picks from this set; the floor (`nova.read` + `nova.write`) is
 * enforced at the MCP verify layer, the HQ scopes are orthogonal
 * opt-ins, same split as the JWT path.
 */
export const NOVA_API_KEY_SCOPES = [
	"nova.read",
	"nova.write",
	"nova.hq.read",
	"nova.hq.write",
] as const;

export type NovaApiKeyScope = (typeof NOVA_API_KEY_SCOPES)[number];

/**
 * The two scopes every Nova MCP call requires, regardless of auth
 * path. Single source of truth for the "floor" check:
 *   - JWT path declares them in `mcpHandler`'s `scopes` config
 *     (`app/api/mcp/jwt-auth.ts`).
 *   - API-key path checks them locally after `verifyApiKey` succeeds
 *     (`app/api/mcp/api-key-auth.ts`).
 *   - Server Actions enforce them at mint and edit time so a key
 *     without both can't be created in the first place.
 *   - Mint-dialog and edit-dialog UI render those scopes as
 *     locked-checked.
 *
 * Lives in `auth-public` rather than next to the route's `SCOPES`
 * object so the React mint-form can import it; keeping a single
 * literal here means every "what's required" answer comes from the
 * same source and can't drift across paths.
 */
export const NOVA_MCP_FLOOR_SCOPES = ["nova.read", "nova.write"] as const;

/**
 * Friendly labels for Nova's scope literals. Used by the settings UI
 * for the scope chips and by `McpScopeError` to render the missing
 * scope as something a user can recognize from the settings page (the
 * raw `nova.hq.read` literal isn't anywhere on the user's screen — the
 * checkbox there says "HQ Read"). The wire `required_scope` field
 * keeps the raw literal for programmatic consumers; only the
 * human-readable message uses the label.
 */
export const NOVA_MCP_SCOPE_LABELS: Record<NovaApiKeyScope, string> = {
	"nova.read": "Read",
	"nova.write": "Write",
	"nova.hq.read": "HQ Read",
	"nova.hq.write": "HQ Write",
};
