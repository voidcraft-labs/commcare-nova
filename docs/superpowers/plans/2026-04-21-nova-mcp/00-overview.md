# Nova MCP Implementation Plan — Overview

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Each phase file is a standalone ordered task list using checkbox (`- [ ]`) syntax.

**Goal:** Expose Nova's generation engine as a hosted MCP server at `mcp.commcare.app/mcp` with OAuth 2.1 auth, plus a Claude Code plugin whose skills orchestrate a dynamically-materialized `nova-architect` subagent that drives the MCP tools on the client's LLM budget.

**Architecture:** Extract each Solutions Architect tool into its own module in `lib/agent/tools/`, with a narrow `ToolExecutionContext` interface. Both the chat-side SA and the MCP server import and register the same tool modules — one source of truth, zero duplication. MCP adds surface-specific wrappers for OAuth scope + ownership, plus ~6 MCP-only tools (list/get/create/delete/compile/upload/agent-prompt). Auth uses Better Auth's `@better-auth/oauth-provider` plugin for OAuth 2.1 + DCR. The plugin skills call `nova.get_agent_prompt` to fetch a server-controlled agent definition, write it to `~/.claude/agents/nova-architect-{runId}.md`, then spawn a subagent via the Agent tool. The web chat route at `/api/chat` preserves identical behavior — the extraction is a refactor underneath, not a behavior change.

**Tech Stack:** Next.js 16, TypeScript strict, Better Auth + `@better-auth/oauth-provider`, `mcp-handler`, `@modelcontextprotocol/sdk`, Firestore, Cloud KMS, Zod, Vitest.

**Out of repo:** The `nova-plugin` and `nova-marketplace` packages live in separate GitHub repositories (documented in Phases I + J). Everything else lands in `/Users/braxtonperry/work/personal/code/commcare-nova`.

---

## Phase index

Phases are strictly ordered — later phases depend on earlier ones. Within a phase, tasks are also ordered.

| Phase | File | Scope |
|---|---|---|
| A | [phase-a-hostname-infrastructure.md](phase-a-hostname-infrastructure.md) | Edge middleware splits `commcare.app` / `mcp.commcare.app` / `docs.commcare.app` on one Cloud Run service. |
| B | [phase-b-oauth-plugin.md](phase-b-oauth-plugin.md) | `@better-auth/oauth-provider` + `jwt()` plugins; consent page; OAuth-AS + OIDC metadata; protected-resource metadata. |
| C | [phase-c-mcp-endpoint-skeleton.md](phase-c-mcp-endpoint-skeleton.md) | Event-source tagging + migration; shared `lib/mcp/types.ts`; `McpContext`; progress emitter; ownership + scope + error helpers; canonical tool-adapter template. |
| D | [phase-d-tool-extraction.md](phase-d-tool-extraction.md) | Extract each SA tool into `lib/agent/tools/<name>.ts` behind a narrow `ToolExecutionContext` interface. Refactor `solutionsArchitect.ts` to consume. Zero behavior change to chat. |
| E | [phase-e-mcp-adapters.md](phase-e-mcp-adapters.md) | Register shared tools on the MCP server via thin adapters. Add the 6 MCP-only tools (list, get, create, delete, compile, upload). |
| F | [phase-f-agent-prompt.md](phase-f-agent-prompt.md) | Server-side agent prompt renderer + `get_agent_prompt` tool. |
| G | [phase-g-route-handler.md](phase-g-route-handler.md) | `app/api/mcp/route.ts` + middleware rewrite `/mcp` → `/api/mcp` on the MCP host + `lib/mcp/server.ts` registration + end-to-end OAuth smoke. |
| H | [phase-h-dynamic-agent-smoke.md](phase-h-dynamic-agent-smoke.md) | Load-bearing verification that Claude Code picks up agent files written mid-session. |
| I | [phase-i-plugin.md](phase-i-plugin.md) | `nova-plugin` repo — six skills + manifest + MCP declaration. Skills mint `run_id` per invocation and use per-runId agent filenames. |
| J | [phase-j-marketplace.md](phase-j-marketplace.md) | `nova-marketplace` repo — GitHub-source marketplace pointer. |
| K | [phase-k-final-smoke.md](phase-k-final-smoke.md) | End-to-end: build + edit + compile + upload + web-UI regression check. |

---

## File structure (files touched)

### New files in `commcare-nova`

**Hostname routing (Phase A):**
- `middleware.ts`
- `lib/hostnames.ts`
- `lib/__tests__/hostnames.test.ts`
- `__tests__/middleware.test.ts`

**OAuth wiring (Phase B):**
- `app/.well-known/oauth-authorization-server/route.ts`
- `app/.well-known/openid-configuration/route.ts`
- `app/.well-known/oauth-protected-resource/route.ts` — one-liner via `oAuthProtectedResourceMetadata(auth)` helper from `better-auth/plugins`.
- `lib/auth-client.ts`
- `app/consent/page.tsx`
- `app/consent/ConsentForm.tsx`
- `scripts/verify-oauth-adapter.ts`

**MCP skeleton (Phase C):**
- `lib/mcp/types.ts` — shared types (`ToolContext`, `JwtClaims`).
- `lib/mcp/context.ts` — `McpContext` (MCP-variant of `GenerationContext`, implements `ToolExecutionContext`).
- `lib/mcp/progress.ts` — `notifications/progress` emitter.
- `lib/mcp/ownership.ts` — `requireOwnedApp`.
- `lib/mcp/errors.ts` — classified-error → MCP-result serializer.
- `lib/mcp/scopes.ts` — scope constants.
- `lib/mcp/__tests__/*.test.ts` — supporting unit tests.
- `scripts/migrate-event-source.ts` — one-shot backfill for historical event envelopes.

**Shared tool modules (Phase D):**
- `lib/agent/tools/<name>.ts` per extracted SA tool (~19 files).
- `lib/agent/toolExecutionContext.ts` — narrow interface both `GenerationContext` and `McpContext` implement.

**MCP adapters + MCP-only tools (Phase E):**
- `lib/mcp/tools/listApps.ts`
- `lib/mcp/tools/getApp.ts`
- `lib/mcp/tools/createApp.ts`
- `lib/mcp/tools/deleteApp.ts`
- `lib/mcp/tools/compileApp.ts`
- `lib/mcp/tools/uploadAppToHq.ts`
- `lib/mcp/adapters/sharedToolAdapter.ts` — adapts a shared `lib/agent/tools/<name>.ts` module to `server.tool(...)` with scope + ownership gates.
- `lib/agent/summarizeBlueprint.ts` — extracted from `buildSolutionsArchitectPrompt` so `get_app` and the SA prompt share one renderer.
- `lib/mcp/__tests__/*.test.ts` — per-adapter + per-MCP-only-tool unit tests.

**Agent prompt (Phase F):**
- `lib/mcp/prompts.ts`
- `lib/mcp/tools/getAgentPrompt.ts`
- `lib/mcp/__tests__/prompts.test.ts`
- `lib/mcp/__tests__/getAgentPrompt.test.ts`

**Route (Phase G):**
- `app/api/mcp/route.ts` — Next.js convention file path. `mcp-handler` uses `basePath: "/api"`.
- External URL is `https://mcp.commcare.app/mcp`. Middleware on the MCP host rewrites `/mcp` → `/api/mcp` (internal) so the external URL stays clean while internals follow convention.
- `lib/mcp/server.ts` — `registerNovaTools` + `registerNovaPrompts`.

### Modified files in `commcare-nova`

- `lib/auth.ts` — add `jwt({ disableSettingJwtHeader: true })` + `oauthProvider({...})` plugins; `disabledPaths: ["/token"]` at the root to prevent collision with `/oauth2/token`.
- `lib/log/types.ts` — add required `source: "chat" | "mcp"` on `MutationEvent` + `ConversationEvent` envelopes.
- `lib/log/writer.ts` — accept `source` in the constructor and stamp it on every envelope.
- `lib/agent/generationContext.ts` — thread `source: "chat"` through existing constructor; implement `ToolExecutionContext` via the extracted method names.
- `app/api/chat/route.ts` — pass `source: "chat"` when constructing `LogWriter`.
- `lib/agent/solutionsArchitect.ts` — pull tool definitions out into `lib/agent/tools/*`; factory just wires them up via the AI SDK `tool()` wrapper.
- `lib/agent/prompts.ts` — delegate blueprint-summary rendering to `lib/agent/summarizeBlueprint.ts`.
- `lib/db/apps.ts` — add `softDeleteApp(appId)`; filter `status: "deleted"` from `listApps`.
- `biome.json` — allowlist `app/api/mcp/**` + `lib/mcp/**` + `lib/agent/tools/**` for `@/lib/commcare` imports.
- `package.json` — add `@better-auth/oauth-provider`, `mcp-handler`, `@modelcontextprotocol/sdk`.

### New repos (Phases I + J)

- `github.com/dimagi/nova-plugin` — `.claude-plugin/plugin.json`, `.mcp.json`, `skills/{build,ship,edit,list,show,upload}/SKILL.md`, `README.md`.
- `github.com/dimagi/nova-marketplace` — `.claude-plugin/marketplace.json`, `README.md`.

---

## Execution notes

- **Run from the worktree.** All commands assume cwd is `.worktrees/feature-mcp/` unless noted otherwise. Worktree is on branch `feature/mcp`.
- **Biome + Lefthook.** Every commit runs lint + format via the pre-commit hook. Warnings and info count as open issues — fix the root cause, not the symptom, not by disable comment.
- **Type-check after each task.** Run `npx tsc --noEmit && echo "✓"` after each substantive change. A silent pass produces no output; `&& echo "✓"` forces a visible success.
- **Test pattern.** Shared-tool tests live under `lib/agent/__tests__/tools/` and assert behavior given a fake `ToolExecutionContext`. MCP adapter tests stub `@/lib/db/apps`, `@/lib/log/writer`, and any domain helpers; they assert scope enforcement, ownership enforcement, and that the shared-tool `execute` was called with the right args.
- **No application-level rate limiting on MCP.** Better Auth's existing rate limiting on `/api/auth/*` covers the auth plane (DCR, token, introspect, revoke). Tool calls are authenticated-only and match the existing Nova convention: `/api/chat`, `/api/commcare/upload`, and every other authenticated endpoint has no app-level rate limiting today. If abuse becomes a problem, the fix is cross-cutting — applied uniformly across Nova — not singled out on MCP.
- **Concurrency.** MCP tool calls are sequential from a single client (HTTP request/response; subagent tool calls serialize by nature). Existing mutation helpers return proper errors for out-of-order operations. No MCP-side concurrency guard, no `status: "generating"` flip, no `hasActiveGeneration` check — those are chat-specific (cost protection + web UI state sync) and don't apply.
- **Model references.** `SA_MODEL` maps to a Claude Code model slug via `mapModelToClaudeCode` (defined in Phase F). If `SA_MODEL` changes, the mapping handles it without a plugin release.
- **OAuth debugging.** Decode JWTs with `echo "<jwt>" | cut -d. -f2 | base64 -d | jq .` to inspect `sub`, `scope`, `aud`, `iss`, `exp`. All four must match for the MCP handler to accept the token.
