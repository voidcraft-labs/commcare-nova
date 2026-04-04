# Builder Components

## Design vs Preview Mode

**Design (edit):** frozen, stateless view. Inputs appear empty, no validation errors, submit bar hidden. Engine state is preserved internally but suppressed at the display layer. **All questions are shown regardless of relevant conditions** — the visibility check is skipped so the full form structure is always visible for editing. Hidden questions render as compact `HiddenField` cards in inspect/pointer modes but are excluded from text mode (no inline-editable surface). Violet accent for edit chrome (outlines, insertion points, drag overlays).

**Preview (test):** persistent testing sandbox. Values survive round-trips through design. Validation state resets on exit via `engine.resetValidation()` so fields start clean on re-entry. On switch back, all rules re-evaluate with the current schema against persisted values. Blueprint mutations recreate the engine, but only user-touched values are restored — untouched fields pick up new defaults.

## Flipbook Scroll Sync

Switching cursor modes preserves scroll position so the same question stays at the same pixel offset. `handleCursorModeChange` captures the topmost visible question and its offset into `scrollAnchor` state before the mode switch. A `useLayoutEffect` fires after React updates the DOM but before paint, adjusting `scrollTop` to re-align the anchor. `scrollAnchor` must be state (not a ref) because the layout effect depends on it. If the anchor is hidden in the new mode, the nearest visible question above it is used.

## Flipbook Height Parity — ProseMirror trailingBreak

ProseMirror injects a `<br class="ProseMirror-trailingBreak">` at the end of every block node for cursor positioning. This break is **hardcoded in prosemirror-view's DOM rendering** — hiding it via CSS is the only option. Two rules handle it:

1. `.tiptap .ProseMirror-trailingBreak:not(:only-child)` — hides the break in non-empty paragraphs where it adds height the static view doesn't have. In empty paragraphs (from pressing Enter), the break is the sole child and stays visible for cursor positioning.
2. `.tiptap:has(> :not(p)) > p:last-child > .ProseMirror-trailingBreak:only-child` — collapses the structural trailing paragraph ProseMirror auto-appends after block-level elements (lists, blockquotes, tables). `:has(> :not(p))` detects any non-paragraph block child. When the editor contains only `<p>` elements, the selector doesn't match and empty lines from pressing Enter stay visible.

`.preview-markdown` sets `white-space: break-spaces` and `position: relative` unconditionally to match ProseMirror's injected defaults — applied globally so no reflow occurs on mode switch. Note: TipTap 3 uses class `tiptap`, not `ProseMirror`.

## Selection Behavior

**Sticky selection** — clicking empty space in the form does not deselect. Selection changes only when the user clicks a different question or navigates away. This is intentional: deselecting on click-outside would constantly dismiss the contextual editor panel.

**Edit guard** — `XPathField` can block `builder.select()` while it has unsaved invalid content via `builder.setEditGuard()`. Two-strike pattern: first navigation attempt warns (shake + tooltip), second attempt allows through. Keystroke resets the warning counter.

## dnd-kit Gotchas

**`queueMicrotask` in `onDragEnd`** — dnd-kit fires `onDragEnd` during `useInsertionEffect` where React 19 forbids `setState`. The state cleanup must be deferred via `queueMicrotask`.

**`collisionPriority` layering** — group/repeat `SortableQuestion` uses `CollisionPriority.Lowest` so the inner `useDroppable` container (set to `Low`) wins collision detection when items are dragged over the content area. Without this, the outer sortable intercepts the drop.

**Empty group drop targets** — `useDroppable` with `:container` suffix ID is necessary because dnd-kit's `OptimisticSortingPlugin` only processes `SortableDroppable` instances — plain `useDroppable` targets are invisible to it.

## EditableQuestionWrapper — `div[role=button]`, NOT `<button>`

Uses `<div role="button">` instead of `<button>` because children contain nested interactive elements (InsertionPoint buttons, TextEditable buttons, form inputs/fieldsets). HTML forbids interactive content inside `<button>` and SSR parsers will mangle the tree. Do not "fix" this to a `<button>`.

## Text Mode Cursor Overlay

Text mode uses a `::after` overlay (z-index `--z-ground`) on the question wrapper to block hover/click on non-text elements. `[data-text-editable]` zones rise above it (z-index `--z-raised`). Form controls (`input`, `textarea`, `select`) additionally get `pointer-events: none !important` and the container gets `user-select: none` to block double-click and drag-to-select focus gestures that bypass the CSS overlay.

## `MutableBlueprint.fromOwned()`

Skips the defensive `structuredClone` — the caller must guarantee exclusive ownership. Used by HistoryManager to adopt popped undo/redo stack entries without redundant deep cloning. Every snapshot is already an independent blueprint copy.
