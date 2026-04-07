# Builder Components

## Design vs Preview Mode

**Design (edit):** frozen, stateless view. Inputs appear empty, no validation errors, submit bar hidden. Engine state is preserved internally but suppressed at the display layer. **All questions are shown regardless of relevant conditions** — the visibility check is skipped so the full form structure is always visible for editing. Hidden questions render as compact `HiddenField` cards. Violet accent for edit chrome (outlines, insertion points, drag overlays).

**Preview (test):** persistent testing sandbox. Values survive round-trips through design. Validation state resets on exit via `engine.resetValidation()` so fields start clean on re-entry. On switch back, all rules re-evaluate with the current schema against persisted values. Blueprint mutations recreate the engine, but only user-touched values are restored — untouched fields pick up new defaults.

## Flipbook Scroll Sync

Switching cursor modes preserves scroll position so the same question stays at the same pixel offset. `handleCursorModeChange` captures the topmost visible question and its offset into `scrollAnchor` state before the mode switch. A `useLayoutEffect` fires after React updates the DOM but before paint, adjusting `scrollTop` to re-align the anchor. `scrollAnchor` must be state (not a ref) because the layout effect depends on it. If the anchor is hidden in the new mode, the nearest visible question above it is used.

## Flipbook Height Parity — ProseMirror trailingBreak

ProseMirror injects a `<br class="ProseMirror-trailingBreak">` at the end of every block node for cursor positioning. This break is **hardcoded in prosemirror-view's DOM rendering** — hiding it via CSS is the only option. Two rules handle it:

1. `.tiptap .ProseMirror-trailingBreak:not(:only-child)` — hides the break in non-empty paragraphs where it adds height the static view doesn't have. In empty paragraphs (from pressing Enter), the break is the sole child and stays visible for cursor positioning.
2. `.tiptap:has(> :not(p)) > p:last-child > .ProseMirror-trailingBreak:only-child` — collapses the structural trailing paragraph ProseMirror auto-appends after block-level elements (lists, blockquotes, tables). `:has(> :not(p))` detects any non-paragraph block child. When the editor contains only `<p>` elements, the selector doesn't match and empty lines from pressing Enter stay visible.

`.preview-markdown` sets `white-space: break-spaces` and `position: relative` unconditionally to match ProseMirror's injected defaults — applied globally so no reflow occurs on mode switch. Note: TipTap 3 uses class `tiptap`, not `ProseMirror`.

## Cursor Mode Toolbar — Absolute, Not Sticky

The glassmorphic toolbar must be absolutely positioned in BuilderLayout's `overflow-hidden relative` wrapper — **not** inside PreviewShell's scroll container (`data-preview-scroll-container`). If placed inside as `sticky`, `backdrop-filter` samples the opaque `bg-pv-bg` background instead of the scrolling content, killing the glass effect. It also creates double scrollbars (BuilderLayout's wrapper + PreviewShell's internal scroller). `topInset` on PreviewShell offsets content below the overlay so the first screen element isn't hidden on initial load.

**Scroll-to-selection uses a rAF-driven animation** instead of native `scrollTo({ behavior: "smooth" })` — panel mount/unmount causes layout shifts that make the browser abandon native smooth scrolling mid-flight. The rAF loop recalculates the element's absolute offset within the scroll container each frame, so it tracks the target correctly even when the old InlineSettingsPanel unmounts and shifts content upward. Cross-screen navigation (`navigateToSelection`) uses `"instant"` behavior because the entire form swaps out via AnimatePresence — smooth scrolling from a stale scroll position is disorienting. Do not switch back to native `scrollTo` smooth scrolling.

**Scroll margin is adaptive** — `SCROLL_MARGIN` (compact) vs `SCROLL_MARGIN_WITH_TOOLBAR` (expanded) based on whether the click activated a text-editable zone. The `hasToolbar` flag threads through `navigateTo` → `_pendingScroll` → `scrollToQuestion`. When clicking a text-editable on an already-selected question, `scrollToQuestion` is called directly (no selection change → no `fulfillPendingScroll` re-fire). Do not collapse these into a single margin — the floating TipTap label toolbar needs clearance, but non-text clicks should not have a gap.

## Selection Behavior

**Sticky selection** — clicking empty space in the form does not deselect. Selection changes only when the user clicks a different question or navigates away. This is intentional: deselecting on click-outside would constantly dismiss the contextual editor panel.

**`navigateTo()` vs `select()`** — use `builder.navigateTo(el)` for intentional user navigation (click, keyboard, insert, duplicate, delete-to-next); it scrolls the design canvas in addition to updating selection. Accepts an optional `behavior` parameter (`"smooth"` default for same-form, `"instant"` for cross-screen). `navigateToSelection()` (tree sidebar clicks) always passes `"instant"`. Use `builder.select(el)` for non-navigating selection changes (rename path update, undo/redo restore). Never call `navigateTo` from undo/redo — the scroll is handled separately by `applyUndoRedo`.

**Edit guard** — `XPathField` can block `builder.select()` while it has unsaved invalid content via `builder.setEditGuard()`. Two-strike pattern: first navigation attempt warns (shake + tooltip), second attempt allows through. Keystroke resets the warning counter.

**`SelectedElement.questionUuid`** is the stable question identity — survives renames. Components compare by UUID to determine panel visibility and scroll targets. `questionPath` is still carried for blueprint mutation calls.

## dnd-kit Gotchas

**`queueMicrotask` in `onDragEnd`** — dnd-kit fires `onDragEnd` during `useInsertionEffect` where React 19 forbids `setState`. The state cleanup must be deferred via `queueMicrotask`.

**`collisionPriority` layering** — group/repeat `SortableQuestion` uses `CollisionPriority.Lowest` so the inner `useDroppable` container (set to `Low`) wins collision detection when items are dragged over the content area. Without this, the outer sortable intercepts the drop.

**Empty group drop targets** — `useDroppable` with `:container` suffix ID is necessary because dnd-kit's `OptimisticSortingPlugin` only processes `SortableDroppable` instances — plain `useDroppable` targets are invisible to it. Container IDs use `${question.uuid}:container`, not `${questionPath}:container` — rename-safe and consistent with sortable item IDs.

## EditableQuestionWrapper — `div[role=button]`, NOT `<button>`

Uses `<div role="button">` instead of `<button>` because children contain nested interactive elements (InsertionPoint buttons, TextEditable buttons, form inputs/fieldsets). HTML forbids interactive content inside `<button>` and SSR parsers will mangle the tree. Do not "fix" this to a `<button>`.

## Edit Mode — Combined Inspect + Text Editing

Edit mode merges the former "inspect" and "text" cursor modes into a single unified mode. `EditableQuestionWrapper` renders `div[role=button]` with `cursor-pointer` (click-to-select) and wraps children in `pointer-events-none`. `[data-text-editable]` zones punch through via CSS (`pointer-events: auto; cursor: text; z-index: 1`). The wrapper's `onClickCapture` handler checks for text-editable targets: if found, it selects the question but doesn't stop propagation, allowing `TextEditable` to also activate inline editing. Non-text clicks select the question and stop propagation as before. Properties panel has `cursor-auto` (unchanged).

## Undo/Redo

`applyUndoRedo` in `BuilderLayout` wraps `syncViewFromStore` in `flushSync` to force React to commit the store update before any DOM queries. zundo atomically restores `blueprint + selected + screen + cursorMode + activeFieldId` in the store — `screen` is read directly from the store (no local state sync needed). `syncViewFromStore` only resets the navigation history to a single entry matching the restored screen via `navResetTo()`. Without `flushSync`, `[data-field-id]` elements toggled into existence by the undo (e.g. a Required toggle just enabled) wouldn't be in the DOM yet. Do not replace with `requestAnimationFrame`.

**Focus restoration after undo/redo** uses a `focusHint` string stored on `builder` — the `[data-field-id]` key of whichever field the user was editing when the snapshot was taken. `InlineSettingsPanel` tracks the active field via a delegated `onFocus` handler calling `builder.setActiveField()`. This persists through blur → commit → snapshot so blur-triggered saves capture the correct field. The hint is consumed once by `useFocusHint` in the matching editor section, then cleared. Do not query `document.activeElement` for this — blur moves focus before the snapshot fires.

## Properties Panel — Per-Type Field Support

Not every question property applies to every question type. `FIELD_TYPE_SUPPORT` in `contextual/shared.ts` maps each logic field to the set of types that support it. CommCare/Formplayer constraints drive these sets — e.g., `calculate` overwrites user input so only `hidden` fields should have it; `required` is ignored on groups by Formplayer; media types have no XPath-expressible value to validate.

When adding a new question property, add it to `FIELD_TYPE_SUPPORT` — fields absent from the map are allowed on all types (safe default). Type conversion families (`questionTypeConversions.ts`) are designed so every member shares identical field support — conversions can't produce stale properties.

`ContextualEditorData` and `ContextualEditorUI` own their section visibility — they wrap their own card and return `null` when the question type has no applicable fields. `ContextualEditorLogic` always renders (every type has at least `relevant`).

## `ContextualEditorHeader` — Don't Memoize Move Targets

Move targets and adjacency flags (`isFirst`/`isLast`) are computed **inline in the render body**, not in `useMemo`. After `moveQuestion`, Immer produces new entity map references that trigger a re-render — the inline computation picks up the fresh state automatically. Memoizing on `[selected]` alone would miss the entity change because selection doesn't change on a reorder.
