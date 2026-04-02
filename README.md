# commcare nova

A web app that generates CommCare applications from natural language conversation. Describe what you need, and Nova builds a fully structured CommCare app — forms, case management, logic, and all.

## How It Works

Nova uses a single AI agent — the **Solutions Architect** — that converses with you to understand your requirements, then generates a complete CommCare app blueprint through a multi-stage pipeline. The entire conversation and generation happens in one streaming session via the Vercel AI SDK and Anthropic's Claude.

**Bring Your Own API Key** — there's no auth layer or server-side key. You provide your Anthropic API key in the settings UI, and it's stored in your browser's localStorage. It's sent per-request and never persisted on the server.

## Getting Started

### Local Development

```bash
cp .env.example .env   # Optional — enables run logging by default
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to start building.

You'll be prompted to enter your Anthropic API key before you can generate apps.

### Docker

```bash
docker build -t commcare-nova .
docker run -p 8080:8080 commcare-nova
```

### Deploy to Cloud Run

```bash
gcloud run deploy nova --source . --region <region>
```

Cloud Run builds the image from the Dockerfile automatically. No server-side secrets are needed — API keys are stored client-side and sent per request.

## Commands

```bash
npm run dev                              # Start dev server (Turbopack)
npm run build                            # Production build
npm test                                 # Run tests
npm run test:watch                       # Watch mode tests
npx tsx scripts/test-schema.ts           # Test structured output schemas (requires ANTHROPIC_API_KEY)
npx tsx scripts/build-xpath-parser.ts    # Rebuild XPath parser from grammar
```

## Stack

- **Next.js 16** — App Router, Turbopack
- **TypeScript** — strict mode
- **Tailwind CSS v4** — dark theme with custom properties
- **Vercel AI SDK** — streaming chat, tool calls, structured output
- **Anthropic Claude** — LLM backbone
- **Vitest** — testing

## Developer Tools

### Event Logging

Authenticated users get real-time Firestore logging automatically. Each pipeline run writes events (user messages, LLM steps with token usage and cost, data emissions, and errors) to Firestore documents under the project's log subcollection.

### Log Replay

Admins can replay saved event logs through the builder UI without making any API calls. Click the Replay button on a project in `/builds` to open the builder with a navigation bar that lets you step forward and backward through each stage of the original run. Useful for iterating on UI changes without re-running the generation pipeline.

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