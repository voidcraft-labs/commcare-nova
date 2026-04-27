# lib/agent — LLM-facing agent layer

Owns every module the Solutions Architect reaches into during generation or edit. No other directory imports Anthropic, renders the SA system prompt, or generates tool schemas.

## Boundary rule

External consumers (`app/api/chat/route.ts`, `app/api/compile/route.ts`, `components/chat/ChatSidebar.tsx`) import from `@/lib/agent/*` entry points — never from individual implementation files.

**The SA speaks domain vocabulary end-to-end.** Tool names, tool arguments, tool return shapes, and the system prompt all use domain names (`field`, `kind`, `validate`, `validate_msg`, `case_property_on`). There is no CommCare→domain translation layer anywhere in this directory — SA tool args feed directly into `blueprintHelpers.ts` reducers.

The case-type pointer is `case_property_on` (disambiguating against the still-present `CasePropertyMapping.case_property` slot in `lib/domain/blueprint.ts`, which holds a property name). The `_on` suffix is load-bearing: it forces the prepositional reading "the case [type] this property is on," which keeps the SA from treating its value as a property name. Without the suffix the SA reads the value as a property name and prefixes field ids with the case-type name to "disambiguate," wasting tokens and corrupting field identity.

CommCare wire terms live at one genuine boundary outside `lib/agent/`: `lib/commcare/` (XForm emission, HQ JSON expander, validator, suite-entry derivation). `validateAndFix` feeds `BlueprintDoc` through the validator + `expandDoc` directly — no wire-format round-trip inside the agent layer.

## What lives here

- `solutionsArchitect.ts` — the one `ToolLoopAgent` factory. Owns the SA's internal `BlueprintDoc` for the lifetime of a request and emits fine-grained mutations for every tool call.
- `prompts.ts` — composes the mode-specific (build vs. edit) SA system prompt. CommCare XForm terms (e.g. `jr:`, `#form/`, XPath function names) still appear where the SA genuinely needs them.
- `summarizeBlueprint.ts` — domain-vocabulary renderer that walks `BlueprintDoc` and produces the compact text both `prompts.ts` (edit-mode summary) and the MCP `get_app` tool share.
- `toolSchemaGenerator.ts` — generates the three field-mutation tool schemas (`addFieldsItemSchema`, `addFieldSchema`, `editFieldUpdatesSchema`) from `fieldRegistry` + `fieldKinds`. Per-kind `saDocs` flows through into the `kind` enum description. The 8-optional ceiling on the batch-item schema is met by two patterns: required-with-sentinel for universal keys (`label`/`required`) and nested-object optionals for grouped feature configs (`validate: { expr, msg? }`, `repeat: { mode, count?, ids_query? }`). Each nested object consumes one slot regardless of its inner field count.
- `toolSchemas.ts` — materializes the generator output once and exposes the stable Zod nodes the SA + `scripts/test-schema.ts` reuse.
- `scaffoldSchemas.ts` — describe-rich input schemas for the initial-build generation tools (`generateSchema`, `generateScaffold`, `addModule`). Separate from `toolSchemas.ts` because these describe whole-app structure, not per-field edits.
- `generationContext.ts` — shared wrapper around the Anthropic client, SSE stream writer, `LogWriter` (event log), and `UsageAccumulator` (cost). Implements the shared `ToolExecutionContext` contract (`recordMutations`, `recordConversation`) on top of chat-specific internals (`emitMutations`, `emitConversation`, `emitError`) plus the shared `handleAgentStep(step, label)` helper used by the SA's `onStepFinish` callback. The only sanctioned way to write a doc-mutating stream event and the only way to write an agent-side log event.
- `validationLoop.ts`, `autoFixer.ts`, `errorClassifier.ts` — post-generation CommCare validation + fix loop. Takes `ToolExecutionContext` (not the concrete `GenerationContext`) so the same loop runs on the SA chat surface and the MCP adapter; emits fix mutations through `ctx.recordMutations`.
- `blueprintHelpers.ts` — pure `Mutation[]` builders the SA calls from its tool handlers (`addFieldMutations`, `setScaffoldMutations`, `renameFieldMutations`, etc.).
- `contentProcessing.ts` — sentinel stripping (`stripEmpty`) + case-type default merging (`applyDefaults`) + flat-to-discriminated reshape (`flatFieldToField`) for the `addFields` input. Domain-vocab throughout; case-type metadata (which uses CommCare-flavored `validation`/`validation_msg` on its property shape) is translated onto the field's nested `validate: { expr, msg? }` object at this one boundary. The reshape also flattens the SA's nested `repeat: { mode, count?, ids_query? }` into the schema's discriminated-union form (`repeat_mode` + variant-specific `repeat_count` or `data_source`). `unescapeXPath` is exported because `editPatchToFieldPatch` in `tools/editField.ts` needs the same XPath-entity normalization the add path applies.

## The write surface (server side)

The SA computes `Mutation[]` internally (via the helpers in `blueprintHelpers.ts`), applies them to its own doc via Immer `produce`, and persists them through the shared tool-execution contract via `ctx.recordMutations(mutations, doc, stage?)`. Clients of that stream (the interactive builder) receive `data-mutations` events and feed the payload straight into `docStore.applyMany(mutations)` — no translation, no reconstruction. The agent and the user speak the same mutation API.

`data-done` still carries the full `PersistableDoc` at the end of `validateApp` because validation autofixes can produce opaque deltas; the final reconciliation there is cheaper than threading a mutation trail through the fix registry. Nothing else emits full docs on the live path.

## SA prompt caching

Request-level `cacheControl: { type: 'ephemeral' }` in the provider options. Anthropic automatically places the breakpoint on the last cacheable block and advances it as the conversation grows — the system prompt stays cached across requests within a session.

Cache TTL is 5 minutes. The route uses a client-reported timestamp to choose the message strategy: within the window, full history is sent; after expiry, only the last user message goes (one-shot edit). Edit-vs-build mode is a separate decision — see root CLAUDE.md.

## Provider options shape (Opus 4.7)

SA shape: `{ cacheControl, thinking: { type: 'adaptive', display: 'summarized' }, effort }`. `effort` is a **top-level** provider option (sibling of `thinking`), not nested inside it — the AI SDK's Zod schema silently strips misplaced fields, so a misplaced field appears to work and silently doesn't reach the wire. `display: 'summarized'` is required for human-readable thinking summaries on Opus 4.7. Always type provider options as `AnthropicProviderOptions`, never `Record<string, JSONValue>`.

## Two tool groups: generation + shared

Tools split into a generation set (build mode only: `generateSchema`, `generateScaffold`, `addModule`) and a shared set (all modes: `askQuestions`, `searchBlueprint`, `getModule`, `getForm`, `getField`, `addFields`, `addField`, `editField`, `removeField`, `updateModule`, `updateForm`, `createForm`, `removeForm`, `createModule`, `removeModule`, `validateApp`). When the app already exists, generation tools are excluded. Mutation tools return human-readable success strings, not JSON metadata, so the SA trusts its own edits without re-reading the blueprint.

## Shared-tool return contract

Every `lib/agent/tools/<name>.ts` `execute` returns one of three tagged shapes (`tools/common.ts` + `tools/validateApp.ts`):

- `MutatingToolResult<R>` — `{ kind: "mutate", mutations, newDoc, result }`. Tool body has already persisted via `ctx.recordMutations` before returning; `result` is the LLM-facing payload.
- `ReadToolResult<R>` — `{ kind: "read", data }`. Pure read, no persistence.
- `ValidateAppResult` — `{ kind: "validate", success, doc, hqJson?, errors? }`. The fix loop persists internally; the wrapper unconditionally advances its working doc.

The `kind` discriminator is the contract two consumers dispatch on:
- Chat-side `wrapMutating` / `wrapRead` in `solutionsArchitect.ts` destructure the shape and surface only the inner payload to the AI SDK tool.
- MCP `projectResult` in `lib/mcp/adapters/sharedToolAdapter.ts` switches on `kind` to project to the wire envelope.

Adding a new shared tool: pick a shape, return it tagged. A future fourth shape requires updating both consumers — the exhaustive `switch` in `projectResult` is the compile-time tripwire.
