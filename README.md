# commcare nova

A web app for designing CommCare applications through natural language conversation. Describe what you need, and Nova builds a fully structured CommCare app — forms, case management, logic, and all. Then keep editing it conversationally or directly in the visual builder.

## How It Works

Nova uses a single AI agent — the **Solutions Architect (SA)** — powered by Anthropic's Claude via the Vercel AI SDK. The SA converses with users to understand requirements, generates a complete app blueprint through tool calls, and handles subsequent edits in the same conversational interface.

Users authenticate via Google OAuth, and each app is persisted to Firestore with full ownership tracking. After initial generation, users can revisit their apps, edit them through chat or the visual builder, and pick up where they left off. Chat history is preserved per-app as threaded conversations.

The home page (`/`) serves as the app list for returning users, or a get-started prompt for new ones. The builder (`/build/[id]`) is where generation and editing happen. An admin dashboard (`/admin`) provides user management and usage visibility.

## Getting Started

### Local Development

```bash
cp .env.example .env   # Fill in auth + Firestore credentials for full functionality
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to start building.

### Docker

```bash
docker build -t commcare-nova .
docker run -p 8080:8080 commcare-nova
```

### Deploy to Cloud Run

```bash
gcloud run deploy nova --source . --region <region>
```

Cloud Run builds the image from the Dockerfile automatically. Configure auth secrets, Anthropic API key, and Firestore project via environment variables or Secret Manager.

## Commands

```bash
npm run dev                              # Start dev server (Turbopack)
npm run build                            # Production build
npm run lint                             # Biome lint + format check
npm run format                           # Biome auto-format
npm test                                 # Run tests
npm run test:watch                       # Watch mode tests
npx tsx scripts/test-schema.ts           # Test structured output schemas (requires ANTHROPIC_API_KEY)
npx tsx scripts/build-xpath-parser.ts    # Rebuild XPath parser from grammar
```

### Pre-commit Hook

[Lefthook](https://github.com/evilmartians/lefthook) runs `biome check --staged` before every commit. It installs automatically on `npm install` — no extra setup needed. If the check fails, fix with `npm run format` and re-stage.

## Stack

- **Next.js 16** — App Router, Turbopack
- **TypeScript** — strict mode
- **Tailwind CSS v4** — dark theme with custom properties
- **Vercel AI SDK** — streaming chat, tool calls, structured output
- **Anthropic Claude** — LLM backbone
- **Better Auth** — Google OAuth with Firestore-backed sessions
- **Google Cloud Firestore** — app persistence, chat threads, event logging, usage tracking
- **Zustand** — builder reactive state
- **Motion** — animations
- **dnd-kit** — drag-and-drop question reordering
- **TipTap 3** — rich text editing
- **Base UI** — floating elements (popovers, tooltips, menus)
- **Vitest** — testing

## Developer Tools

### Event Logging

Every authenticated request writes a real-time event stream to Firestore — user messages, LLM steps with token usage and cost, data emissions, and errors. Events are written fire-and-forget under the app's log subcollection; a Firestore outage never blocks generation.

### Log Replay

Admins can replay saved event logs through the builder UI without making any API calls (`/build/replay/[id]`). A navigation bar lets you step forward and backward through each stage of the original run. Useful for iterating on UI changes without re-running the generation pipeline.

### XPath Playground

Visit `/xpath-test` to experiment with CommCare XPath syntax highlighting and formatting. The page has an editable CodeMirror editor with a format button and sample expressions covering hashtag references, paths, predicates, functions, and operators.

The XPath grammar (`lib/codemirror/xpath.grammar`) is a custom Lezer grammar supporting XPath 1.0 plus CommCare's `#case/`, `#form/`, and `#user/` hashtag shorthand. If you modify the grammar, rebuild the parser with:

```bash
npx tsx scripts/build-xpath-parser.ts
```

### Signal Grid Test

Visit `/signal-test` to tune the Signal Grid neural activity panel. The page lets you simulate all streaming states (sending, reasoning, building, error-recovering, error-fatal) with adjustable container width, manual energy injection, direct mode control, and preset scenarios including a full lifecycle simulation and error transitions. Changes to the grid controller or panel chrome can be verified here without running a real generation.

### Error System Test

Visit `/error-test` to simulate error scenarios end-to-end. The page shows the signal grid and generation progress together alongside toast notifications. Scenarios include invalid API key, mid-build stream errors, rate limiting, overloaded-with-recovery, compile failures, and toast stacking. Manual toast triggers let you test error/warning/info toasts individually. Use this to verify that error states flow correctly from the API through the signal grid, progress bar, and toast system without waiting for a real error.