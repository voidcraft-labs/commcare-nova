# Nova MCP — Design Spec

**Date:** 2026-04-21
**Status:** Draft

---

## Problem

Nova's generation surface today is the web chat at `/api/chat`: session-cookie auth, SSE with live blueprint mutations, the browser as the only client. That surface is good at what it was built for — an interactive canvas where the user watches the agent build their app — and bad at everything else. Anything that wants to drive Nova programmatically (another LLM agent, a scripted workflow, a terminal-based developer who doesn't want the browser) currently has to either lie to the chat endpoint or wait for a new interface.

The underlying engine is already the right shape: `lib/agent/solutionsArchitect.ts` is an agent loop that calls structured tools to mutate a `BlueprintDoc`; `lib/commcare` compiles that doc to the wire formats HQ requires; `lib/db/apps` persists to Firestore with per-user ownership and a monthly spend cap; the validator + auto-fix loop reconciles. What's missing is a programmatic entrypoint, exposed as MCP tools so any LLM agent can drive the agent loop itself — on its own LLM budget — without needing to embed Nova's prompt or duplicate its logic.

## The product in one sentence

**Nova for Claude Code** is a plugin that turns Claude Code (or any MCP client) into a CommCare app builder, driving Nova's hosted MCP endpoint to build, edit, compile, and deploy apps.

## Goals

1. **Primitives on the server, reasoning on the client.** `mcp.commcare.app/mcp` exposes the mutation, validation, compile, and HQ upload primitives as MCP tools. The agent reasoning loop runs on the client side — inside a Claude Code subagent for plugin consumers, inside the consumer's own LLM stack for headless consumers. Nova's server never calls Anthropic.
2. **Single source of truth for the agent prompt.** The agent system prompt lives on the server and is fetched at skill-invoke time via dynamic context injection. Prompt iteration does not require a plugin release.
3. **Native Claude Code primitives, no custom protocol.** Plugin skill spawns one of two static `nova-architect-*` subagents via the Agent tool; the subagent self-fetches its real operating instructions from the server on its first tool call (`get_agent_prompt`). The plugin's `.mcp.json` declares the hosted server; OAuth handles auth. Every piece is documented Claude Code behavior.
4. **OAuth 2.1 with Dynamic Client Registration** for authentication. What every remote MCP of record uses (GitHub, Sentry, Notion, Stripe, Linear). First-class Claude Code support via `/mcp`. No API key paste, no settings page for key management, token refresh and revocation are the client's problem.
5. **Existing multi-tenant guards carry over.** Ownership, concurrency, fail-closed persistence, event log, HQ credential KMS encryption — reused without change. Spend cap is retired from this entrypoint because Nova no longer makes the LLM calls. Every event written from the MCP path tags `source: "mcp"` (vs `source: "chat"` from the web flow) so analytics can distinguish surfaces cleanly.
6. **Parallel to the web UI.** The chat route and browser canvas keep working exactly as they do today. MCP is an additional entrypoint.
7. **Two modes ship as two skills: `/nova:build` (interactive) and `/nova:ship` (autonomous).** Interactive lets the agent call Claude Code's native `AskUserQuestion` tool mid-build; the question surfaces to the main conversation, the user answers, the subagent resumes. Autonomous disallows `AskUserQuestion` at the subagent level and runs the agent against a prompt variant that instructs it to commit to defaults. Both share the same underlying primitive tools and agent loop.

## Non-goals

- **Server-side agent execution.** Nova does not call Anthropic on behalf of clients. Consumers bring their own LLM access.
- **MCP resources.** `nova://apps/{id}` / `nova://apps/{id}/ccz` are a natural fit for browsable blueprint + artifact data, but tool-based `get_app` / `compile_app` works on every client. Layering resources in later is additive and doesn't break the tool surface.
- **Per-key permission scopes.** Every OAuth session grants everything the user can do in the web UI. Scope restriction is additive later.
- **Replacing or migrating the chat route + web UI.** Parallel surfaces; no deprecation plan.
- **Agent that runs in the main conversation.** The plugin's skills spawn a dedicated `nova-architect` subagent via the Agent tool, keeping the agent's token-heavy blueprint editing out of the user's main conversation. The user's main conversation only sees the skill orchestration and the subagent's final summary.
- **Server-side MCP elicitation in v1.** `AskUserQuestion` on the client side covers the plugin path; direct MCP consumers bring their own interaction mechanism with their own LLM loop. MCP `elicitation/create` stays unused on Nova's server for now — it's additive later if a headless consumer asks for a server-driven question flow.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Plugin flow (Claude Code)                                               │
│                                                                          │
│   User types: /nova:build vaccine tracking app for rural clinics         │
│     │                                                                    │
│     ▼                                                                    │
│   Claude Code invokes the /nova:build skill INLINE in the main           │
│   conversation. The skill body invokes the Agent tool with               │
│   subagent_type: "nova:nova-architect-interactive"                       │
│   (or "nova:nova-architect-autonomous" for /nova:ship) and a             │
│   JSON bootstrap payload carrying mode, interactive, and (for            │
│   edits) app_id + task.                                                  │
│     │                                                                    │
│     ▼                                                                    │
│   The Agent tool boots the STATIC subagent shipped with the plugin      │
│   at agents/nova-architect-<mode>.md. Frontmatter is fixed at plugin    │
│   publish time: model, effort, maxTurns, and — critically —              │
│   the AskUserQuestion tool-permission gate (autonomous mode ships       │
│   with disallowedTools: [AskUserQuestion]; interactive mode doesn't).   │
│   The body is a short bootstrap stub.                                    │
│     │                                                                    │
│     ▼                                                                    │
│   On turn 0, the subagent parses the JSON payload and calls              │
│   mcp__plugin_nova_nova__get_agent_prompt(mode, interactive, app_id?).  │
│   The server renders the real operating instructions fresh (same        │
│   prompt the web chat route uses, with edit-mode blueprint summary      │
│   inlined) and returns them as a plain text block. The subagent         │
│   treats that text as its full system prompt for the rest of the run.   │
│   This keeps the server as the single source of truth for prompt        │
│   iteration — no plugin release needed to update the prompt body.       │
│     │                                                                    │
│     ▼                                                                    │
│   Subagent runs the agent loop. Tool calls go over MCP to               │
│   mcp.commcare.app/mcp with tool names prefixed                          │
│   `mcp__plugin_nova_nova__` (Claude Code's plugin-scoping convention):  │
│     mcp__plugin_nova_nova__generate_schema(...) → mutation applied      │
│     mcp__plugin_nova_nova__add_module(...)      → mutation applied      │
│     mcp__plugin_nova_nova__add_fields(...)      → mutation applied      │
│     mcp__plugin_nova_nova__validate_app(...)    → validator + auto-fix  │
│     (all persisted to Firestore, event log updated)                      │
│                                                                          │
│   In interactive mode, the subagent may call AskUserQuestion             │
│   when a design choice is ambiguous. The question passes through         │
│   to the main conversation; the user answers; the subagent resumes.      │
│   Autonomous mode physically cannot call AskUserQuestion — the           │
│   frontmatter disallowedTools gate blocks it at the tool-permission     │
│   layer, not as prompt guidance.                                         │
│     │                                                                    │
│     ▼                                                                    │
│   Subagent returns summary to the main conversation.                     │
│   User sees: app_id, blueprint summary, any errors.                      │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│  Direct MCP flow (any other LLM agent consumer)                          │
│                                                                          │
│   External LLM agent connects to mcp.commcare.app/mcp over HTTP+OAuth.   │
│   Agent fetches the prompt (via the `agent` MCP prompt or the GET).      │
│   Agent runs its own agent loop using whatever LLM access it has.           │
│   Same mutation / validation / compile / upload tools as above.          │
│   LLM tokens billed to the consumer's LLM provider, not Nova.            │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│  Web flow (unchanged)                                                    │
│                                                                          │
│   Browser → (SSE) → /api/chat → live blueprint mutations                 │
│   Session-cookie auth. Anthropic via Nova's server key.                  │
│   Spend cap applies.                                                     │
└──────────────────────────────────────────────────────────────────────────┘
```

**Shared across all three surfaces:**

- Mutation helpers in `lib/agent/blueprintHelpers.ts` (produce `Mutation[]`)
- `BlueprintDoc` persistence in Firestore via `lib/db/apps`
- Event log via `lib/log/writer`
- Validator + auto-fix in `lib/agent/validationLoop.ts`
- `lib/commcare` for `expandDoc`, `compileCcz`, `importApp`
- Per-user ownership (`loadAppOwner`) + concurrency guard (`hasActiveGeneration`) + KMS-encrypted HQ credentials (`getDecryptedCredentialsWithDomain`)

**What diverges per surface:** transport (SSE vs HTTP/JSON-RPC), input shape, output shape (streamed `data-*` events vs MCP tool responses), auth (session cookie vs OAuth access token), and who runs the agent loop (Nova's server vs the MCP client).

---

## The plugin

Distributed via a Nova-owned Claude Code marketplace at `voidcraft-labs/nova-marketplace`. Installed by the user with `/plugin marketplace add voidcraft-labs/nova-marketplace && /plugin install nova@nova-marketplace`.

### Plugin manifest (`.claude-plugin/plugin.json`)

```json
{
  "name": "nova",
  "version": "1.0.0",
  "description": "Build, edit, compile, and deploy CommCare apps from Claude Code",
  "author": { "name": "bperry", "email": "bperry@dimagi.com" },
  "homepage": "https://docs.commcare.app/mcp",
  "repository": "https://github.com/voidcraft-labs/nova-plugin",
  "license": "Apache-2.0"
}
```

### MCP server declaration (`.mcp.json`)

```json
{
  "mcpServers": {
    "nova": {
      "type": "http",
      "url": "https://mcp.commcare.app/mcp"
    }
  }
}
```

On first use, Claude Code discovers the authorization server by fetching `https://mcp.commcare.app/.well-known/oauth-protected-resource`, which points at `https://commcare.app` as the AS. Claude Code runs the OAuth 2.1 flow (Dynamic Client Registration) against `commcare.app`. The user completes the browser login; Claude Code stores the resulting token in its credential store and attaches it to subsequent requests to `mcp.commcare.app`. Token refresh is handled by Claude Code natively.

### Static bootstrap + self-fetch pattern

All three skills that drive the agent loop (`/nova:build`, `/nova:ship`, `/nova:edit`) use the same single-step pattern in their skill body. The skill runs **inline in the main conversation** (no `context: fork`):

1. **Invoke** — call the `Agent` tool with `subagent_type: "nova:nova-architect-interactive"` (or `"nova:nova-architect-autonomous"` for `/nova:ship`) and a JSON bootstrap payload as the prompt. The payload carries `mode`, `interactive`, optionally `app_id` (edits), and the user's free-form `task`.

The inline read-only skills (`/nova:list`, `/nova:show`, `/nova:upload`) call their MCP tool directly from the main conversation with no subagent spawn. Run grouping for those calls is server-derived per the "Tools exposed" section above.

The spawned subagent reads a **static agent file** shipped with the plugin (`agents/nova-architect-interactive.md` or `agents/nova-architect-autonomous.md`). Its frontmatter — `model: opus`, `effort: xhigh`, `maxTurns: 100`, the full `tools` allowlist, and the autonomous agent's `disallowedTools: [AskUserQuestion]` — is fixed at plugin-publish time. Its body is a short bootstrap stub instructing the subagent to parse the JSON payload and, on turn 0, call `mcp__plugin_nova_nova__get_agent_prompt(mode, interactive, app_id?)`. The server returns the real operating instructions as a plain text block; the subagent treats that text as its full system prompt for the rest of the run.

Why this shape (post-Phase H):

- **Server is the single source of truth for prompt body.** The body text is server-rendered per invocation, so prompt iteration on the server is picked up immediately without a plugin release. The one thing that ships with the plugin is frontmatter — which rarely changes.
- **Static frontmatter is required.** Claude Code memoizes agent definitions at session start (`utils/plugins/loadAgentsDir.ts`); the original plan (write `<plugin-root>/agents/nova-architect-{runId}.md` mid-session, then spawn) is structurally impossible because agent discovery doesn't re-scan inside a session. The Phase H probe confirmed this across both plugin-dir and `~/.claude/agents/` fallback paths. Static files are the only mechanism that actually works.
- **Auth is native.** `get_agent_prompt` is an MCP tool, authenticated by Claude Code's OAuth bearer automatically. No token paste, no `apiKeyHelper`, no shell-layer auth.
- **Autonomous mode enforcement is tool-level.** The autonomous agent file's frontmatter carries `disallowedTools: [AskUserQuestion]`, so the spawned subagent literally cannot call `AskUserQuestion`. Prompt-only guidance would be weaker.
- **Plugin-scoped tool names.** Claude Code scopes plugin-sourced MCP tools as `mcp__plugin_<pluginName>_<serverName>__<toolName>` (`utils/plugins/mcpPluginIntegration.ts#addPluginScopeToServers`). For this plugin that's `mcp__plugin_nova_nova__*` — every reference to a Nova tool in skills + agent files uses that form.
- **No run id on the wire.** Clients don't mint, supply, or observe a run id. The server derives grouping from app-doc state on every event-writing call — see the "Run grouping is server-derived" section above.

### Skill: `/nova:build` — interactive (`skills/build/SKILL.md`)

```yaml
---
name: build
description: Generate a CommCare app from a natural-language spec, asking the user clarifying questions when the intent is ambiguous. Use when the user wants a collaborative build.
argument-hint: <spec describing the app>
allowed-tools: Agent(nova:nova-architect-interactive)
---

# Task

Invoke the Agent tool with `subagent_type: "nova:nova-architect-interactive"` and this prompt:

   ```
   {
     "mode": "build",
     "interactive": true,
     "task": "$ARGUMENTS"
   }

   Follow your bootstrap: call mcp__plugin_nova_nova__get_agent_prompt
   with the mode/interactive above (no app_id in build mode), then
   build the CommCare app matching the task.

   When complete, report the app_id, a summary of modules and forms,
   and any validation notes.
   ```

Return whatever the subagent reports, verbatim.
```

### Skill: `/nova:ship` — autonomous (`skills/ship/SKILL.md`)

```yaml
---
name: ship
description: Generate a CommCare app from a natural-language spec, autonomously, without asking the user clarifying questions. Use when the user wants a one-shot build.
argument-hint: <spec describing the app>
allowed-tools: Agent(nova:nova-architect-autonomous)
---

# Task

Invoke the Agent tool with `subagent_type: "nova:nova-architect-autonomous"` and this prompt:

   ```
   {
     "mode": "build",
     "interactive": false,
     "task": "$ARGUMENTS"
   }

   Follow your bootstrap: call mcp__plugin_nova_nova__get_agent_prompt
   with the mode/interactive above (no app_id in build mode), then
   build the CommCare app matching the task autonomously. Make every
   design decision yourself.

   When complete, report the app_id, a summary of modules and forms,
   any validation notes, and the design decisions you made.
   ```

Return the subagent's report, verbatim.
```

### Skill: `/nova:edit` (`skills/edit/SKILL.md`)

Interactive by default (spawns the interactive subagent). A `/nova:edit-ship` autonomous variant can ship later if demand shows up; v1 only ships the interactive edit.

The instruction must be quoted when the skill is invoked (e.g., `/nova:edit abc123 "add a phone field to client registration"`). Skill argument substitution only supports `$ARGUMENTS` (full string) and `$N` (single positional); there's no shell-style "rest of args" expansion, so quoting produces a clean `$0` (app_id) + `$1` (full instruction).

```yaml
---
name: edit
description: Edit an existing CommCare app with a natural-language instruction. Asks clarifying questions when needed.
argument-hint: <app_id> "<instruction>"
allowed-tools: Agent(nova:nova-architect-interactive)
---

# Task

Invoke the Agent tool with `subagent_type: "nova:nova-architect-interactive"` and this prompt:

   ```
   {
     "mode": "edit",
     "interactive": true,
     "app_id": "$0",
     "task": "$1"
   }

   Follow your bootstrap: call mcp__plugin_nova_nova__get_agent_prompt
   with the mode/interactive/app_id above. The server inlines the
   app's blueprint summary into the returned text, so you boot with
   full edit context — do NOT call get_app as a separate step.
   Then apply the requested edit.

   When complete, report the modified blueprint summary.
   ```

Return the subagent's report, verbatim.
```

### Skill: `/nova:list` (`skills/list/SKILL.md`)

```yaml
---
name: list
description: List your Nova apps.
---

Call `mcp__plugin_nova_nova__list_apps`. The tool returns JSON `{ apps: [...] }` inside a text content block. Parse it and format as a markdown table: ID, Name, Status, Last Updated.
```

This skill runs inline in the main conversation because listing is cheap and the user likely wants to see the output in their current session to pick an `app_id`.

### Skill: `/nova:show` (`skills/show/SKILL.md`)

```yaml
---
name: show
description: Show the blueprint summary of a Nova app.
argument-hint: <app_id>
---

Call `mcp__plugin_nova_nova__get_app` with `app_id: "$ARGUMENTS"`. Present the returned markdown summary verbatim.
```

Also inline. Same reasoning.

### Skill: `/nova:upload` (`skills/upload/SKILL.md`)

```yaml
---
name: upload
description: Upload a Nova app to CommCare HQ.
argument-hint: <app_id> <domain> [app_name]
---

Call `mcp__plugin_nova_nova__upload_app_to_hq` with `app_id: "$0"`, `domain: "$1"`, and `app_name: "$2"` (omit the field entirely if $2 is empty). Report the resulting `hq_app_id` and `url`.
```

### Why static agent files — not dynamically written per invocation

v1 ships **two** static agent files in the plugin: `agents/nova-architect-interactive.md` and `agents/nova-architect-autonomous.md`. Both have identical bodies (a short bootstrap stub) and differ only in frontmatter: the autonomous variant carries `disallowedTools: [AskUserQuestion]`. The subagent's real operating instructions are fetched fresh from the server on turn 0 via `get_agent_prompt`.

This static-agent shape is a hard requirement, not a preference. Claude Code memoizes agent definitions at session start (`loadAgentsDir.ts:296` wraps the loader in lodash `memoize` keyed by cwd; `:713` reads `systemPrompt = content.trim()` once at parse time and closes over the literal string). There is no programmatic path to make new or overwritten agent files visible mid-session — Phase H confirmed this across both plugin-dir and `~/.claude/agents/` fallback paths, and `/reload-plugins` is a `LocalCommandCall` with no skill-layer invocation. The original plan (skill writes `<plugin-root>/agents/nova-architect-{runId}.md`, then spawns) was structurally impossible.

The split between static frontmatter and server-rendered body is the right division of responsibilities anyway:

- **Frontmatter** (model, effort, maxTurns, tool allowlist, the `AskUserQuestion` gate) rarely changes. When it does change, a plugin release is appropriate.
- **Body** (the operating instructions, blueprint framing, tool-discipline rules, completion contract) iterates constantly. Hosting it server-side means prompt iteration is immediate and applies to every future run.

A future `nova-architect` auto-delegation agent for natural-language prompts ("build me a CommCare app…" without typing `/nova:build`) can land additively later — a separate, thin agent that exists solely to match the intent and invoke the same skill.

### Why skills and not a single `/nova` command

Each command is a focused task with different tool needs and different invocation shape. A monolithic `/nova` that dispatches internally would either sacrifice the subagent fork (for `list`/`show`, which don't need it) or force it (for `list`, which doesn't).

---

## The hosted MCP endpoint

`mcp.commcare.app/mcp` — streamable HTTP MCP transport served by a Next.js route. The `mcp.commcare.app` hostname maps to the same Cloud Run service as the main web app; Next.js middleware inspects the hostname and restricts what the subdomain serves to just the MCP handler plus its `.well-known/oauth-protected-resource` metadata. Everything else on `mcp.commcare.app` returns 404. The MCP server is constructed with `createMcpHandler` from `mcp-handler` and wrapped by the `mcpHandler` helper from `@better-auth/oauth-provider`, which handles JWT bearer-token verification on every request. Authenticated via OAuth 2.1.

### Hostname layout

Three hostnames on the same Cloud Run service, separated by middleware:

| Hostname | Serves | Does not serve |
|---|---|---|
| `commcare.app` | Web app, `/api/auth/*` (Better Auth + OAuth AS), `/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration` | The MCP handler or its protected-resource metadata |
| `mcp.commcare.app` | `/mcp` (MCP handler — the `get_agent_prompt` tool lives here), `/.well-known/oauth-protected-resource` | Everything else (including any auth or web-app route) |
| `docs.commcare.app` | Documentation | Everything else |

Better Auth's session cookie is scoped to `commcare.app` only (no `crossSubDomainCookies` config). It never rides on requests to `mcp.commcare.app` or `docs.commcare.app`. The MCP endpoint only honors `Authorization: Bearer <jwt>`; if a session cookie were somehow attached, it would be ignored. This isolation is the point — the web session and the MCP bearer token live in completely separate auth planes and cannot contaminate each other.

### Authentication

**Better Auth's `@better-auth/oauth-provider` plugin.** Nova's existing Better Auth instance gets two additional plugins in `lib/auth.ts` — `jwt()` and `oauthProvider({...})` — which together turn it into a full OAuth 2.1 authorization server with OIDC compatibility and explicit MCP support. We do not write our own authorization server; the plugin provides:

- Authorization code flow with PKCE required (OAuth 2.1 baseline)
- Refresh token flow with `offline_access` scope
- JWT-signed access tokens (verified remotely via `/api/auth/jwks`) plus OIDC `id_token`
- RFC 7591 Dynamic Client Registration (`allowDynamicClientRegistration: true`), including `allowUnauthenticatedClientRegistration: true` for public clients — which is the path Claude Code takes when it first connects
- RFC 7662 introspection and RFC 7009 revocation endpoints
- RFC 8414 authorization server metadata at `/.well-known/oauth-authorization-server`
- OIDC discovery at `/.well-known/openid-configuration`
- Consent flow: user redirected to `/consent` after authentication; the page calls `authClient.oauth2.consent({ accept: true })` (which hits `/api/auth/oauth2/consent`) to complete the grant.
- Per-endpoint rate limiting on OAuth routes (defaults are sensible — keep them)
- Revocation via `/oauth2/revoke` which Claude Code calls when the user picks "Clear authentication" in its `/mcp` menu

**MCP tool-layer rate limiting** is a separate concern (the OAuth plugin's rate limits only cover `/api/auth/*`). The MCP handler wraps each tool invocation in a per-user-per-tool-per-minute limiter backed by Firestore. Defaults: `generate_schema` / `generate_scaffold` / `add_module` at 10/min; field mutations at 60/min; `compile_app` at 30/min; `upload_app_to_hq` at 10/min; reads (`list_apps` / `get_app`) at 120/min. Over-limit responses carry the same classified-error shape as other tool errors.

Plugin configuration (inside `lib/auth.ts`):

```ts
oauthProvider({
  loginPage: "/sign-in",
  consentPage: "/consent",
  validAudiences: ["https://mcp.commcare.app"],
  scopes: ["openid", "profile", "email", "offline_access", "nova.read", "nova.write"],
  allowDynamicClientRegistration: true,
  allowUnauthenticatedClientRegistration: true,
  clientRegistrationDefaultScopes: ["openid", "profile", "email", "offline_access", "nova.read", "nova.write"],
  clientRegistrationClientSecretExpiration: "30d",
})
```

Scopes split into `nova.read` and `nova.write`:

- `nova.read` — `list_apps`, `get_app`, `compile_app` (download a ccz or HQ JSON of your own app), `get_agent_prompt` (the turn-0 self-fetch bootstrap the plugin's static subagent uses). Safe for read-only consumers.
- `nova.write` — every blueprint mutation (`create_app`, `generate_schema`, `generate_scaffold`, `add_module`, `add_fields`, `add_field`, `edit_field`, `remove_field`, `update_module`, `update_form`, `create_form`, `remove_form`, `create_module`, `remove_module`, `validate_app`), plus `delete_app` (destructive but scoped to the user's own apps under soft-delete semantics), plus `upload_app_to_hq` (external deploy that still requires user-owned HQ credentials).

The Nova plugin requests both scopes by default at DCR time — `/nova:build`, `/nova:edit`, `/nova:ship` all need write. Future narrowly-scoped clients (a reporting agent, a dashboard) can register with just `nova.read`. `openid`/`profile`/`email`/`offline_access` are standard OIDC/OAuth scopes that come with the plugin.

Per-tool scope enforcement lives in the MCP handler: each tool declares its required scope, the handler checks the JWT's `scope` claim before dispatching. Tools called without the required scope return an MCP error whose content JSON carries `error_type: "insufficient_scope"`.

The plugin uses standard Better Auth schemas; running `npx @better-auth/cli generate` produces schema entries for four new tables (`oauthClient`, `oauthRefreshToken`, `oauthAccessToken`, `oauthConsent`) that the existing Firestore adapter (`better-auth-firestore`) reads via Better Auth's adapter-agnostic schema interface.

Better Auth's existing `auth_users` collection remains the identity source; the plugin joins tokens and consents to users via foreign key (`userId` → `user.id`) exactly as the admin plugin does today.

**MCP endpoint wiring.** The MCP route uses the plugin's `mcpHandler` helper, which verifies the `Authorization: Bearer <jwt>` header against the local JWKS endpoint and only invokes the inner handler when the token is valid:

```ts
// app/api/mcp/route.ts (sketch)
import { createMcpHandler } from "mcp-handler";
import { mcpHandler } from "@better-auth/oauth-provider";
import { registerNovaTools, registerNovaPrompts } from "@/lib/mcp/server";

const handler = mcpHandler(
  {
    jwksUrl: "https://commcare.app/api/auth/jwks",
    verifyOptions: {
      issuer: "https://commcare.app",
      audience: "https://mcp.commcare.app",
    },
  },
  (req, jwt) => createMcpHandler(
    (server) => {
      registerNovaTools(server, jwt.sub);   // jwt.sub is the Better Auth user id
      registerNovaPrompts(server);
    },
    { serverInfo: { name: "nova", version: "1.0.0" } },
    { basePath: "/api", maxDuration: 300 },
  )(req),
);

export { handler as GET, handler as POST, handler as DELETE };
```

The resource server metadata endpoint — required by MCP clients to discover the authorization server — is a small route that calls the plugin's resource client:

```ts
// app/.well-known/oauth-protected-resource/route.ts (sketch; served only on mcp.commcare.app)
import { serverClient } from "@/lib/server-client";

export const GET = async () =>
  Response.json(await serverClient.getProtectedResourceMetadata({
    resource: "https://mcp.commcare.app",
    authorization_servers: ["https://commcare.app"],
  }));
```

The authorization server metadata and OIDC discovery endpoints are one-liners from the plugin:

```ts
// app/.well-known/oauth-authorization-server/route.ts
import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { getAuth } from "@/lib/auth";
export const GET = oauthProviderAuthServerMetadata(getAuth());
```

```ts
// app/.well-known/openid-configuration/route.ts
import { oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider";
import { getAuth } from "@/lib/auth";
export const GET = oauthProviderOpenIdConfigMetadata(getAuth());
```

### Tools exposed

These mirror the agent's current tool set — the ones the agent calls during a build or edit. Each is a thin wrapper that validates input, loads the app by id (with ownership check), applies mutations via the existing helpers in `lib/agent/blueprintHelpers.ts`, persists to Firestore, writes to the event log, and returns a success string. No Anthropic calls.

**Meta / lifecycle:**
- `list_apps()` → `{ apps: [{ app_id, name, status, updated_at }] }`
- `get_app(app_id)` → `{ blueprint_summary: string }`
- `create_app(app_name?)` → `{ app_id }` — mints a new app doc in Firestore (fail-closed persistence happens here, before any agent work).
- `delete_app(app_id)` → `{ deleted: true, recoverable_until: <iso-8601> }` — **soft-delete**: sets `status: "deleted"` and `deleted_at: <timestamp>` on the app doc; the app is filtered out of `list_apps` and all other tools, but the blueprint + event log + HQ credentials are retained. A scheduled job hard-deletes soft-deleted apps 30 days after deletion. An agent-triggered accidental delete can be recovered by support within the window. Hard-delete is only triggered by the retention job, never by a tool call.

**Generation (build mode):**
- `generate_schema(app_id, spec)` — generates case model + fields; applies the resulting mutations.
- `generate_scaffold(app_id)` — generates modules and forms from the schema.
- `add_module(app_id, config)` — adds a module with its forms and fields.

**Editing (all modes):**
- `search_blueprint(app_id, query)` → text search across modules / forms / fields.
- `get_module(app_id, module_id)` → module + forms + fields summary.
- `get_form(app_id, form_id)` → form + fields summary.
- `get_field(app_id, field_path)` → single-field summary.
- `add_fields(app_id, parent_form_id, fields[])` — batch add.
- `add_field(app_id, parent_form_id, field)` — single add.
- `edit_field(app_id, field_path, updates)` — edit field properties.
- `remove_field(app_id, field_path)`
- `update_module(app_id, module_id, updates)`
- `update_form(app_id, form_id, updates)`
- `create_form(app_id, module_id, config)`
- `remove_form(app_id, form_id)`
- `create_module(app_id, config)`
- `remove_module(app_id, module_id)`

**Validation + deploy:**
- `validate_app(app_id)` → runs `runValidation` + the auto-fix loop; returns the final errors array (empty on success).
- `compile_app(app_id, format: "ccz" | "json")` → returns the compiled artifact (base64 for ccz, inline JSON for json).
- `upload_app_to_hq(app_id, domain, app_name?)` → resolves KMS-encrypted HQ creds, uploads, returns `{ hq_app_id, url }`.

**Input schemas** for all tools are generated from the same Zod source used by the existing agent tool-schema generator (`lib/agent/toolSchemaGenerator.ts`). Field-level schemas continue to come from `lib/domain/fields/*.ts`. No duplicate schema definitions.

### Run grouping is server-derived; the wire never carries a run id

Admin surfaces group event-log rows by a `run_id` the server derives from state it already observes — the app doc's existing `run_id` field plus its `updated_at` timestamp. Clients never supply a run id, never see one on responses, and never declare it on any tool schema. Accepting a client-minted id would mean trusting or validating arbitrary strings the caller could collide, malform, or use to pollute another user's grouping; the derivation closes that whole attack surface by keeping the id a server-only concern.

The derivation (`lib/mcp/deriveRunId` in `lib/mcp/runId.ts`) is a 30-minute sliding window: on every event-writing tool call, the server reads the app's current `run_id` + `updated_at`; if the app has been touched within the window, the call joins that run; otherwise the server mints a fresh UUID and persists it back onto the app doc (via `updateAppForRun` in `lib/db/apps.ts`), starting a new run. Read-only tools (`get_app`, `list_apps`, `compile_app`, `get_agent_prompt`, `delete_app`) don't write event-log rows and therefore don't derive — the grouping signal only matters where grouped rows exist.

Server-derived grouping was chosen over any client-supplied carrier because Claude Code's MCP client (`services/mcp/client.ts`) overwrites the request metadata bag on every outbound call — anything the subagent tried to pass there would be silently stripped before leaving the client. Keeping the id off the wire entirely sidesteps that constraint, and keeping it off the tool arguments avoids trusting arbitrary client-supplied strings as Firestore-grouping keys.

### `get_agent_prompt` — the self-fetch bootstrap tool

Special-purpose meta-tool called by the spawned subagent as its first tool use on every run. Scoped under `nova.read`.

- **Signature:** `get_agent_prompt(mode: "build" | "edit", interactive: boolean, app_id?: string) → text`
- **Return shape.** Plain MCP `text` content block — the rendered system-prompt body verbatim, to be treated as the subagent's full operating instructions for the rest of the run. No JSON wrapper, no frontmatter, no parse step on the hot path. (Frontmatter ships with the static agent file and cannot be server-driven because Claude Code memoizes agent definitions at session start — see the static-agent section above.)
- **`app_id` contract.** Required when `mode === "edit"`: the tool ownership-gates + loads the blueprint server-side and inlines `summarizeBlueprint(doc)` into the returned text so the spawned subagent boots with full edit context at turn 0 (exact parity with `/api/chat`'s edit mode). Missing `app_id` in edit mode surfaces as `error_type: "invalid_input"` with message text "edit mode requires app_id". Ignored in build mode — `mode` is the authoritative flag and a spurious id never triggers a Firestore round-trip. Ownership failures in edit mode collapse to `not_found` (IDOR hardening, same as every other app-scoped tool).
- **Prompt body.** Rendered server-side from the canonical source in `lib/mcp/prompts.ts` via `buildSolutionsArchitectPrompt` — the same renderer `/api/chat` uses. Build mode produces the build-framing prompt; edit mode with a populated `app_id` produces the `EDIT_PREAMBLE` framing plus an inlined `summarizeBlueprint(doc)` so the subagent already knows the app's structure at turn 0 (no `get_app` round-trip). An empty-modules doc (degenerate edit case before any generation has run) intentionally falls back to the build prompt while keeping the edit tool surface — the renderer's `moduleOrder.length > 0` check is the single source of truth for "is there anything to edit?". Interactivity shapes the `## Interaction Mode` block (interactive: use `AskUserQuestion` for genuine ambiguities; autonomous: commit to defaults and report choices).
- **Auth:** OAuth bearer, same as every other tool. `nova.read` scope is sufficient; this is a read, not a mutation.
- **Plugin-scoped call name.** Subagents spawned from the plugin call this tool as `mcp__plugin_nova_nova__get_agent_prompt` — Claude Code's plugin MCP naming convention (`mcp__plugin_<pluginName>_<serverName>__<toolName>`). Direct MCP consumers connecting without the plugin use whatever server name they mount under.
- **Rate limit:** bucketed at 120/min per user (same as other reads).

This is the only tool the spawned subagent calls before switching into the real agent loop. Every subsequent tool call goes against the mutation / validation / compile / upload primitives below.

### Request flow

Every MCP request:

1. Transport layer: HTTP POST or SSE GET per MCP streamable HTTP spec.
2. OAuth middleware validates the bearer token, resolves the user.
3. Tool handler dispatches by tool name.
4. Ownership check: `loadAppOwner(app_id)` must return the authenticated user for any tool that takes an `app_id`.
5. Concurrency guard: `hasActiveGeneration(user_id, app_id)` — allows concurrent reads, blocks concurrent writes to the same app.
6. Mutation helpers produce `Mutation[]`, applied via the existing pipeline (Firestore write, event log entry).
7. Response: structured MCP tool result + any progress notifications fired during execution.

### Progress notifications

Tools emit `notifications/progress` at meaningful events. The stage taxonomy piggybacks on the existing `deriveReplayChapters` chapter tags:

- `app_created`, `schema_generated`, `scaffold_generated`, `module_added`, `form_added`, `validation_started`, `validation_fix_applied`, `validation_passed`, `upload_started`, `upload_complete`

Each notification carries a human-readable `message` string formatted as `"[<stage>] <text>[ | <key>=<val>...]"`. Clients render the whole `message` to users; those that want structured event tracking parse the `[<stage>]` prefix and optional inline `key=val` pairs. The MCP-spec-required `progress` counter increments monotonically.

### Error handling

Classified errors via the existing `classifyError` helper, returned as MCP `isError: true` results whose `content[0].text` is a JSON-encoded `McpErrorPayload` (`{ error_type, message, app_id? }`). The existing fire-and-forget `failApp(appId, type)` path runs server-side on classified errors.

---

## Cost model

**Nova does not pay for any LLM inference from this entrypoint.**

- Plugin consumers: the agent loop runs inside a Claude Code subagent (forked context). Claude Code bills the tokens to the user's Claude Code subscription or API key. Nova's Anthropic key is never called.
- Direct MCP consumers: the agent loop runs inside whatever LLM stack the consumer brings. Same outcome — Nova only handles the mutation primitives.
- Nova's Firestore write costs, egress, and HQ upload proxying are the only infrastructure costs, and they're measured in cents per session at any realistic scale.

The monthly spend cap (`MONTHLY_SPEND_CAP_USD` in `lib/db/usage.ts`) remains in place for the web chat route, which still makes Anthropic calls on Nova's key. The MCP endpoint doesn't consult it — there's nothing to measure.

---

## Coexistence with the chat route and web UI

The chat route at `/api/chat` and the browser canvas UI continue to work exactly as they do today. Same transport, same auth, same streaming shape, same spend-cap semantics. The MCP endpoint is an additional entrypoint on top of the same shared core (mutation helpers, persistence, validator, compiler, HQ upload).

### Code reuse

- `lib/agent/blueprintHelpers.ts`, `lib/agent/validationLoop.ts`, `lib/commcare/*`, `lib/db/apps`, `lib/log/writer`, `lib/agent/toolSchemaGenerator.ts` — reused verbatim by both surfaces.
- `lib/agent/solutionsArchitect.ts` (the `ToolLoopAgent` construction) — only used by `/api/chat`. The MCP endpoint does not construct an Anthropic client; the agent loop is the client's responsibility.
- `lib/agent/generationContext.ts` — today it owns the SSE writer + `LogWriter` + `UsageAccumulator`. An MCP variant of the context is introduced that owns an MCP progress emitter instead of the SSE writer, with `LogWriter` unchanged and `UsageAccumulator` omitted (no usage to track).

### What's retired from the MCP path

The `UsageAccumulator` + monthly cap machinery is not invoked from the MCP endpoint. Concurrency, ownership, and the event log remain.

---

## Code layout

**New modules:**

- `app/api/mcp/route.ts` — streamable HTTP MCP transport, wrapped by the plugin's `mcpHandler` for JWT verification. Middleware rewrites `mcp.commcare.app/mcp` to `/api/mcp` so this route serves the user-facing URL.
- `lib/mcp/tools/getAgentPrompt.ts` — implements the `get_agent_prompt` MCP tool. Ownership-gates + loads the blueprint in edit mode (so the server can inline `summarizeBlueprint(doc)` into the returned system prompt), and calls into `lib/mcp/prompts.ts` to assemble a plain text response per mode + interactivity + optional `app_id`.
- `app/.well-known/oauth-authorization-server/route.ts` — one-line handler from `oauthProviderAuthServerMetadata`.
- `app/.well-known/openid-configuration/route.ts` — one-line handler from `oauthProviderOpenIdConfigMetadata`.
- `app/.well-known/oauth-protected-resource/route.ts` — resource server metadata for the MCP endpoint. Middleware ensures this is only reachable on `mcp.commcare.app`.
- `middleware.ts` — hostname-aware routing. Allowlists routes per hostname (`commcare.app`, `mcp.commcare.app`, `docs.commcare.app`), 404s anything off-allowlist. Integration test asserts each hostname's forbidden routes return 404.
- `app/consent/page.tsx` — OAuth consent UI. Reads `client_id` and `scope` from the query, renders the client name + scope list, calls `authClient.oauth2.consent({ accept: true })` on approve. Client helper handles the POST to `/api/auth/oauth2/consent`.
- `lib/mcp/server.ts` — registers tools and prompts on the MCP server instance.
- `lib/mcp/tools/` — one file per tool. Thin handlers over `lib/agent/blueprintHelpers.ts` + `lib/commcare/*`.
- `lib/mcp/prompts.ts` — canonical source of the agent system-prompt body. Exports a render function that takes `(interactive, editDoc?)` and returns the rendered prompt text for `get_agent_prompt`. Delegates to `buildSolutionsArchitectPrompt(editDoc)` (the same renderer `/api/chat` uses) so the MCP + web surfaces stay in lockstep, then appends the `## Interaction Mode` block per the `interactive` flag.
- `lib/mcp/context.ts` — MCP-variant of `GenerationContext` (progress emitter + `LogWriter`, no `UsageAccumulator`).
- `lib/mcp/progress.ts` — helpers for emitting `notifications/progress` with the stage taxonomy encoded into the spec-required `message` field.
- `lib/auth-client.ts` — Better Auth client with `oauthProviderClient` plugin; used by the consent page.
- `lib/server-client.ts` — resource-server client built with `oauthProviderResourceClient`; used by the protected-resource-metadata route.

**Modified existing:**

- `lib/auth.ts` — adds `jwt()` and `oauthProvider({...})` to the `plugins` array; adds `disabledPaths: ["/token"]` per plugin guidance to avoid collisions.
- `package.json` — adds `@better-auth/oauth-provider`, `mcp-handler`, `@modelcontextprotocol/sdk`.
- `lib/commcare/CLAUDE.md` — adds `app/api/mcp/*`, `lib/mcp/tools/*` to the allowlist for `noRestrictedImports`.

**Not built:**

- No custom OAuth authorization server, no custom token issuance, no custom JWKS endpoint, no custom `/oauth-sessions` settings page. All of that is either provided by `@better-auth/oauth-provider` out of the box or handled client-side by Claude Code (e.g., "Clear authentication" in `/mcp` calls the plugin's `/oauth2/revoke`).

**Plugin package** (separate repo at `github.com/voidcraft-labs/nova-plugin`, separate deploy):

- `nova-plugin/.claude-plugin/plugin.json`
- `nova-plugin/.mcp.json` — declares the `nova` MCP server at `https://mcp.commcare.app/mcp`
- `nova-plugin/agents/nova-architect-interactive.md` — static bootstrap agent; frontmatter with full tool allowlist (incl. `AskUserQuestion`) + model/effort/maxTurns, body instructs self-fetch via `mcp__plugin_nova_nova__get_agent_prompt` on turn 0
- `nova-plugin/agents/nova-architect-autonomous.md` — same body, frontmatter carries `disallowedTools: [AskUserQuestion]`
- `nova-plugin/skills/build/SKILL.md` — interactive build; single-step orchestration (spawn `nova:nova-architect-interactive` via Agent with a JSON bootstrap payload)
- `nova-plugin/skills/ship/SKILL.md` — autonomous build; same shape, spawns `nova:nova-architect-autonomous`
- `nova-plugin/skills/edit/SKILL.md` — interactive edit; two-step shape, spawns the interactive subagent with `mode: "edit"` + `app_id` in the bootstrap payload
- `nova-plugin/skills/list/SKILL.md`
- `nova-plugin/skills/show/SKILL.md`
- `nova-plugin/skills/upload/SKILL.md`

**Marketplace:**

- `nova-marketplace/.claude-plugin/marketplace.json` — points at the nova-plugin repo by GitHub source. Distributed via `claude plugin marketplace add voidcraft-labs/nova-marketplace`.

---

## Implementation phases

1. **Hostname infrastructure.** Add `mcp.commcare.app` and `docs.commcare.app` to Cloud Run domain mappings (same service for `commcare.app` and `mcp.commcare.app`; docs can go to the same service or a static host). Write `middleware.ts` that routes by hostname: normalize the `Host` header (strip trailing dot, strip explicit `:443` port), allowlist per-hostname paths, return 404 for anything off-list. Allowlist-default-deny for unknown hostnames (e.g., Cloud Run's internal `*-uc.a.run.app` generated host) — the middleware should route those to the main-app handler, not to `mcp.commcare.app` behavior. Integration tests assert: `/admin` on `mcp.commcare.app` 404s; `/mcp` on `commcare.app` 404s; trailing-dot hosts resolve correctly; Cloud Run internal hosts default to main-app behavior.
2. **Better Auth OAuth plugin wiring.** Three sub-steps:
   - **2a. Verify adapter compatibility (load-bearing).** Before committing to the plugin choice, stand up a disposable Better Auth project with `jwt()` + `oauthProvider()` against the `better-auth-firestore` adapter and confirm the adapter implements every hook the plugin needs (client registration, secret rotation, refresh token compound keys, transactional consent writes). If the community Firestore adapter doesn't cover the plugin's surface, either contribute the missing hooks upstream or fall back to a different adapter / storage strategy for the OAuth tables only. This is the biggest unknown in the spec; nothing downstream works if the adapter can't run the plugin's schema.
   - **2b. Plugin configuration.** Add `jwt()` and `oauthProvider({...})` to `lib/auth.ts` with `validAudiences: ["https://mcp.commcare.app"]`. Run `npx @better-auth/cli generate` to materialize the four new tables. Register the `.well-known/oauth-authorization-server` and `.well-known/openid-configuration` routes on `commcare.app`.
   - **2c. Verify JWKS endpoint path.** The spec hardcodes `jwksUrl: "https://commcare.app/api/auth/jwks"`, which is the probable path given Better Auth's `basePath: "/api/auth"`. Confirm the exact path with a live GET before wiring it into `mcpHandler`; adjust the spec + config if it differs.
3. **Consent page.** `app/consent/page.tsx` — reads `client_id` and `scope` from query, calls `auth.api.oauth2.publicClient` (or the prelogin variant) to display the client name + the requested scopes, calls `authClient.oauth2.consent({ accept: true })` on approve (the client helper POSTs to `/api/auth/oauth2/consent`). Defends against missing / tampered query params by returning a 400 if the in-flight authorization request can't be resolved.
4. **MCP endpoint skeleton.** `app/api/mcp/route.ts` using `mcpHandler` + `createMcpHandler`. Register stub tool handlers for all tools. Add the protected-resource metadata route at `app/.well-known/oauth-protected-resource/route.ts` (middleware-gated to `mcp.commcare.app` only). Verify tool discovery from Claude Code via `claude mcp add --transport http nova https://mcp.commcare.app/mcp` — the OAuth flow should fire on first tool call, consent page should render, token should land in Claude Code's credential store, and `/mcp` should list the stubbed tools.
5. **Primitive tool handlers.** Port the agent's current tool handler bodies to `lib/mcp/tools/*`. Each one validates input, ownership, concurrency; applies mutations via the existing helpers; persists; emits progress; returns the success string the agent already expects.
6. **`get_agent_prompt` tool + server-side prompt source.** `lib/mcp/prompts.ts` — canonical agent system-prompt renderer. `lib/mcp/tools/getAgentPrompt.ts` — the tool handler, scoped under `nova.read`, returns the rendered prompt text keyed by `(mode, interactive, app_id?)`. Edit mode requires `app_id` and inlines the blueprint summary server-side; build mode ignores `app_id`.
7. **Dynamic-agent discovery probe (load-bearing).** Before committing to a skill design, verify whether Claude Code picks up agent files written or overwritten mid-session. Outcome (Phase H): it does NOT. Claude Code memoizes agent definitions at session start in a lodash `memoize` closure keyed by cwd, and `/reload-plugins` is a `LocalCommandCall` not reachable from a skill. The mint-runId → write → spawn design is impossible. Skills must use static agent files shipped with the plugin; server-rendered content is injected via a turn-0 self-fetch, not via frontmatter writes.
8. **Plugin skills + static agents.** Build the plugin package: two static agents (`nova-architect-interactive`, `nova-architect-autonomous`) with plugin-published frontmatter and a short self-fetch bootstrap body, plus six skills (`build`, `ship`, `edit`, `list`, `show`, `upload`). Test via a local marketplace + `claude plugin install` + `/nova:ship "..."`. Confirm the subagent's first tool call is `mcp__plugin_nova_nova__get_agent_prompt`, the returned text becomes its operating instructions, `create_app` → `generate_schema` → `generate_scaffold` → `add_fields` → `validate_app` all run cleanly, `AskUserQuestion` passes through in interactive mode and is tool-level-blocked in autonomous mode, ownership + event log all fire.
9. **Marketplace.** Stand up the Nova marketplace repo at `voidcraft-labs/nova-marketplace`. Install instructions on `docs.commcare.app`.
10. **End-to-end smoke.** Generate, edit, compile, upload via the plugin from Claude Code. Verify the web UI continues to work unchanged.

Phase 1 is foundational and unblocks everything else. Phase 2 is the critical dependency for anything auth-related. Phases 4–6 can proceed in parallel once phases 1–3 land. Phase 7 is the other load-bearing gate — its outcome determines whether skills use static or dynamic agents (Phase H confirmed static). Phase 8 depends on 4–7. Phase 9 is packaging.
