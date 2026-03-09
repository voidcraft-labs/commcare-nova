# CommCare Nova

Next.js web app that generates CommCare apps from natural language conversation.

## Stack

- **Framework**: Next.js 16 (App Router, Turbopack)
- **Language**: TypeScript (strict mode)
- **Styling**: Tailwind CSS v4 with `@theme inline` custom properties
- **Animation**: Motion (imported as `motion/react`, NOT `framer-motion`)
- **Validation**: Zod v4
- **AI (Chat)**: Vercel AI SDK (`ai` + `@ai-sdk/react` + `@ai-sdk/anthropic`) — `streamText`, `useChat`, client-side tools
- **AI (Generation)**: Anthropic SDK (`@anthropic-ai/sdk`) with structured output via `zodOutputFormat`
- **Testing**: Vitest

## Project Structure

```
app/                    # Next.js App Router pages and API routes
  api/
    chat/               # Chat endpoint (Vercel AI SDK streamText)
    blueprint/
      scaffold/         # Tier 1 scaffold endpoint
      fill/             # Full blueprint generation (all tiers)
    validate/           # Blueprint validation
    compile/            # CCZ compilation + download
  build/[id]/           # Main builder view (3-panel layout)
  builds/               # Build history
components/
  builder/              # AppTree, DetailPanel, GenerationProgress, EmptyState
  chat/                 # ChatSidebar, ChatMessage, ChatInput, QuestionCard, ThinkingIndicator
  ui/                   # Button, Input, Badge, Logo
hooks/                  # useBuilder, useApiKey, useBuilds
lib/
  services/
    builder.ts          # Builder class — singleton state machine for the build lifecycle
    claude.ts           # Stateless Anthropic SDK functions (generation pipeline only)
    appGenerator.ts     # Three-tier generation pipeline (scaffoldBlueprint, fillBlueprint)
    hqJsonExpander.ts   # Blueprint → HQ import JSON (XForm XML, form actions, Vellum metadata)
    hqJsonConverter.ts  # CCZ XML files → HQ import JSON (for re-import)
    cczCompiler.ts      # HQ import JSON → .ccz archive (adds case blocks, suite.xml)
    __tests__/          # Vitest tests for expander + compiler
  schemas/              # Zod schemas for AppBlueprint, tier outputs
  prompts/              # System/tier prompts for Claude
  types/                # TypeScript type definitions
  store.ts              # JSON file persistence in .data/ (builds + ccz files)
```

## Key Architecture Decisions

### Chat with Vercel AI SDK

The chat uses `streamText()` on the server and `useChat()` on the client. Two tools:

- **`askQuestions`** (client-side, no `execute`) — Claude asks structured multiple-choice questions. The tool part renders as a `QuestionCard` stepper in chat. User clicks answers, component calls `addToolOutput` when all questions are answered, `sendAutomaticallyWhen` re-sends to continue the conversation.
- **`scaffoldBlueprint`** (client-side, no `execute`) — Claude calls this when it has enough info. `stopWhen: hasToolCall('scaffoldBlueprint')` halts the stream immediately — Claude never gets a turn to output text after calling it. The client reads the tool input (appName + appSpecification), calls `/api/blueprint/scaffold` to run tier 1, and shows the scaffold in the builder tree.

No SSE wiring, no session coordination, no separate respond endpoint. The AI SDK handles the full message lifecycle via `UIMessage` parts.

### Builder Class

`lib/services/builder.ts` exports a `Builder` class — a singleton state machine shared across components via `useBuilder()`. Phases: `Idle → Scaffolding → Modules → Forms → Validating → Fixing → Done | Error`.

- `builder.setScaffold(bp, conversation, appName)` — shows the scaffold blueprint in AppTree, stores context for filling
- `builder.fillBlueprint(apiKey)` — calls `/api/blueprint/fill` (all tiers), updates blueprint when done
- `builder.bind(onUpdate)` — triggers React re-renders on state changes

### Two-Step Blueprint Generation

1. **Scaffold** (`/api/blueprint/scaffold` → `scaffoldBlueprint()`) — Tier 1 only. Returns app structure + data model with empty form content. Shows immediately in the builder tree so the user can review the architecture.
2. **Fill** (`/api/blueprint/fill` → `fillBlueprint()`) — All three tiers from scratch. Triggered by the "Generate" button in the header after scaffold is visible. Replaces the scaffold with the full blueprint.

### Three-Tiered Generation Pipeline

The generation pipeline uses the raw Anthropic SDK — structured output for schema generation, not interactive conversation.

Runs in three tiers to stay within Anthropic's schema compilation limits:
1. **Scaffold** (Tier 1): App structure + data model (case types, modules, forms)
2. **Module Content** (Tier 2): Case list columns per module
3. **Form Content** (Tier 3): Questions + case config per form

Each tier uses its own slim Zod schema with `sendOneShotStructured()`. Results are assembled into a full `AppBlueprint` via `assembleBlueprint()`.

### Per-Question Case Property Mapping

The LLM doesn't manage form-level case wiring. Instead, each question has:
- **`case_property`** — which case property this question maps to (or null)
- **`is_case_name`** — true if this question's value becomes the case name (registration forms)

The assembler (`deriveCaseConfig()`) derives form-level `case_name_field`, `case_properties`, and `case_preload` automatically:
- **Registration**: all questions with `case_property` → `case_properties` map. Question with `is_case_name` → `case_name_field`.
- **Followup**: questions with `case_property` → `case_preload` (load from case). Non-readonly ones also → `case_properties` (save back).
- **Survey**: no case config derived.

The assembled `BlueprintForm` still has form-level fields for the expander — the change is only in what the LLM outputs.

### Bring-Your-Own-API-Key

No auth layer. The user's Anthropic API key is stored in localStorage and sent per request via the AI SDK's `body` option. Never persisted server-side.

## Chat Components

- **`ChatSidebar`** — Message list + input. Reads `builder.phase` to suppress thinking indicator when the builder is active.
- **`ChatMessage`** — Iterates `message.parts`: renders text bubbles for `text` parts, `QuestionCard` for `tool-askQuestions` parts. `tool-scaffoldBlueprint` parts are ignored in chat (handled by BuilderLayout).
- **`QuestionCard`** — Animated stepper with local state. Shows questions one at a time with option buttons. Answered questions display as checkmark + answer. Calls `addToolOutput` when all questions are answered.
- **`ThinkingIndicator`** — Orbital violet dot animation. Shown when chat status is `submitted`/`streaming` AND builder phase is `Idle` AND scaffold is not in-flight.

## Schemas

### Nullable vs Optional
- **Tier schemas** (for Claude's structured output): use `.nullable()` — required by the API
- **Assembled blueprint** (for validation/expansion): use `.optional()` — more natural for TS
- Assembly strips nulls via spread: `...(value != null && { key: value })`

### Question Format
- Tier 3 outputs flat questions with `parent_id` for nesting
- Assembled blueprint uses recursive `children` arrays
- `unflattenQuestions()` and `flattenQuestions()` convert between formats
- Questions carry `case_property` and `is_case_name` — `deriveCaseConfig()` handles the rest
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

## Theme

Dark "Stellar Minimalism" theme. CSS custom properties defined in `globals.css`:
- Backgrounds: `--nova-void` (#050510) → `--nova-elevated` (#1a1a3e)
- Text: `--nova-text` (#e8e8ff) → `--nova-text-muted` (#555577)
- Accents: `--nova-violet`, `--nova-cyan`, `--nova-emerald`, `--nova-amber`, `--nova-rose`
- Fonts: Outfit (display), Plus Jakarta Sans (body), JetBrains Mono (code)

## Service Layer Notes

- `builder.ts`: `Builder` class — singleton via `useBuilder()`. Manages phase, blueprint, selected element. `bind()` hooks into React re-renders.
- `claude.ts`: Stateless functions, API key per-call. `sendOneShotStructured` for single-message structured output. Used by generation pipeline only.
- `appGenerator.ts`: `scaffoldBlueprint()` for tier 1 only, `fillBlueprint()` for all tiers. Pure functions — take inputs, return `GenerationResult`.
- `hqJsonExpander.ts`: `expandBlueprint()` converts `AppBlueprint` → HQ import JSON. Generates XForm XML with proper Vellum dual-attribute hashtag expansion, form actions, case details. `validateBlueprint()` checks semantic rules.
- `hqJsonConverter.ts`: `HqJsonConverter` class parses CCZ XML files back into HQ import JSON for re-import. Extracts case references from XForm binds.
- `cczCompiler.ts`: `CczCompiler` class takes HQ import JSON → `.ccz` Buffer. Generates suite.xml, profile.ccpr, app_strings.txt. Injects case blocks (create/update/close/subcases) back into XForm XML.
