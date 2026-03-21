# Builder Components

## BuilderLayout

Main layout with one `useChat` instance targeting `/api/chat`. Wrapped in `ErrorBoundary` around LeftPanel (Chat + Structure tabs), PreviewShell, and DetailPanel.

- **`body`** sends: `apiKey`, `pipelineConfig`, `blueprint` (for edits), `blueprintSummary` (for SA context).
- **`sendAutomaticallyWhen`** only triggers for `askQuestions` (client-side tool).
- **`onData`** handles all state updates via `applyDataPart()`.
- **`messages: persistedChatMessages`** seeds useChat with module-level cached messages on mount. The AI SDK's `Chat` instance lives in a `useRef` inside `useChat`, so it resets on component remount. `persistedChatMessages` (module-level, like the `Builder` singleton) bridges the gap — updated on every render, restored on remount.

### Four-Tier Header Layout

1. **Tier 1 — Logo bar**: `commcare nova` + settings link. `bg-nova-void`. Collapses to zero height in hero/centered mode via animated `height: 0 → auto`.
2. **Tier 2 — Project subheader**: Full-width breadcrumbs (left) + `DownloadDropdown` (right). `bg-[rgba(139,92,246,0.06)]` with subtle violet glow shadow. Shows as soon as centered mode exits (breadcrumbs populate once `app_name` arrives). Download button appears when `phase === Done`. `text-lg` for hierarchy above chat/toolbar text.
3. **Tier 3 — Toolbar** (`SubheaderToolbar.tsx`): Full-width `ViewModeToggle` (centered) + Undo/Redo (right). `bg-nova-deep`. Only shows when `Done` + blueprint exists.
4. **Tier 4 — Content area**: Main content fills full width (scrollbar on far right). LeftPanel (dual-tab Chat/Structure) and DetailPanel float as absolute overlays from left/right edges respectively.

### Chat-Centered Landing

When `builder.phase === Idle && !builder.treeData`, chat fills center with hero Logo above welcome heading and input — no header bars, uniform `bg-nova-void`. On generation start, Logo animates from center to header via `layoutId="nova-logo"`, header tiers slide in, chat becomes a 320px sidebar overlay — coordinated by `LayoutGroup`. `AnimatePresence` fades in builder panels (150ms delay). No DOM re-parenting — messages and input state preserved.

### Project Subheader (Tier 2)

`CollapsibleBreadcrumb` (exported from `SubheaderToolbar.tsx`) renders navigable breadcrumbs, always derived from the `usePreviewNav` stack. Follow-up forms show the selected case name as the final breadcrumb segment. Clicking a breadcrumb calls `nav.navigateTo()` + `builder.select()`. Breadcrumbs use `text-lg whitespace-nowrap` — no truncation since the full-width bar has ample space. Collapse behind `…` dropdown only at depth 4+.

### Toolbar (Tier 3, `SubheaderToolbar.tsx`)

Full-width 3-column grid: left spacer, center `ViewModeToggle` (`components/preview/ViewModeToggle.tsx`), right Undo/Redo. `h-12 bg-nova-deep`. `ViewModeToggle` is a compact `h-[34px]` 2-segment control (Design | Preview) matching undo/redo button height.

`usePreviewNav` is lifted to BuilderLayout and shared with `PreviewShell` (via `nav` prop) so navigation state stays in sync. PreviewShell renders with `hideHeader` since BuilderLayout owns the header tiers.

### View Mode Sync

`viewMode` state (`'design' | 'preview'`). Two modes only — the app tree lives permanently in the LeftPanel's Structure tab rather than as a separate "overview" mode.

- **Design ↔ Preview**: Nav is shared (no sync needed). Selection preserved but invisible in preview mode. Preview → Design preserves existing selection state — sidebar only opens if user had something selected before entering preview. Design → Preview auto-focuses the selected question's input.
- **Escape in preview**: Switches to design without nav sync (stays on current screen).
- **Structure tree selection**: `handleTreeSelect` in BuilderLayout calls both `builder.select()` and `nav.replaceStack()` so clicking a tree item navigates the canvas to the corresponding form and opens the detail panel.

When `Done` + blueprint exists:
- `'design'` → `PreviewShell` (editable canvas) + `LeftPanel` (overlay left, Chat/Structure tabs) + `DetailPanel` (overlay right)
- `'preview'` → `PreviewShell` (read-only, no edit chrome, no sidebars)

### Panel State Management

LeftPanel and DetailPanel both collapse in preview mode:
- `leftOpen = viewMode === 'preview' ? false : leftPanelOpen`
- `detailOpen = viewMode === 'preview' ? false : detailUserPref`
- `showDetailPanel = showToolbar && !!builder.selected && detailOpen`

`leftTab` (`'chat' | 'structure'`) tracks which LeftPanel tab is active. Auto-switches to `'structure'` when tree data first appears during generation, then to `'chat'` when generation completes (so the SA's "app is ready" message is visible). After generation, the canvas auto-navigates to the first form.

DetailPanel pref syncs with selection changes via a `useEffect` that suppresses during view mode transitions (prevents auto-sync re-selections from reopening a closed panel). When selection changes without a view mode change: selecting sets pref `true`, deselecting sets pref `false`. View mode transitions (where auto-sync may re-select from nav) leave the pref unchanged. Undo/redo explicitly sets pref `true` to show edit context. The reopen button (`ci:chat-conversation-circle`) also hides in preview mode.

## LeftPanel

Dual-tab left panel combining Chat and Structure (app tree) in a single overlay. Tab bar with `ci/message` (Chat) and `tabler/list-tree` (Structure) icons + close chevron. Each tab renders its content in the shared panel body:
- **Chat tab**: Embeds `ChatSidebar` in `sidebar-embedded` mode (no header/chrome — LeftPanel provides the shell).
- **Structure tab**: Embeds `AppTree` in `compact` mode (tighter spacing for 320px width). `onTreeSelect` prop delegates to BuilderLayout's `handleTreeSelect` which calls both `builder.select()` and `nav.replaceStack()` — so clicking any item in the tree navigates the canvas and opens the detail panel.

Keyboard shortcuts extracted to `useBuilderShortcuts.ts` hook, registered via `useKeyboardShortcuts`. Undo/redo shortcuts delegate to `handleUndo`/`handleRedo` callbacks (passed from BuilderLayout) rather than calling `builder.undo()`/`redo()` directly — this enables view restoration after undo/redo.

### Undo/Redo View Restoration

Undo/redo "teleports" the user back to where the edit was made. Each history snapshot captures the current `ViewMode`. On undo/redo, `builder.undo()`/`redo()` return the captured view mode. BuilderLayout's `restoreView()` switches viewMode if needed and syncs the preview nav stack to the restored selection (so the correct form is visible in design/preview mode). `builder.setViewMode()` keeps the HistoryManager in sync on each render.

## DetailPanel

Right-side overlay mirroring ChatSidebar's structure. BuilderLayout wraps it in an outer `motion.div` with `absolute right-0 top-0 bottom-0 z-20` for positioning and slide animation (`x: 320 → 0`). Inner DetailPanel is a plain `w-80 h-full` div styled as a pullout: `rounded-l-xl m-2 mr-0 border border-nova-border-bright border-r-0 shadow-[0_2px_12px_rgba(0,0,0,0.4)]`. Floats over main content without affecting layout or scrollbar position.

Split into sub-panels:
- `detail/ModuleDetail.tsx` — module name, case type, columns
- `detail/FormDetail.tsx` — form name, type, case config
- `detail/QuestionDetail.tsx` — question fields, XPath, options

Reads/writes through `builder.mb` (persistent `MutableBlueprint`). Three editing patterns:

- **EditableText** — Always-rendered input/textarea styled as static text when unfocused, editing chrome on focus. Click places cursor at the native click position (no DOM swap). Single-line: Enter saves. Multiline: Enter inserts newline, Cmd/Ctrl+Enter saves. Escape cancels. Blur saves. Emerald checkmark fades on save. `autoFocus` focuses on mount. `selectAll` selects all text on focus (used for newly added questions via `builder.isNewQuestion(path)`, cleared on first save via `builder.clearNewQuestion()`).
- **EditableDropdown** — Custom dark-themed dropdown. Selection saves immediately (including re-selection of current value, enabling actions like reopening the XPath modal). Click-outside/Escape via `useDismissRef`.
- **XPathEditorModal** — Portal-mounted CodeMirror editor with fold gutters (ci chevron SVG markers), bracket matching, zebra stripes. Opens with `prettyPrintXPath` (same expanded format as sidebar), saves back via `formatXPath` (single-line for storage). Auto-focuses with cursor at end. Cmd/Ctrl+Enter saves, Escape closes via ref callback. Cancel/Update buttons. Indentation uses 4 spaces (matching `Layout.Tab` rendering).

**Editable fields:** module name, form name, form type, question label/id/type/case_property/hint, required (dropdown with conditional → opens XPath modal), validation/relevant/default_value/calculate (XPath modal). "Add Property" shows `+` buttons for missing optional fields.

### Rename Propagation

- Editing question ID → `mb.renameQuestion()` → `rewriteXPathRefs` (Lezer-based) updates `/data/...` paths and `#form/...` hashtags across siblings.
- Editing case property → `mb.renameCaseProperty()` → `rewriteHashtagRefs` for `#case/...` refs across all questions, columns, XPath, and output tags.

## XPathField

Read-only CodeMirror with Nova theme, `tabSize: 4`, `prettyPrintXPath` for display. Optional `onClick` adds hover highlight (used by DetailPanel to open XPath modal).

## GenerationProgress

Progress bar with phase labels during generation. Counts derived from `builder.progressCompleted` / `builder.progressTotal`.

## ReplayController

Fixed-position pill for log replay navigation. Left/right arrows, stage counter, close button. Drives Builder via `applyDataPart()`. Accepts `initialIndex` prop — defaults to 0 but BuilderLayout passes `doneIndex` so replay starts at the completed app state (edit stages after Done are still navigable forward).
