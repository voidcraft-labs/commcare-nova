# Services Layer

Core business logic: Solutions Architect agent, blueprint management, LLM orchestration, CommCare output generation.

## Solutions Architect Agent

Split across two files:
- `solutionsArchitect.ts` — `createSolutionsArchitect()` with tool definitions + `buildColumnPrompt()`
- `validationLoop.ts` — `validateAndFix()`, `groupErrorsByForm()`, `applyProgrammaticFixes()`

`solutionsArchitect.ts` exports `createSolutionsArchitect(ctx, mutableBp, blueprintSummary?)` — single `ToolLoopAgent` with 21 tools in 6 groups:

**Conversation (1):**
- `askQuestions` (client-side, no `execute`) — structured multiple-choice rendered as QuestionCard. `sendAutomaticallyWhen` re-sends when all answered.

**Code Execution (1):**
- `code_execution` — Anthropic code execution sandbox. SA writes Python for build steps via programmatic tool calling.

**Generation (3)** — SA provides structured data directly (no sub-LLM calls). All marked with `allowedCallers: ['code_execution_20260120']` for programmatic calling from code execution:
- `generateSchema` — accepts case types + properties. `onInputStart` emits `data-start-build`.
- `generateScaffold` — accepts module/form structure. `onInputStart` emits `data-phase: structure`.
- `addModule` — accepts case list/detail columns. `onInputStart` emits `data-phase: modules`.

**Form Building (1):**
- `addQuestions` — batch-append flat questions to a form. Marked with `allowedCallers: ['code_execution_20260120']` for programmatic calling from code execution. Processes questions through `stripEmpty → applyDefaults → buildQuestionTree`, merging with existing form questions. Emits `data-form-updated`.

**Read (4):**
- `searchBlueprint`, `getModule`, `getForm`, `getQuestion`

**Mutation (10):**
- `editQuestion` (includes ID rename with automatic propagation), `addQuestion`, `removeQuestion`, `updateModule`, `updateForm` (name, close_case, child_cases), `createForm`, `removeForm`, `createModule`, `removeModule`

**Validation (1):**
- `validateApp` — runs `validateAndFix()` loop. `onInputStart` emits `data-phase: validate`, emits `data-done` on success.

**Build sequence:** `askQuestions → code_execution (generateSchema → generateScaffold → addModule × N → addQuestions × N) → updateForm (close_case/child_cases) → validateApp`

The SA makes all architecture and form design decisions. All build tools are called from code execution — JSON construction stays in the sandbox, not in the SA's context window.

**prepareStep:** Inline function that consolidates prompt caching (message-level), reasoning (adaptive thinking), and container forwarding (code execution sandbox persistence) into a single provider options builder. No external `withPromptCaching` dependency. Cache control skips code-execution-related messages (tool results, assistant messages containing `code_execution` tool calls, and assistant messages containing tool calls made BY code execution via programmatic tool calling) since they aren't rendered in Claude's context.

**Agent limits:** `stopWhen: stepCountIs(80)` — resets per request. Error recovery prompt tells SA to bail after 2-3 failed retries.

**SA prompt** (`lib/prompts/solutionsArchitectPrompt.ts`) includes a CommCare XPath quick reference so the SA can write correct XPath without hallucinating function signatures (e.g. `round()` takes 1 arg, not 2).

Also re-exports `validateAndFix()` (from `validationLoop.ts`) — programmatic validation + fix loop (rule-based fixes + deep XPath validation). Unfixable errors (e.g. empty forms) are surfaced to the SA to fix with its normal tools.

## MutableBlueprint

`mutableBlueprint.ts` — wraps `AppBlueprint` (deep-cloned) for progressive population and in-place mutation.

- **New build**: Route creates `MutableBlueprint({ app_name: '', modules: [], case_types: null })`. Generation tools populate via `setCaseTypes()`, `setScaffold()`, `updateModule()`, `replaceForm()`.
- **Edit/continuation**: Route creates `MutableBlueprint(existingBlueprint)`. SA uses read/mutation tools directly.

**Question identification:** All public question methods use `QuestionPath` (branded string type from `questionPath.ts`) — a slash-delimited tree path like `"group1/child_q"`. Paths are built via `qpath(id, parent?)`, never by string concatenation. SA tools receive bare IDs from the LLM and resolve to paths via `resolveQuestionId()`.

**Query:** `search()` finds matches across question paths/labels/case_properties/XPath/module names/form names/columns.

**Cross-level move:** `moveQuestion()` accepts optional `targetParentPath` in opts. When present, removes the question from its current parent array and inserts into the target parent's children (or root if `undefined`). Circular nesting (moving a group into itself or a descendant) is a no-op. Backward-compatible — callers omitting `targetParentPath` get same-level reorder as before.

**Rename propagation:**
- `renameQuestion(path, newId)` — renames question ID within a single form, propagates through XPath expressions and output tags via Lezer-based `rewriteXPathRefs`. Returns `{ newPath: QuestionPath, xpathFieldsRewritten }`.
- `renameCaseProperty()` — cross-form rename for case properties: renames question ID in all forms of the module, rewrites `#case/` hashtag refs, updates columns. Does not touch `case_types` (frozen after generation).
- The SA's `editQuestion` tool detects ID changes and calls the appropriate method automatically — `renameCaseProperty` for case properties, `renameQuestion` for others. No separate rename tool needed.
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
- `ANTHROPIC_CACHE_CONTROL` — Anthropic cache control marker for prompt caching (`cache_control: ephemeral`).
- `thinkingProviderOptions(effort)` — Anthropic adaptive thinking provider options for `generate()`/`streamGenerate()` calls.

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
- Registration: `is_case_property` questions → `case_properties` map (property name = question ID). `id === 'case_name'` → `case_name_field`.
- Followup: `is_case_property` questions → both `case_preload` and `case_properties`. `id === 'case_name'` → `case_name_field`.
- Survey: no case config.

Called on-demand by expander and validator — no form-level case fields stored.

## Compiler (cczCompiler.ts)

`CczCompiler` takes HQ import JSON → `.ccz` Buffer. Generates suite.xml, profile.ccpr, app_strings.txt. Injects case blocks back into XForm XML.

## AutoFixer (autoFixer.ts)

Programmatic fixes for common CommCare app issues. Used by `validateAndFix()` loop. Includes auto-fix for unquoted string literals (wraps bare words in single quotes).

## CommCare Module (commcare/)

Shared platform module: `constants.ts` (reserved words, regex), `xml.ts` (escapeXml), `hashtags.ts` (Vellum expansion), `ids.ts` (hex ID gen), `hqTypes.ts` (HQ JSON interfaces), `hqShells.ts` (factory functions), `validate.ts` (identifier validation).

### Deep Validation (commcare/validate/)

Three-phase XPath validation mirroring real compiler architecture — parsing (Lezer) → type checking → name/arity/reference checking. Operates directly on `AppBlueprint` objects during build and edit.

- `functionRegistry.ts` — `FUNCTION_REGISTRY`: static `Map<string, FunctionSpec>` for all ~65 CommCare XPath functions + XPath 1.0 core. Each entry has `minArgs`, `maxArgs`, `returnType` (`XPathType`), and optional `paramTypes` array. Source of truth for arities: commcare-core's `ASTNodeFunctionCall.java`. Source of truth for types: XPath 1.0 spec + CommCare runtime. `findCaseInsensitiveMatch()` powers "did you mean?" suggestions.
- `typeChecker.ts` — Bottom-up type inference over the Lezer CST. Infers `XPathType` (`string | number | boolean | nodeset | any`) for every node, then checks operator/function constraints via a declarative `OPERATOR_TYPES` table. Flags provably-lossy coercions: non-numeric string literals in numeric contexts (e.g. `- 'hello'`, `'text' * 2`, `round('foo')`). Allows legitimate patterns: nodeset coercion (unknowable), numeric string literals (`'5' + 3`), boolean↔number coercion.
- `xpathValidator.ts` — `validateXPath(expr, validPaths?, caseProperties?)`: comprehensive Lezer CST walker. Three phases: `⚠` → syntax error, `Invoke` → function name + arity, type checker → type errors, path refs → node existence, `HashtagRef` → case property existence.
- `index.ts` — `validateBlueprintDeep(blueprint)`: orchestrator called by `validateBlueprint()`. Per-form: walks all XPath fields, runs cycle detection via `TriggerDag.reportCycles()`. Cross-form: validates `#case/prop` references against `blueprint.case_types`. Exports `collectValidPaths()` and `collectCaseProperties()` for reuse by the CodeMirror linter.
- `types.ts` — `ValidationError` with codes: `XPATH_SYNTAX`, `UNKNOWN_FUNCTION`, `WRONG_ARITY`, `INVALID_REF`, `INVALID_CASE_REF`, `CYCLE`, `TYPE_ERROR`.

The fix loop in `validationLoop.ts` auto-fixes case-mismatched function names (`Today()` → `today()`) and wrong `round()` arity (`round(x, 2)` → `round(x)`).

## Run Logging

Set `RUN_LOGGER=1` in `.env` to enable. Each run writes to `.log/` — always valid JSON, even on crash.

**RunLogger class** (`runLogger.ts`): created once per request.
- `logStep(step)` — creates Step, drains emission/sub-result/tool-output buffers, computes cost, flushes. `StepToolCall.output` is populated from `logToolOutput` for server-side tools and backfilled by `logConversation` for client-side tools (e.g. `askQuestions`) whose output arrives on the follow-up request.
- `logEmission(type, data)` — buffers an emission (skips transient types like `data-partial-scaffold`)
- `logSubResult(label, result)` — buffers sub-generation usage data
- `logToolOutput(toolName, output)` — buffers a server-side tool's return value. Matched to `tool_calls` by name in `logStep()`. Used by `validateApp` to capture success/failure + error details.
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

Single stage: `solutionsArchitect` (model + maxOutputTokens + reasoning + reasoningEffort). Default: Opus, reasoning max. No sub-LLM calls — the SA produces all structured data directly.

`maxOutputTokens` of `0` means no cap. Reasoning uses Anthropic adaptive thinking (`type: 'adaptive'`) with configurable effort (`low`/`medium`/`high`/`max`). `ctx.reasoningForStage(stage)` returns the config or `undefined`.

Users configure via `/settings`. Settings flow: `localStorage → useSettings() → useChat body → route.ts → GenerationContext.pipelineConfig`.

**Models proxy:** `POST /api/models` takes `{ apiKey }`, returns latest version of each family (Opus, Sonnet, Haiku) for settings dropdowns.
