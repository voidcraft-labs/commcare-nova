# Builder Components

## BuilderLayout

Main 3-panel layout with one `useChat` instance targeting `/api/chat`.

- **`body`** sends: `apiKey`, `pipelineConfig`, `blueprint` (for edits), `blueprintSummary` (for SA context).
- **`sendAutomaticallyWhen`** only triggers for `askQuestions` (client-side tool).
- **`onData`** handles all state updates via `applyDataPart()`.

### Chat-Centered Landing

When `builder.phase === Idle && !builder.treeData`, chat fills center with hero Logo above welcome heading and input — no header bar, uniform `bg-nova-void`. On generation start (DataModel phase), Logo animates from center to header via `layoutId="nova-logo"`, header slides in (animated `height: 0 → auto`), chat narrows to 380px sidebar — coordinated by `LayoutGroup` wrapping the layout. `AnimatePresence` fades in builder panels (150ms delay). No DOM re-parenting — messages and input state preserved.

### Subheader Toolbar

BuilderLayout renders a **subheader toolbar** (only when `Done` + blueprint exists) spanning the full width right of the chat sidebar. 3-column grid layout: left shows app name (tree mode) or navigable breadcrumbs (preview/live mode), center has `PreviewToggle` (3-segment: Tree / Preview / Live), right has Undo/Redo buttons. Breadcrumbs come from `usePreviewNav` and clicking a crumb calls `nav.navigateTo(index)`. Both the main content area and DetailPanel sit **below** this subheader in a flex row — sidebars slide out from beneath the subheader, never above it.

`usePreviewNav` is lifted to BuilderLayout and shared with `PreviewShell` (via `nav` prop) so navigation state stays in sync. AppTree and PreviewShell render with `hideHeader` since BuilderLayout owns the subheader.

### View Modes

`viewMode` state (`'tree' | 'preview' | 'test'`). When `Done` + blueprint exists:
- `'tree'` → `AppTree` + `DetailPanel` (inline right sidebar)
- `'preview'` → `PreviewShell` (editable canvas) + `DetailPanel` (inline right sidebar)
- `'test'` → `PreviewShell` (read-only, no edit chrome or sidebar)

Subheader: breadcrumbs left, `PreviewToggle` centered, Undo/Redo right. Keyboard shortcuts (undo/redo, Tab/Shift+Tab navigation, Delete, Cmd+D duplicate, arrow keys to reorder) registered via `useKeyboardShortcuts`.

## DetailPanel

Reads/writes through `builder.mb` (persistent `MutableBlueprint`). Three editing patterns:

- **EditableText** — Click-to-edit inline text. Blur/Enter saves, Escape cancels. Emerald checkmark fades on save.
- **EditableDropdown** — Custom dark-themed dropdown. Selection saves immediately. Click-outside/Escape closes.
- **XPathEditorModal** — Portal-mounted CodeMirror editor with fold gutters, bracket matching, zebra stripes. Cancel/Update buttons.

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
