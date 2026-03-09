# CommCare Nova

Next.js web app that generates CommCare mobile apps from natural language conversation.

## Stack

- **Framework**: Next.js 16 (App Router, Turbopack)
- **Language**: TypeScript (strict mode)
- **Styling**: Tailwind CSS v4 with `@theme inline` custom properties
- **Animation**: Motion (imported as `motion/react`, NOT `framer-motion`)
- **Validation**: Zod v4
- **AI**: Anthropic SDK (`@anthropic-ai/sdk`) with structured output via `zodOutputFormat`
- **Testing**: Vitest

## Project Structure

```
app/                    # Next.js App Router pages and API routes
  api/                  # REST endpoints (generate, validate, compile, chat)
  build/[id]/           # Main builder view (3-panel layout)
  builds/               # Build history
components/
  builder/              # AppTree, DetailPanel, GenerationProgress, EmptyState
  chat/                 # ChatSidebar, ChatMessage, ChatInput
  ui/                   # Button, Input, Badge, Logo
hooks/                  # useBuilder, useChat, useApiKey, useBuilds
lib/
  services/             # Core generation pipeline
  schemas/              # Zod schemas for AppBlueprint, tier outputs, chat response
  prompts/              # System/tier prompts for Claude
  types/                # TypeScript type definitions
  store.ts              # JSON file persistence in .data/ (builds + ccz files)
```

## Key Architecture Decisions

### Three-Tiered Generation Pipeline
The AI generation runs in three tiers to stay within Anthropic's schema compilation limits:
1. **Scaffold** (Tier 1): App structure + data model (case types, modules, forms)
2. **Module Content** (Tier 2): Case list columns per module
3. **Form Content** (Tier 3): Questions + case config per form

Each tier uses its own slim Zod schema with `sendOneShotStructured()`. Results are assembled into a full `AppBlueprint` via `assembleBlueprint()`.

### Structured Output Everywhere
All Claude interactions use Zod schemas with `zodOutputFormat` for typed, validated responses:
- **Generation tiers**: `sendOneShotStructured()` with scaffold/module/form schemas
- **Chat**: `sendStructured()` with `ChatResponseSchema` — returns `{ intent, app_name, app_description, question }`
- Schema `.describe()` annotations guide Claude's behavior — no redundant prompt instructions

### Chat-Driven Auto-Generation
User describes app in chat → Claude returns structured `ChatResponse` with intent:
- `intent: "generate"` + `app_name` + `app_description` → auto-triggers generation pipeline
- `intent: "clarify"` + `question` → asks the user for more info
- No manual "Build" button — generation starts automatically when Claude has enough info
- Chat renders generation intents as styled cards (app name + architecture preview)

### Direct API Calls (No Job System)
Generation runs inline in the POST handler. The client calls `/api/generate`, waits for the result, and gets the blueprint back directly. No background jobs, no SSE streaming, no pub/sub.

### Stateless Claude Service
Stateless functions that accept an API key per-call. No conversation history stored server-side.

### Bring-Your-Own-API-Key
No auth layer. The user's Anthropic API key is stored in localStorage and sent per request. Never persisted server-side.

## Schemas

### Nullable vs Optional
- **Tier schemas** (for Claude's structured output): use `.nullable()` — required by the API
- **Assembled blueprint** (for validation/expansion): use `.optional()` — more natural for TS
- Assembly strips nulls via spread: `...(value != null && { key: value })`

### Chat Response Schema
Defined in `lib/schemas/chat.ts`. Field descriptions on the Zod schema guide Claude — the system prompt doesn't repeat schema instructions.

### Question Format
- Tier 3 outputs flat questions with `parent_id` for nesting
- Assembled blueprint uses recursive `children` arrays
- `unflattenQuestions()` and `flattenQuestions()` convert between formats

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

Key design choices in `lib/services/`:
- `claude.ts`: Stateless functions, API key per-call. `sendOneShotStructured` for single-message structured output, `sendStructured` for multi-turn structured output.
- `appGenerator.ts`: Pure function — takes inputs, returns `GenerationResult`. No events, no callbacks, no I/O.
- `cczCompiler.ts`: Returns `Buffer`, stored to disk via `store.ts` for download
