# lib/agent — LLM-facing agent layer

Owns every module the Solutions Architect reaches into during generation or edit. No other directory imports Anthropic, renders the SA system prompt, or generates tool schemas. External consumers import from `@/lib/agent/*` entry points, never implementation files.

## Domain vocabulary end-to-end

Tool names, arguments, return shapes, and the system prompt all use domain names. There is no CommCare→domain translation layer in this directory — SA tool args feed directly into the mutation builders. CommCare wire terms live at one genuine boundary outside: `lib/commcare/`.

The case-type pointer is `case_property_on` — the `_on` suffix is load-bearing: it forces the prepositional reading "the case type this property is on." Without it the SA reads the value as a property name and prefixes field ids with the case-type name to "disambiguate," corrupting field identity.

## SA tool-loop invariants

- **Tool execution is serialized via a promise-chain mutex** so parallel `tool_use` blocks see a consistent working doc. Without it, concurrent branches read the same pre-batch snapshot and the last write silently drops earlier mutations from the SA's own view (the wire still gets them; the SA's state corrupts, surfacing as an "edits aren't sticking" rework loop).
- **`validateApp`'s success arm is the unique chat-completion boundary**: it awaits `materializeCaseStoreSchemas` BEFORE emitting `data-done`, so a user action fired sub-second after the celebration sees a synced Postgres schema. A materialization throw routes through the same classify/emit/failApp path the route's `failRun` uses — never an SA retry against a Postgres outage no edit can fix.
- **The write surface**: the SA applies `Mutation[]` to its own doc via Immer and persists through `ctx.recordMutations`; the builder client feeds the same payload into `docStore.applyMany` — no translation, no reconstruction. `data-done` carries the full doc only because validation autofixes produce opaque deltas; nothing else emits full docs live.
- The validation loop takes the shared `ToolExecutionContext` interface (not the chat-concrete context) so the same loop runs on chat and MCP surfaces.

## Tool schema generation

The two field-mutation tool inputs are generated from `fieldRegistry` as a `discriminatedUnion("kind", …)`: each arm exposes ONLY the properties its kind declares and is `.strict()`, so the wrong-property-for-kind error class is structurally unexpressible. Tool use is NOT grammar-constrained (that ceiling is `Output.object`-only), so arms carry as many optionals as the kind declares. `label` is per-kind on the add arms (omitted on `hidden`, optional on containers, required non-empty on visible kinds); the required-with-sentinel `label` survives only on the WIDE processing types that infer the pipeline's flat shapes, never on an arm. Feature configs group under nested objects so each reads as one slot.

`contentProcessing.ts` is the one boundary where sentinel stripping, case-type default merging, and the flat→discriminated reshape happen; case-type metadata's CommCare-flavored `validation`/`validation_msg` translates onto the field's nested `validate` object here and nowhere else.

## SA prompt caching + provider options

Request-level `cacheControl: { type: 'ephemeral' }`; Anthropic auto-advances the breakpoint, so the system prompt stays cached within a session. Cache TTL is 5 minutes; the route picks full-history vs last-message-only off a client-reported timestamp (edit-vs-build mode is a separate decision — root CLAUDE.md).

Provider options shape: `effort` is a TOP-LEVEL sibling of `thinking`, not nested — the AI SDK's Zod schema silently strips misplaced fields, so a misplaced option appears to work and never reaches the wire. `display: 'summarized'` is required for readable thinking summaries on Opus 4.7+. Type provider options as `AnthropicProviderOptions`, never `Record<string, JSONValue>`.

## Tool surface rules

- Tools split into a generation set (build mode only) and a shared set; when the app exists, generation tools are excluded.
- **No singular add-tool has a plural twin.** Anything added one-or-more-at-a-time has exactly one list-taking tool; one item is a length-1 array. A redundant singular twin burns context and invites one-call-per-item behavior.
- The chat route's history strip drops tool-use parts naming tools absent from the current set, so removing/renaming a tool can't orphan an old thread's references on a live-cache edit.
- Mutation tools return a human-readable success `message` so the SA trusts its own edits without re-reading the blueprint.
- Case-list authoring belongs to the case-list-config tools (`updateModule` is name-only; `createModule` accepts no case-list shape). Case-search authoring belongs to the case-search-config tools. Media authoring belongs to the media tools — the generic mutation tools carry NO media slot, so the SA can't mint or reference an asset id outside the media surface.

### Case-list authoring — atomic ops + uuid handles

`columns` and `searchInputs` decompose into ops: list-`add` (mints uuids, surfaces them positionally in `result.uuids`), plus `update`/`remove`/`reorder` addressing a single uuid. `filter` is one Predicate, so a wholesale set-tool with `null`-clears fits. Every read surface (get/search/summarize) carries the uuids so the SA inherits handles after a fresh-session resume. The `update*` tools accept the FULL body shape — partial patches don't fit the per-arm field sets, and switching search-input arms changes the field set anyway. The tools accept the typed AST shapes directly via Zod from `lib/domain`.

### Case-search authoring — wholesale per cluster

`caseSearchConfig` is a settings bag, not an addressable list: two wholesale-replace tools (display cluster; advanced cluster carrying `excludedOwnerIds`). Each replaces its own cluster and preserves the other byte-identically. Every cluster slot is required-and-nullable (`null` clears) — zero optionals, no absent-vs-null ambiguity. Search inputs themselves stay on `caseListConfig.searchInputs` (one source across both screens) and are authored ONLY through the search-input family; the case-search tools deliberately carry no `searchInputs` slot. The `excludedOwnerIds` authoring name translates to CCHQ's `commcare_blacklisted_owner_ids` at suite-XML emission only.

### Media authoring — dedicated carriers + the asset library

Five doc-mutation tools attach asset ids to carriers; two library tools (list + remove) are how the SA discovers and retires asset ids. Key contracts:

- **Media slots use dedicated, clear-safe mutation kinds — never generic `update*` patches.** The SA streams mutations as JSON and `JSON.stringify` DROPS `undefined` keys, so a patch-encoded clear arrives as `{}` and the stale ref survives. The dedicated kinds carry an explicit on-wire `null`, mapped to `undefined` inside the reducer. Not folded into the generic reducers as null-means-clear because `setConnectType` stores `null` as a real value. Option media is the exception: it rides a wholesale concrete `options` array, which survives JSON.
- Asset existence is NOT checked at attach time — the validation loop adjudicates post-mutation, surfacing bad refs with carrier locations.
- `removeMediaAsset` refuses (naming the carriers) while the asset is referenced in the in-hand doc OR any of the owner's live apps. The reference guard reads the asset's append-only `referencingAppIds` reverse index and re-walks only those candidates to confirm (append-only means candidates can be stale; the re-walk is the proof). Un-backfilled rows fall back to the owner-wide scan. The deletion mechanics are shared with the browser delete route so the two can't drift.
- Slot-vs-kind gating uses the schema key set (`fieldKindDeclaresKey`), never `key in field` — an unset optional slot is absent as an own property even on a kind that supports it.

## Document extraction

- One structured Gemini call fills the extract schema with `title` + `summary` FIRST and the large `extract` LAST — **schema field order is load-bearing**: writing the extract last stops the model bleeding the trailing fields into the extract mid-generation.
- A structured call has no partial: truncation or malformed output yields no parseable object, so extraction FAILS rather than returning half an extract.
- `EXTRACTOR_VERSION` keys stored extracts — bump it on ANY prompt/model/conversion change to invalidate stale extracts with no migration. It lives in `lib/domain/multimedia` (beside the key it versions) so importing it doesn't drag the office parsers into the caller's graph.
- The single-flight store is the ONE entry point both the eager upload-time route and the chat-send backstop go through — a document extracts once, never per turn. `onInflight: "report"` gives the badge poller a fast 202; `onInflight: "wait"` polls the in-flight job rather than starting a second model call. A stale-claim bound re-claims jobs whose process died.

## Attachment resolution

`resolveAttachments` turns asset-id refs into model-ready content BEFORE the SA runs, walking EVERY message (not just the last — history carries refs, and raw `text/markdown` file parts would be rejected by Anthropic on later turns). Resolved parts are deduped by assetId and byte-identical across turns so re-resolving history keeps the prompt cache hit. Every failure path degrades to a human-readable placeholder — an attachment is never dropped. Only a not-yet-extracted document counts toward the "reading documents" status, so already-read documents resolve silently.

## Shared-tool return contract

Every shared tool returns one of three tagged shapes: `MutatingToolResult` (already persisted via `ctx.recordMutations`; `result.message` is the prose the LLM reads, `result.summary` is UI-only and stripped by the MCP projector), `ReadToolResult` (pure read), or `ValidateAppResult`. The `kind` discriminator is what the chat-side wrappers and the MCP projector dispatch on — a fourth shape must update both consumers, and the exhaustive `switch` in the projector is the compile-time tripwire.
