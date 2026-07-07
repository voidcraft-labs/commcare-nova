# AI Elements Chat Refit + Attachment Extraction — Implementation Plan

> **SUPERSEDED.** The attachment-extraction parts of this plan (Haiku summarizer, base64 file-parts) were replaced during implementation by the media-store design — Gemini 3.5 Flash, asset-id refs, `documentExtraction*`. See `docs/specs/2026-06-03-chat-attachments-via-media-store.md`. Kept for lineage only.

> **For agentic workers:** Implement this plan task-by-task with subagent-driven development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Nova's hand-rolled chat input + message rendering with Vercel AI Elements, wire file attachments through, and add server-side Haiku faithful-extraction of large documents so they never inflate the Opus context.

**Architecture:** Vendor six AI Elements components into `components/ai-elements/`, restyle them to Nova's icons/tokens, and rewire the four `components/chat/` surfaces (`ChatInput`, `ChatMessage`, `ChatSidebar`, `ChatContainer`) to use them while preserving the signal grid, askQuestions routing, replay, and thread persistence. On the server, a new `lib/agent/attachments.ts` rewrites large file parts into Haiku-extracted text inside `/api/chat` before they reach Opus.

**Tech Stack:** Next.js 16, React 19, TypeScript strict, Tailwind v4, AI SDK v7 beta (`ai`, `@ai-sdk/react`, `@ai-sdk/anthropic`), AI Elements (shadcn `base-nova`), `@iconify/react/offline` + Tabler, `mammoth` (docx), `xlsx`/SheetJS, Vitest.

**Testing posture:** Per project convention, **no RTL/jsdom UI tests** — UI is `f(state)`. TDD applies to the **server/pure logic** (attachment decode, office→markdown, threshold branching, `prepareAttachments` orchestration, the `extractFromContent` method) via Vitest. The **client refit** (vendoring, icon-swap, wiring) is verified by `npm run lint` + `npm run build` + the user-runnable acceptance in the spec — not by mounting components.

**Reference:** `docs/specs/2026-05-30-ai-elements-chat-refit-design.md`

---

## File Structure

**Created:**
- `components/ai-elements/*` — vendored components (conversation, message, prompt-input, attachments, reasoning, tool) + any base-nova primitives the add lands. Customized to Nova icons/styles.
- `lib/agent/attachments.ts` — attachment preparation: orchestration (`prepareAttachments`) + pure helpers (`decodeTextDataUrl`, `docxToMarkdown`, `xlsxToMarkdown`, `rowsToMarkdownTable`) + the extraction prompt + `ATTACHMENT_EXTRACT_CHAR_THRESHOLD` / `ATTACHMENT_MAX_BYTES`.
- `lib/agent/__tests__/attachments.test.ts` — unit tests for the above.

**Modified:**
- `lib/agent/generationContext.ts` — add `extractFromContent(...)` multimodal sibling to `generatePlainText`.
- `lib/agent/index.ts` — export `prepareAttachments`.
- `app/api/chat/route.ts` — call `prepareAttachments` after `ctx`, before the user-message emit + agent stream.
- `components/chat/ChatInput.tsx` — replaced by a `PromptInput` composition (or deleted + replaced by a new colocated input component).
- `components/chat/ChatMessage.tsx` — `Message`/`MessageContent` shell + ChatMarkdown; reasoning panel; edit-mode tool cards; user file-attachment chips.
- `components/chat/ChatSidebar.tsx` — `Conversation` scroll container; re-implement the three uncovered scroll behaviors; signal grid stays below.
- `components/chat/ChatContainer.tsx` — `handleSend` widened to `{ text, files }`.
- `components/chat/ThinkingIndicator.tsx` — demoted or deleted if orphaned.
- `package.json` — `mammoth`, `xlsx` added; `nanoid`/`use-stick-to-bottom` landed by the add; streamdown removed if unused.

---

## Phase A — Vendor + theme the AI Elements components

### Task 1: Vendor the components, restore curated primitives

**Files:**
- Create: `components/ai-elements/*`
- Guard: `components/shadcn/{select,popover,button,input,label,calendar}.tsx`

- [ ] **Step 1: Snapshot curated shadcn primitives**

Run: `git status --short components/shadcn && git stash list`
Record the current `components/shadcn/` files so overwrites are detectable later.

- [ ] **Step 2: Run the targeted add**

Run: `npx ai-elements@latest add conversation message prompt-input attachments reasoning tool`
When prompted to overwrite any existing `components/shadcn/*` file, answer **No**. Allow new primitives (`textarea`, `tooltip`, `hover-card`, `dropdown-menu`, `collapsible`, `spinner`, `badge`, `code-block` if pulled).
Expected: new files under `components/ai-elements/`, plus new base-nova primitives under `components/shadcn/`.

- [ ] **Step 3: Restore any clobbered curated primitive**

Run: `git diff --stat components/shadcn`
For any **pre-existing** file that changed (`select`, `popover`, `button`, `input`, `label`, `calendar`), restore Nova's version: `git checkout -- components/shadcn/<file>.tsx`. Keep only genuinely-new primitive files.

- [ ] **Step 4: Record landed deps**

Run: `git diff package.json`
Expected new deps: `nanoid`, `use-stick-to-bottom` (and possibly `streamdown`, `shiki` if message/reasoning/tool's CodeBlock pulled them). Note them — Task 2 removes any that become unused after the ChatMarkdown swap.

- [ ] **Step 5: Commit the as-landed vendored components**

```bash
git add components/ai-elements components/shadcn package.json package-lock.json
git commit -m "chore(chat): vendor AI Elements components (conversation, message, prompt-input, attachments, reasoning, tool)"
```

### Task 2: Re-skin vendored components to Nova icons + styles

**Files:**
- Modify: every file under `components/ai-elements/` and any new `components/shadcn/*` primitive

> The vendored source ships `lucide-react` icons and default shadcn rounding. Per [[feedback_vendored_components_use_nova_icons_styles]] every icon becomes Tabler-via-iconify and styling matches Nova's chat chrome. This is a mechanical pass, file by file.

- [ ] **Step 1: Inventory lucide usages**

Run: `rg -n "from \"lucide-react\"|from 'lucide-react'" components/ai-elements components/shadcn`
Produce the list of `(file, iconNames)` to swap.

- [ ] **Step 2: Swap each lucide icon to Tabler/iconify**

For every occurrence, apply this transformation (example shown for the loader/paperclip/send/chevron/x/copy icons; map each lucide name to its Tabler equivalent):

```tsx
// BEFORE (vendored default)
import { Loader2Icon, PaperclipIcon, SendIcon, ChevronDownIcon, XIcon } from "lucide-react";
// …
<Loader2Icon className="size-4 animate-spin" />

// AFTER (Nova convention)
import { Icon } from "@iconify/react/offline";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import tablerPaperclip from "@iconify-icons/tabler/paperclip";
import tablerArrowUp from "@iconify-icons/tabler/arrow-up";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerX from "@iconify-icons/tabler/x";
// …
<Icon icon={tablerLoader2} className="size-4 animate-spin" />
```

Icon name map (lucide → Tabler): `Loader2Icon`→`loader-2`, `PaperclipIcon`→`paperclip`, `SendIcon`/`ArrowUpIcon`→`arrow-up`, `SquareIcon`(stop)→`player-stop-filled`, `XIcon`→`x`, `ChevronDownIcon`→`chevron-down`, `ChevronRightIcon`→`chevron-right`, `CopyIcon`→`copy`, `CheckIcon`→`check`, `ImageIcon`→`photo`, `FileIcon`→`file`, `RefreshCcwIcon`→`refresh`, `BrainIcon`/reasoning→`bulb` or `brain`. Add any missing Tabler icon to the project's extras file (`lib/icons` / wherever Nova keeps extras) per the icons convention.

- [ ] **Step 3: Patch `PromptInputTextarea` for Nova input convention**

In `components/ai-elements/prompt-input.tsx`, add `autoComplete="off"` and `data-1p-ignore` to the underlying textarea props (Nova input rule).

- [ ] **Step 4: Route reasoning + tool markdown through ChatMarkdown (drop streamdown)**

In `components/ai-elements/reasoning.tsx`, change `ReasoningContent` to render Nova's `ChatMarkdown` (`@/lib/markdown`) instead of `Streamdown`. In `components/ai-elements/tool.tsx`, render `ToolOutput`'s string output via `ChatMarkdown` (or plain `<pre>` for JSON input) rather than `MessageResponse`/Streamdown. Remove now-dead `streamdown`/`Response`/`MessageResponse` imports.

- [ ] **Step 5: Restyle to Nova chrome**

Where vendored classes use default shadcn rounding/spacing that clashes (e.g. `rounded-lg` on bubbles, `--radius` 10px), align to Nova's chat chrome: `rounded-xl` bubbles, `border-nova-border`, `bg-nova-surface`/`bg-nova-deep`, violet accent on the submit button. Keep changes minimal and local to the vendored files.

- [ ] **Step 5b: No duplicate tooltip provider**

If the add landed `components/shadcn/tooltip.tsx` (a second Base-UI tooltip wrapper alongside `components/ui/Tooltip.tsx`), do NOT mount a second provider — `(app)/layout.tsx` already provides `@base-ui/react/tooltip` context that the new wrapper consumes (module singleton). Point the vendored components at the existing Nova tooltip wrapper, or have the new wrapper re-export Nova's, so there is one tooltip surface. Run `rg -n "TooltipProvider" components app` to confirm exactly one provider mount.

- [ ] **Step 6: Remove unused deps**

Run: `rg -n "streamdown|lucide-react" components/ai-elements`
If neither is referenced anymore, `npm uninstall streamdown` (and shiki if only CodeBlock used it and CodeBlock is unused). Leave `lucide-react` installed only if the two pre-existing `components/shadcn/{select,calendar}.tsx` still use it (out of scope to change those).

- [ ] **Step 7: Verify build + lint, commit**

Run: `npm run lint && npm run build`
Expected: clean (no lucide in `components/ai-elements`, no type errors).

```bash
git add components package.json package-lock.json
git commit -m "style(chat): re-skin vendored AI Elements to Nova icons + tokens, ChatMarkdown for reasoning/tool"
```

---

## Phase B — Server: attachment extraction pipeline (TDD)

### Task 3: `extractFromContent` multimodal method on `GenerationContext`

**Files:**
- Modify: `lib/agent/generationContext.ts`
- Test: `lib/agent/__tests__/generationContext-extractFromContent.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import * as aiSdk from "ai";

// Mock generateText so we assert the wrapper plumbing, not the network.
vi.mock("ai", async (orig) => {
  const actual = await orig<typeof import("ai")>();
  return { ...actual, generateText: vi.fn() };
});

describe("GenerationContext.extractFromContent", () => {
  it("sends a multimodal user message and tracks usage", async () => {
    const ctx = makeTestContext(); // existing helper pattern from generationContext-emitMutations.test.ts
    (aiSdk.generateText as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: "EXTRACTED",
      usage: { inputTokens: 10, outputTokens: 5 },
      warnings: [],
    });

    const out = await ctx.extractFromContent({
      system: "extract",
      instruction: "Extract requirements.",
      file: { mediaType: "application/pdf", data: "data:application/pdf;base64,AAAA" },
      label: "attachment-pdf",
      model: "claude-haiku-4-5-20251001",
      maxOutputTokens: 4096,
    });

    expect(out).toBe("EXTRACTED");
    const call = (aiSdk.generateText as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.messages[0].content).toEqual([
      { type: "text", text: "Extract requirements." },
      { type: "file", data: "data:application/pdf;base64,AAAA", mediaType: "application/pdf" },
    ]);
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `npm test -- generationContext-extractFromContent`
Expected: FAIL — `extractFromContent` not a function.

- [ ] **Step 3: Implement the method (after `generatePlainText`)**

```ts
/** Multimodal sibling of generatePlainText: sends a text instruction plus a single
 *  file content block (e.g. a PDF document block) to the model and returns plain text.
 *  Usage tracks through the same accumulator as every other sub-generation. */
async extractFromContent(opts: {
  system: string;
  instruction: string;
  file: { mediaType: string; data: string };
  label: string;
  model?: string;
  maxOutputTokens?: number;
}): Promise<string> {
  try {
    const model = opts.model ?? MODEL_DEFAULT;
    const result = await generateText({
      model: this.anthropic(model),
      system: opts.system,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: opts.instruction },
            { type: "file", data: opts.file.data, mediaType: opts.file.mediaType },
          ],
        },
      ],
      maxOutputTokens: opts.maxOutputTokens,
    });
    logWarnings(`extractFromContent:${opts.label}`, result.warnings);
    if (result.usage) this.trackSubGeneration(result.usage);
    return result.text;
  } catch (error) {
    this.emitError(classifyError(error), `extractFromContent:${opts.label}`);
    throw error;
  }
}
```

- [ ] **Step 4: Run, verify pass**

Run: `npm test -- generationContext-extractFromContent`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/agent/generationContext.ts lib/agent/__tests__/generationContext-extractFromContent.test.ts
git commit -m "feat(agent): multimodal extractFromContent on GenerationContext"
```

### Task 4: Pure conversion helpers + threshold (TDD)

**Files:**
- Create: `lib/agent/attachments.ts` (helpers only this task)
- Test: `lib/agent/__tests__/attachments.test.ts`
- Install: `npm install mammoth xlsx`

- [ ] **Step 1: Install deps**

Run: `npm install mammoth xlsx`
Expected: both added to `package.json` dependencies.

- [ ] **Step 2: Write failing tests for the pure helpers**

```ts
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  decodeTextDataUrl,
  rowsToMarkdownTable,
  xlsxToMarkdown,
  ATTACHMENT_EXTRACT_CHAR_THRESHOLD,
} from "@/lib/agent/attachments";

describe("decodeTextDataUrl", () => {
  it("decodes a base64 text data URL to utf-8", () => {
    const b64 = Buffer.from("hello, world", "utf-8").toString("base64");
    expect(decodeTextDataUrl(`data:text/plain;base64,${b64}`)).toBe("hello, world");
  });
});

describe("rowsToMarkdownTable", () => {
  it("renders a GFM table from a 2D array", () => {
    const md = rowsToMarkdownTable([["a", "b"], ["1", "2"]]);
    expect(md).toContain("| a | b |");
    expect(md).toContain("| --- | --- |");
    expect(md).toContain("| 1 | 2 |");
  });
});

describe("xlsxToMarkdown (round-trip)", () => {
  it("converts a workbook buffer to markdown tables per sheet", () => {
    const ws = XLSX.utils.aoa_to_sheet([["name", "age"], ["Ada", 36]]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "People");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const md = xlsxToMarkdown(buf);
    expect(md).toContain("People");
    expect(md).toContain("| name | age |");
    expect(md).toContain("| Ada | 36 |");
  });
});

describe("threshold", () => {
  it("is a fixed constant ~32k chars", () => {
    expect(ATTACHMENT_EXTRACT_CHAR_THRESHOLD).toBeGreaterThanOrEqual(20_000);
  });
});
```

- [ ] **Step 3: Run, verify fail**

Run: `npm test -- attachments`
Expected: FAIL — module/exports missing.

- [ ] **Step 4: Implement the helpers**

```ts
import mammoth from "mammoth";
import * as XLSX from "xlsx";

/** Above this many extracted chars (~8k tokens at ~4 chars/token), condense with
 *  Haiku; below it, inline raw for perfect fidelity. Not user-configurable —
 *  the cost-vs-fidelity dial lives in code per Nova's model-config convention. */
export const ATTACHMENT_EXTRACT_CHAR_THRESHOLD = 32_000;

/** Hard ceiling on a single decoded attachment; above this we refuse rather than
 *  risk Cloud Run memory/body limits. Defense-in-depth behind PromptInput maxFileSize. */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/** Decode the base64 payload of a `data:` URL to a utf-8 string. */
export function decodeTextDataUrl(url: string): string {
  const comma = url.indexOf(",");
  const b64 = comma >= 0 ? url.slice(comma + 1) : url;
  return Buffer.from(b64, "base64").toString("utf-8");
}

/** Decode the base64 payload of a `data:` URL to a Buffer. */
export function decodeBinaryDataUrl(url: string): Buffer {
  const comma = url.indexOf(",");
  const b64 = comma >= 0 ? url.slice(comma + 1) : url;
  return Buffer.from(b64, "base64");
}

/** Render a 2D string array as a GitHub-flavored markdown table. */
export function rowsToMarkdownTable(rows: string[][]): string {
  if (rows.length === 0) return "";
  const header = rows[0];
  const sep = header.map(() => "---");
  const body = rows.slice(1);
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [line(header), line(sep), ...body.map(line)].join("\n");
}

/** docx buffer → markdown (mammoth maps Word styles to clean markdown). */
export async function docxToMarkdown(buffer: Buffer): Promise<string> {
  const { value } = await mammoth.convertToMarkdown({ buffer });
  return value;
}

/** xlsx buffer → one markdown table per sheet, each prefixed with the sheet name. */
export function xlsxToMarkdown(buffer: Buffer): string {
  const wb = XLSX.read(buffer, { type: "buffer" });
  return wb.SheetNames.map((name) => {
    const rows = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[name], {
      header: 1,
      blankrows: false,
      defval: "",
      raw: false,
    });
    return `### ${name}\n\n${rowsToMarkdownTable(rows.map((r) => r.map(String)))}`;
  }).join("\n\n");
}
```

- [ ] **Step 5: Run, verify pass**

Run: `npm test -- attachments`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/agent/attachments.ts lib/agent/__tests__/attachments.test.ts package.json package-lock.json
git commit -m "feat(agent): attachment decode + office→markdown helpers (mammoth, SheetJS)"
```

### Task 5: `prepareAttachments` orchestration (TDD)

**Files:**
- Modify: `lib/agent/attachments.ts`
- Modify: `lib/agent/index.ts`
- Test: `lib/agent/__tests__/attachments.test.ts`

- [ ] **Step 1: Write failing orchestration tests (mocked ctx)**

```ts
import type { UIMessage } from "ai";
import { prepareAttachments } from "@/lib/agent/attachments";

function userMsg(parts: UIMessage["parts"]): UIMessage {
  return { id: "u1", role: "user", parts } as UIMessage;
}
function fakeCtx(extractReturn = "EXTRACTED") {
  return {
    generatePlainText: vi.fn().mockResolvedValue(extractReturn),
    extractFromContent: vi.fn().mockResolvedValue(extractReturn),
  } as unknown as import("@/lib/agent/generationContext").GenerationContext;
}

it("inlines small text attachments raw (no model call)", async () => {
  const text = "short requirements";
  const b64 = Buffer.from(text, "utf-8").toString("base64");
  const ctx = fakeCtx();
  const out = await prepareAttachments(
    [userMsg([{ type: "text", text: "build" },
      { type: "file", filename: "r.txt", mediaType: "text/plain", url: `data:text/plain;base64,${b64}` }])],
    ctx,
  );
  const parts = out.at(-1)!.parts;
  expect(parts.some((p) => p.type === "file")).toBe(false);
  expect(parts.map((p) => (p.type === "text" ? p.text : "")).join("")).toContain("short requirements");
  expect(ctx.generatePlainText).not.toHaveBeenCalled();
});

it("Haiku-extracts large text attachments", async () => {
  const big = "x".repeat(40_000);
  const b64 = Buffer.from(big, "utf-8").toString("base64");
  const ctx = fakeCtx();
  const out = await prepareAttachments(
    [userMsg([{ type: "file", filename: "big.txt", mediaType: "text/plain", url: `data:text/plain;base64,${b64}` }])],
    ctx,
  );
  expect(ctx.generatePlainText).toHaveBeenCalledOnce();
  expect(out.at(-1)!.parts.some((p) => p.type === "file")).toBe(false);
  expect(out.at(-1)!.parts.find((p) => p.type === "text")!.text).toContain("EXTRACTED");
});

it("leaves image attachments untouched", async () => {
  const ctx = fakeCtx();
  const img = { type: "file", filename: "f.png", mediaType: "image/png", url: "data:image/png;base64,AAAA" } as const;
  const out = await prepareAttachments([userMsg([img])], ctx);
  expect(out.at(-1)!.parts).toContainEqual(img);
  expect(ctx.generatePlainText).not.toHaveBeenCalled();
  expect(ctx.extractFromContent).not.toHaveBeenCalled();
});

it("routes large PDFs through extractFromContent", async () => {
  const ctx = fakeCtx();
  const bigPdf = "data:application/pdf;base64," + "A".repeat(60_000);
  const out = await prepareAttachments(
    [userMsg([{ type: "file", filename: "spec.pdf", mediaType: "application/pdf", url: bigPdf }])],
    ctx,
  );
  expect(ctx.extractFromContent).toHaveBeenCalledOnce();
  expect(out.at(-1)!.parts.some((p) => p.type === "file")).toBe(false);
});

it("inlines raw on extraction error (never drops)", async () => {
  const big = "y".repeat(40_000);
  const b64 = Buffer.from(big, "utf-8").toString("base64");
  const ctx = fakeCtx();
  (ctx.generatePlainText as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("haiku down"));
  const out = await prepareAttachments(
    [userMsg([{ type: "file", filename: "big.txt", mediaType: "text/plain", url: `data:text/plain;base64,${b64}` }])],
    ctx,
  );
  expect(out.at(-1)!.parts.find((p) => p.type === "text")!.text).toContain("yyyy");
});
```

- [ ] **Step 2: Run, verify fail**

Run: `npm test -- attachments`
Expected: FAIL — `prepareAttachments` not exported.

- [ ] **Step 3: Implement `prepareAttachments`**

```ts
import type { UIMessage } from "ai";
import type { GenerationContext } from "./generationContext";

const HAIKU = "claude-haiku-4-5-20251001";
const EXTRACT_SYSTEM =
  "You are a requirements extractor for a CommCare app builder. Given a document, " +
  "reproduce EVERY requirement that could become a form, field, case type, validation rule, " +
  "or workflow: preserve all field names, enumerated options, units, validation constraints, " +
  "conditional logic, and case/parent-child relationships VERBATIM. Strip only prose, " +
  "boilerplate, and formatting. Do NOT invent, summarize away detail, or normalize to CommCare " +
  "vocabulary — that is the architect's job. Output compact bulleted structure grouped by section.";

const TEXT_MEDIA = new Set(["text/plain", "text/markdown", "text/csv", "text/tab-separated-values"]);
const isImage = (m: string) => m.startsWith("image/");
const wrap = (filename: string, body: string) => `<<Attachment: ${filename}>>\n${body}`;
const textPart = (text: string) => ({ type: "text" as const, text });

/** Faithfully condense a long string with Haiku; inline raw on failure (never drop). */
async function condense(ctx: GenerationContext, filename: string, body: string): Promise<string> {
  if (body.length < ATTACHMENT_EXTRACT_CHAR_THRESHOLD) return wrap(filename, body);
  try {
    const extracted = await ctx.generatePlainText({
      system: EXTRACT_SYSTEM,
      prompt: body,
      label: `attachment:${filename}`,
      model: HAIKU,
      maxOutputTokens: 16_000,
    });
    return wrap(filename, extracted);
  } catch {
    return wrap(filename, body); // fidelity over failure
  }
}

/**
 * Rewrite the last user message's file parts into model-ready content under a cost budget,
 * BEFORE the message reaches Opus. Text/office docs above threshold are Haiku-extracted;
 * small ones inline raw; large PDFs go to Haiku as native document blocks; images pass through.
 * Returns a new messages array (input not mutated).
 */
export async function prepareAttachments(
  messages: UIMessage[],
  ctx: GenerationContext,
): Promise<UIMessage[]> {
  const last = messages.at(-1);
  if (!last || last.role !== "user") return messages;

  const nextParts: UIMessage["parts"] = [];
  for (const part of last.parts) {
    if (part.type !== "file") {
      nextParts.push(part);
      continue;
    }
    const { mediaType, url } = part;
    const filename = part.filename ?? "attachment";

    // Oversize guard (defense behind PromptInput maxFileSize).
    if (url.length > ATTACHMENT_MAX_BYTES * 1.37 /* base64 inflation */) {
      nextParts.push(textPart(
        `<<Attachment ${filename} was too large to process. Attach a smaller file or split it.>>`,
      ));
      continue;
    }

    if (isImage(mediaType)) {
      nextParts.push(part); // Opus vision pass-through
      continue;
    }

    if (mediaType === "application/pdf") {
      const big = url.length > ATTACHMENT_EXTRACT_CHAR_THRESHOLD; // byte proxy; small PDFs pass through
      if (!big) { nextParts.push(part); continue; }
      try {
        const extracted = await ctx.extractFromContent({
          system: EXTRACT_SYSTEM,
          instruction: `Extract every requirement from this document (${filename}).`,
          file: { mediaType, data: url },
          label: `attachment:${filename}`,
          model: HAIKU,
          maxOutputTokens: 16_000,
        });
        nextParts.push(textPart(wrap(filename, extracted)));
      } catch {
        nextParts.push(part); // fall back to native PDF pass-through
      }
      continue;
    }

    try {
      let body: string;
      if (TEXT_MEDIA.has(mediaType)) {
        body = decodeTextDataUrl(url);
      } else if (mediaType.includes("wordprocessingml") || filename.endsWith(".docx")) {
        body = await docxToMarkdown(decodeBinaryDataUrl(url));
      } else if (mediaType.includes("spreadsheetml") || filename.endsWith(".xlsx")) {
        body = xlsxToMarkdown(decodeBinaryDataUrl(url));
      } else {
        // Unknown non-image type slipped past the accept allowlist: best-effort text decode.
        body = decodeTextDataUrl(url);
      }
      nextParts.push(textPart(await condense(ctx, filename, body)));
    } catch {
      nextParts.push(textPart(`<<Attachment ${filename} could not be read.>>`));
    }
  }

  const nextLast: UIMessage = { ...last, parts: nextParts };
  return [...messages.slice(0, -1), nextLast];
}
```

- [ ] **Step 4: Export from the barrel**

In `lib/agent/index.ts`, add: `export { prepareAttachments } from "./attachments";`

- [ ] **Step 5: Run, verify pass**

Run: `npm test -- attachments`
Expected: PASS (all orchestration cases).

- [ ] **Step 6: Commit**

```bash
git add lib/agent/attachments.ts lib/agent/index.ts lib/agent/__tests__/attachments.test.ts
git commit -m "feat(agent): prepareAttachments — Haiku faithful-extraction of large doc attachments"
```

### Task 6: Wire `prepareAttachments` into the chat route

**Files:**
- Modify: `app/api/chat/route.ts`

- [ ] **Step 1: Import and call after `ctx`**

In the `createUIMessageStream({ execute })` block, immediately after `const ctx = new GenerationContext({...})`, add:

```ts
// Condense large document attachments with Haiku BEFORE they reach Opus, so the
// doc text isn't re-read at full input rate on every tool-loop step (up to 80).
const preparedMessages = await prepareAttachments(messages, ctx);
```

Add `prepareAttachments` to the existing `@/lib/agent` import.

- [ ] **Step 2: Use `preparedMessages` downstream**

Replace `const lastMessage = messages.at(-1);` with `const lastMessage = preparedMessages.at(-1);` (the `isTextUIPart` user-message event then captures the condensed text — what Opus actually saw). In the `effectiveMessages` computation, replace every `messages` reference with `preparedMessages`.

- [ ] **Step 3: Verify build + typecheck**

Run: `npm run lint && npm run build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add app/api/chat/route.ts
git commit -m "feat(chat): run prepareAttachments before the SA so large docs are condensed"
```

---

## Phase C — Client: wire the new components

> No RTL tests (UI is `f(state)`). Each task verifies by `npm run lint && npm run build`; behavior is confirmed in the final acceptance.

### Task 7: Replace `ChatInput` with a `PromptInput` composition

**Files:**
- Modify/replace: `components/chat/ChatInput.tsx`

- [ ] **Step 1: Widen the onSend contract**

Change `ChatInputProps.onSend` to `(message: { text: string; files?: FileUIPart[] }) => void` (import `FileUIPart` from `ai`). Keep `disabled` and `centered`.

- [ ] **Step 2: Build the PromptInput composition**

```tsx
"use client";
import type { FileUIPart } from "ai";
import {
  PromptInput, PromptInputBody, PromptInputTextarea, PromptInputFooter,
  PromptInputTools, PromptInputActionMenu, PromptInputActionMenuTrigger,
  PromptInputActionMenuContent, PromptInputActionAddAttachments,
  PromptInputSubmit, PromptInputHeader, type PromptInputMessage,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import { Attachments, Attachment, AttachmentPreview, AttachmentRemove } from "@/components/ai-elements/attachments";

const ACCEPT = ".txt,.md,.csv,.pdf,.png,.jpg,.jpeg,.gif,.webp,.docx,.xlsx";

function PendingAttachments() {
  const a = usePromptInputAttachments();
  if (a.files.length === 0) return null;
  return (
    <Attachments variant="inline">
      {a.files.map((f) => (
        <Attachment data={f} key={f.id} onRemove={() => a.remove(f.id)}>
          <AttachmentPreview />
          <AttachmentRemove />
        </Attachment>
      ))}
    </Attachments>
  );
}

interface ChatInputProps {
  onSend: (message: { text: string; files?: FileUIPart[] }) => void;
  disabled?: boolean;
  centered?: boolean;
}

export function ChatInput({ onSend, disabled, centered }: ChatInputProps) {
  const handleSubmit = (message: PromptInputMessage) => {
    const text = (message.text ?? "").trim();
    if ((!text && !message.files?.length) || disabled) return;
    onSend({ text, files: message.files });
  };

  return (
    <PromptInput
      onSubmit={handleSubmit}
      accept={ACCEPT}
      multiple
      globalDrop
      maxFiles={5}
      maxFileSize={10 * 1024 * 1024}
      className="border-t border-nova-border"
    >
      <PromptInputHeader><PendingAttachments /></PromptInputHeader>
      <PromptInputBody>
        <PromptInputTextarea
          placeholder={centered ? "Tell me about the app you want to build..." : "Ask for changes..."}
          disabled={disabled}
        />
      </PromptInputBody>
      <PromptInputFooter>
        <PromptInputTools>
          <PromptInputActionMenu>
            <PromptInputActionMenuTrigger />
            <PromptInputActionMenuContent>
              <PromptInputActionAddAttachments />
            </PromptInputActionMenuContent>
          </PromptInputActionMenu>
        </PromptInputTools>
        <PromptInputSubmit disabled={disabled} status={disabled ? "submitted" : "ready"} />
      </PromptInputFooter>
    </PromptInput>
  );
}
```

> Note: `PromptInput` clears its own text + files on submit (form reset). The centered ring styling is applied via `className`/`data-centered` as in the prior input — match the previous look.

- [ ] **Step 3: Verify build + lint**

Run: `npm run lint && npm run build`
Expected: clean. (`ChatSidebar` is updated in Task 9; a transient type mismatch on `onSend` is fine until then — or do Tasks 7→9 together before this verify.)

- [ ] **Step 4: Commit**

```bash
git add components/chat/ChatInput.tsx
git commit -m "feat(chat): PromptInput-based input with attachments (no model picker/speech)"
```

### Task 8: Widen `ChatContainer.handleSend` to carry files

**Files:**
- Modify: `components/chat/ChatContainer.tsx`

- [ ] **Step 1: Update `handleSend`**

```tsx
import type { FileUIPart } from "ai";
// …
const handleSend = useCallback(
  ({ text, files }: { text: string; files?: FileUIPart[] }) => {
    if (!text.trim() && !files?.length) return;
    sendMessage({ text, files });
  },
  [sendMessage],
);
```

All other wiring (transport `body()`, effects, `beginRun`/`endRun`, `saveThread`, `onData`) is unchanged — files ride inside `messages`.

- [ ] **Step 2: Verify build + lint, commit**

Run: `npm run lint && npm run build`

```bash
git add components/chat/ChatContainer.tsx
git commit -m "feat(chat): forward attachments through handleSend → sendMessage"
```

### Task 9: Swap the scroll container to `Conversation`; preserve the three uncovered behaviors

**Files:**
- Modify: `components/chat/ChatSidebar.tsx`

- [ ] **Step 1: Replace the scroll `<div>` with `Conversation`**

Replace the hand-rolled `<div ref={scrollRef} className="… overflow-y-auto …">` and its `scrollRef` callback + `morphing` rAF + scroll listeners with:

```tsx
<Conversation className={centered ? "" : "flex-1"}>
  <ConversationContent className="p-4 space-y-4">
    {children /* historical threads, above live list */}
    {messages.length === 0 && !isLoading && (
      centered ? <WelcomeIntro /> : (
        <ConversationEmptyState
          title=""
          description={isExistingApp ? "What changes would you like to make?" : "Describe the CommCare app you want to build."}
        />
      )
    )}
    {messages.map((msg) => (
      <ChatMessage key={msg.id} message={msg} addToolOutput={handleToolOutput} pendingAnswerRef={pendingAnswerRef} />
    ))}
  </ConversationContent>
  <ConversationScrollButton />
</Conversation>
```

Keep the `SignalPanel`/`SignalGrid` block (`shrink-0`, **below** `Conversation`), the `ChatInput` block, and the centered↔sidebar `motion.div` wrappers exactly as before.

- [ ] **Step 1b: Widen the send contract through the sidebar**

`ChatSidebarProps.onSend` is currently `(message: string) => void`. Widen it to `(message: { text: string; files?: FileUIPart[] }) => void` (import `FileUIPart` from `ai`). Update the internal `handleSend` to keep the question-answer routing (answers are text-only) while forwarding files otherwise:

```tsx
const handleSend = useCallback(
  (message: { text: string; files?: FileUIPart[] }) => {
    if (pendingAnswerRef.current) {
      pendingAnswerRef.current(message.text); // askQuestions answer — text only
    } else {
      triggerSendWave();
      onSend(message);
    }
  },
  [onSend, triggerSendWave],
);
```

`ChatInput` receives `onSend={handleSend}`; `ChatContainer` passes its `{text, files}` `handleSend` as `onSend`. The whole chain is now `{ text, files }`.

- [ ] **Step 2: Re-implement the question-card autoscroll on top of Conversation**

`use-stick-to-bottom` does not scroll a mid-list question card into view. Keep the existing effect, but target the `Conversation` content element via a ref on `ConversationContent` (or `document.querySelector` within the sidebar root) instead of `scrollElRef`:

```tsx
// when activeQuestionCount increases, scroll the last waiting card into view
const lastCard = contentRef.current?.querySelector('[data-question-card="waiting"]:last-of-type');
lastCard?.scrollIntoView({ behavior: "smooth", block: "nearest" });
```

- [ ] **Step 3: Re-implement morph pin-persistence**

The center↔sidebar morph no longer needs the manual `morphing` rAF (StickToBottom keeps pinned-to-bottom across layout changes when at bottom). Verify by morphing while pinned; if the pin is lost during the 450ms morph, pass `Conversation`'s `initial`/resize handling or call its `scrollToBottom` from the existing `morphing` effect using the `contextRef`. Remove the now-dead `scrollRef`, `chatScrollPinnedRef`, `chatScrollTopRef`, `isNearBottomRef`, `isUserHoldingRef`, and the morph rAF loop.

- [ ] **Step 4: Verify build + lint**

Run: `npm run lint && npm run build`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add components/chat/ChatSidebar.tsx
git commit -m "feat(chat): Conversation scroll container; keep signal grid + question-card autoscroll"
```

### Task 10: `ChatMessage` — Message shell, attachments, reasoning, tool cards

**Files:**
- Modify: `components/chat/ChatMessage.tsx`
- Modify/delete: `components/chat/ThinkingIndicator.tsx`

- [ ] **Step 1: Wrap text parts in `Message`/`MessageContent` with `ChatMarkdown`**

Keep the stable-text-part-id logic. Render assistant text via `ChatMarkdown` and user text as `whitespace-pre-wrap`, both inside:

```tsx
<Message from={message.role}>
  <MessageContent>{/* per-part content */}</MessageContent>
</Message>
```

- [ ] **Step 2: Render user file parts as attachment chips**

```tsx
if (part.type === "file") {
  return (
    <Attachments key={...} variant="list">
      <Attachment data={part}><AttachmentPreview /><AttachmentInfo /></Attachment>
    </Attachments>
  );
}
```

Show the original `filename` (the server condenses content, not the displayed name).

- [ ] **Step 3: Render reasoning parts in a `Reasoning` panel**

Consolidate `reasoning` parts (per the AI Elements pattern) into one `Reasoning`/`ReasoningTrigger`/`ReasoningContent` block, `isStreaming` true when the last part of the last message is `reasoning` and the stream is open. (`ReasoningContent` was patched in Task 2 Step 4 to use `ChatMarkdown`.)

- [ ] **Step 4: Render edit-mode tool parts as `Tool` cards**

```tsx
// askQuestions keeps its custom card; generate* stay null (signal grid owns them);
// every other tool-* part renders a collapsible Tool card.
if (part.type === "tool-askQuestions") { /* unchanged AskQuestionsCard */ }
if (part.type === "tool-generateSchema" || part.type === "tool-generateScaffold") return null;
if (part.type.startsWith("tool-")) {
  // `startsWith` does not narrow the union — cast to ToolUIPart (from "ai") to read
  // toolCallId/input/state/output/errorText.
  const toolPart = part as ToolUIPart;
  return (
    <Tool key={toolPart.toolCallId}>
      <ToolHeader type={toolPart.type} state={toolPart.state} />
      <ToolContent>
        <ToolInput input={toolPart.input} />
        <ToolOutput
          output={typeof toolPart.output === "string" ? <ChatMarkdown>{toolPart.output}</ChatMarkdown> : undefined}
          errorText={toolPart.state === "output-error" ? toolPart.errorText : undefined}
        />
      </ToolContent>
    </Tool>
  );
}
return null; // data-*, step-start, etc.
```

- [ ] **Step 5: Demote/delete `ThinkingIndicator`**

Run: `rg -n "ThinkingIndicator" components` — if it has no importers after the reasoning panel lands, delete it; otherwise leave it for the pre-token `submitted` gap.

- [ ] **Step 6: Verify build + lint, commit**

Run: `npm run lint && npm run build`

```bash
git add components/chat/ChatMessage.tsx components/chat/ThinkingIndicator.tsx
git commit -m "feat(chat): Message shell + reasoning panel + edit-mode tool cards + attachment display"
```

---

## Phase D — Verify

### Task 11: Full verification + user-runnable acceptance

- [ ] **Step 1: Static checks**

Run: `npm run lint && npm run build`
Expected: clean.

- [ ] **Step 2: Unit tests + leak gate**

Run: `npm test && npm run test:leaks`
Expected: all pass; no leaks.

- [ ] **Step 3: Confirm no lucide in the chat surface**

Run: `rg -n "lucide-react" components/ai-elements components/chat`
Expected: no matches.

- [ ] **Step 4: User-runnable acceptance (from the spec)**

`npm run dev`, open the builder, attach a large `.txt`/`.pdf`/`.docx` requirements doc → appears as a Nova-styled removable chip → send → (a) user message shows the attachment, (b) signal grid animates, (c) run summary shows a `claude-haiku-4-5` extraction call + reduced Opus input tokens, (d) the SA generates an app reflecting the doc. Confirm the reasoning panel and (on an existing app) an edit Tool card render.

- [ ] **Step 5: Code review**

Dispatch a multi-dimensional review workflow over the diff (correctness, security at the markdown/attachment boundary, Nova conventions, leak-safety), then address findings.
