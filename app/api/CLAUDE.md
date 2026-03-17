# API Routes

## POST /api/chat (`chat/route.ts`)

The single endpoint for all agent interaction. Creates `RunLogger`, `GenerationContext`, `MutableBlueprint`, then `createSolutionsArchitect()`.

**Body params** (from `useChat` body): `apiKey`, `pipelineConfig`, `blueprint` (for edits), `blueprintSummary` (for SA context), `runId` (for log continuation).

**Streaming**: Uses `createUIMessageStream` + `createAgentUIStream`. Server emits transient data parts via `ctx.emit()` which drive builder state on the client.

`maxDuration = 300` (5 min timeout for long generation runs).

## POST /api/compile (`compile/route.ts`)

Compiles blueprint → HQ import JSON → `.ccz`. Stores result in `.data/` via `store.ts`.

**Sub-routes:**
- `POST /api/compile/json` — returns HQ import JSON only
- `GET /api/compile/[id]/download` — downloads stored `.ccz` file

## POST /api/models (`models/route.ts`)

Proxy for Anthropic API model listing. Takes `{ apiKey }`, returns latest version of each model family (Opus, Sonnet, Haiku). Used by settings page dropdowns.
