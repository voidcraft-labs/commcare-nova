# CommCare Nova

Next.js web app that generates CommCare apps from natural language conversation.

## Stack

- **Framework**: Next.js 16 (App Router, Turbopack)
- **Language**: TypeScript (strict mode)
- **Styling**: Tailwind CSS v4 with `@theme inline` custom properties
- **Animation**: Motion (imported as `motion/react`, NOT `framer-motion`)
- **Validation**: Zod v4
- **AI**: Vercel AI SDK (`ai` + `@ai-sdk/react` + `@ai-sdk/anthropic`) — `ToolLoopAgent`, `createUIMessageStream`, `createAgentUIStream`, `useChat`, `generateText`, `streamText`, `Output.object()`
- **Markdown**: marked (allowlist renderer in `lib/markdown.ts` — headings, bold, italic, lists, tables, hr, code; blocks links, images, raw HTML)
- **Icons**: Coolicons (`@iconify-icons/ci`) + Tabler (`@iconify-icons/tabler`) via `@iconify/react`
- **Testing**: Vitest

## Project Structure

```
app/                    # Next.js App Router pages and API routes
  api/
    chat/               # Single endpoint — Solutions Architect agent
    compile/            # CCZ compilation + download
    models/             # Anthropic models list proxy (POST with apiKey)
  build/[id]/           # Main builder view (3-panel layout)
  builds/               # Build history
  settings/             # Settings page (API key, pipeline model/token config, log replay)
components/
  builder/              # AppTree, DetailPanel, GenerationProgress, ReplayController
  chat/                 # ChatSidebar, ChatMessage, ChatInput, QuestionCard, ThinkingIndicator
  ui/                   # Button, Input, Badge, Logo
hooks/                  # useBuilder, useSettings, useApiKey
lib/
  services/
    solutionsArchitect.ts # Solutions Architect agent — single ToolLoopAgent with 21 tools
    builder.ts          # Builder class — singleton state machine for the build lifecycle
    mutableBlueprint.ts # MutableBlueprint class — wraps AppBlueprint for progressive population and mutation
    generationContext.ts # GenerationContext class — shared LLM abstraction for all calls (supports extended thinking)
    runLogger.ts        # RunLogger class — disk-based run logger (writes JSON to .log/ when RUN_LOGGER=1)
    logReplay.ts        # Log replay — stage extraction from RunLog + module-level singleton store
    hqJsonExpander.ts   # Blueprint → HQ import JSON (XForm XML, form actions, Vellum metadata)
    cczCompiler.ts      # HQ import JSON → .ccz archive (adds case blocks, suite.xml)
    autoFixer.ts        # Programmatic fixes for common CommCare app issues
    commcare/           # Shared CommCare platform module (constants, XML, hashtags, HQ types/shells)
    __tests__/          # Vitest tests for expander, compiler, commcare module, mutableBlueprint
  schemas/
    blueprint.ts        # Zod schemas for AppBlueprint + generation schemas (caseTypesOutput, scaffoldModules, moduleContent)
    contentProcessing.ts # Post-processing utilities: flat→nested tree, strip sentinels, apply data model defaults
  prompts/              # Agent prompts (solutionsArchitectPrompt, schemaPrompt, scaffoldPrompt)
  types/                # TypeScript type definitions
  models.ts             # Central model pricing config + DEFAULT_PIPELINE_CONFIG
  store.ts              # CCZ file persistence in .data/
scripts/
  test-schema.ts            # Structured output schema test (sends schema to Haiku, verifies compilation)
  sync-knowledge.ts         # Knowledge sync pipeline entry point
  knowledge/                # Pipeline phases: discover, crawl, triage, distill, reorganize
```

## Key Architecture Decisions

### Single Solutions Architect Agent

A single `POST /api/chat` endpoint runs everything. One `ToolLoopAgent` — the **Solutions Architect (SA)** — converses with users, incrementally generates apps through focused tool calls, and edits them. All within one conversation context and one prompt-caching window.

The SA has **21 tools** in 5 groups:

**Conversation (1):**
- **`askQuestions`** (client-side, no `execute`) — structured multiple-choice questions rendered as `QuestionCard`. `sendAutomaticallyWhen` re-sends when all questions are answered.

**Generation (4)** — each takes natural language instructions, runs structured output generation internally, returns a summary:
- **`generateSchema`** — designs case types + properties. Emits `data-start-build` to trigger layout transition.
- **`generateScaffold`** — designs module/form structure. Emits `data-phase: structure`, streams partial scaffold.
- **`addModule`** — generates case list/detail columns for a module.
- **`addForm`** — generates all questions for a form via structured output.

**Read (4):**
- `searchBlueprint`, `getModule`, `getForm`, `getQuestion`

**Mutation (11):**
- `editQuestion`, `addQuestion`, `removeQuestion`, `updateModule`, `updateForm`, `createForm`, `removeForm`, `createModule`, `removeModule`, `renameCaseProperty`, `regenerateForm`

**Validation (1):**
- **`validateApp`** — runs `validateAndFix()` loop, emits `data-done`.

**Typical build sequence:**
```
SA: askQuestions (rounds of clarification)
SA: generateSchema → data model
SA: generateScaffold → module/form structure
SA: addModule × N → case list columns
SA: addForm × N → form questions
SA: validateApp → done
```

The SA makes all architecture decisions (entities, relationships, module structure, form purposes). Generation tools handle detail work (question IDs, XPath, group structure).

### MutableBlueprint as Single State Container

`MutableBlueprint` is the single state container throughout the entire lifecycle:
- **New build**: Route creates `MutableBlueprint({ app_name: '', modules: [], case_types: null })`. Generation tools progressively populate it via `setCaseTypes()`, `setScaffold()`, `updateModule()`, `replaceForm()`.
- **Edit/continuation**: Route creates `MutableBlueprint(existingBlueprint)`. SA uses read/mutation tools directly.

### GenerationContext

`lib/services/generationContext.ts` exports a `GenerationContext` class — the **single place** all LLM calls flow through. Wraps an Anthropic client + UI stream writer + RunLogger + PipelineConfig.

- **`model(id)`** — returns the Anthropic model provider
- **`pipelineConfig`** — readonly `PipelineConfig` (merged with `DEFAULT_PIPELINE_CONFIG`). Pipeline stages read model IDs and max tokens from here.
- **`emit(type, data)`** — writes a transient data part to the client stream
- **`logger`** — the `RunLogger` instance
- **`generatePlainText(opts)`** — text-only generation with automatic run logging
- **`generate(schema, opts)`** — one-shot structured generation via `generateText` + `Output.object()` with automatic run logging. Accepts `reasoning?: { effort }`.
- **`streamGenerate(schema, opts)`** — streaming structured generation via `streamText` + `Output.object()` + `partialOutputStream` with `onPartial` callback. Accepts `reasoning?: { effort }`.
- **`reasoningForStage(stage)`** — returns `{ effort }` if reasoning is enabled and the model supports it, `undefined` otherwise.

Also exports **`withPromptCaching`** — a shared `prepareStep` config that marks the last message with Anthropic's `cache_control: ephemeral`. Spread into the SA's `ToolLoopAgent` constructor so prior conversation turns are cached across steps.

### Client State via `onData` (No useEffect Scanning)

All builder state updates flow through the `onData` callback on `useChat`. The server emits transient data parts, and `onData` fires once per part. No `useEffect` scans messages.

Data parts emitted:
- `data-start-build` → `builder.startDataModel()` (triggers layout transition)
- `data-schema` → `builder.setSchema(caseTypes)`
- `data-partial-scaffold` → `builder.setPartialScaffold()` (progressive scaffold streaming)
- `data-scaffold` → `builder.setScaffold()`
- `data-phase` → `builder.setPhase()` (structure, forms, validate, fix)
- `data-module-done` → `builder.setModuleContent()`
- `data-form-done` / `data-form-fixed` / `data-form-updated` → `builder.setFormContent()`
- `data-blueprint-updated` → `builder.updateBlueprint()` (structural edits)
- `data-fix-attempt` → `builder.setFixAttempt()`
- `data-done` → `builder.setDone()` (blueprint + hqJson)
- `data-error` → `builder.setError()`

### Single useChat

`BuilderLayout` has one `useChat` instance targeting `/api/chat`. No second generation instance, no client-side orchestration, no round-trips.

- **`body`** sends `apiKey`, `pipelineConfig`, `blueprint` (for edits), and `blueprintSummary` (for SA context) per request
- **`sendAutomaticallyWhen`** only triggers for `askQuestions` (client-side tool), not server-side tool completions
- **`onData`** handles all builder state updates (see above)

### Chat-Centered Landing

Chat is the hero experience. When `builder.phase === Idle && !builder.treeData`, the chat fills the center of the screen (`isCentered = true`) with a large hero Logo above the welcome heading and input — no header bar, just one continuous `bg-nova-void` background. When generation starts (DataModel phase), the logo animates from center to the top-left header position via `layoutId="nova-logo"`, the header slides in (animated `height: 0 → auto`), and the chat narrows to its 380px sidebar position — all coordinated by `LayoutGroup` wrapping the entire layout including the header. `AnimatePresence` fades in builder panels (150ms delay). No DOM re-parenting — messages and input state are preserved throughout the transition.

### Builder Class

`lib/services/builder.ts` exports a `Builder` class — a singleton state machine shared across components via `useBuilder()`. Phases: `Idle → DataModel → Structure → Forms → Validate → Fix → Done | Error`.

- `builder.startDataModel()` — transitions to DataModel phase ("Designing data model...")
- `builder.setSchema(caseTypes)` — stores case types from schema generation
- `builder.setPartialScaffold(partial)` — updates tree progressively from streaming structured output
- `builder.setScaffold(scaffold)` — stores completed scaffold
- `builder.setModuleContent(moduleIndex, columns)` / `builder.setFormContent(moduleIndex, formIndex, form)` — updates partial modules, auto-derives progress counts
- `builder.setPhase(phase)` / `builder.setFixAttempt(attempt, errorCount)` — phase transitions from data parts
- `builder.setDone(result)` / `builder.setError(message)` — terminal states
- `builder.treeData` — getter with four-level fallback: `blueprint` > `partialModules` merged with scaffold > `scaffold` > `partialScaffold`
- `builder.subscribe(listener)` — triggers React re-renders on state changes
- Progress counters (`progressCompleted`/`progressTotal`) are derived from the `partialModules` map against the scaffold.

### Data Model Defaults (Case Properties as Source of Truth)

`case_types` on the blueprint carry rich property metadata: `label`, `data_type`, `hint`, `help`, `required`, `constraint`, `constraint_msg`, `options`. This makes case properties the single source of truth for shared question metadata.

**Questions are sparse** — when a question maps to a case property via `case_property`, it only needs to carry overrides (e.g. `relevant`, `calculate`, `default_value`). Defaults are merged at two points:
1. **Content post-processing** (`contentProcessing.ts`) — `applyDefaults()` auto-merges from the case type at assembly time (type, label, hint, help, required, constraint, options, is_case_name). Also runs `unescapeXPath()` on all XPath fields to sanitize HTML entities (`&gt;` → `>`) that LLMs sometimes emit.
2. **Expander** — `mergeQuestionDefaults()` / `mergeFormQuestions()` merge before XForm generation and validation

`is_case_name` is auto-derived from `case_name_property` in the case type definition — the LLM only sets it explicitly to override.

### Structured Output Schema Constraints

The Anthropic schema compiler times out with >8 `.optional()` fields per array item (each creates an `anyOf` union in JSON Schema). The `singleFormSchema` in `solutionsArchitect.ts` uses a hybrid approach:
- **8 optional fields** (sparse, saves tokens): `hint`, `help`, `constraint`, `constraint_msg`, `relevant`, `calculate`, `default_value`, `options`
- **4 required sentinel fields** (almost always present, low cost): `label` (empty string), `required` (empty string), `case_property` (empty string), `is_case_name` (false)
- **`type`** uses `z.enum(QUESTION_TYPES)` (enums don't create `anyOf` unions)

Post-processing (`stripEmpty` in `contentProcessing.ts`) converts sentinel values back to undefined.

Use `npx tsx scripts/test-schema.ts` to verify schemas compile against Haiku.

### Per-Question Case Property Mapping

The LLM doesn't manage form-level case wiring. Instead, each question has:
- **`case_property`** — which case property this question maps to (or null)
- **`is_case_name`** — auto-derived from `case_name_property` in the case type, or explicitly set to override

The assembler (`deriveCaseConfig()`) derives form-level `case_name_field`, `case_properties`, and `case_preload` automatically:
- **Registration**: all questions with `case_property` → `case_properties` map. Question with `is_case_name` → `case_name_field`.
- **Followup**: questions with `case_property` → `case_preload` (load from case) AND `case_properties` (save back). Question with `is_case_name` → `case_name_field`.
- **Survey**: no case config derived.

`deriveCaseConfig()` is called on-demand by the expander and validator — no form-level case fields are stored.

### Case List Columns

Case list columns are fully controlled by the LLM — no columns are auto-prepended or filtered by the expander/compiler. The LLM can use any case property as a column field, including `case_name`. Reserved property restrictions only apply to `case_properties` (the update block), not to display columns.

### Bring-Your-Own-API-Key

No auth layer. The user's Anthropic API key is stored in localStorage (inside `nova-settings`) and sent per request via the AI SDK's `body` option. Never persisted server-side.

## Chat Components

- **`ChatSidebar`** — Message list + input. Accepts `mode: 'centered' | 'sidebar'`, optional `readOnly` (hides input, used by log replay). Centered mode renders below the hero Logo with no header/border, uniform `gap-6` spacing. Sidebar mode is the 380px docked panel with `p-4` messages and `border-t` input. Uses `layout` + `layoutId` for animated transition between modes. Reads `builder.phase` to suppress thinking indicator when the builder is active.
- **`ChatMessage`** — Iterates `message.parts`: renders text bubbles for `text` parts, `QuestionCard` for `tool-askQuestions` parts. Assistant text is rendered through `renderMarkdown()` (allowlist-based marked renderer); user text is plain `whitespace-pre-wrap`. All other tool/data parts are ignored in chat (handled by `onData` in BuilderLayout).
- **`QuestionCard`** — Animated stepper with local state. Shows questions one at a time with option buttons. Answered questions display as checkmark + answer. Calls `addToolOutput` when all questions are answered. Also accepts a `pendingAnswerRef` — when the user types a message while a question is waiting, `ChatSidebar` routes it through this ref instead of sending a chat message. Typed answers are prefixed with `"User Responded: "` so the SA knows the user typed free-form text rather than picking an option.
- **`ThinkingIndicator`** — Orbital violet dot animation. Shown when chat status is `submitted`/`streaming` AND builder phase is `Idle` AND scaffold is not in-flight.

## Schemas

### Question Fields
Only `id` and `type` are required on a `Question`. All other fields (`label`, `hint`, `help`, `required`, `constraint`, `constraint_msg`, `relevant`, `calculate`, `default_value`, `options`, `case_property`, `is_case_name`, `children`) are optional — present only when set. All text fields are plain `string`.

### Question Format
- One `Question` type with nested `children` arrays for groups/repeats
- The stored schema supports one level of nesting, but the SA's per-type tools with `parentId` can build arbitrarily deep structures
- Questions carry `case_property` and `is_case_name` — `deriveCaseConfig()` derives form-level case wiring on-demand
- `default_value` generates `<setvalue event="xforms-ready">` in the XForm (one-time on load, unlike `calculate` which recalculates)

### XPath and Vellum Hashtags

Questions can use `#case/property_name` and `#user/property_name` shorthand in XPath expressions (`relevant`, `calculate`, `constraint`, `default_value`). The expander handles these with a dual-attribute pattern matching CommCare's Vellum editor:

- **Real attributes** (`calculate`, `relevant`, `constraint`, `value`) — `#case/` expanded to full `instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/property` XPath.
- **Vellum attributes** (`vellum:calculate`, `vellum:relevant`, `vellum:value`) — original shorthand preserved for the Vellum editor.
- **Vellum metadata** (`vellum:hashtags`, `vellum:hashtagTransforms`) — JSON metadata on each bind.
- **`case_references_data.load`** — form-level JSON mapping each question path to its `#case/` references.
- **Secondary instance declarations** — `<instance src="jr://instance/casedb" id="casedb" />` and `<instance src="jr://instance/session" id="commcaresession" />` added when hashtags are used.

### Close Case
- `{}` = unconditional close
- `{question, answer}` = conditional close
- absent/undefined = no close

## Commands

```bash
npm run dev          # Start dev server (Turbopack)
npm run build        # Production build
npm test             # Run tests (vitest)
npm run test:watch   # Watch mode tests
npx tsx scripts/test-schema.ts  # Test structured output schemas against Haiku (requires ANTHROPIC_API_KEY)
```

## Icons

Coolicons (`ci` prefix) via `unplugin-icons`. No inline SVGs — all icons are imported as React components.

- **Import pattern**: `import ciIconName from '@iconify-icons/ci/icon-name'`
- **Usage**: `<Icon icon={ciIconName} width="16" height="16" className="..." />`
- **Browse available icons**: `node_modules/@iconify-icons/ci/` (one file per icon)
- No build plugin needed — pure ESM, works with Turbopack

## Theme

Dark "Stellar Minimalism" theme. CSS custom properties defined in `globals.css`:
- Backgrounds: `--nova-void` (#050510) → `--nova-elevated` (#1a1a3e)
- Text: `--nova-text` (#e8e8ff) → `--nova-text-muted` (#555577)
- Accents: `--nova-violet`, `--nova-cyan`, `--nova-emerald`, `--nova-amber`, `--nova-rose`
- Fonts: Outfit (display), Plus Jakarta Sans (body), JetBrains Mono (code)

## Model Configuration

`lib/models.ts` is the single source of truth for default model IDs, pricing, and pipeline config. Runtime model selection is user-configurable via the settings page.

- `MODEL_DEFAULT` — fallback model for `GenerationContext` methods (`claude-sonnet-4-6`)
- `MODEL_PRICING` — cost lookup keyed by model ID (per million tokens: input, output, cacheWrite, cacheRead)
- `DEFAULT_PIPELINE_CONFIG` — `PipelineConfig` object with per-stage model + maxOutputTokens + reasoning defaults
- `modelSupportsReasoning(modelId)` — returns true for Opus/Sonnet families (not Haiku)
- `modelSupportsMaxReasoning(modelId)` — returns true for Opus only ("max" effort is Opus-exclusive)

### Settings & Pipeline Config

Users configure models and token limits per pipeline stage at `/settings`. Settings are stored in `localStorage('nova-settings')` and sent to the server per request via `useChat` body.

**Data flow**: `localStorage → useSettings() → useChat body → route.ts → GenerationContext.pipelineConfig → SA agent / tool LLM calls`

**Pipeline stages** (each has model + maxOutputTokens + reasoning + reasoningEffort):
- `solutionsArchitect` — SA agent (default: Opus, reasoning high)
- `schemaGeneration` — `generateSchema` tool's LLM call (default: Sonnet, reasoning high)
- `scaffold` — `generateScaffold` + `addModule` LLM calls (default: Sonnet, reasoning high)
- `formGeneration` — `addForm` + `regenerateForm` LLM calls (default: Sonnet, reasoning off)

Pipeline code reads from `ctx.pipelineConfig.<stage>` — never hardcoded model IDs. A `maxOutputTokens` of `0` means no cap. Reasoning uses Anthropic adaptive thinking (`type: 'adaptive'`) with configurable effort (`low`/`medium`/`high`/`max`). `ctx.reasoningForStage(stage)` returns the effort config or `undefined` if reasoning is off or the model doesn't support it.

**Hooks**: `useSettings()` is the primary hook (reads/writes `nova-settings`). `useApiKey()` is a thin wrapper that delegates to `useSettings()`.

**Models proxy**: `POST /api/models` takes `{ apiKey }` and returns the latest version of each model family (Opus, Sonnet, Haiku) from the Anthropic API, used to populate the settings dropdowns.

## Run Logging

Set `RUN_LOGGER=1` in `.env` to enable disk-based run logging. When enabled, each pipeline run writes a JSON file to `.log/` that is updated incrementally after every event (always valid JSON, even on crash).

- **`lib/services/runLogger.ts`** — `RunLogger` class. Created once per request in the route handler. Key methods:
  - `setAgent(name)` — tracks the current agent (`'Solutions Architect'`)
  - `setAppName(name)` — renames the log file from `*_unnamed.json` to `*_{app_name}.json`
  - `logConversation(messages)` — overwrites the `conversation` field with the latest `UIMessage[]`
  - `logEvent(event)` — appends an orchestration/generation/fix event with token counts and cost estimate
  - `logSubResult(label, result)` — stitches a sub-generation result onto the most recent orchestration event's matching tool call
  - `finalize()` — sets `finished_at`, recomputes totals, renames log file
- **Abandoned log cleanup**: On construction, scans `.log/` for UUID-named orphan files and renames them to `{timestamp}_abandoned.json`.
- **Integration**: `GenerationContext.generate()`/`streamGenerate()` call `logger.logSubResult()` automatically. SA `onStepFinish` calls `logger.logEvent()` for orchestration steps.
- **Output**: `.log/{timestamp}_{app_name|unnamed|abandoned}.json`

## Log Replay

Client-side feature for replaying a previously captured run log (`.log/*.json`) through the Builder state machine without making API calls.

**Flow**: `/settings` page → file picker → `extractReplayStages(log)` → module-level store → navigate to `/build/new` → `BuilderLayout` reads store on mount → `ReplayController` drives Builder state.

- **`lib/services/logReplay.ts`** — Stage extraction + singleton store. `extractReplayStages()` walks a `RunLog` to find conversation messages, scaffold output, and per-tool generation results. Each stage is a `ReplayStage` with `header`, `subtitle?`, `messages`, and `applyToBuilder` closure.
- **`app/settings/page.tsx`** — File picker with drag-and-drop. Parses JSON, shows metadata preview.
- **`components/builder/ReplayController.tsx`** — Fixed-position pill at top center of viewport. Left/right navigation, stage counter, close button.

## Service Layer Notes

- `solutionsArchitect.ts`: Exports `createSolutionsArchitect(ctx, mutableBp, blueprintSummary?)` — single `ToolLoopAgent` with all 21 tools. Generation tools (`generateSchema`, `generateScaffold`, `addModule`, `addForm`) delegate to `ctx.generate()`/`ctx.streamGenerate()` with per-stage model config. Also exports `validateAndFix()` — programmatic validation + fix loop (rule-based fixes + structured output fallback for empty forms). Also exports `generateSingleFormContent()` for the `addForm` and `regenerateForm` tools. **Note:** `validateAndFix` has an artificial 3s delay when validation passes on the first attempt — our validation is purely deterministic and completes near-instantly, which feels jarring. Remove this delay once we integrate the CommCare core .jar for full validation.
- `mutableBlueprint.ts`: `MutableBlueprint` class — wraps `AppBlueprint` (deep-cloned) for progressive population and in-place mutation. `setCaseTypes()` and `setScaffold()` for generation. `search()` finds matches across question IDs/labels/case_properties/XPath/module names/form names/columns. Mutation methods auto-derive case config after changes. `renameCaseProperty()` propagates renames across all questions, columns, and XPath expressions.
- `generationContext.ts`: `GenerationContext` class — wraps Anthropic client + UI stream writer + RunLogger + PipelineConfig. All LLM calls go through this class. Also exports `thinkingProviderOptions(effort)` for ToolLoopAgent constructors and `withPromptCaching` for Anthropic prompt caching.
- `contentProcessing.ts`: Post-processing utilities for structured output from form generation. `stripEmpty()` converts sentinel values back to undefined. `buildQuestionTree()` converts flat parentId-based questions to nested children arrays. `applyDefaults()` merges case property metadata. `processSingleFormOutput()` chains all three.
- `hqJsonExpander.ts`: `expandBlueprint()` converts `AppBlueprint` → HQ import JSON. Generates XForm XML with Vellum dual-attribute hashtag expansion, secondary instance declarations, form actions, case details. `validateBlueprint()` checks semantic rules.
- `cczCompiler.ts`: `CczCompiler` class takes HQ import JSON → `.ccz` Buffer. Generates suite.xml, profile.ccpr, app_strings.txt. Injects case blocks back into XForm XML.
- `commcare/`: Shared module — `constants.ts` (reserved words, regex), `xml.ts` (escapeXml), `hashtags.ts` (Vellum expansion), `ids.ts` (hex ID gen), `hqTypes.ts` (HQ JSON interfaces), `hqShells.ts` (factory functions), `validate.ts` (identifier validation).

## Knowledge Sync Pipeline

`scripts/sync-knowledge.ts` — offline pipeline that fetches CommCare docs from Confluence and distills them into markdown knowledge files. See `scripts/README.md` for full documentation.

```bash
npx tsx scripts/sync-knowledge.ts --phase discover|crawl|triage|distill|reorganize|reorg-plan|reorg-execute [--yes]
```

- **Phases 0-3** (discover → crawl → triage → distill): Fetch, classify, cluster, and distill Confluence pages
- **Phase 4** (reorganize): Two-pass Opus reorganization
- Cache lives in `.data/confluence-cache/` — incremental, safe to interrupt and resume
- Models used: Haiku (triage), Sonnet (distill/clustering), Opus (reorganize). Model IDs are hardcoded in the script files, not in `lib/models.ts`
