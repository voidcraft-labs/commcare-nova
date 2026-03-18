# API Routes

## Error Handling

`lib/apiError.ts` — `ApiError` class with `status` and `details` fields + `handleApiError()` utility. Routes throw `ApiError` at the point of failure; a single `handleApiError` call in the catch block produces the response.

## POST /api/chat (`chat/route.ts`)

The single endpoint for all agent interaction. Creates `RunLogger`, `GenerationContext`, `MutableBlueprint`, then `createSolutionsArchitect()`.

**Input validation**: `chatRequestSchema` (from `lib/schemas/apiSchemas.ts`) validates our fields (`apiKey`, `pipelineConfig`, `blueprint`, etc.) via Zod `safeParse`. `messages` is typed as `UIMessage[]` from the AI SDK — not schema-validated.

**Body params** (from `useChat` body): `apiKey`, `pipelineConfig`, `blueprint` (for edits), `blueprintSummary` (for SA context), `runId` (for log continuation).

**Streaming**: Uses `createUIMessageStream` + `createAgentUIStream`. Server emits transient data parts via `ctx.emit()` which drive builder state on the client.

`maxDuration = 300` (5 min timeout for long generation runs).

## POST /api/compile (`compile/route.ts`)

Compiles blueprint → HQ import JSON → `.ccz`. Stores result in `.data/` via `store.ts`.

**Sub-routes:**
- `POST /api/compile/json` — returns HQ import JSON only, uses `ApiError` for validation failures
- `GET /api/compile/[id]/download` — downloads stored `.ccz` file

## POST /api/models (`models/route.ts`)

Proxy for Anthropic API model listing. Validates `{ apiKey }` via `modelsRequestSchema`. Returns latest version of each model family (Opus, Sonnet, Haiku). Returns proper HTTP status codes for auth failures (401) and upstream errors (502).
