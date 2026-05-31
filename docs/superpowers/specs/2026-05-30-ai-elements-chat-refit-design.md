# AI Elements Chat Refit + Attachment Extraction — Design

**Status:** Draft (v1)
**Date:** 2026-05-30
**Authors:** Braxton Perry, Claude

## Overview

Nova's chat surface — the conversation with the Solutions Architect (SA) — is currently built from hand-rolled components: a bespoke auto-resizing textarea + send button (`components/chat/ChatInput.tsx`), a hand-written message bubble + markdown renderer (`components/chat/ChatMessage.tsx`), and a hand-managed scroll container with `MutationObserver`/`ResizeObserver`/pin listeners (inside `components/chat/ChatSidebar.tsx`). None of it supports file attachments, the SA's already-streamed reasoning text is thrown away in the UI, and edit-mode tool calls are invisible in chat.

This work replaces the input and message-rendering surfaces with **Vercel AI Elements** — the shadcn-based component library that is the UI pair to the AI SDK we already run — and adds **file attachments** wired end to end, with **server-side Haiku extraction** of large documents so they never inflate the Opus context.

The **signal grid** status indicator (`components/chat/SignalGrid.tsx` + `SignalPanel.tsx` + `SignalGridController`) is **explicitly preserved** — it is not replaced, restyled, or rewired.

### The cost problem this solves

Users paste up to 200k+ characters of requirements-document text straight into the chat input. Two failures follow:

1. The input was never built for that volume of text.
2. That text rides inside the conversation and is **re-read on every step of the SA's tool loop** (`solutionsArchitect.ts` sets `stopWhen: stepCountIs(80)`), and **re-written whenever the 5-minute prompt cache expires** between turns. A single cache-write of ~50k tokens is only ~$0.31 — but multiplied across up to 80 tool-loop steps and re-written across a multi-turn session, the bill climbs toward the ~$8/run users have reported. It is the *multiplication*, not a one-time write, that costs.

The fix: accept the document as an **attachment**, and before it reaches Opus, run a cheap **Haiku faithful-extraction** pass (claude-haiku-4-5, $1/$5 per Mtok) that condenses a ~50k-token doc to ~5–8k tokens of preserved requirements. Opus then re-reads the compact extraction across the loop instead of the raw blob — a ~6× cut on a recurring, multiplied cost.

## Goals

- Replace `ChatInput`, the text-bubble rendering in `ChatMessage`, and the scroll container in `ChatSidebar` with AI Elements components, vendored into `components/ai-elements/`.
- Wire file attachments through: pick/drag/paste in the input → sent in the user message → displayed in the message → consumed server-side.
- Summarize large text/doc attachments with Haiku **faithful extraction** (requirements extractor, not lossy summarizer), server-side at send time, before Opus.
- Support, at first ship: **PDF + images + text/markdown/csv** (natively read by Claude; zero new deps) and **docx + xlsx** (converted to markdown by the canonical libraries `mammoth` and `SheetJS`, then extracted).
- Surface the SA's already-streamed **summarized reasoning** in a collapsible panel, and show **edit-mode tool calls** as collapsible cards.
- Use **Nova's own icons and styles** throughout the vendored components — no second icon library, no off-theme chrome.
- Preserve every existing chat behavior: signal grid, askQuestions answer-routing, auto-resend, replay read-only mode, thread persistence, centered↔sidebar morph, disabled-while-generating.

## Design properties — the quality bar

1. **No security regression at the markdown boundary.** Assistant text is untrusted, and with attachments a malicious document becomes a prompt-injection vector that could make the SA emit an exfiltration link or image. Nova's `ChatMarkdown` (`lib/markdown.tsx`) enforces a security allowlist (`StripLink`/`StripImage`/`StripInput`). The refit renders `ChatMarkdown` **inside** AI Elements `Message`/`MessageContent` and does **not** adopt AI Elements `MessageResponse`/`streamdown`, which would render clickable links + images and silently bypass that allowlist. The allowlist matters *more* with this feature, not less.
2. **Nova's visual identity, not the library's.** Every vendored AI Elements file has its `lucide-react` icons swapped to Nova's idiom (`import { Icon } from "@iconify/react/offline"` + `@iconify-icons/tabler/*`) and is restyled to Nova's `nova-*` tokens and chat chrome (`rounded-xl` bubbles, violet accent, `nova-border`/`nova-surface`). No `lucide` is added to the chat surface. The default shadcn `--radius` (10px) is overridden locally where it reads too round next to Nova chrome.
3. **The model is the source of truth for what it can read.** PDF and images are sent to Claude as native `document`/`image` blocks — no extraction library. Only the formats Claude cannot ingest natively (docx, xlsx) are converted, and they are converted with the canonical, trusted libraries for the job, not an arbitrary extractor.
4. **No silent requirement loss.** Haiku is prompted as a faithful *extractor* (preserve every field, option, unit, validation rule, conditional, and case relationship; strip only prose/boilerplate; never invent or normalize to CommCare vocabulary). It runs with a generous output budget so it never silently truncates, and on any Haiku error the raw text is inlined rather than dropped. Only attachments above a size threshold are extracted; small ones are inlined verbatim for perfect fidelity.
5. **Cost is bounded at one named constant.** The extract-vs-inline threshold is a single code constant (`ATTACHMENT_EXTRACT_CHAR_THRESHOLD`), not user-configurable — matching Nova's model-config-as-constants convention. The user owns the cost-vs-fidelity dial by editing one value.
6. **The signal grid is untouched.** It reads the same `messages` array and walks last-assistant parts by SDK part type; the component swap changes no part types, so its energy/mode pipeline keeps working unchanged. It is a sibling of, not replaced by, the new conversation chrome.

## Components adopted

Vendored via a **targeted** `npx ai-elements@latest add conversation message prompt-input attachments reasoning tool` (NOT `add all` — minimizes the clobber surface and avoids pulling `cmdk`/`command` via prompt-input's unused command palette).

| Component | Role in Nova | Replaces / adds |
| --- | --- | --- |
| `prompt-input` | The chat input | Replaces `ChatInput` wholesale; adds attachment plumbing |
| `attachments` | Attachment chips (input) + sent-attachment display (message) | New |
| `conversation` | Auto-stick-to-bottom scroll container + scroll-to-bottom button + empty state | Replaces the hand-rolled scroll logic in `ChatSidebar` |
| `message` (shell only) | `Message`/`MessageContent` wrappers around Nova's `ChatMarkdown` | Replaces the bubble shell in `ChatMessage` |
| `reasoning` | Collapsible panel for the SA's summarized thinking | New (reasoning parts render `null` today) |
| `tool` | Collapsible cards for edit-mode tool calls | New (non-askQuestions tool parts render `null` today) |

**Not adopted** (and why): `MessageResponse`/branching/actions (no alternate-response/retry; security — see property 1); model picker + speech in `prompt-input` (model is a fixed code constant; no voice); `suggestion` (deferred — content-authoring burden); everything else in the catalog is off-domain (code-IDE, voice, graph-editor, RAG-citation, generated-image surfaces).

## Install guardrails

The AI Elements CLI runs `shadcn` under Nova's `components.json` (style `base-nova`, ui alias `@/components/shadcn`), so primitives resolve to the base-nova registry (Base-UI-backed). Before/after the add:

- **Restore curated primitives.** `@/components/shadcn/{select,popover,button,input,label}.tsx` carry local edits (e.g. z-modal portal fixes on select/popover). The add lists some as `registryDependencies` and will offer to overwrite them. Answer "no", or `git diff components/shadcn` after the add and restore Nova's versions for any pre-existing file that changed. New primitives the add genuinely introduces (`textarea`, `tooltip`, `hover-card`, `dropdown-menu`, `collapsible`, `spinner`) are kept — then **icon-swapped + restyled** like every other vendored file.
- **No duplicate tooltip provider.** `(app)/layout.tsx` already provides `@base-ui/react/tooltip` context; the new base-nova `tooltip` wrapper consumes the same module singleton. Do **not** mount a second provider. Consolidate the duplicate wrapper (`components/ui/Tooltip.tsx` vs the new `@/components/shadcn/tooltip.tsx`) per the holistic-refactor rule.
- **CSS variables already resolve.** `app/globals.css` binds every shadcn slot AI Elements touches (`--background`→`nova-void`, `--primary`→`nova-violet`, `--muted-foreground`→`nova-text-secondary`, `--border`→`nova-border`, etc.) under `.dark`, which is never removed from `<html>`. No token rebinding needed.
- **New runtime deps the add lands:** `nanoid` (prompt-input), `use-stick-to-bottom` (conversation). Plus `mammoth` + `xlsx` (SheetJS) added manually for office conversion. `lucide-react` is **not** newly depended on by the chat surface (icons swapped out); leave the two pre-existing `components/shadcn/{select,calendar}.tsx` lucide usages as-is (out of scope).

## Client changes

### `components/chat/ChatInput.tsx` → replaced by a `PromptInput` composition

A new input built from `PromptInput`, `PromptInputBody`, `PromptInputTextarea`, `PromptInputFooter`, `PromptInputTools`, `PromptInputActionMenu` → `PromptInputActionAddAttachments`, `PromptInputSubmit`, and a `PromptInputHeader` hosting the inline attachment chips (`Attachments` variant `inline` + `Attachment`/`AttachmentPreview`/`AttachmentRemove`, driven by `usePromptInputAttachments`).

Preserved behavior:
- Enter sends, Shift+Enter newlines.
- `disabled` while `isLoading || isGenerating`.
- Centered vs. sidebar placeholder ("Tell me about the app you want to build…" vs "Ask for changes…") and the centered ring styling.
- `autoComplete="off"` + `data-1p-ignore` patched onto the vendored `PromptInputTextarea` (Nova input convention).
- The submit handler surfaces **both** text and files so `ChatSidebar.handleSend` can forward them.

Attachment constraints set on `PromptInput`: `accept` allowlist (pdf, png/jpeg/gif/webp, text/markdown/csv, docx, xlsx), `maxFiles`, `maxFileSize`, `globalDrop`, `multiple`. Rejection is enforced at the `accept` boundary so the server transform operates over a closed set.

### `components/chat/ChatMessage.tsx` — bubble shell swapped; attachments + reasoning + tool cards added

- Text parts: render inside `Message`/`MessageContent` with Nova's `ChatMarkdown` for assistant text and plain `whitespace-pre-wrap` for user text (unchanged renderer; new shell).
- `tool-askQuestions` parts: **unchanged** — still render `AskQuestionsCard` with `pendingAnswerRef` + `addToolOutput` threaded through.
- `tool-generateSchema` / `tool-generateScaffold` parts: render `null` (the signal grid + GenerationProgress own build-mode feedback).
- **Any other `tool-*` part** (the edit/mutation tools — `addFields`, `editField`, `createForm`, `updateModule`, `removeField`, `validateApp`, etc.): render an AI Elements `Tool` card (`Tool`/`ToolHeader`/`ToolContent`/`ToolInput`/`ToolOutput`), tool name derived from the part type, state badge from `part.state`, and Nova's `{ error }` result shape mapped to the card's error display. This naturally scopes to edit mode, since build-only tools are the generate* ones rendered `null`.
- `reasoning` parts: render an AI Elements `Reasoning` collapsible panel (was `null`). `ThinkingIndicator` is demoted to the pre-token (`submitted`) gap or deleted if it becomes an orphan.
- New incoming **user** `file` parts: render as `Attachments` (grid/list variant) showing the **original** filename/size (not the server-condensed payload).

### `components/chat/ChatSidebar.tsx` — scroll container swapped to `Conversation`

Replace the inner `<div ref={scrollRef}>` + all hand-rolled scroll logic with `Conversation`/`ConversationContent`/`ConversationScrollButton`, feeding `ConversationEmptyState` the existing build/edit prompt copy. `use-stick-to-bottom` (inside `Conversation`) covers pin + user-scroll-hold + the scroll-to-bottom button.

**Three behaviors `use-stick-to-bottom` does NOT cover must be re-implemented on top of `Conversation`:**
1. Pin-state persistence across the centered↔sidebar morph (today `chatScrollPinnedRef`/`chatScrollTopRef` survive because `ChatSidebar` never unmounts).
2. The morph-anchor `requestAnimationFrame` loop keyed on `morphing`.
3. The question-card `scrollIntoView` keyed on `[data-question-card="waiting"]`.

Preserved: the centered↔sidebar morph, `handleSend`'s `pendingAnswerRef` answer-routing + `triggerSendWave`, the `SignalPanel`/`SignalGrid` block (`shrink-0`, rendered **below** `ConversationContent`, untouched), `WelcomeIntro`, and the server-rendered `ThreadHistory` children (must mount **inside** `ConversationContent`, above the live list).

### `components/chat/ChatContainer.tsx` — `handleSend` widened to carry files

Only `handleSend` changes: widen its signature to `({ text, files })` and call `sendMessage({ text, files })` (the AI SDK's `sendMessage` accepts `files`). All transport/effect/lifecycle wiring (refs, `derivePhase` gating, `beginRun`/`endRun`, `saveThread`, `onData` → `streamDispatcher`, auto-resend) is untouched. Files ride inside the `messages` array, not the custom `body` fields, so `createChatInstance`'s `body()` is unchanged.

## Server changes — attachments + extraction

### New module `lib/agent/attachments.ts` (exported from `lib/agent/index.ts`)

`prepareAttachments(messages, ctx)` walks the last user message's parts and rewrites file parts into model-ready content under a cost budget. For each `file` part, classified by `mediaType`:

- **Image** (`image/*`): left as a native `file` part → Opus vision pass-through. Not extracted (the visual *is* the spec; a few hundred tokens; no cost problem).
- **PDF** (`application/pdf`): if the doc is non-trivial (page-count/byte proxy ≥ threshold), hand the PDF **to Haiku as a native `document` block** (Haiku reads PDF natively) for faithful extraction → replace the part with the extracted text; otherwise pass the PDF through natively to Opus.
- **Text-like** (`text/plain`, `text/markdown`, `text/csv`): base64-decode the data URL → if chars ≥ `ATTACHMENT_EXTRACT_CHAR_THRESHOLD`, Haiku faithful-extraction → replace with text; else inline raw text.
- **Office** (`docx` → `mammoth` to markdown; `xlsx` → `SheetJS` to markdown tables): convert to markdown text, then apply the same threshold branch (extract above, inline below).
- On any Haiku/conversion error: **inline the raw/converted text** rather than dropping the attachment — no requirement is silently lost.

Each extracted/inlined block is wrapped in a delimiter naming the source filename (e.g. `<<Attachment: requirements.docx>>\n…`).

**Two extraction call shapes, both routed through `GenerationContext` so cost lands on the same `UsageAccumulator` the spend cap + run summary read** (per the agent-layer rule that the context is the only sanctioned path to the Anthropic client):
- *Text-derived content* (decoded text/md/csv, office→markdown) is a plain string → the existing `GenerationContext.generatePlainText({ system, prompt, label, model: "claude-haiku-4-5-20251001", maxOutputTokens })` (it takes a string `prompt`, which fits).
- *PDF* must ride as a native `document` content block, which `generatePlainText`'s string-only `prompt` cannot carry. This work adds a small **multimodal** sibling method to `GenerationContext` — `extractFromContent({ system, content, label, model, maxOutputTokens })` — that wraps `generateText` with a content-parts array (text instruction + the PDF `file` part) and tracks usage via the same `trackSubGeneration`. The PDF base64 rides as an Anthropic document block automatically (no Files API needed for base64 sources).

Pure conversion helpers (data-URL decode, office→markdown) are separated from the orchestration so they are unit-testable without a model call.

The `ATTACHMENT_EXTRACT_CHAR_THRESHOLD` constant (~32,000 chars ≈ ~8k tokens) and the faithful-extraction prompt live in this module.

### `app/api/chat/route.ts` — one call inserted

Inside the `createUIMessageStream({ execute })` block, **after** `const ctx = new GenerationContext(...)` and **before** the user-message conversation emit + `createSolutionsArchitect`/`createAgentUIStream`, call `await prepareAttachments(messages, ctx)` so the heavy file parts are replaced before any conversion to model messages. The existing `isTextUIPart` user-message extraction then naturally captures the condensed text (it captures what Opus actually saw). The edit-vs-build gating + `effectiveMessages` cache-strategy filter are unchanged. `app/api/chat/schema.ts` is unchanged — file parts ride inside the SDK `messages` array, not the custom request fields.

### Attachment data flow

```
PromptInput onSubmit({ text, files })   files = FileUIPart[] (url = base64 data-URL)
  → ChatContainer handleSend → sendMessage({ text, files })
  → useChat appends user message parts = [{text}, ...FileUIParts] → POST /api/chat
  → route reads body.messages
  → prepareAttachments(messages, ctx):  large text/office/pdf → Haiku extraction text;
                                         small text → inline raw; images → untouched
  → effectiveMessages → createAgentUIStream → convertToModelMessages
       (images → vision blocks; extracted text → normal text; small PDFs → native document)
  → Opus never re-reads the raw blob across the tool loop
```

The condensed extraction is what gets persisted into the saved thread (the transform runs before the user-message event + `saveThread`), so historical threads show what Opus actually saw — correct.

## Untouched / load-bearing

- `SignalPanel` + `SignalGrid` + `SignalGridController` energy/mode pipeline.
- `AskQuestionsCard` (`pendingAnswerRef`, `data-question-card` attribute, `addToolOutput`-on-last-question).
- `sendAutomaticallyWhen` auto-resend; `lib/generation/streamDispatcher.ts`.
- Replay read-only mode (`useReplayMessages`, `inReplayMode`) — replay messages are structurally compatible `UIMessage[]`; the same swapped renderer handles their text/reasoning/tool/askQuestions/error parts read-only.
- Thread persistence + the `data-app-id` → `history.replaceState` URL promotion.
- `HistoricalThread`/`HistoricalMessage`/`ThreadDivider` (server-rendered; optional `ChatMarkdown` parity only).

## Risks

- **Wire-size of base64 attachments.** A 200k-char doc posts as ~270KB+ base64 inside the JSON body; multiple large files compound. Mitigation: `maxFileSize` + `maxFiles` on `PromptInput`, and a total-attachment-bytes ceiling checked at the route before decoding, to protect Next/Cloud Run body + memory limits. The ceiling rejection message follows Nova's Elm-like error convention.
- **Office conversion fidelity.** `mammoth`/`SheetJS` flatten complex layout / embedded images. Mitigation: documented escape hatch — attach as **PDF** for pixel-perfect fidelity (native, one click from Word/Excel). pptx is **out of scope** for v1 (neither lib covers it); a canonical pptx extractor is a fast-follow.
- **Haiku cost on the abort path.** The route already wires `req.signal` abort → `usage.flush()`; verify the Haiku sub-generation cost is flushed there too.
- **Silent requirement loss** — the core summarization danger. Mitigated by the faithful-extraction prompt, generous output budget, threshold (only large docs touched), and raw-inline-on-error fallback.

## Out of scope / fast-follow

- pptx attachments (needs a canonical extractor beyond mammoth/SheetJS).
- `suggestion` starter-prompt chips.
- Office→PDF conversion via Gotenberg/LibreOffice for maximum-fidelity office handling (the chosen v1 path is canonical text libs; PDF-direct is the escape hatch).
- A token/cost/context-window display (`context` component) — admin surface only, if ever.

## Verification — user-runnable acceptance

After implementation, the reviewer/user runs:

1. `npm run dev`, open the builder (`http://localhost:3000`, a new build).
2. In the chat input, click the attach (paperclip) button **or** drag a large `.txt`/`.pdf`/`.docx` requirements document onto the input. Observe it appears as a **removable attachment chip styled in Nova's chrome** (Tabler icons, violet accent — no lucide, no off-theme rounding).
3. Type "build an app from this" and send. Observe: (a) the sent user message shows the attachment with its original filename; (b) the signal grid animates (untouched); (c) the run summary / server log shows a `claude-haiku-4-5` extraction call condensing the doc before the Opus run (and the Opus input token count reflects the condensed size, not the raw doc); (d) the SA generates an app reflecting the document's requirements.
4. Observe the SA's **summarized reasoning** in a collapsible panel during generation.
5. On an existing app, make an edit ("rename the patient_name field to full_name") and observe the edit rendered as a **collapsible Tool card** in chat.
6. Confirm `npm run lint`, `npm run build`, `npm test`, and `npm run test:leaks` pass.
