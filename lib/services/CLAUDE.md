# Services Layer

Core business logic: Solutions Architect agent, blueprint management, LLM orchestration, CommCare output generation.

## Solutions Architect Agent

Split across three files:
- `solutionsArchitect.ts` — `createSolutionsArchitect()` with tool definitions
- `lib/schemas/toolSchemas.ts` — question field schemas for SA tools, derived from `questionFields` in `blueprint.ts`
- `validationLoop.ts` — `validateAndFix()` orchestrator

`solutionsArchitect.ts` exports `createSolutionsArchitect(ctx, mutableBp)` — single `ToolLoopAgent` with 20 tools in 6 groups:

**Conversation (1):**
- `askQuestions` (client-side, no `execute`) — structured multiple-choice rendered as QuestionCard. `sendAutomaticallyWhen` re-sends when all answered.

**Generation (3)** — SA calls directly with structured data (no sub-LLM calls):
- `generateSchema` — accepts case types + properties. `strict: true`. `onInputStart` emits `data-start-build`.
- `generateScaffold` — accepts module/form structure. `strict: true`. `onInputStart` emits `data-phase: structure`.
- `addModule` — accepts case list/detail columns. `onInputStart` emits `data-phase: modules`.

**Form Building (1):**
- `addQuestions` — batch-append flat questions to a form. Processes questions through `stripEmpty → applyDefaults(caseTypes, formType, moduleCaseType) → buildQuestionTree`, merging with existing form questions. `applyDefaults` auto-sets `default_value` to `#case/{id}` for primary case properties in follow-up forms. Emits `data-form-updated`.

**Read (4):**
- `searchBlueprint`, `getModule`, `getForm`, `getQuestion`

**Mutation (10):**
- `editQuestion` (includes ID rename with automatic propagation), `addQuestion`, `removeQuestion`, `updateModule`, `updateForm` (name, close_case, post_submit, connect), `createForm` (name, type, post_submit), `removeForm`, `createModule`, `removeModule`

**Validation (1):**
- `validateApp` — runs `validateAndFix()` loop. `onInputStart` emits `data-phase: validate`, emits `data-done` on success.

**Build sequence:** `askQuestions → generateSchema → generateScaffold → addModule × N → addQuestions × N → validateApp`

The SA makes all architecture and form design decisions. All tools are called directly.

**prepareStep:** Inline function that consolidates prompt caching and reasoning (adaptive thinking) into a single provider options builder. Model and reasoning effort are hardcoded via `SA_MODEL` and `SA_REASONING` from `lib/models.ts`. Uses request-level `cacheControl: { type: 'ephemeral' }` in `providerOptions.anthropic` — Anthropic automatically places the cache breakpoint on the last cacheable block and advances it as the conversation grows. System prompt stays cached across requests.

**Agent limits:** `stopWhen: stepCountIs(80)` — resets per request. Error recovery prompt tells SA to bail after 2-3 failed retries.

**SA prompt** (`lib/prompts/solutionsArchitectPrompt.ts`) includes a CommCare XPath quick reference so the SA can write correct XPath without hallucinating function signatures (e.g. `round()` takes 1 arg, not 2). The Connect section instructs the SA to assign `learn_module` and `assessment` independently per form based on content — educational forms get `learn_module` only, quiz forms get `assessment` only, combined forms get both.

Also re-exports `validateAndFix()` (from `validationLoop.ts`) — runs `runValidation()` in a loop, applying auto-fixes from `FIX_REGISTRY` by error code. Unfixable errors are surfaced to the SA as strings via `errorToString()` so it can fix them with its mutation tools.

## MutableBlueprint

`mutableBlueprint.ts` — wraps `AppBlueprint` (deep-cloned) for progressive population and in-place mutation.

- **New build**: Route creates `MutableBlueprint({ app_name: '', modules: [], case_types: null })`. Generation tools populate via `setCaseTypes()`, `setScaffold()`, `updateApp()`, `updateModule()`, `replaceForm()`.
- **Edit/continuation**: Route creates `MutableBlueprint(existingBlueprint)`. SA uses read/mutation tools directly.
- **Zero-copy adoption**: `MutableBlueprint.fromOwned(blueprint)` skips the defensive `structuredClone` — caller must guarantee exclusive ownership. Used by HistoryManager to adopt popped stack entries without redundant cloning.

**Question identification:** All public question methods use `QuestionPath` (branded string type from `questionPath.ts`) — a slash-delimited tree path like `"group1/child_q"`. Paths are built via `qpath(id, parent?)`, never by string concatenation. SA tools receive bare IDs from the LLM and resolve to paths via `resolveQuestionId()`.

**Query:** `search()` finds matches across question paths/labels/case_properties/XPath/module names/form names/columns.

**Cross-level move:** `moveQuestion()` accepts optional `targetParentPath` in opts. When present, removes the question from its current parent array and inserts into the target parent's children (or root if `undefined`). Circular nesting (moving a group into itself or a descendant) is a no-op. Backward-compatible — callers omitting `targetParentPath` get same-level reorder as before.

**Rename propagation:**
- `renameQuestion(path, newId)` — renames question ID within a single form, propagates through XPath expressions via Lezer-based `rewriteXPathRefs` and bare hashtags in display text via `transformBareHashtags`. Returns `{ newPath: QuestionPath, xpathFieldsRewritten }`.
- `renameCaseProperty()` — cross-form rename for case properties: renames question ID in all forms of the module, rewrites `#case/` hashtag refs in both XPath and display text, updates columns. Does not touch `case_types` (frozen after generation).
- The SA's `editQuestion` tool detects ID changes and calls the appropriate method automatically — `renameCaseProperty` for case properties, `renameQuestion` for others. No separate rename tool needed.

## GenerationContext

`generationContext.ts` — the single place all LLM calls flow through. Constructor takes a single `GenerationContextOptions` object.

**Readonly fields:**
- `session` — Better Auth `Session`. Always present (all users are authenticated). Used by `validateApp` to save projects to Firestore.
- `projectId` — Firestore project ID, present when updating an existing project. Threaded from the chat request body.
**Methods:**
- `model(id)` — returns Anthropic model provider
- `emit(type, data)` — writes transient data part to client stream
- `emitError(error, context?)` — classifies error, logs to EventLogger, emits `data-error` to client. Handles broken writer gracefully (error still in event log).
- `logger` — the `EventLogger` instance
- `generatePlainText(opts)` — text-only generation with automatic run logging. Wrapped in try/catch → `emitError` + re-throw.
- `generate(schema, opts)` — one-shot structured generation via `generateText` + `Output.object()`. Accepts `reasoning?: { effort }`. Wrapped in try/catch → `emitError` + re-throw.
- `streamGenerate(schema, opts)` — streaming structured generation via `streamText` + `Output.object()` + `partialOutputStream` with `onPartial`. Accepts `reasoning?: { effort }`. `onError` callback uses `emitError`.

**Exports:**
- `thinkingProviderOptions(effort)` — Anthropic adaptive thinking provider options for `generate()`/`streamGenerate()` calls.

## Error Classification

`errorClassifier.ts` — inspects errors from the AI SDK / API calls and returns a `ClassifiedError` with a human-readable message safe for display.

**Error types:** `api_auth`, `api_rate_limit`, `api_overloaded`, `api_timeout`, `api_server`, `model_error`, `stream_broken`, `spend_cap_exceeded`, `internal`. All are `recoverable: false`. Detection: checks `APICallError` from `@ai-sdk/provider` (has `statusCode`, `responseBody`), then falls back to message pattern matching. Unknown errors fall through to `internal` ("Something went wrong during generation."). `spend_cap_exceeded` is not produced by `classifyError()` — it's a pre-flight rejection returned directly by the chat route as a 429 JSON response. The `MESSAGES` record is exported for reuse by route handlers.

**Error flow:** Three catch points cover the full surface:
1. `route.ts` outer catch — errors from `createSolutionsArchitect` / `createAgentUIStream`
2. `route.ts` inner catch — errors during stream consumption (manual reader loop replaces `writer.merge()`)
3. `generationContext.ts` wraps — errors from any LLM call, emits + re-throws so the tool's catch also handles it

Both route-level catch blocks (1 and 2) delegate to a local `handleRouteError(error, source)` closure that classifies, emits `data-error`, and calls `failProject()` to mark the project as `status: 'error'` with the classified `error_type`. `failProject` is fire-and-forget — Firestore failures don't block the error response. For cases where the process dies before any catch block runs (OOM, Cloud Run kill), `listProjects()` applies timeout inference as a backstop.

If the stream writer is broken (can't emit `data-error`), `emitError` catches silently — the error is in the run log, and the `useChat` hook's `error` property fires on the client as a fallback.

## Toast Notifications

`toastStore.ts` — module-level singleton following the builder pattern. Callable from anywhere via `showToast(severity, title, message?)`. Consumed by `useToasts()` hook + `ToastContainer` component (portal-mounted, top-right). Severities: `error` (persistent), `warning` (8s auto-dismiss), `info` (5s). Max 3 visible toasts.

## Builder

`builder.ts` — state machine scoped to the build page via `BuilderProvider` (`hooks/useBuilder.tsx`). `useBuilder()` reads from React context.

**Phases:** `Idle → Loading → Generating → Ready`. Generation progress is tracked via `GenerationStage` (`DataModel`, `Structure`, `Modules`, `Forms`, `Validate`, `Fix`) — metadata only meaningful during `phase === Generating`. Errors during generation are metadata (`GenerationError: { message, severity: 'recovering' | 'failed' } | null`) on the `Generating` phase, not a separate phase.

**All state is private with readonly getters.** Consumers read via getters (`builder.phase`, `builder.selected`, `builder.blueprint`, etc.) and mutate through methods only.

**Agent activity state** — five getters separate agent activity from build pipeline phase:
- `builder.agentActive` — true when the SA is processing a request. Set by BuilderLayout via `setAgentActive()` synced from `useChat` status (`submitted`/`streaming`).
- `builder.isGenerating` — true when `phase === Generating`.
- `builder.isThinking` — `agentActive && !isGenerating`. Works for both initial generation (before first data part arrives) and edit operations (phase stays `Ready`).
- `builder.postBuildEdit` — true when the agent reactivates after having gone idle in `Ready` phase (i.e., the user sent a new message after generation completed). `completeGeneration()` resets it to false; `setAgentActive(true)` sets it to true when `phase === Ready`. ChatSidebar uses this to distinguish post-build summary (reasoning) from user-initiated edits (editing).
- `builder.editMadeMutations` — true when the SA mutated the blueprint during the current post-build edit session (via `setFormContent` or `updateBlueprint`). Reset when a new edit session starts (`setAgentActive(true)` in Ready phase) and on `completeGeneration()`/`reset()`. ChatSidebar uses this with `postBuildEdit` to decide done vs idle: if `postBuildEdit && !editMadeMutations` the SA only asked questions → `'idle'`; otherwise → `'done'`.

**Stream energy** — two non-versioned channels for the SignalGrid neural activity display. Never trigger React re-renders.
- **Burst energy** (`injectEnergy` / `drainEnergy`) — from `applyDataPart()` bursts (200 for module/form completions, 100 for updates, 50 for stage transitions) and the intro sequence. Drives building-mode flashes when UI-visible changes occur.
- **Think energy** (`injectThinkEnergy` / `drainThinkEnergy`) — from message content deltas (text, reasoning, and tool input parts tracked by SignalGrid component, 2x multiplier). Drives reasoning-style neural firing in all modes. In building and editing modes, think energy creates hotspot/scatter activity layered on the sweep/defrag bars; burst energy triggers delivery flashes.

**Edit scope** — non-versioned `EditScope` tracking what the agent is currently editing. Set by `SignalGrid` from streaming tool call args (`moduleIndex`, `formIndex`, `questionPath`). `computeEditFocus()` maps scope + blueprint structure to a normalized `EditFocus` zone for the signal grid controller. Uses `flatIndexById()` from `questionTree.ts` for question-level precision — walks the tree structurally, no string parsing.

**Key members:**
- `builder.mb` — persistent MutableBlueprint instance (undefined before blueprint exists)
- `builder.blueprint` — getter returning `mb.getBlueprint()` (plain data for serialization)
- `builder.notifyBlueprintChanged()` — arrow property (stable ref), notifies subscribers after mutations
- `builder.treeData` — getter with four-level fallback: blueprint > partialModules merged with scaffold > scaffold > partialScaffold
- `builder.subscribe` / `builder.getSnapshot` — arrow properties for `useSyncExternalStore`. `_version` counter incremented in `notify()`.
- `builder.subscribeMutation` — arrow property for subscribing to blueprint/selection changes only (not UI-only state changes like phase labels or panel toggles). Fires from `notifyBlueprintChanged`, `undo`, `redo`, `select`, and `updateBlueprint`. Used by `ReferenceProviderWrapper` to invalidate cached question/case data.
- `builder.questionAnchor` / `builder.setQuestionAnchor` / `builder.subscribeAnchor` / `builder.getAnchorSnapshot` — selected question's DOM element, registered by `EditableQuestionWrapper` ref callback. Uses a **separate** listener set from the main `subscribe`/`notify` to avoid re-rendering the wrapper tree (which would re-trigger the ref callback in an infinite loop). `ContextualEditor` subscribes via `useSyncExternalStore(subscribeAnchor, getAnchorSnapshot)`.
- `builder.select(el?)` — set selection; call with no args to deselect. Consults `_editGuard` before proceeding — an inline editor (e.g. XPathField) can block selection changes while it has unsaved invalid content. `setEditGuard(guard)` / `clearEditGuard()` manage the guard. Intentionally does not gate `undo()`/`redo()` — those restore full snapshots including selection state.
- Progress counters (`progressCompleted`/`progressTotal`) derived from partialModules map against scaffold.

**New question state** — encapsulated behind methods, not public fields:
- `builder.markNewQuestion(path)` — called by QuestionTypePicker after inserting
- `builder.isNewQuestion(path)` — checks if question was just added (drives auto-focus + select-all)
- `builder.clearNewQuestion()` — called by ContextualEditor on first save

**Editor tab state** — `builder.editorTab` / `builder.setEditorTab(tab)`. Persists the active ContextualEditor tab (UI/Logic/Data) across component unmount/remount cycles (design↔preview mode switches). Reset to `'ui'` on question change.

**Data parts → builder methods:**

| Emission type | Builder method |
|---|---|
| `data-start-build` | `startGeneration()` |
| `data-schema` | `setSchema(caseTypes)` |
| `data-partial-scaffold` | `setPartialScaffold()` |
| `data-scaffold` | `setScaffold()` |
| `data-phase` | `advanceStage()` |
| `data-module-done` | `setModuleContent()` |
| `data-form-done` / `data-form-fixed` / `data-form-updated` | `setFormContent()` — updates `_mb.replaceForm()` in edit mode, `_partialModules` during build |
| `data-blueprint-updated` | `updateBlueprint()` |
| `data-fix-attempt` | `setFixAttempt()` |
| `data-done` | `completeGeneration()` |
| `data-project-saved` | `setProjectId()` |
| `data-error` | `setGenerationError()` |

`applyDataPart(builder, type, data)` — shared switch used by both real-time streaming (`onData`) and log replay.

### Undo/Redo

`HistoryManager` (`historyManager.ts`) — Proxy-based mutation interception on MutableBlueprint. Each snapshot stores `SnapshotEntry { blueprint, meta: SnapshotMeta, viewMode: ViewMode }`. `SnapshotMeta` captures mutation type (`add`/`remove`/`move`/`duplicate`/`update`/`rename`/`structural`), module/form indices, and `QuestionPath` values. `ViewMode` (`'overview' | 'design' | 'preview'`) captures which view the user was in when the edit was made. `deriveMeta()` maps method names + args to metadata; `duplicateQuestion` clone path is patched after execution. `undo()`/`redo()` return `{ mb, meta, viewMode }` — uses `MutableBlueprint.fromOwned()` to adopt popped stack entries without redundant cloning. Builder uses meta to derive smart selection (e.g., undo-remove re-selects the restored question, undo-add clears selection) and returns `viewMode` so BuilderLayout can restore the view. Drag guard: `builder.setDragging()` prevents undo/redo during drag operations. History cleared on form switch (in `select()`) and generation start (`startGeneration()`). Created in `completeGeneration()`, disabled during generation, cleared on `reset()`.

**View restoration:** `builder.setViewMode()` keeps HistoryManager's `viewMode` in sync (called by BuilderLayout on each render). On undo/redo, `builder.undo()`/`redo()` return the captured `ViewMode`. BuilderLayout's `restoreView()` switches viewMode if needed and syncs the preview nav stack to the restored selection when in design/preview mode — so the user is "teleported" back to where the edit was made.

### Keyboard Shortcuts

`KeyboardManager` (`keyboardManager.ts`) — module-level singleton, single `document.keydown` listener. Input suppression (input/textarea/select/contenteditable/.cm-content) unless `global: true`. `useKeyboardShortcuts` hook uses `useSyncExternalStore`'s subscribe lifecycle for register/unregister.

`questionNavigation.ts` — `flattenQuestionPaths()` returns `QuestionPath[]` for Tab/Shift+Tab navigation through the question tree.

## Expander

Split across four files:
- `hqJsonExpander.ts` — `expandBlueprint()` orchestrator + `detectUnquotedStringLiteral()`
- `xformBuilder.ts` — `buildXForm()`, `buildQuestionParts()`, `buildConnectBlocks()`, `InstanceTracker`, `getAppearance()`, `getXsdType()`
- `formActions.ts` — `buildFormActions()`, `buildCaseReferencesLoad()`
- `connectConfig.ts` — `deriveConnectDefaults()` fills defaults for Connect sub-configs that are already present (never auto-creates sub-configs). Assigns default `id` values and fills missing field values. `normalizeConnectConfig()` strips empty sub-configs (e.g. task with blank name/description) so absent data stays absent in XForm output. Called from `MutableBlueprint.updateForm()`.

`expandBlueprint()` converts `AppBlueprint` → HQ import JSON. `detectUnquotedStringLiteral()` uses the Lezer XPath parser to flag bare words in XPath fields (e.g. `no` instead of `'no'`).

**`case_list_only` modules** — CommCare requires every case type to be declared as a module's primary `case_type`. Child case types with no follow-up workflow use `case_list_only: true` on their module. The expander sets `case_list.show = true` and `case_list.label` on these modules so HQ accepts them.

**Markdown itext** — all itext entries (labels, hints, option labels) emit both `<value>` and `<value form="markdown">`. CommCare only renders markdown when the markdown form is present; without it, syntax like `**bold**` renders as literal text. This is safe for plain text — identical rendering when no markdown syntax is present.

**Vellum hashtag expansion** — dual-attribute pattern matching CommCare's Vellum editor. All three hashtag types (`#form/`, `#case/`, `#user/`) are expanded via the Lezer XPath parser's `HashtagRef` node (with `HashtagType` and `HashtagSegment` children). `expandHashtags()` in `commcare/hashtags.ts` is the single expansion point:
- `#form/question` → `/data/question` (trivial, hardcoded in Vellum).
- `#case/property` → full `instance('casedb')/...` XPath.
- `#user/property` → full user-case `instance('casedb')/...` XPath.
- Real attributes (`calculate`, `relevant`, `constraint`, `value`) get expanded XPath.
- Vellum attributes (`vellum:calculate`, `vellum:relevant`, `vellum:value`) preserve original shorthand.
- Every bind gets `vellum:nodeset="#form/..."`, every setvalue gets `vellum:ref="#form/..."`.
- Vellum metadata (`vellum:hashtags`, `vellum:hashtagTransforms`) — JSON on binds with `#case/` or `#user/` refs only.
- `<output value="..."/>` tags in labels get `vellum:value` preserving shorthand when expansion occurs.
- **Bare hashtags in prose** — labels/hints may contain bare `#case/foo` text (not wrapped in `<output>` tags). `wrapBareHashtags()` auto-wraps these in `<output value="..."/>` before expansion. Uses regex (not Lezer) because labels are prose, not XPath — the Lezer parser can't find hashtags in prose text (surrounding chars like `**` get parsed as XPath operators, swallowing the `#`).
- `case_references_data.load` — form-level JSON mapping question paths to `#case/` refs.
- **Secondary instances** — `InstanceTracker` accumulates required instances (`casedb`, `commcaresession`) at the point of use during the build. `buildQuestionParts` scans XPath fields and labels; `buildConnectBlocks` scans Connect XPath expressions. `casedb` implies `commcaresession` (case XPath uses session for case_id). No post-hoc string scanning — requirements are registered where binds are generated.

**Case config derivation** (`deriveCaseConfig(questions, formType, moduleCaseType, caseTypes)`):
- Groups questions by `case_property_on` value. Primary case (matches module case type) vs child cases (different case type).
- Registration: primary `case_property_on` questions → `case_properties` map. `id === 'case_name'` → `case_name_field`.
- Followup: primary questions → both `case_preload` and `case_properties`. `id === 'case_name'` → `case_name_field`.
- Survey: no case config.
- Child cases: questions with `case_property_on` naming a non-primary case type → auto-derived `DerivedChildCase[]` with case_type, case_name_field, case_properties, relationship (from case_types), and repeat_context (auto-detected from question tree).

Called on-demand by expander and validator — no form-level case fields stored.

## Compiler (cczCompiler.ts)

`CczCompiler` takes HQ import JSON → `.ccz` Buffer. Generates suite.xml, profile.ccpr, app_strings.txt. Injects case blocks (create/update/close/subcases) back into XForm XML via `addCaseBlocks()`.

Entry definitions (datums, stack frames) are derived via the session module (`commcare/session.ts`) — the compiler just serializes them. After case block injection, every XForm is validated via `validateXFormXml()` — checking that all bind nodesets, control refs, setvalue targets, and itext references resolve to actual nodes. Suite.xml is also parsed to verify well-formedness. The compiler throws on any structural issue, preventing broken .ccz files from being packaged.

## Session & Navigation (commcare/session.ts)

Single source of truth for CommCare session mechanics: entry datums, stack operations, form linking.

### Stack Operation Model

CommCare Core processes three operation types after form submission. All three are modeled in `StackOperation`:

| Operation | XML | Behavior | Used by Nova |
|---|---|---|---|
| `create` | `<create>` | Push a new navigation frame onto the stack | Yes — all destinations + form links |
| `push` | `<push>` | Add steps to the current frame | Typed, not generated |
| `clear` | `<clear>` | Remove frames from the stack (wipe history) | Typed, not generated |

Key behavioral differences:
- **No `<stack>` at all**: form frame popped, user returns to previous navigation level (case list, module menu, etc.)
- **`<create/>` (empty)**: new empty frame pushed → no command → resolves to home
- **`<clear/>`**: stack is explicitly wiped → session ends → home

These are NOT the same. A user deep in Home → Module → Case List → Form would go back to the Case List with no `<stack>`, but to Home with `<create/>` or `<clear/>`. Nova omits `<stack>` entirely when `post_submit` is absent (CommCare's natural pop-back behavior). When `post_submit` is `'default'`, an empty `<create/>` is generated to force navigation home.

### Entry Derivation

`deriveEntryDefinition()` combines session datums (what a form needs before opening) and stack operations (where to go after submission) into a single `EntryDefinition` that the compiler serializes to suite.xml. Currently supports single case_id datum for followup forms.

### Post-Submit Destinations

Users and the SA see three choices (`USER_FACING_DESTINATIONS`). Two additional values exist for CommCare export fidelity (`POST_SUBMIT_DESTINATIONS`) and are resolved automatically.

| Destination | User-facing | Suite.xml Stack | Status |
|---|---|---|---|
| `default` | "App Home" | `<create/>` (empty) | Implemented |
| `root` | *(internal)* | `<create><command value="'root'"/></create>` | Implemented — same as default until `put_in_root` is modeled |
| `module` | "This Module" | `<create><command value="'m{idx}'"/></create>` | Implemented |
| `parent_module` | *(internal)* | Same as module | Stub — falls back to module until nested modules are modeled |
| `previous` | "Previous Screen" | `<create>` with module cmd + case datums | Implemented |

### Form Linking

`form_links` on BlueprintForm enables conditional navigation to other forms/modules. `deriveFormLinkStack()` generates one `<create>` per link (with `ifClause` from the link's condition), plus a fallback `<create>` whose condition negates all link conditions. `detectFormLinkCycles()` provides DFS-based circular link detection.

**Implemented:** Stack generation, fallback frame generation, cycle detection, full validation.
**Not wired:** SA tools (no `form_links` parameter), FormSettingsPanel UI, preview engine navigation, HQ export of `form_links` array. Setting `form_links` directly on the blueprint will generate correct suite.xml and pass validation.

**Auto datum matching not implemented.** CommCare HQ's `_find_best_match()` automatically matches datums between source and target forms by ID + case_type. Nova's form links require manual `datums` when the target form needs session variables. When auto datum matching is implemented, it must handle: same ID + same case_type (perfect match), different ID + same case_type (datum rename), and surface explicit warnings rather than silent fallback.

### Edge Cases & Gaps

**`put_in_root` (CommCare's "Menu Mode: Display only forms"):**
CommCare's `put_in_root` boolean on modules flattens navigation — the module's forms appear directly in the parent menu instead of inside a module menu. This has cascading effects on post-submit navigation:
- `'module'` becomes invalid (there IS no module menu — forms are at root level). HQ errors: "form link to display only forms."
- `'root'` and `'default'` diverge: `'root'` shows the root menu (which includes the flattened forms), `'default'` clears the session entirely.
- `'parent_module'` with a `put_in_root` parent also becomes invalid (same reason — parent has no menu).

When `put_in_root` is added to `BlueprintModule`:
1. Add validation: `'module'` is invalid when `mod.put_in_root`
2. The build should auto-resolve `'module'` → `'root'` for `put_in_root` modules
3. The `'root'` vs `'default'` distinction becomes meaningful — update the UI to surface `'root'` as a separate option ("Main Menu" vs "App Home") only when `put_in_root` modules exist in the app

**Validated but behavior not yet modeled (validation stubs activate when features are added):**
- `module` + `put_in_root` — see above. Currently checked via `case_list_only` as a partial equivalent.
- `parent_module` + `root_module` — Always errors today (parent modules not modeled). When `root_module` is added to `BlueprintModule`, check: parent exists AND parent is not `put_in_root`.
- `previous` + `multi_select` — HQ errors when module and root module have mismatched multi-select. When `is_multi_select` is added, check the mismatch.
- `previous` + `inline_search` — HQ errors when a followup form's module uses inline search (search results can't be restored). When inline search is added, check this combination.

**Not yet implemented (documented for when these features are built):**
- **Auto datum matching** for form links (manual datums required)
- **Shadow module resolution** for form link targets (`form_module_id` in HQ)
- **`<push>` operations** — typed but never generated. Used in HQ for appending steps to existing frames.
- **`<clear>` operations** — typed but never generated. Used in HQ for explicit stack wiping. Our `default` destination uses empty `<create/>` which achieves the same home-navigation result.
- **Form link export to HQ JSON** — `form_links` is validated and generates suite.xml, but the HQ import JSON `form_links` array is not populated from the blueprint. The `hqShells.ts` form shell still exports an empty `form_links: []`. When wired, must map blueprint's index-based targets to HQ's unique_id-based `form_id`/`module_unique_id`.
- **SA tool + UI surface for form links** — `updateForm`/`createForm` tools don't accept `form_links`. `FormSettingsPanel` doesn't display them. The preview engine doesn't navigate to linked forms after submission.

### HQ Workflow Mapping

`toHqWorkflow()` / `fromHqWorkflow()` convert between Nova's `PostSubmitDestination` and CommCare HQ's `post_form_workflow` strings. When `form_links` are present, the expander should set `post_form_workflow: 'form'` and populate `form_links` + `post_form_workflow_fallback` in the HQ JSON — this is not yet wired.

## AutoFixer (autoFixer.ts)

Post-expansion XML fixes for CommCare app issues (itext conversion, reserved property names in XML, missing case binds). Operates on generated XForm XML, not the blueprint.

## CommCare Module (commcare/)

Shared platform module: `constants.ts` (reserved words, regex, length limits), `xml.ts` (escapeXml), `hashtags.ts` (Vellum expansion), `ids.ts` (hex ID gen), `hqTypes.ts` (HQ JSON interfaces), `hqShells.ts` (factory functions), `validate.ts` (identifier validation).

**WAF workaround in `hqShells.ts`:** HQ's app import endpoint (`ImportAppStepsView`) is missing a `waf_allow('XSS_BODY')` WAF exemption that all other XForms-handling endpoints have. The AWS WAF inspects the first 16KB of the request body for XSS patterns and blocks when it finds XForms elements like `<input>`, `<select>`, `<upload>` that look like HTML tags. `applicationShell()` includes ~50 standard HQ Application properties before `_attachments` to push the XForms XML past the 16KB inspection window. These properties must appear before `modules` and `_attachments` in key order — do not reorder them.

### Validation System (commcare/validate/)

Rule-based validation system that catches every error CommCare HQ would catch during a build. Each check is a discrete function that returns structured `ValidationError[]` objects with typed error codes, scope, location, and details.

**Architecture:**
- `errors.ts` — `ValidationError` interface with `ValidationErrorCode` union (~40 codes), `errorToString()` for SA-facing messages.
- `runner.ts` — `runValidation(blueprint)`: single entry point. Walks the blueprint tree once running scope-appropriate rules, then runs deep XPath validation.
- `rules/app.ts` — App-level rules: empty app name, duplicate module names, child case type missing module, circular form links.
- `rules/module.ts` — Module-level rules: case type presence/format/length, case_list_only constraints, case list column presence, column field validation against known case properties.
- `rules/form.ts` — Form-level rules: empty form, case config validation (name field, reserved/invalid/duplicate properties, length limits, media types, preload), close_case, post_submit (destination validity, parent_module without parent, module on case_list_only), form_links (empty array, target existence, self-reference, missing fallback), Connect config. Derives case config once per form.
- `rules/question.ts` — Question-level rules (recursive): select no options, hidden no value, unquoted string literals, invalid question ID format.
- `fixes.ts` — `FIX_REGISTRY`: `Map<ValidationErrorCode, FixFn>` mapping error codes to auto-fix functions. The fix loop in `validationLoop.ts` dispatches by error code.

**XPath Deep Validation** (unchanged, called by runner):
- `functionRegistry.ts` — `FUNCTION_REGISTRY`: static `Map<string, FunctionSpec>` for all ~65 CommCare XPath functions + XPath 1.0 core. Each entry has `minArgs`, `maxArgs`, `returnType` (`XPathType`), and optional `paramTypes` array. Source of truth for arities: commcare-core's `ASTNodeFunctionCall.java`. Source of truth for types: XPath 1.0 spec + CommCare runtime. `findCaseInsensitiveMatch()` powers "did you mean?" suggestions.
- `typeChecker.ts` — Bottom-up type inference over the Lezer CST. Infers `XPathType` (`string | number | boolean | nodeset | any`) for every node, then checks operator/function constraints via a declarative `OPERATOR_TYPES` table. Flags provably-lossy coercions: non-numeric string literals in numeric contexts (e.g. `- 'hello'`, `'text' * 2`, `round('foo')`). Allows legitimate patterns: nodeset coercion (unknowable), numeric string literals (`'5' + 3`), boolean↔number coercion.
- `xpathValidator.ts` — `validateXPath(expr, validPaths?, caseProperties?)`: comprehensive Lezer CST walker. Three phases: `⚠` → syntax error, `Invoke` → function name + arity, type checker → type errors, path refs → node existence, `HashtagRef` → case property existence.
- `index.ts` — `validateBlueprintDeep(blueprint)`: deep XPath orchestrator called by `runner.ts`. Per-form: walks all XPath fields, runs cycle detection via `TriggerDag.reportCycles()`. Cross-form: validates `#case/prop` references against `blueprint.case_types`. Exports `collectValidPaths()` and `collectCaseProperties()` for reuse by the CodeMirror linter.

**Post-expansion XForm validation** (called by validationLoop and CczCompiler):
- `xformValidator.ts` — `validateXFormXml(xml, formName, moduleName)`: parses generated XForm XML with htmlparser2, validates that all bind nodesets, body control refs, setvalue targets, and itext references resolve to actual instance nodes. Catches orphaned binds (the `"Bind Node found but has no associated Data node"` class of errors from Vellum/FormPlayer). Used in two places: the validation loop (after `expandBlueprint`) and the CczCompiler (after case block injection).

**HQ build checks fully covered:**
- **Form workflows** — All `post_submit` destinations validated (value, context, edge cases). Form linking (`form_links`) fully validated: target existence, self-reference, circular detection (app-level DFS), missing fallback for conditional links, empty array. Auto datum matching not yet implemented (manual datums required). Source: `validators.py:1054-1105`. See "Session & Navigation" section for detailed gap list.

**HQ build checks NOT yet covered** (add validation when we build these features):
- **Shadow modules** — HQ validates source module exists, shadow parent tags present. Source: `validators.py:927-936`.
- **Parent select / child module cycles** — HQ checks for circular parent_select and root_module references between modules. Source: `validators.py:225-250`. We only check within-form cycles currently.
- **Case search config** — HQ validates search nodeset instances, grouped vs ungrouped properties, search_on_clear + auto_select conflicts. Source: `validators.py:511-557`.
- **Case tile configuration** — HQ validates tile templates, row conflicts, address formats, clickable icons. Source: `validators.py:656-715`.
- **Smart links** — HQ validates endpoint presence, conflicts with parent select / multi-select / inline search. Source: `validators.py:435-466`.
- **Case list field actions** — HQ validates endpoint_action_id references resolve. Source: `validators.py:559-572`.
- **Sort field format** — HQ validates case list sort fields match a specific regex pattern. Source: `validators.py:630-642`.
- **Multimedia references** — HQ validates multimedia attachments exist for any referenced media. Not relevant until we support image/audio in case details.
- **Multi-language** — HQ validates no empty language codes, itext entries exist for all languages. We only generate single-language (English) apps currently.
- **Itemset validation** — FormPlayer validates itemset nodeset/label/copy/value relationships, referenced instances exist, copy targets are repeatable. Source: `XFormParser.java:2554-2619`. Relevant when we support dynamic select lists from lookup tables.
- **Repeat homogeneity** — FormPlayer validates all repeated nodes for a binding are structurally identical. Source: `XFormParser.java:2383`. Our generator produces uniform repeats, but should validate if we ever allow manual XForm editing.

## Event Logging

`eventLogger.ts` — flat event stream logger. Every event is a `StoredEvent` (envelope + discriminated `LogEvent` union).

**EventLogger class** (`eventLogger.ts`): created once per request.
- `enableFirestore(email, projectId)` — activates Firestore sink. Called by the route handler for authenticated users.
- `logStep(step)` — writes a `StepEvent`. Matches tool results from the SDK's `onStepFinish` callback to tool calls by `toolCallId`, so every tool's return value (including errors) appears in the log automatically. Also drains buffered sub-generation results by name. Computes `TokenUsage`.
- `logEmission(type, data)` — writes an `EmissionEvent` immediately (real-time, not batched). `step_index` associates it with the current step for replay grouping.
- `logSubResult(label, result)` — buffers sub-generation usage data (consumed by `logStep` for tool call matching).
- `logError(error, context?)` — writes an `ErrorEvent` immediately.
- `logConversation(messages)` — writes a `MessageEvent` for the current request's user message.
- `finalize()` — async, awaits a single `incrementUsage` call to flush accumulated request-level cost. Idempotent (`_finalized` guard) — safe to call from the execute `finally` block, `onFinish`, and `req.signal.abort` without double-writing. On failure, logs and moves on — the pre-request `getMonthlyUsage()` read is the fail-closed gate (see `lib/db/usage.ts`). Also accumulates cost across steps in private fields (`_usageInputTokens`, `_usageOutputTokens`, `_usageCost`), including inner tool sub-generation costs.
- `estimateCost()` — exported helper for token cost calculation using `MODEL_PRICING`.

**Firestore sink**: One document per event at `users/{email}/projects/{projectId}/logs/`. Fire-and-forget writes. `ignoreUndefinedProperties: true` on the Firestore instance silently drops `undefined` values (produced by `stripEmpty()` converting sentinel strings back). Zod `z.discriminatedUnion` validates reads.

**Event types** (`StoredEvent` in `lib/db/types.ts`):
- Envelope: `run_id`, `sequence` (monotonic), `request` (HTTP boundary), `timestamp` (ISO 8601)
- `MessageEvent` (`type: 'message'`) — user message `id` + `text`
- `StepEvent` (`type: 'step'`) — `step_index`, `text`, `reasoning`, `tool_calls: LogToolCall[]`, `usage: TokenUsage`
- `EmissionEvent` (`type: 'emission'`) — `step_index`, `emission_type`, `emission_data: JsonValue`
- `ErrorEvent` (`type: 'error'`) — `error_type`, `error_message`, `error_raw`, `error_fatal`, `error_context`

**`JsonValue`** — recursive JSON type (`string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }`). Used for emission payloads and tool call args/outputs. Guarantees serialization fidelity without `unknown`.

## Log Replay

Client-side replay of event logs through Builder without API calls. Consumes `StoredEvent[]` from Firestore.

**Firestore-based**: `/builds` page Replay button → fetch `GET /api/projects/{id}/logs` → `extractReplayStages(events)` → consume-once store → `/build/new` → `ReplayController` drives Builder.

`logReplay.ts` — `extractReplayStages(events: StoredEvent[])` pre-indexes emissions by `step_index`, then walks step events sequentially. Each step's tool calls become replay stages. Multi-tool steps split by `moduleIndex`/`formIndex` via `distributeEmissions`. Progressive chat messages built from message and step events. Uses `applyDataPart()` — same code path as real-time streaming. Returns `doneIndex` — index of the synthetic "Done" stage — so consumers can start at the completed app state.

**Replay store** — `setReplayData()` deposits stages into a module-level singleton; `consumeReplayData()` reads and clears it atomically. The store is always drained on first read, so stale replay state can never leak across navigations. BuilderLayout calls `consumeReplayData` inside a `useState` initializer so it executes exactly once on mount.

## Model Configuration

The SA agent uses `SA_MODEL` (Opus) and `SA_REASONING` (max effort) from `lib/models.ts`. These are code constants — not user-configurable. To change the model, update `lib/models.ts` and deploy. Reasoning uses Anthropic adaptive thinking (`type: 'adaptive'`) with the configured effort level.
