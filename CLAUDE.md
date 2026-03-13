# CommCare Nova

Next.js web app that generates CommCare apps from natural language conversation.

## Stack

- **Framework**: Next.js 16 (App Router, Turbopack)
- **Language**: TypeScript (strict mode)
- **Styling**: Tailwind CSS v4 with `@theme inline` custom properties
- **Animation**: Motion (imported as `motion/react`, NOT `framer-motion`)
- **Validation**: Zod v4
- **AI**: Vercel AI SDK (`ai` + `@ai-sdk/react` + `@ai-sdk/anthropic`) — `ToolLoopAgent`, `createUIMessageStream`, `createAgentUIStream`, `useChat`, `generateText`, `streamText`, `Output.object()`
- **Icons**: Coolicons (`@iconify-icons/ci`) + Tabler (`@iconify-icons/tabler`) via `@iconify/react`
- **Testing**: Vitest

## Project Structure

```
app/                    # Next.js App Router pages and API routes
  api/
    chat/               # Single autonomous endpoint (PM + Architect agents)
    compile/            # CCZ compilation + download
  build/[id]/           # Main builder view (3-panel layout)
  builds/               # Build history
components/
  builder/              # AppTree, DetailPanel, GenerationProgress
  chat/                 # ChatSidebar, ChatMessage, ChatInput, QuestionCard, ThinkingIndicator
  ui/                   # Button, Input, Badge, Logo
hooks/                  # useBuilder, useApiKey
lib/
  services/
    builder.ts          # Builder class — singleton state machine for the build lifecycle
    architectAgent.ts   # Solutions Architect agent — generation mode (scaffold → modules → forms → assemble → validate) and edit mode (search → get → edit → validate)
    mutableBlueprint.ts # MutableBlueprint class — wraps AppBlueprint for in-place search, read, and mutation during editing
    generationContext.ts # GenerationContext class — shared LLM abstraction for all pipeline calls
    runLogger.ts        # RunLogger class — disk-based run logger (writes JSON to .log/ when RUN_LOGGER=1)
    hqJsonExpander.ts   # Blueprint → HQ import JSON (XForm XML, form actions, Vellum metadata)
    cczCompiler.ts      # HQ import JSON → .ccz archive (adds case blocks, suite.xml)
    autoFixer.ts        # Programmatic fixes for common CommCare app issues
    commcare/           # Shared CommCare platform module (constants, XML, hashtags, HQ types/shells)
    commcare/knowledge/ # Distilled CommCare platform knowledge (.md) + loadKnowledge.ts loader
    formBuilderAgent.ts # Form Builder sub-agent — builds forms via per-type tool calls (addTextQuestion, addSingleSelectQuestion, etc.) on a MutableBlueprint shell
    __tests__/          # Vitest tests for expander, compiler, commcare module, mutableBlueprint, and formBuilderAgent
  schemas/              # Zod schemas for AppBlueprint, tier outputs
  prompts/              # Agent prompts (productManagerPrompt, architectPrompt, editArchitectPrompt, scaffoldPrompt, modulePrompt, formDesignPrompt, formBuilderPrompt) — generation prompts accept knowledge param
  types/                # TypeScript type definitions
  models.ts             # Central model ID + pricing config
  store.ts              # CCZ file persistence in .data/
scripts/
  sync-knowledge.ts       # Knowledge sync pipeline entry point
  knowledge/              # Pipeline phases: discover, crawl, triage, distill, reorganize
```

## Key Architecture Decisions

### Two-Agent Pipeline (Single Endpoint)

A single `POST /api/chat` endpoint runs the entire pipeline: conversation, generation, and editing. Two agents, named by job title:

1. **Product Manager** (Tier 0) — A `ToolLoopAgent` that gathers requirements via conversation and delegates to the Solutions Architect for generation. Tools:
   - **`askQuestions`** (client-side, no `execute`) — structured multiple-choice questions rendered as `QuestionCard` in chat. `sendAutomaticallyWhen` re-sends when all questions are answered.
   - **`generateApp`** (server-side) — called when the PM has enough info. Emits `data-planning`, creates the Solutions Architect, drains the architect stream, returns a rich summary.
   - **`editApp`** (server-side) — called when the user requests changes to a generated app. Emits `data-editing`, creates a `MutableBlueprint` + edit-mode architect for surgical edits, returns a summary.

2. **Solutions Architect** (Tier 1) — A `ToolLoopAgent` that orchestrates generation or editing inside the PM's tool executors. Two modes:

   **Generation mode** (`createArchitectAgent`):
   - **`generateScaffold`** — designs app structure + data model via `streamGenerate()` with `onPartial` for progressive streaming
   - **`generateModuleContent`** — case list columns per module via `generate()`
   - **`generateAllForms`** — two-phase form generation: (1) design phase produces a UX-focused implementation plan via `generatePlainText()`, (2) build phase runs a Form Builder sub-agent with the design injected into its system prompt
   - **`assembleBlueprint`** — combines scaffold + module/form results into a full `AppBlueprint`
   - **`validateApp`** — runs `validateAndFix` loop on the assembled blueprint

   **Edit mode** (`createEditArchitectAgent`):
   - **`searchBlueprint`** — keyword search across question IDs, labels, case properties, XPath, module/form names, columns
   - **`getModule`** / **`getForm`** / **`getQuestion`** — retrieve full details of specific elements
   - **`loadKnowledge`** — on-demand CommCare platform knowledge loading (the knowledge index is always in the edit architect's system prompt)
   - **`editQuestion`** / **`addQuestion`** / **`removeQuestion`** — question-level mutations with auto case config re-derivation
   - **`updateModule`** / **`updateForm`** / **`addForm`** / **`removeForm`** / **`addModule`** / **`removeModule`** — structural mutations
   - **`renameCaseProperty`** — renames a case property with automatic propagation across all forms, columns, and XPath expressions
   - **`regenerateForm`** — full form regeneration via Form Builder sub-agent for major restructuring
   - **`validateApp`** — runs `validateAndFix` loop on the mutated blueprint

The PM does NOT make technical decisions (property names, case types, form structures). It writes a plain English `appSpecification`. The Solutions Architect translates that into CommCare architecture.

### GenerationContext

`lib/services/generationContext.ts` exports a `GenerationContext` class — the **single place** all LLM calls flow through. Wraps an Anthropic client + UI stream writer + RunLogger.

- **`model(id)`** — returns the Anthropic model provider
- **`emit(type, data)`** — writes a transient data part to the client stream (`writer.write({ type, data, transient: true })`)
- **`logger`** — the `RunLogger` instance, accessible by agents for logging orchestration events
- **`generatePlainText(opts)`** — text-only generation (no schema) via `generateText` with automatic run logging. Used by the form design phase.
- **`generate(schema, opts)`** — one-shot structured generation via `generateText` + `Output.object()` with automatic run logging via `logger.logSubResult()`
- **`streamGenerate(schema, opts)`** — streaming structured generation via `streamText` + `Output.object()` + `partialOutputStream` with `onPartial` callback and automatic run logging
- **`runAgent(agent, opts)`** — runs a `ToolLoopAgent` to completion with centralized step logging (token counts, cache metrics, knowledge attribution, tool call args). Reads the agent's system prompt from `agent.settings.instructions` for the log. All sub-agents (Form Builder, future agents) go through this method.

Also exports **`withPromptCaching`** — a shared `prepareStep` config that marks the last message with Anthropic's `cache_control: ephemeral`. Spread into all `ToolLoopAgent` constructors via `...withPromptCaching` so prior conversation turns are cached across steps.

The PM (via `logger.logEvent` in `onStepFinish`) and the architect (via `generate`/`streamGenerate` which call `logger.logSubResult`) use the same `GenerationContext` instance, created once in the route handler. The Form Builder goes through `ctx.runAgent()` which handles step logging centrally.

### Client State via `onData` (No useEffect Scanning)

All builder state updates flow through the `onData` callback on `useChat`. The server emits transient data parts (`writer.write({ type, data, transient: true })`), and `onData` fires once per part. No `useEffect` scans messages.

Data parts emitted by the pipeline:
- `data-planning` / `data-editing` → `builder.startPlanning()` / `builder.startEditing()`
- `data-partial-scaffold` → `builder.setPartialScaffold()` (progressive scaffold streaming)
- `data-scaffold` → `builder.setScaffold()`
- `data-phase` → `builder.setPhase()` (designing, modules, forms, validating, fixing)
- `data-module-done` → `builder.setModuleContent()`
- `data-question-added` → `builder.setFormContent()` (progressive streaming — emitted after each question tool call during form building)
- `data-form-done` / `data-form-fixed` / `data-form-updated` → `builder.setFormContent()`
- `data-blueprint-updated` → `builder.updateBlueprint()` (structural edits)
- `data-fix-attempt` → `builder.setFixAttempt()`
- `data-done` → `builder.setDone()` (blueprint + hqJson)
- `data-error` → `builder.setError()`

### Single useChat

`BuilderLayout` has one `useChat` instance targeting `/api/chat`. No second generation instance, no client-side orchestration, no round-trips.

- **`body`** sends `apiKey`, `blueprint` (for edits), and `blueprintSummary` (for PM context) per request
- **`sendAutomaticallyWhen`** only triggers for `askQuestions` (client-side tool), not server-side tool completions
- **`onData`** handles all builder state updates (see above)

### Chat-Centered Landing

Chat is the hero experience. When `builder.phase === Idle && !builder.treeData`, the chat fills the center of the screen (`isCentered = true`) with a large hero Logo above the welcome heading and input — no header bar, just one continuous `bg-nova-void` background. When generation starts (Planning phase), the logo animates from center to the top-left header position via `layoutId="nova-logo"`, the header slides in (animated `height: 0 → auto`), and the chat narrows to its 380px sidebar position — all coordinated by `LayoutGroup` wrapping the entire layout including the header. `AnimatePresence` fades in builder panels (150ms delay). No DOM re-parenting — messages and input state are preserved throughout the transition.

### Builder Class

`lib/services/builder.ts` exports a `Builder` class — a singleton state machine shared across components via `useBuilder()`. Phases: `Idle → Planning → Designing → Modules → Forms → Validating → Fixing → Done | Error`. Also `Editing` for edit flows.

- `builder.startPlanning()` — transitions to Planning phase ("Generating plan...")
- `builder.startEditing()` — transitions to Editing phase ("Applying changes...")
- `builder.setPartialScaffold(partial)` — updates tree progressively from streaming structured output
- `builder.setScaffold(scaffold)` — stores completed scaffold
- `builder.setModuleContent(moduleIndex, columns)` / `builder.setFormContent(moduleIndex, formIndex, form)` — updates partial modules, auto-derives progress counts
- `builder.setPhase(phase)` / `builder.setFixAttempt(attempt, errorCount)` — phase transitions from data parts
- `builder.setDone(result)` / `builder.setError(message)` — terminal states
- `builder.treeData` — getter with four-level fallback: `blueprint` > `partialModules` merged with scaffold > `scaffold` > `partialScaffold`
- `builder.subscribe(listener)` — triggers React re-renders on state changes
- Progress counters (`progressCompleted`/`progressTotal`) are derived from the `partialModules` map against the scaffold — no server-emitted counts needed.

### Three-Tiered Generation (within the Solutions Architect)

The architect runs generation in three tiers:
1. **Scaffold** (Tier 1): Translates plain English spec → app structure + data model (case types, property names, modules, forms) + per-form `formDesign` UX specs. All technical naming decisions happen here. Reserved property constraints are in the schema's `.describe()` strings. Uses `streamGenerate()` with `onPartial` for progressive scaffold streaming to the client.
2. **Module Content** (Tier 2): Case list columns per module — delegated via `generate()` with `moduleContentSchema`
3. **Form Content** (Tier 3): Two-phase design → build pipeline:
   - **Design phase**: A text-only `generatePlainText()` call produces a detailed UX implementation plan for all forms. The design prompt includes the full scaffold (with `formDesign` specs from the architect), the data model, conditional CommCare knowledge, and gold-standard form examples (`form-design-examples.md`). This phase reasons about grouping, skip logic, calculated fields, cross-form coordination, and end-user workflow — producing a design document with exact question IDs, types, XPath expressions, and rationale.
   - **Build phase**: A **Form Builder sub-agent** (`createFormBuilderAgent`) implements the design. The design document is injected into the agent's system prompt so it executes faithfully rather than improvising. The sub-agent builds forms question-by-question using **per-type tools** — one tool per question type (e.g. `addTextQuestion`, `addSingleSelectQuestion`, `addHiddenQuestion`). Each tool's schema is a self-documenting contract with only the fields relevant to that type. A `FieldCategory` system (`data`, `date`, `select`, `geopoint`, `barcode`, `media`, `trigger`, `hidden`, `structural`) drives which fields appear. The sub-agent also has `setCloseCaseCondition` and `addChildCase` (with `strict: true` + dynamic `z.enum()` of known case types to prevent hallucination).

Results are assembled into a full `AppBlueprint` via `assembleBlueprint()`.

### Knowledge Injection

CommCare platform knowledge from `lib/services/commcare/knowledge/*.md` is loaded into generation prompts so the SA produces idiomatic CommCare patterns instead of structurally-valid-but-naive solutions.

**Generation mode** — knowledge is conditionally loaded per phase via `resolveConditionalKnowledge(phase, context)` in `loadKnowledge.ts`. Each phase has a small **core** set (always loaded) and **conditional** sets triggered by keyword matches against `specification + formPurpose`:
- Scaffold core (2 files): case types, modules. Conditional: hierarchy, sharing, form linking, scale
- Module core (1 file): case list config. Conditional: case search, calculated columns, icons
- **Form design phase**: loads conditional form knowledge + `form-design-examples.md` (gold-standard annotated examples). The design prompt (`formDesignPrompt`) receives the full scaffold, data model, knowledge, and examples.
- **Form Builder build phase: no knowledge loaded.** The model already knows CommCare question types and form patterns well enough. The design document (from the design phase) provides all the UX guidance. The tool schemas (with `case_property` enum from the data model) provide sufficient structural guidance.

Each prompt function (`scaffoldPrompt`, `modulePrompt`, `formBuilderPrompt`, `formDesignPrompt`) accepts an optional `knowledge` string and embeds it in a `<knowledge>` block. The architect agent resolves the appropriate files before each `generate()`/`streamGenerate()`/`generatePlainText()` call.

**Edit mode** — on-demand via a `loadKnowledge` tool. The edit architect's system prompt always includes a `KNOWLEDGE_INDEX` (one-liner per file) so it knows what's available. Feature-specific files (alerts, scheduler, registry, UCR, encryption, etc.) are excluded from default generation sets but available on-demand in edit mode.

### Data Model Defaults (Case Properties as Source of Truth)

`case_types` on the blueprint carry rich property metadata: `label`, `data_type`, `hint`, `help`, `required`, `constraint`, `constraint_msg`, `options`. This makes case properties the single source of truth for shared question metadata.

**Questions are sparse** — when a question maps to a case property via `case_property`, it only needs to carry overrides (e.g. `relevant`, `calculate`, `default_value`, `readonly`). Defaults are merged at two points:
1. **Form Builder agent** — each per-type tool's shared executor auto-merges from the case type at build time (type, label, hint, help, required, constraint, options, is_case_name). Also runs `unescapeXPath()` on all XPath fields to sanitize HTML entities (`&gt;` → `>`) that LLMs sometimes emit.
2. **Expander** — `mergeQuestionDefaults()` / `mergeFormQuestions()` merge before XForm generation and validation

The Form Builder uses **dynamic schemas**: `case_property` becomes a `z.enum()` of available property names when the case type is known. `addChildCase` uses a dynamic `z.enum()` of case type names from the blueprint (with `strict: true` for constrained decoding). Module content's column `field` also uses a dynamic enum.

`is_case_name` is auto-derived from `case_name_property` in the case type definition — the LLM only sets it explicitly to override.

### Per-Question Case Property Mapping

The LLM doesn't manage form-level case wiring. Instead, each question has:
- **`case_property`** — which case property this question maps to (or null)
- **`is_case_name`** — auto-derived from `case_name_property` in the case type, or explicitly set to override

The assembler (`deriveCaseConfig()`) derives form-level `case_name_field`, `case_properties`, and `case_preload` automatically:
- **Registration**: all questions with `case_property` → `case_properties` map. Question with `is_case_name` → `case_name_field`.
- **Followup**: questions with `case_property` → `case_preload` (load from case). Non-readonly ones also → `case_properties` (save back). Question with `is_case_name` → `case_name_field`.
- **Survey**: no case config derived.

`deriveCaseConfig()` is called on-demand by the expander and validator — no form-level case fields are stored.

### Case List Columns

Case list columns are fully controlled by the LLM — no columns are auto-prepended or filtered by the expander/compiler. The LLM can use any case property as a column field, including `case_name`. Reserved property restrictions only apply to `case_properties` (the update block), not to display columns.

### Bring-Your-Own-API-Key

No auth layer. The user's Anthropic API key is stored in localStorage and sent per request via the AI SDK's `body` option. Never persisted server-side.

## Chat Components

- **`ChatSidebar`** — Message list + input. Accepts `mode: 'centered' | 'sidebar'`. Centered mode renders below the hero Logo with no header/border, uniform `gap-6` spacing, and no vertical padding on messages/input (parent flex gap controls all spacing). Sidebar mode is the 380px docked panel with `p-4` messages and `border-t` input. Uses `layout` + `layoutId` for animated transition between modes. Reads `builder.phase` to suppress thinking indicator when the builder is active.
- **`ChatMessage`** — Iterates `message.parts`: renders text bubbles for `text` parts, `QuestionCard` for `tool-askQuestions` parts. All other tool parts (`tool-generateApp`, `tool-editApp`) and data parts are ignored in chat (handled by `onData` in BuilderLayout).
- **`QuestionCard`** — Animated stepper with local state. Shows questions one at a time with option buttons. Answered questions display as checkmark + answer. Calls `addToolOutput` when all questions are answered.
- **`ThinkingIndicator`** — Orbital violet dot animation. Shown when chat status is `submitted`/`streaming` AND builder phase is `Idle` AND scaffold is not in-flight.

## Schemas

### Question Fields
Only `id` and `type` are required on a `Question`. All other fields (`label`, `hint`, `help`, `required`, `readonly`, `constraint`, `constraint_msg`, `relevant`, `calculate`, `default_value`, `options`, `case_property`, `is_case_name`, `children`) are optional — present only when set. All text fields are plain `string`.

### Question Format
- One `Question` type with nested `children` arrays for groups/repeats
- The stored schema supports one level of nesting, but the Form Builder agent's per-type tools with `parentId` can build arbitrarily deep structures
- Questions carry `case_property` and `is_case_name` — `deriveCaseConfig()` derives form-level case wiring on-demand
- `default_value` generates `<setvalue event="xforms-ready">` in the XForm (one-time on load, unlike `calculate` which recalculates)

### XPath and Vellum Hashtags

Questions can use `#case/property_name` and `#user/property_name` shorthand in XPath expressions (`relevant`, `calculate`, `constraint`, `default_value`). The expander handles these with a dual-attribute pattern matching CommCare's Vellum editor:

- **Real attributes** (`calculate`, `relevant`, `constraint`, `value`) — `#case/` expanded to full `instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/property` XPath. This is what the XForm runtime evaluates.
- **Vellum attributes** (`vellum:calculate`, `vellum:relevant`, `vellum:value`) — original shorthand preserved for the Vellum editor. Only added when hashtags are present.
- **Vellum metadata** (`vellum:hashtags`, `vellum:hashtagTransforms`) — JSON metadata on each bind telling Vellum which hashtags are used and how to expand them.
- **`case_references_data.load`** — form-level JSON mapping each question path to its array of `#case/` references. Required by CommCare HQ to resolve hashtags during app builds.

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

`lib/models.ts` is the single source of truth for model IDs and pricing. Never hardcode model IDs elsewhere.

- `MODEL_GENERATION` — structured generation (scaffold + modules + forms), currently `claude-sonnet-4-6`
- `MODEL_FIXER` — available for cheap/fast fixes, currently `claude-haiku-4-5-20251001` (validation uses programmatic fixes + Form Builder fallback instead)
- `MODEL_PM` — Product Manager agent (Tier 0), currently `claude-sonnet-4-6`
- `MODEL_PRICING` — cost lookup keyed by model ID (per million tokens: input, output, cacheWrite, cacheRead)

## Run Logging

Set `RUN_LOGGER=1` in `.env` to enable disk-based run logging. When enabled, each pipeline run writes a JSON file to `.log/` that is updated incrementally after every event (always valid JSON, even on crash).

- **`lib/services/runLogger.ts`** — `RunLogger` class. Created once per request in the route handler. Key methods:
  - `setAgent(name)` — tracks the current agent (`'Product Manager'`, `'Solutions Architect'`, `'Edit Architect'`)
  - `setAppName(name)` — renames the log file from `*_unnamed.json` to `*_{app_name}.json`
  - `logEvent(event)` — appends an orchestration/generation/fix event with token counts and cost estimate
  - `logSubResult(label, result)` — stitches a sub-generation result onto the most recent orchestration event's matching tool call (e.g. "Scaffold" generation result attaches to the `generateScaffold` tool call entry)
  - `finalize()` — sets `finished_at` and recomputes totals
- **Integration**: `GenerationContext.generate()`/`streamGenerate()` call `logger.logSubResult()` automatically. Agent `onStepFinish` callbacks call `logger.logEvent()` for orchestration steps.
- **Output**: `.log/{timestamp}_{app_name}.json` — contains run metadata, per-event token usage (including `cache_read_tokens` / `cache_write_tokens`) + cache-aware cost estimates, full request/response I/O, and roll-up totals.

## Service Layer Notes

- `builder.ts`: `Builder` class — singleton via `useBuilder()`. Holds `scaffold`, `blueprint`, `partialScaffold` (streaming structured output), and `partialModules` (module/form results). `treeData` getter merges partial data with scaffold for progressive rendering. Setter methods are called from `onData` callback in BuilderLayout. `updateProgress()` derives completed/total counts from the `partialModules` map.
- `architectAgent.ts`: Two factory functions. `createArchitectAgent(ctx, accumulator)` returns a generation-mode `ToolLoopAgent` with tools: `generateScaffold`, `generateModuleContent`, `generateAllForms`, `assembleBlueprint`, `validateApp`. `generateAllForms` runs a two-phase pipeline: (1) design phase via `ctx.generatePlainText()` with `formDesignPrompt` (loads conditional knowledge + gold-standard examples), (2) build phase via Form Builder sub-agent with the design injected. `createEditArchitectAgent(ctx, mutableBp)` returns an edit-mode `ToolLoopAgent` with search/get/edit/validate/loadKnowledge tools operating on a `MutableBlueprint`. `regenerateForm` also spawns a Form Builder sub-agent. Both share `validateAndFix()` (programmatic loop — rule-based validation + programmatic fixes, with Form Builder fallback for empty forms). `BlueprintAccumulator` collects generation results; `MutableBlueprint` wraps an existing blueprint for surgical edits.
- `formBuilderAgent.ts`: `createFormBuilderAgent(ctx, mb, opts)` factory returning a `ToolLoopAgent` that builds forms question-by-question via **per-type tools** (17 question tools + `setCloseCaseCondition` + `addChildCase`). Each question type has its own tool with only relevant fields, driven by a `FieldCategory` system and `buildSchema()` helper. A shared `createExecutor()` handles data model default merging and `unescapeXPath()` sanitization. `addChildCase` uses `strict: true` with a dynamic `z.enum()` of known case types to prevent hallucination. Operates on a `MutableBlueprint` shell at indices [0,0]. Accepts an optional `formDesign` string (from the design phase) injected into the system prompt for faithful implementation. No knowledge loaded — relies on the design document + self-documenting tool schemas. Executed via `ctx.runAgent()` for centralized logging. Used by `generateAllForms`, `regenerateForm`, and `validateAndFix` (empty form fallback).
- `mutableBlueprint.ts`: `MutableBlueprint` class — wraps `AppBlueprint` (deep-cloned) for in-place search, read, and mutation. `search()` finds matches across question IDs/labels/case_properties/XPath/module names/form names/columns. Mutation methods (`updateQuestion`, `addQuestion`, `removeQuestion`, etc.) auto-derive case config after changes. `renameCaseProperty()` propagates renames across all questions, columns, and XPath expressions.
- `generationContext.ts`: `GenerationContext` class — wraps Anthropic client + UI stream writer + RunLogger. Provides `generatePlainText()` (text-only, no schema), `generate()` (one-shot structured), `streamGenerate()` (streaming structured with `onPartial`), `runAgent()` (ToolLoopAgent execution with centralized step logging), `emit()` (transient data parts). All LLM calls go through this class. Also exports `withPromptCaching` — spread into ToolLoopAgent constructors for Anthropic prompt caching.
- `runLogger.ts`: `RunLogger` class — disk-based run logger. Writes incremental JSON to `.log/` after every mutation when `RUN_LOGGER=1`. Tracks current agent, stitches sub-generation results onto orchestration tool calls, computes cache-aware per-event cost estimates (using `cache_read_tokens` / `cache_write_tokens`) and roll-up totals.
- `hqJsonExpander.ts`: `expandBlueprint()` converts `AppBlueprint` → HQ import JSON. Generates XForm XML with proper Vellum dual-attribute hashtag expansion, form actions, case details. `validateBlueprint()` checks semantic rules.
- `cczCompiler.ts`: `CczCompiler` class takes HQ import JSON → `.ccz` Buffer. Generates suite.xml, profile.ccpr, app_strings.txt. Injects case blocks (create/update/close/subcases) back into XForm XML.
- `autoFixer.ts`: `AutoFixer` class applies programmatic fixes (itext, reserved properties, missing binds) to generated files before validation.
- `commcare/`: Shared module — `constants.ts` (reserved words, regex), `xml.ts` (escapeXml), `hashtags.ts` (Vellum expansion), `ids.ts` (hex ID gen), `hqTypes.ts` (HQ JSON interfaces), `hqShells.ts` (factory functions), `validate.ts` (identifier validation).
- `commcare/knowledge/`: Distilled CommCare platform knowledge files (`.md`) + `loadKnowledge.ts` (loader utility, conditional knowledge resolver, knowledge index). Generated by `scripts/sync-knowledge.ts` from Confluence docs. Loaded into SA prompts at generation time via `resolveConditionalKnowledge()` (core + keyword-triggered conditional sets) and available on-demand in edit mode via the `loadKnowledge` tool.

## Knowledge Sync Pipeline

`scripts/sync-knowledge.ts` — offline pipeline that fetches CommCare docs from Confluence and distills them into knowledge files for the Solutions Architect agent. See `scripts/README.md` for full documentation.

```bash
npx tsx scripts/sync-knowledge.ts --phase discover|crawl|triage|distill|reorganize|reorg-plan|reorg-execute [--yes]
```

- **Phases 0-3** (discover → crawl → triage → distill): Fetch, classify, cluster, and distill Confluence pages into `.data/confluence-cache/distilled/*.md` (intermediate output)
- **Phase 4** (reorganize): Two-pass Opus reorganization — reads distilled files, cuts HQ UI content, merges related topics, writes final output to `lib/services/commcare/knowledge/*.md`
- Cache lives in `.data/confluence-cache/` — incremental, safe to interrupt and resume
- Confluence auth uses cloud gateway URL (`api.atlassian.com/ex/confluence/{cloudId}/wiki`), not direct site URL
- Models used: Haiku (triage), Sonnet (distill/clustering), Opus (reorganize). Model IDs are hardcoded in the script files, not in `lib/models.ts` (these are offline scripts, not the runtime pipeline)
- AI SDK patterns: `streamText` + `Output.object()` for streaming structured output, `partialOutputStream` for progressive rendering, `inputTokens`/`outputTokens` for usage (not `promptTokens`/`completionTokens`)
