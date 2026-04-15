# Builder Components

## Edit vs preview mode

**Edit** is a frozen, stateless view: inputs appear empty, validation is suppressed, the submit bar is hidden. **All questions render regardless of relevant conditions** — hidden questions appear as compact cards so the full structure is always visible for editing. Engine state is preserved internally; only the display layer is suppressed.

**Preview** is a persistent testing sandbox. Values survive round-trips through edit. Validation state resets on exit so fields start clean on re-entry; on switch back, rules re-evaluate against the persisted values. Blueprint mutations recreate the engine, but only user-touched values are restored — untouched fields pick up new defaults, so editing a default expression is immediately reflected.

## Pointer mode is immersive

Pointer mode atomically hides both sidebars AND the floating reopen buttons. The mode switcher stashes current sidebar open-state in a single set call so entering and leaving restores the user's layout exactly. An early return on no-op mode switches is required — without it, entering pointer mode twice overwrites the stash with `{ false, false }`.

## Flipbook scroll sync

Switching cursor modes preserves scroll: capture the topmost visible question + its offset **before** the mode change, correct `scrollTop` in a layout effect **after** the DOM updates. The anchor must be React state (not a ref) so the layout effect depends on it.

- **Fallback when the anchor is hidden in the new mode** (e.g. a hidden field switching edit → pointer): search outward from the anchor index, backward first then forward. Backward-only misses the case where the anchor was the first question.
- **ResizeObserver correction** — sidebar width animations run async (~200ms) after the initial correction. A ResizeObserver re-corrects during that window, then clears the pending anchor after 250ms so later unrelated resizes don't reapply it.

## ProseMirror trailingBreak — CSS fix, not DOM

ProseMirror injects `<br class="ProseMirror-trailingBreak">` at the end of every block for cursor positioning, and this is hardcoded in prosemirror-view. Two selectors hide it only where it adds phantom height:

1. `.tiptap .ProseMirror-trailingBreak:not(:only-child)` — hide in non-empty paragraphs. In empty paragraphs (Enter keypress), the break is the sole child and must stay visible for cursor positioning.
2. `.tiptap:has(> :not(p)) > p:last-child > .ProseMirror-trailingBreak:only-child` — collapse the structural trailing paragraph ProseMirror auto-appends after block-level elements (lists, blockquotes, tables). `:has(> :not(p))` only matches when non-paragraph children exist, so empty lines in a plain-paragraph document stay visible.

Preview markdown sets `white-space: break-spaces` and `position: relative` globally to match ProseMirror's injected defaults, so no reflow occurs on mode switch. TipTap 3 uses class `tiptap`, not `ProseMirror`.

## Cursor mode toolbar — absolute, not sticky

The glassmorphic toolbar is absolutely positioned in the outer content wrapper, NOT as `sticky` inside the scroll container. Sticky-inside samples the opaque page background instead of scrolling content (kills the glass effect) and creates double scrollbars.

## Scroll-to-selection — rAF loop, not native smooth

Panel mount/unmount causes layout shifts that make the browser abandon native `scrollTo({ behavior: "smooth" })` mid-flight. A rAF loop recalculates the element's offset each frame and tracks the target correctly. Cross-screen navigation uses `"instant"` — smooth-scrolling between screens is disorienting. Do not switch back to native smooth.

Scroll margin is adaptive: compact for non-text clicks, expanded when the click activated a text-editable zone (floating label toolbar needs clearance). The "has toolbar" flag threads from the click site through to the scroll request.

## Sticky selection

Clicking empty space does not deselect. Deselecting would constantly dismiss the contextual editor panel. Selection only changes when the user clicks a different question or navigates away.

## Selection + scroll flow

Selection is a URL-state change (replace, no history entry); scroll is requested imperatively via a pending-target mechanism that the target question's wrapper consumes when it sees itself selected. This decouples "change the URL" from "scroll the canvas" so same-form and cross-screen navigation both flow through the same two calls. Tree sidebar clicks pass `"instant"` scroll behavior; in-canvas clicks default to `"smooth"`. Undo/redo scrolls directly — do NOT call into the pending mechanism from undo paths.

**Edit guard.** An XPath editor with unsaved invalid content can block navigation via the edit-guard context. Two-strike pattern: first attempt warns (shake + tooltip), second lets through. Any keystroke resets the counter.

**Question uuid is the stable UI identity** — it survives renames. Components compare by uuid to determine panel visibility and scroll targets. The question path is still carried for blueprint mutation calls.

## dnd-kit gotchas

- **`queueMicrotask` around onDragEnd state cleanup.** dnd-kit fires `onDragEnd` during `useInsertionEffect` where React 19 forbids `setState`.
- **Collision priority layering.** Group/repeat sortables use `Lowest` so the inner droppable container (`Low`) wins collision detection when items are dragged over the content area. Without this, the outer sortable intercepts the drop.
- **Empty group drop targets need `useDroppable` with a `:container` suffix id.** The `OptimisticSortingPlugin` only processes `SortableDroppable` instances; plain `useDroppable` targets are invisible to it. Container ids use the question uuid so they survive renames.

## Question wrapper is `div[role=button]`, not `<button>`

Children contain nested interactive elements (insertion-point buttons, text-editable buttons, form inputs, fieldsets). HTML forbids interactive content inside `<button>`, and SSR parsers will mangle the tree. Do not "fix" this to a real button.

## Edit mode is combined inspect + text editing

The wrapper renders `div[role=button]` with `cursor-pointer` and wraps children in `pointer-events-none`. Text-editable zones punch through via CSS (`pointer-events: auto; cursor: text; z-index: 1`). The wrapper's `onClickCapture` handler checks for text-editable targets: if found, select the question but DON'T stop propagation, so inline editing also activates. Non-text clicks select and stop propagation as before.

## Undo / redo

The undo/redo action runs: temporal store restore → `flushSync` (forces a React commit before DOM queries) → URL navigation to the affected question → scroll → violet flash highlight. Without `flushSync`, DOM elements toggled into existence by the undo aren't in the DOM yet when we try to focus them. Do NOT replace with `requestAnimationFrame`.

**Temporal store subscriptions** use `useStoreWithEqualityFn` from `zustand/traditional` with `Object.is`, not plain `useStore`. Plain `useStore` re-renders on every temporal state change regardless of selector; `Object.is` correctly skips re-renders when a boolean result is stable.

**Focus restoration** uses a focus-hint string storing the active field's data-id. A delegated onFocus handler writes the active field to session state, so blur-triggered saves capture the correct field. The hint is consumed once by the matching editor section and cleared. Do not query `document.activeElement` — blur moves focus before the snapshot fires.

## Properties panel — per-type field support

Not every question property applies to every question type. A central field-type-support map drives visibility. CommCare/Formplayer constraints force the sets: `calculate` overwrites user input so only hidden fields should have it; `required` is ignored on groups by Formplayer; media types have no XPath-expressible value.

When adding a new property, add it to the map. Fields absent from the map are allowed on all types (safe default). Type-conversion families are designed so every member shares identical field support, so conversions can't produce stale properties.

Editor sub-panels own their own visibility and return `null` when the type has no applicable fields.

## Contextual header — compute move targets inline

Move targets and `isFirst` / `isLast` flags are computed in the render body, NOT in `useMemo`. After a reorder, Immer produces new entity-map references that trigger a re-render, and inline computation picks up the fresh state. Memoizing on `[selected]` alone would miss the reorder because selection doesn't change on reorder.
