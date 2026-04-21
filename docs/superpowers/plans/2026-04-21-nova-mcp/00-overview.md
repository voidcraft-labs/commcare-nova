# Nova MCP Implementation Plan — Overview

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Each phase file is a standalone ordered task list using checkbox (`- [ ]`) syntax.

**Goal:** Expose Nova's generation engine as a hosted MCP server at `mcp.commcare.app/mcp` with OAuth 2.1 auth, plus a Claude Code plugin whose skills orchestrate a dynamically-materialized `nova-architect` subagent that drives the MCP tools on the client's LLM budget.

**Architecture:** Thin MCP tool wrappers over the existing mutation helpers (`lib/agent/blueprintHelpers.ts`), compiler (`lib/commcare/*`), validator (`lib/agent/validationLoop.ts`), and persistence (`lib/db/apps`) — reasoning happens on the client, not the server. Auth uses Better Auth's `@better-auth/oauth-provider` plugin for OAuth 2.1 + DCR. The plugin skills call `nova.get_agent_prompt` to fetch a server-controlled agent definition, write it to `~/.claude/agents/nova-architect.md`, then spawn a subagent via the Agent tool. The web chat route at `/api/chat` is untouched.

**Tech Stack:** Next.js 16, TypeScript strict, Better Auth + `@better-auth/oauth-provider`, `mcp-handler`, `@modelcontextprotocol/sdk`, Firestore, Cloud KMS, Zod, Vitest.

**Out of repo:** The `nova-plugin` and `nova-marketplace` packages live in separate GitHub repositories (documented in Phases H + I). Everything else lands in `/Users/braxtonperry/work/personal/code/commcare-nova`.

---

## Phase index

Phases are strictly ordered — later phases depend on earlier ones. Within a phase, tasks are also ordered.

| Phase | File | Scope |
|---|---|---|
| A | [phase-a-hostname-infrastructure.md](phase-a-hostname-infrastructure.md) | Edge middleware splits `commcare.app` / `mcp.commcare.app` / `docs.commcare.app` on one Cloud Run service. |
| B | [phase-b-oauth-plugin.md](phase-b-oauth-plugin.md) | `@better-auth/oauth-provider` + `jwt()` plugins; consent page; OAuth-AS + OIDC metadata; protected-resource metadata. |
| C | [phase-c-mcp-endpoint-skeleton.md](phase-c-mcp-endpoint-skeleton.md) | Event-source tagging in `LogWriter`; `McpContext`; progress emitter; ownership / scope / rate-limit / error helpers; shared `lib/mcp/types.ts`. |
| D | [phase-d-primitive-tools.md](phase-d-primitive-tools.md) | 25 primitive tool handlers under `lib/mcp/tools/`. |
| E | [phase-e-agent-prompt.md](phase-e-agent-prompt.md) | Server-side agent prompt renderer + `get_agent_prompt` tool. |
| F | [phase-f-route-handler.md](phase-f-route-handler.md) | `app/api/mcp/route.ts` + `lib/mcp/server.ts` registration + end-to-end OAuth smoke. |
| G | [phase-g-dynamic-agent-smoke.md](phase-g-dynamic-agent-smoke.md) | Load-bearing verification that Claude Code picks up agent files written mid-session. |
| H | [phase-h-plugin.md](phase-h-plugin.md) | `nova-plugin` repo — six skills + manifest + MCP declaration. |
| I | [phase-i-marketplace.md](phase-i-marketplace.md) | `nova-marketplace` repo — GitHub-source marketplace pointer. |
| J | [phase-j-final-smoke.md](phase-j-final-smoke.md) | End-to-end: build + edit + compile + upload + web-UI regression check. |

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
- `app/.well-known/oauth-protected-resource/route.ts`
- `lib/server-client.ts`
- `lib/auth-client.ts`
- `app/consent/page.tsx`
- `app/consent/ConsentForm.tsx`
- `scripts/verify-oauth-adapter.ts`

**MCP skeleton (Phase C):**
- `lib/mcp/types.ts` — shared types (`ToolContext`, etc.) used by every tool.
- `lib/mcp/context.ts` — `McpContext` (MCP-variant of `GenerationContext`).
- `lib/mcp/progress.ts` — `notifications/progress` emitter.
- `lib/mcp/rateLimit.ts` — per-user-per-tool-per-minute limiter.
- `lib/mcp/ownership.ts` — `requireOwnedApp` + concurrency guard.
- `lib/mcp/errors.ts` — classified-error → MCP-result serializer.
- `lib/mcp/scopes.ts` — scope constants + `requireScope`.
- `lib/mcp/__tests__/*.test.ts` — supporting unit tests.

**MCP tools (Phase D):**
- `lib/mcp/tools/listApps.ts`
- `lib/mcp/tools/getApp.ts`
- `lib/mcp/tools/createApp.ts`
- `lib/mcp/tools/deleteApp.ts`
- `lib/mcp/tools/generateSchema.ts`
- `lib/mcp/tools/generateScaffold.ts`
- `lib/mcp/tools/addModule.ts`
- `lib/mcp/tools/searchBlueprint.ts`
- `lib/mcp/tools/getModule.ts`
- `lib/mcp/tools/getForm.ts`
- `lib/mcp/tools/getField.ts`
- `lib/mcp/tools/addFields.ts`
- `lib/mcp/tools/addField.ts`
- `lib/mcp/tools/editField.ts`
- `lib/mcp/tools/removeField.ts`
- `lib/mcp/tools/updateModule.ts`
- `lib/mcp/tools/updateForm.ts`
- `lib/mcp/tools/createForm.ts`
- `lib/mcp/tools/removeForm.ts`
- `lib/mcp/tools/createModule.ts`
- `lib/mcp/tools/removeModule.ts`
- `lib/mcp/tools/validateApp.ts`
- `lib/mcp/tools/compileApp.ts`
- `lib/mcp/tools/uploadAppToHq.ts`
- `lib/mcp/__tests__/*.test.ts` — per-tool unit tests.

**Agent prompt (Phase E):**
- `lib/mcp/prompts.ts`
- `lib/mcp/tools/getAgentPrompt.ts`
- `lib/mcp/__tests__/prompts.test.ts`
- `lib/mcp/__tests__/getAgentPrompt.test.ts`

**Route (Phase F):**
- `app/api/mcp/route.ts`
- `lib/mcp/server.ts` — `registerNovaTools` + `registerNovaPrompts`.

### Modified files in `commcare-nova`

- `lib/auth.ts` — add `jwt()` + `oauthProvider({...})` plugins.
- `lib/log/types.ts` — add `source: "chat" | "mcp"` on `MutationEvent` + `ConversationEvent`.
- `lib/log/writer.ts` — accept + stamp `source` on every envelope.
- `lib/agent/generationContext.ts` — thread `source: "chat"` through existing call sites.
- `app/api/chat/route.ts` — pass `source: "chat"` when constructing `LogWriter`.
- `lib/db/apps.ts` — add `softDeleteApp(appId)`; filter `status: "deleted"` from `listApps`.
- `biome.json` — allowlist `app/api/mcp/**` + `lib/mcp/**` for `@/lib/commcare` imports.
- `package.json` — add `@better-auth/oauth-provider`, `mcp-handler`, `@modelcontextprotocol/sdk`.

### New repos (Phases H + I)

- `github.com/dimagi/nova-plugin` — `.claude-plugin/plugin.json`, `.mcp.json`, `skills/{build,ship,edit,list,show,upload}/SKILL.md`, `README.md`.
- `github.com/dimagi/nova-marketplace` — `.claude-plugin/marketplace.json`, `README.md`.

---

## Execution notes

- **Run from the worktree.** All commands assume cwd is `.worktrees/feature-mcp/` unless noted otherwise. Worktree is on branch `feature/mcp`.
- **Biome + Lefthook.** Every commit runs lint + format via the pre-commit hook. Warnings and info count as open issues — fix the root cause, not the symptom, not by disable comment.
- **Type-check after each task.** Run `npx tsc --noEmit && echo "✓"` after each substantive change. A silent pass produces no output; `&& echo "✓"` forces a visible success.
- **Test pattern.** MCP tool tests stub `@/lib/db/apps`, `@/lib/log/writer`, and `../rateLimit`. For tools that call `lib/agent/*` or `lib/commcare/*`, stub those too — tool tests verify composition, not the helpers themselves.
- **Model references.** `SA_MODEL` maps to a Claude Code model slug via `mapModelToClaudeCode` (defined in Phase E). If `SA_MODEL` changes, the mapping handles it without a plugin release.
- **Do not touch the SA agent.** Per repo memory: do not modify SA tool schemas or the SA system prompt body without explicit permission. This plan only ADDS a server-side renderer (`lib/mcp/prompts.ts`) that calls `buildSolutionsArchitectPrompt` — it does not modify the existing prompt source.
- **OAuth debugging.** Decode JWTs with `echo "<jwt>" | cut -d. -f2 | base64 -d | jq .` to inspect `sub`, `scope`, `aud`, `iss`, `exp`. All four must match for the MCP handler to accept the token.
