# Builder Components

## Edit vs preview mode

**Edit** is a frozen, stateless view: inputs appear empty, validation is suppressed, the submit bar is hidden. **All questions render regardless of relevant conditions** — hidden questions appear as compact cards so the full structure is always visible for editing. Engine state is preserved internally; only the display layer is suppressed.

**Preview** is a persistent testing sandbox. Values survive round-trips through edit. Validation state resets on exit so fields start clean on re-entry; on switch back, rules re-evaluate against the persisted values. Blueprint mutations recreate the engine, but only user-touched values are restored — untouched fields pick up new defaults, so editing a default expression is immediately reflected.

## Pointer mode is immersive

Pointer mode atomically hides both sidebars AND the floating reopen buttons. The mode switcher stashes current sidebar open-state in a single set call so entering and leaving restores the user's layout exactly. An early return on no-op mode switches is required — without it, entering pointer mode twice overwrites the stash with `{ false, false }`.

## Flipbook scroll sync

Switching cursor modes preserves scroll: capture the topmost visible field + its offset **before** the mode change, correct `scrollTop` in a layout effect **after** the DOM updates. The anchor must be React state (not a ref) so the layout effect depends on it.

- **Fallback when the anchor is hidden in the new mode** (e.g. a hidden field switching edit → pointer): search outward from the anchor index, backward first then forward. Backward-only misses the case where the anchor was the first field.
- **ResizeObserver correction** — sidebar width animations run async (~200ms) after the initial correction. A ResizeObserver re-corrects during that window, then clears the pending anchor after 250ms so later unrelated resizes don't reapply it.

## Flipbook layout parity

Edit (`VirtualFormList`) and live (`InteractiveFormRenderer`) must land every row at the same X/Y so the user's reading position never shifts on mode switch. Scroll sync (above) can't rescue a layout that genuinely differs between modes.

- **Group/repeat collapse lives in `FormLayoutContext`** (`components/preview/form/FormLayoutContext.tsx`), mounted once per form in `FormScreen`. Both branches read from it. Do not move collapse state back into `VirtualFormList` — cursor mode switches unmount that tree and would reset every fold.
- **Every row uses `paddingRight: depthPadding(depth)`, not `depthPadding(0)`.** The right gutter scales with depth symmetrically so nested rows are inset from both sides of their container. `depthPadding(0)` on the right made children kiss the group's right border.
- **Live-mode labels wrap `LabelContent` in `<div className="px-[5px] py-[5px]">`** to match `TextEditable`'s idle wrapper in edit mode. Without it every labelled row is 10px shorter in live mode and the flipbook drifts one row height per group/leaf.

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

Clicking empty space does not deselect. Deselecting would constantly dismiss the field inspector panel. Selection only changes when the user clicks a different field or navigates away.

## Selection + scroll flow

Selection is a URL-state change (replace, no history entry); scroll is requested imperatively via a pending-target mechanism that the target field's wrapper consumes when it sees itself selected. This decouples "change the URL" from "scroll the canvas" so same-form and cross-screen navigation both flow through the same two calls. Tree sidebar clicks pass `"instant"` scroll behavior; in-canvas clicks default to `"smooth"`. Undo/redo scrolls directly — do NOT call into the pending mechanism from undo paths.

**Edit guard.** An XPath editor with unsaved invalid content can block navigation via the edit-guard context. Two-strike pattern: first attempt warns (shake + tooltip), second lets through. Any keystroke resets the counter.

**Field uuid is the stable UI identity** — it survives renames. Components compare by uuid to determine panel visibility and scroll targets. The field path is still carried for blueprint mutation calls.

## Drag-and-drop — pragmatic-drag-and-drop + TanStack Virtual

The edit-mode form editor uses Atlassian's `pragmatic-drag-and-drop` (native browser drag, framework-agnostic) with `@tanstack/react-virtual`. `@dnd-kit/react` was replaced because its `OptimisticSortingPlugin` physically moves DOM elements during drag, which fights the virtualizer's absolute-position layout and breaks the live drop-target indicator.

- **Placeholder gap during drag.** The monitor's `onDrag` resolves which insertion row corresponds to the hover position, then REPLACES that insertion row with a taller `drop-placeholder` row (dashed violet outline). The row count stays the same; only the one swapped slot remeasures. The height difference pushes rows below apart, opening a visible gap. When the cursor is in dead space (the placeholder itself, which has no field-row drop target), the last valid position is preserved — clearing it would collapse the gap and trigger a flicker loop. Adjacency suppression prevents the placeholder from appearing next to the source item (a no-op drop).
- **`pendingDropRef` bridges onDrag→onDrop.** At drop time the cursor is usually over the placeholder (not a field row), so `location.current.dropTargets` has no useful data. The monitor stashes the resolved `{drop, edge}` from `onDrag` into a ref that `onDrop` reads to build the `moveField` args. The placeholder row itself is registered as a `dropTargetForElements` so the browser accepts the native drop (no snap-back animation).
- **One monitor owns the mutation.** `VirtualFormList` installs a single `monitorForElements` that receives every drag/drop for the form. `onDrag` computes the placeholder position; `onDrop` applies the real `moveField` mutation + selects the dropped field. Row components never call mutations directly.
- **Drop targets are typed.** `dragData.ts` defines a discriminated union of drop-target payloads (`drop-field`, `drop-group-header`, `drop-empty-container`). The monitor reads the innermost target from `location.current.dropTargets[0]` and dispatches on `kind`. Keep new drop-target kinds in that file so the monitor stays a single switch.
- **Shared `useRowDnd` hook.** Owns `draggable()` + `dropTargetForElements()` registration, self-drop rejection, cycle guard (`isUuidInSubtree`), and the custom native drag preview. Row components pass `buildDropData` + `cycleTargetContainerUuid` + `renderPreview` — the hook handles everything else identically across FieldRow, GroupOpenRow, and EmptyContainerRow.
- **Custom native drag preview.** `setCustomNativeDragPreview` renders a lightweight `DragPreviewPill` into a library-owned offscreen container. The browser snapshots this instead of the source element, so the source stays at its original size — prevents the virtualizer's `measureElement` ResizeObserver from collapsing adjacent rows during drag. The preview portal lives in `useRowDnd`'s return value; callers must render `{preview}` in their JSX.
- **`attachClosestEdge` on `getData`.** Field rows use `attachClosestEdge(..., { allowedEdges: ['top', 'bottom'] })` so the edge is available as `extractClosestEdge(self.data)` during `onDrag` and on drop. Group headers + empty containers have a single drop zone and don't need an edge.
- **Auto-scroll is separate.** `autoScrollForElements({ element: scrollContainer })` in a dedicated effect handles near-edge scrolling during drag. It works across virtualized rows because it drives the scroll container, not any specific row.
- **Cycle guard.** `canDrop` in every drop target + a defensive second check in the monitor's `onDrop` use `isUuidInSubtree` to prevent dragging a group onto its own descendant (which would create a cycle in `fieldOrder`). The guard reads the doc store imperatively on each `canDrop` invocation.
- **Contained scroll + `contain: strict`.** Safe with pragmatic DnD because the drag preview is browser-managed. dnd-kit's `DragOverlay` used `position: fixed` and was broken by `contain: strict`; pragmatic DnD's approach is immune.

## Field wrapper is `div[role=button]`, not `<button>`

Children contain nested interactive elements (insertion-point buttons, text-editable buttons, form inputs, fieldsets). HTML forbids interactive content inside `<button>`, and SSR parsers will mangle the tree. Do not "fix" this to a real button.

## Edit mode is combined inspect + text editing

The wrapper renders `div[role=button]` with `cursor-pointer` and wraps children in `pointer-events-none`. Text-editable zones punch through via CSS (`pointer-events: auto; cursor: text; z-index: 1`). The wrapper's `onClickCapture` handler checks for text-editable targets: if found, select the field but DON'T stop propagation, so inline editing also activates. Non-text clicks select and stop propagation as before.

## Undo / redo

The undo/redo action runs: temporal store restore → `flushSync` (forces a React commit before DOM queries) → URL navigation to the affected field → scroll → violet flash highlight. Without `flushSync`, DOM elements toggled into existence by the undo aren't in the DOM yet when we try to focus them. Do NOT replace with `requestAnimationFrame`.

**Temporal store subscriptions** use `useStoreWithEqualityFn` from `zustand/traditional` with `Object.is`, not plain `useStore`. Plain `useStore` re-renders on every temporal state change regardless of selector; `Object.is` correctly skips re-renders when a boolean result is stable.

**Focus restoration** uses a focus-hint string storing the active field's data-id. A delegated onFocus handler writes the active field to session state, so blur-triggered saves capture the correct field. The hint is consumed once by the matching editor section and cleared. Do not query `document.activeElement` — blur moves focus before the snapshot fires.

## Editor

Field editing is registry-driven. The hierarchy:

- `InlineSettingsPanel` — the violet glass drawer mounted under a selected
  row. Renders chrome only (the focus-handler delegate that tracks active
  fields for undo/redo). Composes `<FieldHeader>` + `<FieldEditorPanel>`.
- `FieldHeader` (in `editor/`) — id input, type-icon adornment, kebab menu
  (move/duplicate/convert/delete), trash button. Reads
  `fieldRegistry[kind]` for icon/label/convertTargets.
- `FieldEditorPanel` (in `editor/`) — composes three `FieldEditorSection`s
  (Data / Logic / Appearance). Hides empty sections via `sectionHasContent`.
- `FieldEditorSection` (in `editor/`) — partitions schema entries into
  visible (rendered via their component) vs addable-but-hidden (rendered
  as Add Property pills). Activation state lives in `useEntryActivation`;
  an effect clears activation when a pending entry becomes independently
  visible.
- Per-key editor components in `editor/fields/` — each one knows how to
  edit a single field key (XPathEditor, RequiredEditor, TextEditor,
  CasePropertyEditor, OptionsEditor).

The Zod schemas + kind metadata live in `lib/domain/fields/<kind>.ts`;
the editor schemas keyed by `FieldKind` live in
`components/builder/editor/fieldEditorSchemas.ts`. Adding a new property
= adding one entry to a kind's schema. Adding a new kind = a new file
in `lib/domain/fields/` + a new entry in `fieldEditorSchemas`.

## Field header — compute move targets inline

Move targets and `isFirst` / `isLast` flags are computed in the render body, NOT in `useMemo`. After a reorder, Immer produces new entity-map references that trigger a re-render, and inline computation picks up the fresh state. Memoizing on `[selected]` alone would miss the reorder because selection doesn't change on reorder.

## App tree

`components/builder/appTree/` holds the structure sidebar:

- `AppTree.tsx` — shell (search input, scroll container, module dispatch).
- `ModuleCard.tsx` / `FormCard.tsx` / `FieldRow.tsx` — three memoized row
  components, one per entity level. Each subscribes to its own entity in
  the doc store; Immer structural sharing means an edit to one field
  re-renders only its `FieldRow`.
- `useSearchFilter.ts` — entity-map-based search filter. SEARCH_IDLE
  sentinel keeps the subscription stable when the user isn't searching.
- `useFieldIconMap.ts` — per-form `{ path → icon }` for chip rendering.
- `useAppTreeSelection.ts` — produces the `handleSelect` callback. Field
  selection primes a pending scroll BEFORE navigating so the target row's
  `useFulfillPendingScroll` has a request waiting when `isSelected` flips.
- `shared.tsx` — `TreeItemRow`, `CollapseChevron`, `HighlightedText`,
  `FormIconContext`.

## Form settings

`components/builder/detail/formSettings/`:

- `FormSettingsButton.tsx` — popover trigger (the public mount point).
- `FormSettingsPanel.tsx` — drawer chrome + section list.
- `CloseConditionSection.tsx` / `AfterSubmitSection.tsx` /
  `ConnectSection.tsx` — three top-level features.
- `LearnConfig.tsx` / `DeliverConfig.tsx` — two connect-mode sub-configs.
- `SelectMenu.tsx` — shared dropdown primitive (chevron + corner-rounding
  + anchor wiring). Used by close-mode, operator, value, and
  after-submit-destination menus.
- `InlineField.tsx` / `LabeledXPathField.tsx` — compact widgets.
- `useConnectLintContext.ts` — XPath lint context for the form.
- `findFieldById.ts` — depth-first lookup by semantic id.
- `types.ts` — shared `FormSettingsSectionProps`.

## Virtual form list

`VirtualFormList.tsx` (in `components/preview/form/virtual/`) is the
edit-mode form renderer. The drag-lifecycle state + `monitorForElements`
registration + cursor-velocity tracking live in `useDragIntent.ts`. The
shell handles virtualization, row dispatch, and the field-picker menu.

## BuilderProvider

`BuilderProvider.tsx` mounts the complete provider stack for a builder session. `key={buildId}` forces a full unmount/remount when the build identity changes — no stale cross-store references can leak.

Provider tree (outer → inner): BlueprintDocProvider → BuilderSessionProvider → ScrollRegistryProvider → EditGuardProvider → BuilderFormEngineProvider. Three lifecycle children: SyncBridge (wires doc store into session), ReplayHydrator (dispatches saved emissions for replay mode), LoadAppHydrator (clears loading flag for existing-app loads).
