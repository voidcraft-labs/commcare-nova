# Phase G — Route handler + end-to-end auth smoke

**Goal:** Assemble the OAuth-verified MCP endpoint, wire `registerNovaTools` to register MCP-only tools + wrap shared tools via `registerSharedTool`, and prove the whole stack works end-to-end from Claude Code.

**Dependencies:** Phases A–F complete.

---

## Task G1: `registerNovaTools` + `lib/mcp/server.ts`

**Files:**
- Create: `lib/mcp/server.ts`

- [ ] **Step 1: Write `lib/mcp/server.ts`**

```ts
/**
 * MCP server registration entry point.
 *
 * Invoked by the route handler once per request, after JWT verification.
 * Registers the MCP-only tools (list / get / create / delete / compile /
 * upload / get_agent_prompt) directly, and wraps every shared SA tool
 * from lib/agent/tools/* via registerSharedTool so the domain definition
 * lives in one place and both the chat and MCP surfaces consume it.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSharedTool } from "./adapters/sharedToolAdapter";
import { registerCompileApp } from "./tools/compileApp";
import { registerCreateApp } from "./tools/createApp";
import { registerDeleteApp } from "./tools/deleteApp";
import { registerGetAgentPrompt } from "./tools/getAgentPrompt";
import { registerGetApp } from "./tools/getApp";
import { registerListApps } from "./tools/listApps";
import { registerUploadAppToHq } from "./tools/uploadAppToHq";
import type { ToolContext } from "./types";

/* Shared tool modules. Each is one of the extracted lib/agent/tools/*
 * files from Phase D. The askQuestions SA tool is intentionally NOT
 * imported here — the MCP surface uses Claude Code's AskUserQuestion
 * via the subagent, not an agent-side ask mechanism. */
import { addFieldTool } from "@/lib/agent/tools/addField";
import { addFieldsTool } from "@/lib/agent/tools/addFields";
import { addModuleTool } from "@/lib/agent/tools/addModule";
import { createFormTool } from "@/lib/agent/tools/createForm";
import { createModuleTool } from "@/lib/agent/tools/createModule";
import { editFieldTool } from "@/lib/agent/tools/editField";
import { generateSchemaTool } from "@/lib/agent/tools/generateSchema";
import { generateScaffoldTool } from "@/lib/agent/tools/generateScaffold";
import { getFieldTool } from "@/lib/agent/tools/getField";
import { getFormTool } from "@/lib/agent/tools/getForm";
import { getModuleTool } from "@/lib/agent/tools/getModule";
import { removeFieldTool } from "@/lib/agent/tools/removeField";
import { removeFormTool } from "@/lib/agent/tools/removeForm";
import { removeModuleTool } from "@/lib/agent/tools/removeModule";
import { searchBlueprintTool } from "@/lib/agent/tools/searchBlueprint";
import { updateFormTool } from "@/lib/agent/tools/updateForm";
import { updateModuleTool } from "@/lib/agent/tools/updateModule";
import { validateAppTool } from "@/lib/agent/tools/validateApp";

const SHARED_TOOLS = [
	addFieldTool,
	addFieldsTool,
	addModuleTool,
	createFormTool,
	createModuleTool,
	editFieldTool,
	generateSchemaTool,
	generateScaffoldTool,
	getFieldTool,
	getFormTool,
	getModuleTool,
	removeFieldTool,
	removeFormTool,
	removeModuleTool,
	searchBlueprintTool,
	updateFormTool,
	updateModuleTool,
	validateAppTool,
];

export function registerNovaTools(server: McpServer, ctx: ToolContext): void {
	/* MCP-only tools. */
	registerGetAgentPrompt(server, ctx);
	registerListApps(server, ctx);
	registerGetApp(server, ctx);
	registerCreateApp(server, ctx);
	registerDeleteApp(server, ctx);
	registerCompileApp(server, ctx);
	registerUploadAppToHq(server, ctx);

	/* Shared tools — one source of truth with the chat-side SA. */
	for (const tool of SHARED_TOOLS) {
		registerSharedTool(server, tool, ctx);
	}
}

export function registerNovaPrompts(_server: McpServer): void {
	/* v1 has no standalone MCP prompts — the agent prompt surface lives
	 * on the get_agent_prompt tool. Kept as an empty hook so the route
	 * handler's registration call site stays stable if prompts are added
	 * later. */
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit && echo "✓"
```

If any shared-tool import fails, the corresponding Phase D extraction didn't land — go back and complete it.

- [ ] **Step 3: Commit**

```bash
git add lib/mcp/server.ts
git commit -m "feat(mcp): registerNovaTools wires up MCP-only tools + shared SA tools"
```

---

## Task G2: `/api/mcp` route with OAuth scope enforcement at the verify layer

Next.js convention puts the file at `app/api/mcp/route.ts`. `mcp-handler`'s default `basePath: "/api"` composes with the `/mcp` segment to match `url.pathname === "/api/mcp"` internally — so the handler dispatches correctly with no config changes from the library default.

**External URL stays `https://mcp.commcare.app/mcp`** — Phase A's middleware rewrites `/mcp` → `/api/mcp` on the MCP host. The external URL is clean; internals follow Next.js convention.

**Files:**
- Create: `app/api/mcp/route.ts`

- [ ] **Step 1: Write the route**

```ts
/**
 * Streamable HTTP MCP endpoint.
 *
 * File path follows Next.js convention (app/api/mcp/route.ts). External
 * URL is /mcp on mcp.commcare.app — middleware rewrites /mcp → /api/mcp.
 * mcp-handler's default basePath: "/api" composes with the /mcp segment
 * to produce the pathname it matches against internally.
 *
 * Request flow:
 *   1. mcpHandler verifies the bearer against local JWKS and the declared
 *      scopes. Missing/invalid token → 401 with WWW-Authenticate pointing
 *      at the authorization server so Claude Code can auto-discover.
 *      Missing required scope → 403.
 *   2. Inner createMcpHandler is invoked with the verified claims,
 *      registering tools bound to this user's id.
 *   3. MCP's JSON-RPC layer dispatches tool calls.
 *
 * Scope enforcement is at the VERIFY LAYER. `verifyAccessToken` checks the
 * bearer carries ALL declared scopes before any adapter runs. This replaces
 * per-handler requireScope calls — one source of truth, nothing to forget.
 */

import { createMcpHandler } from "mcp-handler";
import { mcpHandler } from "@better-auth/oauth-provider";
import { registerNovaPrompts, registerNovaTools } from "@/lib/mcp/server";
import { parseScopes } from "@/lib/mcp/scopes";
import type { JwtClaims } from "@/lib/mcp/types";

const handler = mcpHandler(
	{
		/* Real JWKS URL was captured in Phase B Task B3 Step 3 from the
		 * /.well-known/oauth-authorization-server metadata. If it differs
		 * from the default path below, update here before deploying. */
		jwksUrl: "https://commcare.app/api/auth/jwks",
		verifyOptions: {
			issuer: "https://commcare.app",
			audience: "https://mcp.commcare.app",
			/* Both scopes are required on every bearer for full tool access.
			 * If a future read-only client needs just nova.read, split this
			 * into two separate tool-mounts with different scope sets. */
			scopes: ["nova.read", "nova.write"],
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
			/* Default basePath: "/api" composes with /mcp internally. */
			{ basePath: "/api", maxDuration: 300 },
		)(req),
);

export { handler as GET, handler as POST, handler as DELETE };

export const maxDuration = 300;
```

- [ ] **Step 2: Local auth-wall smoke**

Dev server running. Middleware rewrite from Phase A in place:

```bash
curl -i -H "Host: mcp.commcare.app" -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

Expected: 401 with `WWW-Authenticate` header referencing the authorization server. 404 means the middleware rewrite isn't firing — check Phase A. 200 without auth means verify is broken — check the mcpHandler wiring.

- [ ] **Step 3: Commit**

```bash
git add app/api/mcp/route.ts
git commit -m "feat(mcp): /api/mcp route (external URL /mcp via middleware rewrite)"
```

---

## Task G3: End-to-end OAuth flow via Claude Code (load-bearing smoke)

**Files:** None — documented verification.

This is the first point the full OAuth + MCP + tool stack can run.

**Prerequisite:** Staging or production must be reachable via HTTPS (OAuth redirect URIs require it). Either:
- Deploy to a staging Cloud Run revision with a staging subdomain (e.g., `mcp-staging.commcare.app`), OR
- Use a tunnel (cloudflared/ngrok) pointed at `localhost:3000` and temporarily add the tunnel host to `HOSTNAME_ALLOWLIST` + `trustedOrigins`.

- [ ] **Step 1: Register the server with Claude Code**

```bash
claude mcp add --transport http nova https://mcp.commcare.app/mcp
```

Expected: Claude Code fetches `/.well-known/oauth-protected-resource`, discovers the AS, prompts for auth in the browser, shows the consent page with `nova.read` + `nova.write` scopes, user clicks Allow, token lands in Claude Code's credential store.

- [ ] **Step 2: Verify tool discovery**

`/mcp` in Claude Code:
- `nova` server listed, status: connected.
- Tool list includes all 25 tools.

- [ ] **Step 3: Read-path smoke**

```
"Call nova.list_apps"
```
Expected: `{"apps": [...]}`. No server-log errors.

- [ ] **Step 4: Write-path smoke**

```
"Create a Nova app called 'smoke test'"
```
Expected: `nova.create_app` returns `app_id`. Firestore shows the new doc owned by the authenticated user.

- [ ] **Step 5: Token refresh**

Wait past or shorten access-token TTL (default 1h). Next tool call should refresh transparently via `offline_access`.

- [ ] **Step 6: Scope enforcement**

Register a second OAuth client with only `nova.read` via manual DCR + token grant. Attempt a write tool call — expect a 403 at the verify layer, which Claude Code surfaces as `insufficient_scope`.

- [ ] **Step 7: Revocation**

`/mcp` → nova → Clear authentication. Server logs show `POST /api/auth/oauth2/revoke`. Next tool call re-prompts.

- [ ] **Step 8: Record outcome**

Append to `docs/superpowers/plans/notes/2026-04-21-nova-mcp-infra.md`:

```markdown
## End-to-end OAuth + MCP smoke (YYYY-MM-DD)

- Target: https://mcp.commcare.app/mcp (staging)
- Tool discovery: <pass/fail>
- read tool (list_apps): <pass/fail>
- write tool (create_app): <pass/fail>
- token refresh: <pass/fail>
- scope enforcement: <pass/fail>
- revocation: <pass/fail>
```

- [ ] **Step 9: Commit outcome**

```bash
git add docs/superpowers/plans/notes/2026-04-21-nova-mcp-infra.md
git commit --allow-empty -m "test(mcp): end-to-end OAuth + MCP smoke passed against staging"
```
