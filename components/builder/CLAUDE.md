# Builder Components

## BuilderLayout

Main layout with one `useChat` instance targeting `/api/chat`. Wrapped in `ErrorBoundary` around LeftPanel (Chat + Structure tabs), PreviewShell, and ContextualEditor.

- **`body`** sends: `apiKey`, `pipelineConfig`, `blueprint` (for edits).
- **`sendAutomaticallyWhen`** only triggers for `askQuestions` (client-side tool).
- **`onData`** handles all state updates via `applyDataPart()`.
- **`messages: persistedChatMessages`** seeds useChat with module-level cached messages on mount. The AI SDK's `Chat` instance lives in a `useRef` inside `useChat`, so it resets on component remount. `persistedChatMessages` (module-level, like the `Builder` singleton) bridges the gap — updated on every render, restored on remount.

### Four-Tier Header Layout

1. **Tier 1 — Logo bar**: `commcare nova` + settings link. `bg-nova-void`. Collapses to zero height in hero/centered mode via animated `height: 0 → auto`.
2. **Tier 2 — Project subheader**: Full-width breadcrumbs (left) + `DownloadDropdown` (right). `bg-[rgba(139,92,246,0.06)]` with subtle violet glow shadow. Shows as soon as centered mode exits (breadcrumbs populate once `app_name` arrives). Download button appears when `phase === Done`. `text-lg` for hierarchy above chat/toolbar text.
3. **Tier 3 — Toolbar** (`SubheaderToolbar.tsx`): Full-width `ViewModeToggle` (centered) + Undo/Redo (right). `bg-nova-deep`. Only shows when `Done` + blueprint exists.
4. **Tier 4 — Content area**: Main content fills full width (scrollbar on far right). LeftPanel (dual-tab Chat/Structure) floats as absolute overlay from the left edge. ContextualEditor floats as a portal anchored to the selected question.

### Chat-Centered Landing

When `builder.phase === Idle && !builder.treeData`, chat fills center with hero Logo above welcome heading and input — no header bars, uniform `bg-nova-void`. On generation start, Logo animates from center to header via `layoutId="nova-logo"` (global, no `LayoutGroup` — avoids triggering layout measurement passes that re-animate sibling panels), header tiers slide in, chat becomes a 320px sidebar overlay. `AnimatePresence` fades in builder panels (150ms delay). No DOM re-parenting — messages and input state preserved.

### Project Subheader (Tier 2)

`CollapsibleBreadcrumb` (exported from `SubheaderToolbar.tsx`) renders navigable breadcrumbs, derived from the current screen's hierarchical position (via `nav.breadcrumbPath`). Follow-up forms show the selected case name as the final breadcrumb segment. Clicking a breadcrumb calls `nav.navigateTo()` + `builder.select()`. Breadcrumbs use `text-lg whitespace-nowrap` — no truncation since the full-width bar has ample space. Collapse behind `…` dropdown only at depth 4+.

### Toolbar (Tier 3, `SubheaderToolbar.tsx`)

Full-width 3-column grid: left spacer, center `ViewModeToggle` (`components/preview/ViewModeToggle.tsx`), right Undo/Redo. `h-12 bg-nova-deep`. `ViewModeToggle` is a compact `h-[34px]` 2-segment control (Design | Preview) matching undo/redo button height.

`usePreviewNav` is lifted to BuilderLayout and shared with `PreviewShell` (via `nav` prop) so navigation state stays in sync. PreviewShell renders with `hideHeader` since BuilderLayout owns the header tiers. `handlePreviewBack` syncs `builder.select()` when the in-content back button is clicked, passed to PreviewShell via `onBack`.

### View Mode Sync

`viewMode` state (`'design' | 'preview'`). Two modes only — the app tree lives permanently in the LeftPanel's Structure tab rather than as a separate "overview" mode.

- **Design ↔ Preview**: Nav is shared (no sync needed). Selection preserved but invisible in preview mode. Preview → Design preserves existing selection state — sidebar only opens if user had something selected before entering preview. Design → Preview auto-focuses the selected question's input. **Flipbook scroll sync**: `handleViewModeChange` captures the topmost visible question's `data-question-id` and its pixel offset from the scroll container top before calling `setState`. A `useLayoutEffect` on `viewMode` then restores the scroll position before paint — finding the same element (or the nearest visible question above it if the anchor is hidden by relevancy) and adjusting `scrollTop` to match the captured offset. The scroll container is identified via `[data-preview-scroll-container]` on PreviewShell's inner scroll div.
- **Escape in preview**: Switches to design without nav sync (stays on current screen).
- **Structure tree selection**: `handleTreeSelect` in BuilderLayout calls `builder.select()` and typed nav methods (`nav.navigateToForm()`, `nav.navigateToModule()`, `nav.navigateToHome()`). Typed methods are idempotent — they use `screensEqual()` internally to skip if already on the target screen, preventing duplicate history entries when clicking multiple questions in the same form.

When `Done` + blueprint exists:
- `'design'` → `PreviewShell` (editable canvas) + `LeftPanel` (overlay left, Chat/Structure tabs) + `ContextualEditor` (floating, anchored to selected question)
- `'preview'` → `PreviewShell` (read-only, no edit chrome, no sidebars)

### Panel State Management

LeftPanel collapses in preview mode. ContextualEditor shows in design mode whenever a question is selected (no separate open/close pref — always visible for the selected question).
- `leftOpen = viewMode === 'preview' ? false : leftPanelOpen`
- `showContextualEditor = showToolbar && viewMode === 'design'`

`leftTab` (`'chat' | 'structure'`) tracks which LeftPanel tab is active. Auto-switches to `'structure'` when tree data first appears during generation, then to `'chat'` when generation completes (so the SA's "app is ready" message is visible). After generation, the canvas auto-navigates to the first form.

## LeftPanel

Dual-tab left panel combining Chat and Structure (app tree) in a single overlay. Tab bar with `ci/message` (Chat) and `tabler/list-tree` (Structure) icons + close chevron. Each tab renders its content in the shared panel body:
- **Chat tab**: Embeds `ChatSidebar` in `sidebar-embedded` mode (no header/chrome — LeftPanel provides the shell). ChatSidebar stays mounted when switching to Structure tab (hidden via `visibility: hidden` + `absolute` positioning) to preserve scroll position. AppTree still unmounts on tab switch (resets fuzzy search state).
- **Structure tab**: Embeds `AppTree` in `compact` mode (tighter spacing for 320px width). `onTreeSelect` prop delegates to BuilderLayout's `handleTreeSelect` which calls `builder.select()`, typed nav methods (`navigateToForm`/`navigateToModule`/`navigateToHome`), and scrolls the design canvas to the selected question if not already visible (250ms delay, visibility check, `block: 'start'`). Tree supports expand/collapse at module, form, and group/repeat levels. Question rows use compact `text-xs` font, reduced depth-based indentation (`depth * 6`), alternating row backgrounds (pre-computed via `buildOddPaths`), and `data-tree-question` attributes for cross-panel scroll targeting. **Fuzzy search** input pinned above the scrollable area (compact mode only) filters the tree by question label, question ID, module name, or form name. Uses fuse.js (`lib/filterTree.ts`) with `useDeferredValue` for responsive input. Matching branches preserve parent hierarchy; non-matching items are hidden. Parent nodes auto-expand via `forceExpand` set. Matched text highlighted with `bg-nova-violet/20`. When an ID matches (but not the label), the ID appears in parens on the right of the label in monospace. Escape clears the search; state resets on tab switch (AppTree unmounts).

Keyboard shortcuts extracted to `useBuilderShortcuts.ts` hook, registered via `useKeyboardShortcuts`. Undo/redo shortcuts delegate to `handleUndo`/`handleRedo` callbacks (passed from BuilderLayout) rather than calling `builder.undo()`/`redo()` directly — this enables view restoration after undo/redo.

### Undo/Redo View Restoration

Undo/redo "teleports" the user back to where the edit was made. Each history snapshot captures the current `ViewMode`. On undo/redo, `builder.undo()`/`redo()` return the captured view mode. BuilderLayout's `restoreView()` switches viewMode if needed and syncs the preview nav via typed methods (`navigateToForm`/`navigateToModule`/`navigateToHome`) so the correct form is visible. `builder.setViewMode()` keeps the HistoryManager in sync on each render.

## ContextualEditor

Floating property panel anchored to the selected question via `@floating-ui/react`. Rendered into a `FloatingPortal` at `z-popover`. Appears in design mode whenever a question is selected (`showContextualEditor = showToolbar && viewMode === 'design'`). All hooks called unconditionally before the early return guard (React rules of hooks).

**Anchor resolution** — two-source strategy via `useLayoutEffect`: prefers `builder.questionAnchor` (element registered by `EditableQuestionWrapper`'s React 19 ref callback), falls back to DOM query (`[data-question-id]`). DOM query handles same-form selection instantly; the registered anchor handles cross-form navigation (element mounts after form transition). When neither source finds the element, `anchorReady` state goes false and the panel returns null (no 0,0 flash). The anchor subscription is separate from the main builder subscription (`subscribeAnchor`/`getAnchorSnapshot` via `useSyncExternalStore`) to avoid re-rendering the wrapper tree and causing infinite ref callback loops. Entrance animation replays on question change or after cross-form anchor resolution.

Split into tabbed sub-editors (`ContextualEditorTabs`):
- **UI tab** (`ContextualEditorUI`) — label, type (via `QuestionTypeGrid` popover at `z-popover-top`), hint, required
- **Logic tab** (`ContextualEditorLogic`) — validation, relevant, default_value, calculate (XPath modal)
- **Data tab** (`ContextualEditorData`) — question ID (with rename propagation), `CasePropertyPills` ("Saves to" header + pill buttons), options editor for select types

**Footer** (`ContextualEditorFooter`) — move up/down, duplicate, delete. Uses `flattenQuestionPaths` with `builder.mutationCount` dependency to keep move button enabled/disabled state fresh after mutations.

Reads/writes through `builder.mb` (persistent `MutableBlueprint`). Editing patterns:

- **EditableText** — Always-rendered input/textarea styled as static text when unfocused, editing chrome on focus. Click places cursor at the native click position (no DOM swap). Single-line: Enter saves. Multiline: Enter inserts newline, Cmd/Ctrl+Enter saves. Escape cancels. Blur saves. Emerald checkmark fades on save. `autoFocus` focuses on mount. `selectAll` selects all text on focus (used for newly added questions via `builder.isNewQuestion(path)`, cleared on first save via `builder.clearNewQuestion()`). Optional `labelRight` renders right-aligned content in the label row.
- **EditableDropdown** — Custom dark-themed dropdown. Selection saves immediately (including re-selection of current value, enabling actions like reopening the XPath modal). Click-outside/Escape via `useDismissRef`.
- **QuestionTypeGrid** (`components/builder/QuestionTypeGrid.tsx`) — shared 2-column icon+label grid for type selection. Used by both `ContextualEditorUI` (type change) and `QuestionTypePicker` (insertion point). Highlights active type with violet accent.
- **CasePropertyPills** — pill buttons with "Saves to" header. One pill per case type the module can write to (its own type + child types via `getModuleCaseTypes`). Click to toggle on/off, radio behavior when multiple. Disabled for media types, locked on for `case_name`.
- **XPathEditorModal** — Portal-mounted CodeMirror editor at `z-modal`. Fold gutters, bracket matching, zebra stripes. Opens with `prettyPrintXPath`, saves back via `formatXPath` (single-line for storage). Cmd/Ctrl+Enter saves, Escape closes. Lazy-loaded via `next/dynamic` (`ssr: false`).

### Rename Propagation

- Editing question ID → `mb.renameQuestion()` → `rewriteXPathRefs` (Lezer-based) updates `/data/...` paths and `#form/...` hashtags across siblings.
- Renaming a case property (question with `case_property_on`) → `mb.renameCaseProperty()` → renames question ID across all forms in the module, `rewriteHashtagRefs` for `#case/...` refs, updates columns. Does not touch `case_types` (frozen after generation).

## GenerationProgress

Progress bar with phase labels during generation. Always centered in the content area throughout the entire generation lifecycle — stays centered even after the scaffold tree appears in the left panel, then dismisses immediately on completion with a 1s fade-out. Counts derived from `builder.progressCompleted` / `builder.progressTotal`.

## ReplayController

Fixed-position pill for log replay navigation. Left/right arrows, stage counter, close button. Drives Builder via `applyDataPart()`. Accepts `initialIndex` prop — defaults to 0 but BuilderLayout passes `doneIndex` so replay starts at the completed app state (edit stages after Done are still navigable forward).
