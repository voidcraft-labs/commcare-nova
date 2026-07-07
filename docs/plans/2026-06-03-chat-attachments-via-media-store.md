# Chat Attachments via the Media Store Implementation Plan

> **For agentic workers:** Implement task-by-task with subagent-driven development. Frontend tasks additionally load the `frontend-design` skill and build from `@/components/shadcn`. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Route chat attachments through the per-owner media store (#45): the composer opens the file manager (not the browser picker), uploads go to storage, the requirements **extract** is computed once at upload and reused every turn, and the user can both see *that* extraction happens and preview *what the AI reads*.

**Architecture:** Three layers. (1) **Storage** gains an extract sibling-object in GCS + extract metadata on the asset doc, written by a new async extract route. (2) **Chat** carries asset-id refs in AI SDK message *metadata* (not base64 `FileUIPart`s); the server resolves every message's refs to stored extract text (documents) or image bytes (vision) — retiring `prepareAttachments`, fixing the multi-turn crash, and killing the blob/CSP corruption path. (3) **Transparency UI** adds an extraction indicator + info popover in the file manager and a `Document | What the AI reads` preview dialog.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript strict, AI SDK v7 (`useChat`/`UIMessage<Metadata>`), Firestore + GCS, Gemini 3.5 Flash extractor, shadcn (Base-UI) + the existing raw-Base-UI `MediaPickerDialog`, Tailwind v4, Biome + Vitest.

---

## Key decisions (locked with the user)

- **Raw-viewer scope = native-where-free + extract** (user-selected). PDF → `<iframe>` (out-of-process pdfium), `<img>/<audio>/<video>` native; docx/xlsx/txt/md/csv → "Open original" download. The `What the AI reads` tab (the extract) is the transparency payload and ships for every kind. **No** `mammoth`/`dompurify`/office-render in this work.
- **No raw-send option** — the SA only ever sees the extract (documents) or pixels (images). By design.
- **Per-owner library** (existing #45 model) — chat docs share the user's global library; dedup by content hash. Not per-app.
- **Extraction is async, upload-time, with a lazy server backstop.** Eager trigger after upload powers the file-manager indicator; the chat resolve step re-extracts on demand if a referenced doc has no current-version extract (correctness floor).
- **Extract text → GCS sibling object**, keyed by content hash + extractor version (dedups like the bytes). Only status/metadata lives on the Firestore doc — the library list never carries extract bodies.

## File structure

**Create**
- `lib/agent/documentExtraction.ts` — the kind→extract logic lifted out of `attachments.ts` (`EXTRACT_SYSTEM`, mammoth/xlsx/PDF-native paths, `EXTRACTOR_VERSION`) as `extractDocument({ bytes, mimeType, kind, filename, condenser }) → CondenseResult`. Pure of HTTP/Firestore. (Extract GCS-key derivation lives in `multimedia.ts`; text I/O in `storage/media.ts` — no separate store module.)
- `app/api/media/[assetId]/extract/route.ts` — `POST` (run/persist extraction, owner-gated, `maxDuration = 300`) + `GET` (return stored extract text for the preview tab).
- `app/api/media/[assetId]/extract/__tests__/route.test.ts`
- `lib/chat/attachmentRefs.ts` — `attachmentRefSchema`, `messageMetadataSchema`, `NovaUIMessage = UIMessage<NovaMessageMetadata>`, `CHAT_ATTACHMENT_KINDS` (`["image", ...DOCUMENT_KINDS]`).
- `lib/agent/resolveAttachments.ts` — `resolveAttachments(messages, ctx) → NovaUIMessage[]`: walk every message's `metadata.attachments`, append extract text / image parts. Replaces `prepareAttachments`.
- `lib/agent/__tests__/resolveAttachments.test.ts`, `lib/agent/__tests__/documentExtraction.test.ts`
- `components/builder/media/AssetPreviewDialog.tsx` — shadcn `Dialog` + `Tabs`: `Document` (native/iframe/open-original) + `What the AI reads` (fetch `GET …/extract`).
- `components/builder/media/ExtractionStatusBadge.tsx` + `ExtractionInfoPopover.tsx` — shadcn `Badge`/`Popover`; the indicator + "what is feature extraction" popover.
- `components/builder/media/useDocumentExtraction.ts` — fires `POST …/extract`, exposes per-asset `extracting|ready|failed`, updates the library item.
- `components/chat/ChatAttachmentBar.tsx` — picked-asset chips above the composer (filename + status + open-preview + remove).
- `components/shadcn/tabs.tsx` (`npx shadcn add tabs`); `scroll-area.tsx` if the preview/library needs it.

**Modify**
- `lib/db/types.ts::mediaAssetDocSchema` — add optional `extract` object.
- `lib/db/mediaAssets.ts` — `WireMediaAsset.extract?`, `toWireMediaAsset`, `setAssetExtractStatus(...)` writer.
- `lib/domain/multimedia.ts` — `extractGcsObjectKeyFor` lives here (alongside `gcsObjectKeyFor`); `EXTRACT_OBJECT_INFIX`.
- `lib/storage/media.ts` — `writeTextObject`/`readTextObject` (thin wrappers, or reuse `uploadAssetBytes`/`downloadAssetBytes`).
- `lib/agent/attachments.ts` — retire `prepareAttachments`/`prepareUserPart`/`countCondensableAttachments`/the base64 guards; keep the pure converters by re-export from `documentExtraction.ts`. (Holistic replace — no dead base64 path left behind.)
- `lib/agent/index.ts` — export `resolveAttachments`, drop `prepareAttachments`/`countCondensableAttachments`.
- `lib/agent/generationContext.ts` — `extractFromContent`/`generatePlainText` unchanged; they already satisfy `AttachmentCondenser`. Add a byte-input convenience if the extract route needs it.
- `app/api/chat/route.ts` — swap `prepareAttachments` → `resolveAttachments`; attachment-prep gating reads metadata.
- `components/builder/media/MediaPickerDialog.tsx` — widen `kinds: readonly MediaKind[]` → `readonly AssetKind[]`; `LibraryFilter`/`filter` → `AssetKind | "all"`; thumbs show the extraction badge for documents + a preview affordance.
- `components/builder/media/mediaClient.ts` — `extractMediaAsset(assetId)`, `fetchAssetExtract(assetId)`; widen `fetchMediaLibrary` kind to `AssetKind`.
- `components/builder/media/useMedia.ts` — `useMediaLibrary` kind → `AssetKind`.
- `app/api/media/library/route.ts` — accept `AssetKind` in the `kind` param (validate against `ASSET_KINDS`).
- `components/chat/ChatInput.tsx` — replace the `PromptInput` attachment subsystem with a "+" that opens `MediaPickerDialog`; render `ChatAttachmentBar`; `onSend({ text, attachments })`.
- `components/chat/ChatSidebar.tsx`, `components/chat/ChatContainer.tsx` — thread `attachments` through `onSend`; `sendMessage({ text, metadata: { attachments } })`.
- `components/chat/ChatMessage.tsx` — render attachment chips from `message.metadata.attachments` (live + replay + thread history).
- `lib/db/types.ts`/`lib/chat/threadUtils.ts` — persist `metadata.attachments` on stored thread messages.
- `firestore.indexes.json` — only if the library kind-filter index isn't already kind-generic (verify; the `(owner, kind, created_at desc)` composite covers any kind value).

**Verify-only against CCHQ/AI-SDK:** none (no wire emission; documents never reach the emitter — `isMediaKind` already fences them).

---

## Phase 0 — shadcn + picker kind-widening (foundation)

### Task 0.1: Add shadcn `tabs`
- [ ] `npx shadcn@latest add tabs` (use the repo's package runner). Then **immediately** `npm ls ai` — if it shows a `7.0.0-canary.*`, reset `package.json`/lock to the committed beta.116 and re-add only `tabs` (see `ai_sdk_canary_dep_skew`).
- [ ] Confirm `components/shadcn/tabs.tsx` exports `Tabs/TabsList/TabsTrigger/TabsContent`; restyle to `nova-*` tokens if the generated file ships non-Nova chrome.
- [ ] `npm run lint && npx tsc --noEmit`. Commit `feat(shadcn): add tabs`.

### Task 0.2: Widen the picker + library to `AssetKind`
- [ ] In `MediaPickerDialog.tsx`/`useMedia.ts`/`mediaClient.ts`/`app/api/media/library/route.ts`, replace `MediaKind` with `AssetKind` on the `kinds`/`filter`/`kind`-param surfaces. Library route validates `kind` ∈ `ASSET_KINDS`.
- [ ] Verify `firestore.indexes.json` has a kind-generic `(owner, kind, created_at desc)` index; the carrier callers still pass `MEDIA_KINDS`, so behavior is unchanged for them.
- [ ] Existing media tests green; add a test that the library route accepts `kind=pdf`. Commit `refactor(media): picker accepts document kinds`.

## Phase 1 — Extract storage + async extraction service (backend)

### Task 1.1: Extract-store key + GCS text I/O
- [ ] `lib/domain/multimedia.ts`: add `EXTRACTOR`-agnostic key helper.
```ts
/** Sibling GCS object holding the requirements extract for a document, keyed by
 *  content hash + extractor version so it dedups with the bytes and a version
 *  bump invalidates every stale extract without a migration. */
export function extractGcsObjectKeyFor(
  owner: string,
  contentHash: string,
  version: number,
): string {
  return `users/${owner}/${contentHash}.extract.v${version}.md`;
}
```
- [ ] `lib/storage/media.ts`: `writeTextObject(key, text)` (`uploadAssetBytes` with `Buffer.from(text,"utf8")`, `text/markdown; charset=utf-8`) + `readTextObject(key, maxBytes)` (`downloadAssetBytes(...).toString("utf8")`).
- [ ] Commit.

### Task 1.2: Asset-doc extract field + writer + wire shape
- [ ] `lib/db/types.ts`: add to `mediaAssetDocSchema` an optional `extract` object: `{ status: "extracting"|"ready"|"failed"; version: number; model: string; truncated: boolean; charCount: number; extractedAt: timestamp; failureReason?: string }`. Document that only documents carry it; text lives in GCS.
- [ ] `lib/db/mediaAssets.ts`: `WireMediaAsset.extract?: { status; version; truncated; charCount }` (no text, no failureReason text leak beyond status); update `toWireMediaAsset`; add `setAssetExtractStatus(assetId, patch)` writer (update, never merge).
- [ ] Tests for `toWireMediaAsset` extract projection + `setAssetExtractStatus`. Commit.

### Task 1.3: `documentExtraction.ts` (lift logic out of `attachments.ts`)
- [ ] Move `EXTRACT_SYSTEM`, `docxToMarkdown`, `xlsxToMarkdown`, `rowsToMarkdownTable`, `wrapAttachment`, `CondenseResult`, `AttachmentCondenser`, `CONDENSER_MODEL`, `CONDENSER_PROVIDER_OPTIONS`, `EXTRACT_MAX_OUTPUT_TOKENS` here. Export `extractDocument({ bytes: Buffer; mimeType; kind: DocumentKind; filename; condenser }) → Promise<CondenseResult>`: PDF → `extractFromContent` (build the data URL from bytes); text/docx/xlsx → decode→markdown→`generatePlainText`. Same fidelity-over-failure fallback semantics.
- [ ] `attachments.ts` re-exports the pure converters it still needs (or is deleted once nothing imports it — confirm `preview-attachment-condense.ts` repoints here). Update `scripts/preview-attachment-condense.ts` import.
- [ ] Unit tests (docx/xlsx/text → expected extract shape with a stub condenser). Commit.

### Task 1.4: `POST/GET /api/media/[assetId]/extract`
- [ ] `POST`: `requireSession` → `loadAssetForOwner` → reject non-document kinds (400) → if `extract.status==="ready" && version===EXTRACTOR_VERSION` return as-is (idempotent) → `setAssetExtractStatus(extracting)` → `downloadAssetBytes(cap)` → `extractDocument(ctx-or-standalone-condenser)` → `writeTextObject(extractKey)` → `setAssetExtractStatus(ready,{truncated,charCount})`; on throw `setAssetExtractStatus(failed,{failureReason})` + 500. `export const maxDuration = 300`.
- [ ] `GET`: owner-gated → if no current-version extract → 404/202; else `readTextObject` → `text/markdown`. `Content-Security-Policy: sandbox` + `nosniff` (matches the bytes route).
- [ ] The condenser: a standalone backend `AttachmentCondenser` over `lib/agent/subGeneration.ts` (the route isn't a chat run, so no SSE/usage context) — or reuse `GenerationContext` minimally. Pick the standalone path (mirrors `scripts/preview-attachment-condense.ts`) to keep the media route off the chat context.
- [ ] Route tests (happy path, non-document 400, idempotent ready, failure → failed status). Commit.

## Phase 2 — Chat wiring: refs in, extract out (retire base64)

### Task 2.1: Attachment-ref types + metadata
- [ ] `lib/chat/attachmentRefs.ts`: `attachmentRefSchema = z.object({ assetId: z.string(), kind: z.enum(ASSET_KINDS), filename: z.string() })`; `messageMetadataSchema = z.object({ attachments: z.array(attachmentRefSchema).optional() })`; `type NovaUIMessage = UIMessage<z.infer<typeof messageMetadataSchema>>`; `CHAT_ATTACHMENT_KINDS = ["image", ...DOCUMENT_KINDS] as const`. Commit.

### Task 2.2: `resolveAttachments` (server)
- [ ] `lib/agent/resolveAttachments.ts`: for EVERY message (not just last), read `metadata.attachments`; `loadAssetsByIds(owner, ids)`; per ref append to that message's parts — document → ensure extract (GET stored; if missing/stale call the extract service inline as the lazy backstop) → `textPart(wrapAttachment(filename, extract, truncated))`; image → `downloadAssetBytes`→ base64 data-URL `file` part. Never drops: a missing/foreign asset → placeholder text part. Returns a fresh array; never mutates input. Needs `owner` (from `ctx.session.user.id`).
- [ ] `countAttachments(messages)` for the prep-status gate (any message carrying attachments needing resolution).
- [ ] Tests: multi-turn history with refs resolves all turns; image → file part; missing asset → placeholder; no raw `text/markdown` parts ever produced. Commit.

### Task 2.3: Wire the chat route
- [ ] `app/api/chat/route.ts`: replace `prepareAttachments(messages, ctx)` with `resolveAttachments(messages, ctx)`; replace `countCondensableAttachments` with `countAttachments`; keep the `attachment-prep` start/done bracket + the `user-message` event (text parts already include the wrapped extracts). Build-mode `effectiveMessages = preparedMessages` now safely carries history (no raw file parts).
- [ ] `lib/agent/index.ts` exports updated. `npx tsc --noEmit`. Commit.

### Task 2.4: Composer → file manager + asset refs (client)
- [ ] **Create `components/chat/ChatAttachmentBar.tsx`** — picked-asset chips above the textarea (filename + `ExtractionStatusBadge` + open-preview + remove), reading the composer's picked-asset state.
- [ ] `ChatInput.tsx`: drop the `PromptInput` attachment subsystem (`PendingAttachments`, `PromptInputActionAddAttachments`, `accept`, `maxFiles`); add a "+" button opening `MediaPickerDialog` with `kinds={CHAT_ATTACHMENT_KINDS}`; manage picked-asset state; render `ChatAttachmentBar`. `onSend({ text, attachments: AttachmentRef[] })`.
- [ ] `ChatSidebar.tsx` + `ChatContainer.tsx`: change `onSend`'s type to `{ text; attachments?: AttachmentRef[] }`; `handleSend` → `sendMessage({ text, metadata: attachments?.length ? { attachments } : undefined })`. Remove `FileUIPart` usage.
- [ ] `ChatMessage.tsx`: render attachment chips from `msg.metadata?.attachments` (each opens `AssetPreviewDialog`). Replay + `threadUtils` carry metadata.
- [ ] `useChat({ chat })` — set `messageMetadataSchema` so metadata is typed/validated client-side.
- [ ] Commit.

## Phase 3 — Transparency UI (indicator, popover, preview)

> Load `frontend-design`; build from `@/components/shadcn`. New surfaces use shadcn; do not rewrite the picker's existing Base UI dialog.

### Task 3.1: Extraction indicator + info popover
- [ ] `ExtractionStatusBadge.tsx` (shadcn `Badge`): `extracting` (spinner + "Reading…"), `ready` (subtle "AI-ready"), `failed` (rose, retry). Shown on document thumbs in the picker library + on composer chips.
- [ ] `ExtractionInfoPopover.tsx` (shadcn `Popover`): plain-English "Nova reads a structured extract of your documents — not the raw file. That extract is what the assistant sees. Preview it on any document." (Elm-voice; no internals.) Mounted near the picker's supported-formats line and on the badge.
- [ ] `useDocumentExtraction.ts`: on a document appearing without a current-version extract, fire `POST …/extract`, reflect `extracting→ready/failed`, update the library item via `addUploaded`/a patch. Commit.

### Task 3.2: `AssetPreviewDialog` (Document | What the AI reads)
- [ ] shadcn `Dialog` + `Tabs`. **Document tab**: `image`→`<img src={mediaSrc(id)}>`; `audio`/`video`→native players; `pdf`→`<iframe src={mediaSrc(id)} title>` (out-of-process render); `docx/xlsx/text`→an "Open original" button (`mediaSrc` in a new tab / download). **What the AI reads tab**: `fetchAssetExtract(id)` → render the extract in a monospace block; show `extracting`/`failed` states with retry. Image assets: hide/disable the extract tab (no extract for images) — show "Images are read directly by the assistant."
- [ ] Opened from picker thumb (eye affordance) + composer chip. Commit.

### Task 3.3: Wire preview affordance into the picker
- [ ] `MediaPickerDialog` `LibraryThumb`/cell: add a hover "preview" (eye) control that opens `AssetPreviewDialog` without picking; click still picks. Document cells render `ExtractionStatusBadge`. Commit.

## Self-review gates (run before declaring done)

- **Plan coverage:** every Create/Modify file is owned by a task above; every new UI component (`AssetPreviewDialog`, `ExtractionStatusBadge`, `ExtractionInfoPopover`, `ChatAttachmentBar`) has a named mount site (picker thumb / composer chip / composer bar).
- **User-runnable acceptance:** `npm run dev` → open a build at `/build/new` → click "+" in the composer → the **file manager** opens → upload a `.docx`/`.pdf` → a thumb appears with an **Extracting…** badge that flips to **AI-ready** → open its preview → the **What the AI reads** tab shows the requirements extract and the **Document** tab shows the native/iframe view (or Open-original) → pick it, send a turn → the SA receives the extract → send a *second* turn referencing it → **no `text/markdown` crash** (multi-turn fixed). `npm run build && npm run lint && npm run test && npm run test:leaks` all green.
- **Boundary:** no model calls in `lib/media`/`lib/db`; extraction composed in the route. No raw base64 attachment path remains in `lib/agent`/`components/chat`.
- **Diagnostics:** zero new Biome warnings/infos; `tsc` clean.
