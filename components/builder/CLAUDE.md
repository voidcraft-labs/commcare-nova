# Builder Components

## BuilderLayout

Main 3-panel layout with one `useChat` instance targeting `/api/chat`. Wrapped in `ErrorBoundary` around ChatSidebar, PreviewShell/AppTree, and DetailPanel.

- **`body`** sends: `apiKey`, `pipelineConfig`, `blueprint` (for edits), `blueprintSummary` (for SA context).
- **`sendAutomaticallyWhen`** only triggers for `askQuestions` (client-side tool).
- **`onData`** handles all state updates via `applyDataPart()`.

### Chat-Centered Landing

When `builder.phase === Idle && !builder.treeData`, chat fills center with hero Logo above welcome heading and input — no header bar, uniform `bg-nova-void`. On generation start (DataModel phase), Logo animates from center to header via `layoutId="nova-logo"`, header slides in (animated `height: 0 → auto`), chat narrows to 380px sidebar — coordinated by `LayoutGroup` wrapping the layout. `AnimatePresence` fades in builder panels (150ms delay). No DOM re-parenting — messages and input state preserved.

### Subheader Toolbar (`SubheaderToolbar.tsx`)

Extracted component rendered by BuilderLayout (only when `Done` + blueprint exists) spanning the full width right of the chat sidebar. 3-column grid layout: left shows navigable breadcrumbs (all modes), center has `PreviewToggle` (3-segment: Tree / Design / Preview), right has Undo/Redo buttons + `DownloadDropdown` (JSON/CCZ export). Both the main content area and DetailPanel sit **below** this subheader in a flex row — sidebars slide out from beneath the subheader, never above it.

Breadcrumbs are unified across all view modes via `CollapsibleBreadcrumb` (internal component). In design/preview, derived from `usePreviewNav` stack. In tree mode, derived from `builder.selected` (app name → module → form). Follow-up forms show the selected case name as the final breadcrumb segment (from `caseData.get('case_name')`) instead of repeating the form name. Clicking a breadcrumb navigates: in design/preview calls `nav.navigateTo()` + `builder.select()`; in tree calls `builder.select()` directly.

**Collapsible breadcrumbs**: First and last items always occupy stable DOM positions to prevent flicker on depth changes. At depth ≤3, all segments shown inline with truncation. At depth 4+, middle segments collapse behind an animated `…` dropdown menu (Motion + `useDismissRef`). Last item (current location) has `shrink-0 max-w-[50%]` to prioritize showing its full text; ancestor items use `shrink-[3]` to absorb compression first.

`usePreviewNav` is lifted to BuilderLayout and shared with `PreviewShell` (via `nav` prop) so navigation state stays in sync. AppTree and PreviewShell render with `hideHeader` since BuilderLayout owns the subheader.

### View Mode Sync

`viewMode` state (`'tree' | 'design' | 'preview'`). Selection (`builder.selected`) and navigation (`usePreviewNav` stack) stay in sync across view switches:

- **Tree → Design/Preview**: Nav stack syncs to `builder.selected` (navigates to the selected module/form). `usePreviewNav` auto-resolves case data for followup forms via `resolveScreen`.
- **Design/Preview → Tree**: If nothing selected, `builder.selected` syncs from current nav screen.
- **Design ↔ Preview**: Nav is shared (no sync needed). Selection preserved but invisible in preview mode. Preview → Design preserves existing selection state — sidebar only opens if user had something selected before entering preview. Design → Preview auto-focuses the selected question's input.
- **Escape in preview**: Switches to design without nav sync (stays on current screen).

When `Done` + blueprint exists:
- `'tree'` → `AppTree` + `DetailPanel` (inline right sidebar)
- `'design'` → `PreviewShell` (editable canvas) + `DetailPanel` (inline right sidebar)
- `'preview'` → `PreviewShell` (read-only, no edit chrome or sidebar)

Keyboard shortcuts extracted to `useBuilderShortcuts.ts` hook, registered via `useKeyboardShortcuts`.

## DetailPanel

Animated width panel (0 → 320px) via `AnimatePresence` + motion `width`/`opacity`. Outer `motion.div` handles width animation with `overflow-hidden`; inner `w-80` div keeps content at full width. This ensures the flex-1 content area resizes smoothly (no layout jumps) when the panel opens/closes.

Split into sub-panels:
- `detail/ModuleDetail.tsx` — module name, case type, columns
- `detail/FormDetail.tsx` — form name, type, case config
- `detail/QuestionDetail.tsx` — question fields, XPath, options

Reads/writes through `builder.mb` (persistent `MutableBlueprint`). Three editing patterns:

- **EditableText** — Always-rendered input/textarea styled as static text when unfocused, editing chrome on focus. Click places cursor at the native click position (no DOM swap). Single-line: Enter saves. Multiline: Enter inserts newline, Cmd/Ctrl+Enter saves. Escape cancels. Blur saves. Emerald checkmark fades on save. `autoFocus` focuses on mount. `selectAll` selects all text on focus (used for newly added questions via `builder.isNewQuestion(path)`, cleared on first save via `builder.clearNewQuestion()`).
- **EditableDropdown** — Custom dark-themed dropdown. Selection saves immediately (including re-selection of current value, enabling actions like reopening the XPath modal). Click-outside/Escape via `useDismissRef`.
- **XPathEditorModal** — Portal-mounted CodeMirror editor with fold gutters (ci chevron SVG markers), bracket matching, zebra stripes. Opens with `prettyPrintXPath` (same expanded format as sidebar), saves back via `formatXPath` (single-line for storage). Auto-focuses with cursor at end. Cmd/Ctrl+Enter saves, Escape closes via ref callback. Cancel/Update buttons. Indentation uses 4 spaces (matching `Layout.Tab` rendering).

**Editable fields:** module name, form name, form type, question label/id/type/case_property/hint, required (dropdown with conditional → opens XPath modal), constraint/relevant/default_value/calculate (XPath modal). "Add Property" shows `+` buttons for missing optional fields.

### Rename Propagation

- Editing question ID → `mb.renameQuestion()` → `rewriteXPathRefs` (Lezer-based) updates `/data/...` paths and `#form/...` hashtags across siblings.
- Editing case property → `mb.renameCaseProperty()` → `rewriteHashtagRefs` for `#case/...` refs across all questions, columns, XPath, and output tags.

## XPathField

Read-only CodeMirror with Nova theme, `tabSize: 4`, `prettyPrintXPath` for display. Optional `onClick` adds hover highlight (used by DetailPanel to open XPath modal).

## GenerationProgress

Progress bar with phase labels during generation. Counts derived from `builder.progressCompleted` / `builder.progressTotal`.

## ReplayController

Fixed-position pill for log replay navigation. Left/right arrows, stage counter, close button. Drives Builder via `applyDataPart()`.
