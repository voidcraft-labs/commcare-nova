# Phase F — Route handler + end-to-end auth smoke

**Goal:** Assemble the OAuth-verified MCP endpoint at `/api/mcp`, wire `registerNovaTools`, and prove the whole stack works end-to-end from Claude Code.

**Dependencies:** Phases A–E complete.

---

## Task F1: `registerNovaTools` + `lib/mcp/server.ts`

**Files:**
- Create: `lib/mcp/server.ts`

- [ ] **Step 1: Write `lib/mcp/server.ts`**

```ts
/**
 * MCP server registration entry point.
 *
 * Invoked by the route handler once per request, after JWT verification.
 * Registers every Nova tool + prompt under the authenticated user's id
 * and granted scopes so tool handlers can short-circuit on
 * insufficient_scope without re-parsing the token.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./types";

import { registerGetAgentPrompt } from "./tools/getAgentPrompt";
import { registerListApps } from "./tools/listApps";
import { registerGetApp } from "./tools/getApp";
import { registerCreateApp } from "./tools/createApp";
import { registerDeleteApp } from "./tools/deleteApp";
import { registerGenerateSchema } from "./tools/generateSchema";
import { registerGenerateScaffold } from "./tools/generateScaffold";
import { registerAddModule } from "./tools/addModule";
import { registerSearchBlueprint } from "./tools/searchBlueprint";
import { registerGetModule } from "./tools/getModule";
import { registerGetForm } from "./tools/getForm";
import { registerGetField } from "./tools/getField";
import { registerAddFields } from "./tools/addFields";
import { registerAddField } from "./tools/addField";
import { registerEditField } from "./tools/editField";
import { registerRemoveField } from "./tools/removeField";
import { registerUpdateModule } from "./tools/updateModule";
import { registerUpdateForm } from "./tools/updateForm";
import { registerCreateForm } from "./tools/createForm";
import { registerRemoveForm } from "./tools/removeForm";
import { registerCreateModule } from "./tools/createModule";
import { registerRemoveModule } from "./tools/removeModule";
import { registerValidateApp } from "./tools/validateApp";
import { registerCompileApp } from "./tools/compileApp";
import { registerUploadAppToHq } from "./tools/uploadAppToHq";

export function registerNovaTools(server: McpServer, ctx: ToolContext): void {
	registerGetAgentPrompt(server, ctx);
	registerListApps(server, ctx);
	registerGetApp(server, ctx);
	registerCreateApp(server, ctx);
	registerDeleteApp(server, ctx);
	registerGenerateSchema(server, ctx);
	registerGenerateScaffold(server, ctx);
	registerAddModule(server, ctx);
	registerSearchBlueprint(server, ctx);
	registerGetModule(server, ctx);
	registerGetForm(server, ctx);
	registerGetField(server, ctx);
	registerAddFields(server, ctx);
	registerAddField(server, ctx);
	registerEditField(server, ctx);
	registerRemoveField(server, ctx);
	registerUpdateModule(server, ctx);
	registerUpdateForm(server, ctx);
	registerCreateForm(server, ctx);
	registerRemoveForm(server, ctx);
	registerCreateModule(server, ctx);
	registerRemoveModule(server, ctx);
	registerValidateApp(server, ctx);
	registerCompileApp(server, ctx);
	registerUploadAppToHq(server, ctx);
}

export function registerNovaPrompts(_server: McpServer): void {
	/* v1 has no standalone MCP prompts — the agent prompt surface lives on
	 * the get_agent_prompt tool (structured content the plugin writes to
	 * disk). Kept as a registered-but-empty hook so the route handler's
	 * registration call site stays stable if prompts are added later. */
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit && echo "✓"`
Expected: `✓`. If any tool file has a type error, fix it in that tool's file (not here).

- [ ] **Step 3: Commit**

```bash
git add lib/mcp/server.ts
git commit -m "feat(mcp): registerNovaTools wires up all 25 primitive tools"
```

---

## Task F2: `/api/mcp` route

**Files:**
- Create: `app/api/mcp/route.ts`

- [ ] **Step 1: Write the route**

```ts
/**
 * Streamable HTTP MCP endpoint at /api/mcp.
 *
 * Request flow:
 *   1. mcpHandler (from @better-auth/oauth-provider) verifies the bearer
 *      token against local JWKS, extracts JWT claims.
 *   2. Inner createMcpHandler is invoked with the claims, registering
 *      tools bound to this user's id + granted scopes.
 *   3. MCP's JSON-RPC layer dispatches tool calls.
 *
 * No unauthenticated access. Missing / invalid token → 401 before we ever
 * reach the inner handler, with a WWW-Authenticate header pointing at the
 * authorization server so Claude Code can auto-discover and auth.
 */

import { createMcpHandler } from "mcp-handler";
import { mcpHandler } from "@better-auth/oauth-provider";
import { registerNovaPrompts, registerNovaTools } from "@/lib/mcp/server";
import { parseScopes } from "@/lib/mcp/scopes";
import type { JwtClaims } from "@/lib/mcp/types";

const handler = mcpHandler(
	{
		/* NOTE: confirm this path during Phase B Task B3 Step 3 — the real
		 * JWKS endpoint path is discovered from the authorization-server
		 * metadata document. If it differs, update this constant before
		 * running the end-to-end smoke. */
		jwksUrl: "https://commcare.app/api/auth/jwks",
		verifyOptions: {
			issuer: "https://commcare.app",
			audience: "https://mcp.commcare.app",
		},
	},
	(req: Request, jwt: JwtClaims) =>
		createMcpHandler(
			(server) => {
				registerNovaTools(server, {
					userId: jwt.sub,
					scopes: parseScopes(jwt),
				});
				registerNovaPrompts(server);
			},
			{ serverInfo: { name: "nova", version: "1.0.0" } },
			{ basePath: "/api", maxDuration: 300 },
		)(req),
);

export { handler as GET, handler as POST, handler as DELETE };

export const maxDuration = 300;
```

- [ ] **Step 2: Local auth-wall smoke**

Start dev. With middleware set up from Phase A:

```bash
curl -i -H "Host: mcp.commcare.app" -X POST http://localhost:3000/api/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

Expected: HTTP 401 with a `WWW-Authenticate` header referencing the authorization server. If instead we get 404, middleware is blocking the path — fix the allowlist in `lib/hostnames.ts`.

- [ ] **Step 3: Commit**

```bash
git add app/api/mcp/route.ts
git commit -m "feat(mcp): /api/mcp streamable HTTP endpoint with OAuth-gated tools"
```

---

## Task F3: End-to-end OAuth flow via Claude Code (load-bearing smoke)

**Files:** None — documented verification.

This is the first point the full OAuth + MCP + tool stack can run. Every step before has been mechanically correct; this verifies Claude Code picks it up.

**Prerequisite:** The staging or production environment must be reachable via a valid HTTPS URL (OAuth redirect URIs require HTTPS and browser reachability). Either:
- Deploy to a staging Cloud Run revision with a staging subdomain (e.g., `mcp-staging.commcare.app`), OR
- Use a tunnel (ngrok/cloudflared) pointed at `localhost:3000` and temporarily add the tunnel host to `HOSTNAME_ALLOWLIST` + `trustedOrigins`.

- [ ] **Step 1: Register the server with Claude Code**

```bash
claude mcp add --transport http nova https://mcp.commcare.app/mcp
```

Expected: Claude Code discovers the authorization server via `/.well-known/oauth-protected-resource`, prompts the user to authenticate, opens the browser to `/sign-in` (or directly `/consent` if signed in), shows the consent page with `nova.read` + `nova.write` scopes, user clicks Allow, Claude Code stores the token.

- [ ] **Step 2: Verify tool discovery**

In Claude Code, run `/mcp`:
- `nova` server listed.
- Status: `connected`.
- Tool list includes all 25 tools.

- [ ] **Step 3: Call a read tool**

```
Ask Claude Code: "Call the nova.list_apps tool"
```

Expected: `{"apps":[]}` or a populated list. No error in server logs.

- [ ] **Step 4: Call a write tool**

```
Ask Claude Code: "Create a Nova app called 'smoke test'"
```

Expected: `nova.create_app` returns an `app_id`. Verify in Firestore console that the app doc exists and is owned by the authenticated user.

- [ ] **Step 5: Verify token refresh**

Shorten the access token TTL to ~2 minutes temporarily (or wait past the default 1h). Make another tool call. Claude Code should refresh transparently via `offline_access`; the call should succeed without re-prompting for auth.

- [ ] **Step 6: Verify scope enforcement**

If possible, register a second OAuth client with only `nova.read` (manual DCR via curl). Attempt a write tool call — expect `insufficient_scope` error.

- [ ] **Step 7: Verify revocation**

Claude Code `/mcp` → nova → "Clear authentication". Server logs should show a POST to `/api/auth/oauth2/revoke`. Next tool call re-prompts for auth.

- [ ] **Step 8: Record outcomes**

Append to `docs/superpowers/plans/notes/2026-04-21-nova-mcp-infra.md`:

```markdown
## End-to-end OAuth + MCP smoke (YYYY-MM-DD)

- Target: https://mcp.commcare.app/mcp (staging)
- Tool discovery: <pass/fail>
- read tool: <pass/fail>
- write tool: <pass/fail>
- token refresh: <pass/fail>
- scope enforcement: <pass/fail>
- revocation: <pass/fail>
```

- [ ] **Step 9: Commit the outcome note**

```bash
git add docs/superpowers/plans/notes/2026-04-21-nova-mcp-infra.md
git commit --allow-empty -m "test(mcp): end-to-end OAuth + MCP smoke passed against staging"
```
