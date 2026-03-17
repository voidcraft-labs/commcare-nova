# Services Layer

Core business logic: Solutions Architect agent, blueprint management, LLM orchestration, CommCare output generation.

## Solutions Architect Agent

`solutionsArchitect.ts` exports `createSolutionsArchitect(ctx, mutableBp, blueprintSummary?)` — single `ToolLoopAgent` with 21 tools in 5 groups:

**Conversation (1):**
- `askQuestions` (client-side, no `execute`) — structured multiple-choice rendered as QuestionCard. `sendAutomaticallyWhen` re-sends when all answered.

**Generation (4)** — take natural language instructions, run structured output internally, return summary:
- `generateSchema` — case types + properties. Emits `data-start-build`.
- `generateScaffold` — module/form structure. Emits `data-phase: structure`, streams partial scaffold.
- `addModule` — case list/detail columns.
- `addForm` — form questions via structured output.

**Read (4):**
- `searchBlueprint`, `getModule`, `getForm`, `getQuestion`

**Mutation (11):**
- `editQuestion`, `addQuestion`, `removeQuestion`, `updateModule`, `updateForm`, `createForm`, `removeForm`, `createModule`, `removeModule`, `renameCaseProperty`, `regenerateForm`

**Validation (1):**
- `validateApp` — runs `validateAndFix()` loop, emits `data-done`.

**Build sequence:** `askQuestions → generateSchema → generateScaffold → addModule × N → addForm × N → validateApp`

The SA makes all architecture decisions (entities, relationships, structure). Generation tools handle detail work (question IDs, XPath, group structure).

Also exports:
- `validateAndFix()` — programmatic validation + fix loop (rule-based fixes + structured output fallback for empty forms). Has an artificial 3s delay when validation passes first attempt — remove once CommCare core .jar is integrated for full validation.
- `generateSingleFormContent()` — used by `addForm` and `regenerateForm`.

## MutableBlueprint

`mutableBlueprint.ts` — wraps `AppBlueprint` (deep-cloned) for progressive population and in-place mutation.

- **New build**: Route creates `MutableBlueprint({ app_name: '', modules: [], case_types: null })`. Generation tools populate via `setCaseTypes()`, `setScaffold()`, `updateModule()`, `replaceForm()`.
- **Edit/continuation**: Route creates `MutableBlueprint(existingBlueprint)`. SA uses read/mutation tools directly.

**Query:** `search()` finds matches across question IDs/labels/case_properties/XPath/module names/form names/columns.

**Rename propagation:**
- `renameQuestion()` — renames question ID, propagates through all XPath expressions and output tags in the same form via Lezer-based `rewriteXPathRefs`.
- `renameCaseProperty()` — propagates across all questions, columns, XPath, and output tags via `rewriteHashtagRefs`.
- Both use `rewriteOutputTags` (htmlparser2) for `<output value="..."/>` tags in display text.

## GenerationContext

`generationContext.ts` — the single place all LLM calls flow through.

**Methods:**
- `model(id)` — returns Anthropic model provider
- `pipelineConfig` — readonly `PipelineConfig` (merged with `DEFAULT_PIPELINE_CONFIG`)
- `emit(type, data)` — writes transient data part to client stream
- `logger` — the `RunLogger` instance
- `generatePlainText(opts)` — text-only generation with automatic run logging
- `generate(schema, opts)` — one-shot structured generation via `generateText` + `Output.object()`. Accepts `reasoning?: { effort }`.
- `streamGenerate(schema, opts)` — streaming structured generation via `streamText` + `Output.object()` + `partialOutputStream` with `onPartial`. Accepts `reasoning?: { effort }`.
- `reasoningForStage(stage)` — returns `{ effort }` if reasoning enabled and model supports it, `undefined` otherwise.

**Exports:**
- `thinkingProviderOptions(effort)` — Anthropic adaptive thinking provider options for ToolLoopAgent constructors.
- `withPromptCaching` — `prepareStep` config marking last message with `cache_control: ephemeral`. Spread into SA's ToolLoopAgent constructor.

## Builder

`builder.ts` — singleton state machine shared via `useBuilder()`.

**Phases:** `Idle → DataModel → Structure → Modules → Forms → Validate → Fix → Done | Error`

**Key members:**
- `builder.mb` — persistent MutableBlueprint instance (null before blueprint exists)
- `builder.blueprint` — getter returning `mb.getBlueprint()` (plain data for serialization)
- `builder.notifyBlueprintChanged()` — arrow property (stable ref), notifies subscribers after mutations
- `builder.treeData` — getter with four-level fallback: blueprint > partialModules merged with scaffold > scaffold > partialScaffold
- `builder.subscribe(listener)` — triggers React re-renders
- Progress counters (`progressCompleted`/`progressTotal`) derived from partialModules map against scaffold.

**Data parts → builder methods:**

| Emission type | Builder method |
|---|---|
| `data-start-build` | `startDataModel()` |
| `data-schema` | `setSchema(caseTypes)` |
| `data-partial-scaffold` | `setPartialScaffold()` |
| `data-scaffold` | `setScaffold()` |
| `data-phase` | `setPhase()` |
| `data-module-done` | `setModuleContent()` |
| `data-form-done` / `data-form-fixed` / `data-form-updated` | `setFormContent()` |
| `data-blueprint-updated` | `updateBlueprint()` |
| `data-fix-attempt` | `setFixAttempt()` |
| `data-done` | `setDone()` |
| `data-error` | `setError()` |

`applyDataPart(builder, type, data)` — shared switch used by both real-time streaming (`onData`) and log replay.

## Expander (hqJsonExpander.ts)

`expandBlueprint()` converts `AppBlueprint` → HQ import JSON. `validateBlueprint()` checks semantic rules.

**Vellum hashtag expansion** — dual-attribute pattern matching CommCare's Vellum editor:
- Real attributes (`calculate`, `relevant`, `constraint`, `value`) — `#case/` expanded to full `instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/property` XPath.
- Vellum attributes (`vellum:calculate`, `vellum:relevant`, `vellum:value`) — original shorthand preserved.
- Vellum metadata (`vellum:hashtags`, `vellum:hashtagTransforms`) — JSON on each bind.
- `case_references_data.load` — form-level JSON mapping question paths to `#case/` refs.
- Secondary instances (`casedb`, `commcaresession`) auto-declared when hashtags are used.

**Case config derivation** (`deriveCaseConfig()`):
- Registration: `case_property` → `case_properties` map. `is_case_name` → `case_name_field`.
- Followup: `case_property` → both `case_preload` and `case_properties`. `is_case_name` → `case_name_field`.
- Survey: no case config.

Called on-demand by expander and validator — no form-level case fields stored.

## Compiler (cczCompiler.ts)

`CczCompiler` takes HQ import JSON → `.ccz` Buffer. Generates suite.xml, profile.ccpr, app_strings.txt. Injects case blocks back into XForm XML.

## AutoFixer (autoFixer.ts)

Programmatic fixes for common CommCare app issues. Used by `validateAndFix()` loop before falling back to structured output for unfixable errors.

## CommCare Module (commcare/)

Shared platform module: `constants.ts` (reserved words, regex), `xml.ts` (escapeXml), `hashtags.ts` (Vellum expansion), `ids.ts` (hex ID gen), `hqTypes.ts` (HQ JSON interfaces), `hqShells.ts` (factory functions), `validate.ts` (identifier validation).

## Run Logging

Set `RUN_LOGGER=1` in `.env` to enable. Each run writes to `.log/` — always valid JSON, even on crash.

**RunLogger class** (`runLogger.ts`): created once per request.
- `logStep(step)` — creates Step, drains emission/sub-result buffers, computes cost, flushes
- `logEmission(type, data)` — buffers an emission (skips transient types like `data-partial-scaffold`)
- `logSubResult(label, result)` — buffers sub-generation usage data
- `finalize()` — rebuilds conversation, recomputes totals
- `labelMatchesToolName()` — maps labels (e.g. "Schema") to tool names (e.g. "generateSchema")
- Abandoned log cleanup on construction (renames UUID-named orphans)
- Output: `.log/{timestamp}_{app_name|unnamed|abandoned}.json`

**v2 log format**: `RunLog` with `steps[]`, each containing `tool_calls[]`, `emissions[]`, `usage`. See the `RunLog` type in `runLogger.ts`.

## Log Replay

Client-side replay of v2 run logs through Builder without API calls.

**Flow:** `/settings` file picker → `extractReplayStages(log)` → module-level store → `/build/new` → `BuilderLayout` reads store → `ReplayController` drives Builder.

`logReplay.ts` — walks `log.steps`, builds progressive chat messages, creates `ReplayStage` per tool call. Multi-tool steps split by `moduleIndex`/`formIndex`. Uses `applyDataPart()` — same code path as real-time.

## Pipeline Config

**Stages** (each has model + maxOutputTokens + reasoning + reasoningEffort):
- `solutionsArchitect` — SA agent (default: Opus, reasoning max)
- `schemaGeneration` — `generateSchema` call (default: Sonnet, reasoning medium)
- `scaffold` — `generateScaffold` + `addModule` calls (default: Sonnet, reasoning medium)
- `formGeneration` — `addForm` + `regenerateForm` calls (default: Sonnet, reasoning medium)

`maxOutputTokens` of `0` means no cap. Reasoning uses Anthropic adaptive thinking (`type: 'adaptive'`) with configurable effort (`low`/`medium`/`high`/`max`). `ctx.reasoningForStage(stage)` returns the config or `undefined`.

Users configure per-stage via `/settings`. Settings flow: `localStorage → useSettings() → useChat body → route.ts → GenerationContext.pipelineConfig`.

**Models proxy:** `POST /api/models` takes `{ apiKey }`, returns latest version of each family (Opus, Sonnet, Haiku) for settings dropdowns.
