# lib/agent — LLM-facing agent layer

Owns every module the Solutions Architect reaches into during generation or edit. No other directory imports Anthropic, renders the SA system prompt, or generates tool schemas.

## Boundary rule

External consumers (`app/api/chat/route.ts`, `app/api/compile/route.ts`, `components/chat/ChatSidebar.tsx`) import from `@/lib/agent/*` entry points — never from the individual files. The LLM wire format (CommCare-flavored tool argument names: `type`, `validation`, `case_property_on`) lives here and nowhere else; internal code downstream of a mutation emission always sees domain names (`kind`, `validate`, `case_property`).

## What lives here

- `solutionsArchitect.ts` — the one `ToolLoopAgent` factory. Owns the SA's internal `BlueprintDoc` for the lifetime of a request and emits fine-grained mutations for every tool call.
- `prompts.ts` — system prompt + blueprint summary renderer. "Field" everywhere except where the literal refers to CommCare's platform vocabulary (XForm element names, XPath `#form/` references, tool names like `addQuestions`).
- `toolSchemaGenerator.ts` + `toolSchemas.ts` — generate today's hand-written SA tool schemas from `fieldRegistry`. Mode `"flat-sentinels"` is the only mode shipped; the mode parameter exists for the future per-type flip.
- `generationContext.ts` — shared wrapper around the Anthropic client, SSE stream writer, `LogWriter` (event log), and `UsageAccumulator` (cost). Owns `emitMutations`, `emitConversation`, `emitError`, and the shared `handleAgentStep(step, label)` helper used by the SA's `onStepFinish` callback. The only sanctioned way to write a doc-mutating stream event and the only way to write an agent-side log event.
- `validationLoop.ts`, `autoFixer.ts`, `errorClassifier.ts` — post-generation CommCare validation + fix loop. Emits fix mutations through `emitMutations`.
- `blueprintHelpers.ts` — pure `Mutation[]` builders the SA calls from its tool handlers (`addFieldMutations`, `setScaffoldMutations`, `renameFieldMutations`, etc.).
- `contentProcessing.ts` — flat SA-format question stripping, case-property defaulting, and tree-building. Agent-specific; moved out of `lib/schemas/`.

The legacy wire-event translator (formerly `mutationMapper.ts` here) now lives at `scripts/migrate/legacy-event-translator.ts` — it has no production callers and exists only to back-fill historical log entries during the one-time logs → events migration.

## The write surface (server side)

The SA computes `Mutation[]` internally (via the helpers in `blueprintHelpers.ts`), applies them to its own doc via Immer `produce`, and emits them on the SSE stream via `ctx.emitMutations(mutations, stage?)`. Clients of that stream (the interactive builder) receive `data-mutations` events and feed the payload straight into `docStore.applyMany(mutations)` — no translation, no reconstruction. The agent and the user speak the same mutation API.

`data-done` still carries the full `PersistableDoc` at the end of `validateApp` because validation autofixes can produce opaque deltas; the final reconciliation there is cheaper than threading a mutation trail through the fix registry. Nothing else emits full docs on the live path.

## SA prompt caching

Request-level `cacheControl: { type: 'ephemeral' }` in the provider options. Anthropic automatically places the breakpoint on the last cacheable block and advances it as the conversation grows — the system prompt stays cached across requests within a session.

Cache TTL is 5 minutes. The route uses a client-reported timestamp to choose the message strategy: within the window, full history is sent; after expiry, only the last user message goes (one-shot edit). Edit-vs-build mode is a separate decision — see root CLAUDE.md.

## Provider options shape (Opus 4.7)

SA shape: `{ cacheControl, thinking: { type: 'adaptive', display: 'summarized' }, effort }`. `effort` is a **top-level** provider option (sibling of `thinking`), not nested inside it — the AI SDK's Zod schema silently strips misplaced fields, so a misplaced field appears to work and silently doesn't reach the wire. `display: 'summarized'` is required for human-readable thinking summaries on Opus 4.7. Always type provider options as `AnthropicProviderOptions`, never `Record<string, JSONValue>`.

## Two tool groups: generation + shared

Tools split into a generation set (build mode only: `generateSchema`, `generateScaffold`, `addModule`) and a shared set (all modes: `askQuestions`, `searchBlueprint`, `getModule`, `getForm`, `getQuestion`, `addQuestions`, `addQuestion`, `editQuestion`, `removeQuestion`, `updateModule`, `updateForm`, `createForm`, `removeForm`, `createModule`, `removeModule`, `validateApp`). When the app already exists, generation tools are excluded. Mutation tools return human-readable success strings, not JSON metadata, so the SA trusts its own edits without re-reading the blueprint.
