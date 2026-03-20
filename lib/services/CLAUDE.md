# Services Layer

Core business logic: Solutions Architect agent, blueprint management, LLM orchestration, CommCare output generation.

## Solutions Architect Agent

Split across three files:
- `solutionsArchitect.ts` — `createSolutionsArchitect()` with tool definitions
- `formGeneration.ts` — `singleFormSchema`, `generateSingleFormContent()`, `buildColumnPrompt()`, `QUESTION_TYPES`
- `validationLoop.ts` — `validateAndFix()`, `groupErrorsByForm()`, `applyProgrammaticFixes()`

`solutionsArchitect.ts` exports `createSolutionsArchitect(ctx, mutableBp, blueprintSummary?)` — single `ToolLoopAgent` with 21 tools in 5 groups:

**Conversation (1):**
- `askQuestions` (client-side, no `execute`) — structured multiple-choice rendered as QuestionCard. `sendAutomaticallyWhen` re-sends when all answered.

**Generation (4)** — take natural language instructions, run structured output internally, return summary:
- `generateSchema` — case types + properties. Emits `data-start-build`.
- `generateScaffold` — module/form structure. Emits `data-phase: structure`, streams partial scaffold.
- `addModule` — case list/detail columns.
- `addForm` — form questions via structured output. Returns `questions` tree summary (id, type, case_property, children) so the SA can see structure and coordinate sibling forms.

`addForm` and `regenerateForm` return a compact `questions` tree via `summarizeQuestions()` — the SA sees every question's ID, type, case_property, and nesting. This lets it detect structural mismatches between sibling forms (e.g. registration vs followup) and fix them with mutation tools.

**Read (4):**
- `searchBlueprint`, `getModule`, `getForm`, `getQuestion`

**Mutation (11):**
- `editQuestion`, `addQuestion`, `removeQuestion`, `updateModule`, `updateForm`, `createForm`, `removeForm`, `createModule`, `removeModule`, `renameCaseProperty`, `regenerateForm`

**Validation (1):**
- `validateApp` — runs `validateAndFix()` loop, emits `data-done`.

**Build sequence:** `askQuestions → generateSchema → generateScaffold → addModule × N → addForm × N → validateApp`

The SA makes all architecture decisions (entities, relationships, structure). Generation tools handle detail work (question IDs, XPath, group structure).

Also re-exports from the split files:
- `validateAndFix()` (from `validationLoop.ts`) — programmatic validation + fix loop (rule-based fixes + structured output fallback for empty forms). Has an artificial 3s delay when validation passes first attempt — remove once CommCare core .jar is integrated for full validation.
- `generateSingleFormContent()` (from `formGeneration.ts`) — used by `addForm` and `regenerateForm`.

## MutableBlueprint

`mutableBlueprint.ts` — wraps `AppBlueprint` (deep-cloned) for progressive population and in-place mutation.

- **New build**: Route creates `MutableBlueprint({ app_name: '', modules: [], case_types: null })`. Generation tools populate via `setCaseTypes()`, `setScaffold()`, `updateModule()`, `replaceForm()`.
- **Edit/continuation**: Route creates `MutableBlueprint(existingBlueprint)`. SA uses read/mutation tools directly.

**Question identification:** All public question methods use `QuestionPath` (branded string type from `questionPath.ts`) — a slash-delimited tree path like `"group1/child_q"`. Paths are built via `qpath(id, parent?)`, never by string concatenation. SA tools receive bare IDs from the LLM and resolve to paths via `resolveQuestionId()`.

**Query:** `search()` finds matches across question paths/labels/case_properties/XPath/module names/form names/columns.

**Cross-level move:** `moveQuestion()` accepts optional `targetParentPath` in opts. When present, removes the question from its current parent array and inserts into the target parent's children (or root if `undefined`). Circular nesting (moving a group into itself or a descendant) is a no-op. Backward-compatible — callers omitting `targetParentPath` get same-level reorder as before.

**Rename propagation:**
- `renameQuestion(path, newId)` — renames question ID, propagates through all XPath expressions and output tags in the same form via Lezer-based `rewriteXPathRefs`. Returns `{ newPath: QuestionPath, xpathFieldsRewritten }`.
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

**All state is private with readonly getters.** Consumers read via getters (`builder.phase`, `builder.selected`, `builder.blueprint`, etc.) and mutate through methods only.

**Key members:**
- `builder.mb` — persistent MutableBlueprint instance (undefined before blueprint exists)
- `builder.blueprint` — getter returning `mb.getBlueprint()` (plain data for serialization)
- `builder.notifyBlueprintChanged()` — arrow property (stable ref), notifies subscribers after mutations
- `builder.treeData` — getter with four-level fallback: blueprint > partialModules merged with scaffold > scaffold > partialScaffold
- `builder.subscribe` / `builder.getSnapshot` — arrow properties for `useSyncExternalStore`. `_version` counter incremented in `notify()`.
- `builder.select(el?)` — set selection; call with no args to deselect
- Progress counters (`progressCompleted`/`progressTotal`) derived from partialModules map against scaffold.

**New question state** — encapsulated behind methods, not public fields:
- `builder.markNewQuestion(path)` — called by QuestionTypePicker after inserting
- `builder.isNewQuestion(path)` — checks if question was just added (drives auto-focus + select-all)
- `builder.clearNewQuestion()` — called by DetailPanel on first save

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

### Undo/Redo

`HistoryManager` (`historyManager.ts`) — Proxy-based mutation interception on MutableBlueprint. Each snapshot stores `SnapshotEntry { blueprint, meta: SnapshotMeta, viewMode: ViewMode }`. `SnapshotMeta` captures mutation type (`add`/`remove`/`move`/`duplicate`/`update`/`rename`/`structural`), module/form indices, and `QuestionPath` values. `ViewMode` (`'overview' | 'design' | 'preview'`) captures which view the user was in when the edit was made. `deriveMeta()` maps method names + args to metadata; `duplicateQuestion` clone path is patched after execution. `undo()`/`redo()` return `{ mb, meta, viewMode }` — Builder uses meta to derive smart selection (e.g., undo-remove re-selects the restored question, undo-add clears selection) and returns `viewMode` so BuilderLayout can restore the view. Drag guard: `builder.setDragging()` prevents undo/redo during drag operations. History cleared on form switch (in `select()`) and generation start (`startDataModel()`). Created in `setDone()`, disabled during generation, cleared on `reset()`.

**View restoration:** `builder.setViewMode()` keeps HistoryManager's `viewMode` in sync (called by BuilderLayout on each render). On undo/redo, `builder.undo()`/`redo()` return the captured `ViewMode`. BuilderLayout's `restoreView()` switches viewMode if needed and syncs the preview nav stack to the restored selection when in design/preview mode — so the user is "teleported" back to where the edit was made.

### Keyboard Shortcuts

`KeyboardManager` (`keyboardManager.ts`) — module-level singleton, single `document.keydown` listener. Input suppression (input/textarea/select/contenteditable/.cm-content) unless `global: true`. `useKeyboardShortcuts` hook uses `useSyncExternalStore`'s subscribe lifecycle for register/unregister.

`questionNavigation.ts` — `flattenQuestionPaths()` returns `QuestionPath[]` for Tab/Shift+Tab navigation through the question tree.

## Expander

Split across three files:
- `hqJsonExpander.ts` — `expandBlueprint()` orchestrator + `validateBlueprint()`
- `xformBuilder.ts` — `buildXForm()`, `buildQuestionParts()`, `getAppearance()`, `getXsdType()`
- `formActions.ts` — `buildFormActions()`, `buildCaseReferencesLoad()`

`expandBlueprint()` converts `AppBlueprint` → HQ import JSON. `validateBlueprint()` checks semantic rules. `detectUnquotedStringLiteral()` uses the Lezer XPath parser to flag bare words in XPath fields (e.g. `no` instead of `'no'`).

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

Programmatic fixes for common CommCare app issues. Used by `validateAndFix()` loop before falling back to structured output for unfixable errors. Includes auto-fix for unquoted string literals (wraps bare words in single quotes).

## CommCare Module (commcare/)

Shared platform module: `constants.ts` (reserved words, regex), `xml.ts` (escapeXml), `hashtags.ts` (Vellum expansion), `ids.ts` (hex ID gen), `hqTypes.ts` (HQ JSON interfaces), `hqShells.ts` (factory functions), `validate.ts` (identifier validation).

## Run Logging

Set `RUN_LOGGER=1` in `.env` to enable. Each run writes to `.log/` — always valid JSON, even on crash.

**RunLogger class** (`runLogger.ts`): created once per request.
- `logStep(step)` — creates Step, drains emission/sub-result buffers, computes cost, flushes. `StepToolCall.output` is backfilled by `logConversation` for client-side tools (e.g. `askQuestions`) whose output arrives on the follow-up request.
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

`logReplay.ts` — walks `log.steps`, builds progressive chat messages, creates `ReplayStage` per tool call. Multi-tool steps split by `moduleIndex`/`formIndex`. Uses `applyDataPart()` — same code path as real-time. Tool outputs (e.g. question answers) are read from `StepToolCall.output` and included in replay parts. Extraction returns `doneIndex` — the index of the synthetic "Done" stage — so consumers can start replay at the completed app state without string comparisons.

## Pipeline Config

**Stages** (each has model + maxOutputTokens + reasoning + reasoningEffort):
- `solutionsArchitect` — SA agent (default: Opus, reasoning max)
- `schemaGeneration` — `generateSchema` call (default: Sonnet, reasoning medium)
- `scaffold` — `generateScaffold` + `addModule` calls (default: Sonnet, reasoning medium)
- `formGeneration` — `addForm` + `regenerateForm` calls (default: Sonnet, reasoning medium)

`maxOutputTokens` of `0` means no cap. Reasoning uses Anthropic adaptive thinking (`type: 'adaptive'`) with configurable effort (`low`/`medium`/`high`/`max`). `ctx.reasoningForStage(stage)` returns the config or `undefined`.

Users configure per-stage via `/settings`. Settings flow: `localStorage → useSettings() → useChat body → route.ts → GenerationContext.pipelineConfig`.

**Models proxy:** `POST /api/models` takes `{ apiKey }`, returns latest version of each family (Opus, Sonnet, Haiku) for settings dropdowns.
