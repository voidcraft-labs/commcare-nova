# Phase 5: Declarative Field Editor + Component Splits — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execution uses two-stage review at each task (spec-compliance sonnet + code-quality opus).

**Goal:** Replace the hand-wired `ContextualEditor{Header,Data,Logic,UI}` editor stack with a registry-driven `FieldEditorPanel` + `FieldHeader` that consume each kind's `FieldEditorSchema`. Replace stub editor components with real ones. Split three god components — `FormSettingsPanel` (1360 lines), `AppTree` (976 lines), `VirtualFormList` (872 lines) — along their natural responsibility seams. No CommCare wire-format, no agent code, no log code touched. Phase 5 of 7 from `docs/superpowers/specs/2026-04-16-builder-foundation-design.md`.

**Architecture:** Each `lib/domain/fields/<kind>.ts` already exports a typed `FieldEditorSchema<KindField>` describing which keys appear in the Data / Logic / UI sections (Phase 1 stubbed every entry with `StubField`). Phase 5 replaces stubs with real per-key editor components living under `components/builder/editor/fields/`. A new `FieldEditorPanel` dispatches into those components by reading `fieldEditorSchemas[field.kind]` — no per-kind switching in the panel. A new `FieldHeader` renders the chrome (id input, type picker, kebab menu) by reading `fieldRegistry[field.kind]`. The three god components split along the natural seams already visible in the file content: AppTree's three row types, FormSettingsPanel's three feature sections (close condition, after-submit, connect), and VirtualFormList's drag-lifecycle effect.

**Tech Stack:** TypeScript 5.x strict, React 19, Zustand, Immer, motion/react, @base-ui/react, CodeMirror, @atlaskit/pragmatic-drag-and-drop, Vitest, Biome.

**Worktree:** `.worktrees/phase-5-declarative-editor-and-splits` on branch `refactor/phase-5-declarative-editor-and-splits`. Created at commit `58ce965` (current `main` HEAD — Phase 4 + lifecycle-derivation merged). The worktree already exists and has `npm install` + baseline checks completed.

**Baseline before starting:** From `main` at `58ce965`:
- `npm test -- --run` — 1316 tests across 76 files, all passing
- `npx tsc --noEmit` — clean
- `npm run lint` — clean (`Checked 592 files in 207ms. No fixes applied.`)

Re-verify in the final verification task.

---

## Architectural north star

1. **One source of truth for "what does this kind expose?"** Every fact about a field kind lives in `lib/domain/fields/<kind>.ts`: Zod schema, TS type (via `z.infer`), `FieldKindMetadata` (icon, dataType, convertTargets, …), and `FieldEditorSchema` (Data / Logic / UI entries). The panel never `switch`es on `field.kind`.
2. **Each schema entry is self-describing.** It carries the field key, a typed component, a human label, and visibility/addability metadata. The section component partitions entries into "render the editor" vs "render an Add Property pill" using only entry metadata + the current field state. No central allow-lists, no `fieldSupportedForType` tables.
3. **Per-key editor components own their UX entirely.** Given a typed `(field, value, onChange, label, autoFocus)` props bundle, an editor knows how to display its key. Composite widgets (`required` tri-state, `validate` + `validate_msg` linkage) live INSIDE the relevant editor component, not threaded through the panel.
4. **Splits move code, not behavior.** AppTree, FormSettingsPanel, and VirtualFormList split into smaller files that retain identical behavior. No UX changes, no render-graph changes, no import-cycle introductions. The split is purely an exercise in moving cohesive blocks into their own files.
5. **The registry IS the icon registry.** `fieldRegistry[kind]` carries an `IconifyIcon` (real imported data) and a human-readable `label`. The standalone `fieldKindIcons` / `fieldKindLabels` maps in `lib/fieldTypeIcons.ts` are deleted; consumers read the registry directly. This removes a parallel table the spec explicitly calls out as redundant.

---

## Bridge-smell guardrails (read before every task)

Subagents trained on "what to do" invent bridges. Subagents trained on "why bridges betray the architecture" don't. None of the following patterns may appear in a Phase 5 commit:

- **Re-export shims for deleted files.** When `ContextualEditorData.tsx` is deleted, no `// @deprecated` re-export remains. The new editor surface is `FieldEditorPanel` and only that. Update every import.
- **Keeping `lib/fieldTypeIcons.ts` "for `formTypeIcons`."** That file is split: `formTypeIcons` moves to `lib/domain/forms.ts` (or a small adjacent file under `lib/domain/`). The parallel `fieldKindIcons` / `fieldKindLabels` maps are deleted entirely; consumers read `fieldRegistry[kind].icon` and `fieldRegistry[kind].label`.
- **`if (field.kind === ...)` inside `FieldEditorPanel` or `FieldHeader`.** The panel iterates `fieldEditorSchemas[field.kind][section]`. The header reads `fieldRegistry[field.kind]`. No switch statements over kinds in either component.
- **A central `fieldSupportedForType` table after Phase 5.** Per-kind schemas already encode "which keys are editable for this kind" by listing them as entries. The table is dead — delete it. If a runtime check is needed (e.g. SA validation), it reads the registry/schema directly.
- **Keeping `useAddableField` as the single shared hook for ALL sections.** It survives, but rebranded as `useEntryActivation` and scoped per-section by uuid+section name. The schema-driven section owns its activation state.
- **Splitting AppTree into row files that import each other recursively.** `FieldRow` calls itself for nested groups — keep self-recursion within the same file. Module → Form → Field is a one-way import chain, not a cycle.
- **Splitting `FormSettingsPanel` into files that re-export each other.** Each split file owns one section. The shell imports them once.
- **Inlining drag-intent state into `useDragIntent`'s consumer when the hook returns refs.** The hook returns the public surface (`dragActive`, `placeholderIndex`, `placeholderDepth`) plus a `monitor` registration via internal `useEffect`. The consumer renders; the hook handles state.
- **Adding `/* TODO: revisit in Phase 6 */` comments.** Phase 5 is a complete end state for the editor surface and these three component splits. Land in final shape.
- **`as any` / `@ts-expect-error` to paper over the schema generic in `FieldEditorPanel`.** The narrowing from `Field` → `Extract<Field, { kind: K }>` is the entire point of the discriminated union. If the types don't line up, the editor schema's entry type is wrong — fix the entry, not the panel.
- **Moving `useFocusHint` into a "general" location and keeping the broken `FocusableFieldKey` string union.** The hook moves into `lib/session/hooks` (or stays at its session-store entry point); the FocusableFieldKey union becomes the open `string` type or is sourced from per-kind schema keys. Don't preserve a hand-edited list of focus-hint keys.

---

## Scope boundaries

IN SCOPE (this plan):

- New per-key editor components under `components/builder/editor/fields/`:
  - `XPathEditor.tsx` (relevant, validate, default_value, calculate; with `validate_msg` nested under validate)
  - `RequiredEditor.tsx` (the tri-state required widget — extracted from `RequiredSection`)
  - `TextEditor.tsx` (hint, validate_msg standalone — for fields that don't pair with validate)
  - `CasePropertyEditor.tsx` (case_property dropdown — wraps `CasePropertyDropdown`)
  - `OptionsEditor.tsx` (move + adapt from `contextual/OptionsEditor.tsx`)
  - `LabelEditor.tsx` (the `label` field for kinds that have one — registered in headers, not bodies; this is for the optional-Label edit case)
- New panel + header under `components/builder/editor/`:
  - `FieldEditorPanel.tsx` (composes 3 sections)
  - `FieldEditorSection.tsx` (renders entries + Add Property pills)
  - `FieldHeader.tsx` (id, type icon adornment, type picker submenu, kebab menu — replaces `ContextualEditorHeader`)
  - `useEntryActivation.ts` (per-section pending-add-property state — renamed `useAddableField`)
  - `addPropertyButton.tsx` (the pill — moved from `contextual/AddPropertyButton.tsx`)
- Update each `lib/domain/fields/<kind>.ts` editor schema:
  - Replace `StubField` with the real per-key editor component
  - Add `label` (human-readable) and `addable` (bool) on every entry
  - Add `visible?: (field: F) => boolean` where the editor should hide (e.g., `validate_msg` only when `validate` is set)
- Update `lib/domain/kinds.ts`:
  - `FieldEditorEntry`: require `label: string`; add `addable?: boolean`; remove unused `renderOverride` (no consumer)
  - `FieldEditorComponentProps`: add `label: string` and `autoFocus?: boolean`
  - `FieldKindMetadata`: change `icon: string` → `icon: IconifyIcon`; add `label: string` (the human-readable name)
- Update each `lib/domain/fields/<kind>.ts` metadata:
  - Replace `icon: "tabler:cursor-text"` with `icon: tablerCursorText` (imported)
  - Add `label: "Text"` (was `fieldKindLabels[kind]`)
- Delete `lib/fieldTypeIcons.ts`'s `fieldKindIcons` and `fieldKindLabels` exports. Move `formTypeIcons` to `lib/domain/forms.ts` (or its own small file `lib/domain/formTypeIcons.ts`). Delete `lib/fieldTypeIcons.ts` once no exports remain.
- Wire `InlineSettingsPanel.tsx` to use `<FieldHeader />` + `<FieldEditorPanel />`.
- Delete `components/builder/contextual/` entirely:
  - `ContextualEditorHeader.tsx` (replaced by `FieldHeader`)
  - `ContextualEditorData.tsx` (replaced by `FieldEditorPanel` Data section)
  - `ContextualEditorLogic.tsx` (replaced by `FieldEditorPanel` Logic section)
  - `ContextualEditorUI.tsx` (replaced by `FieldEditorPanel` UI section)
  - `RequiredSection.tsx` (folded into `RequiredEditor`)
  - `CasePropertyDropdown.tsx` (folded into `CasePropertyEditor` — internal, not exported)
  - `AddPropertyButton.tsx` (moved to editor module)
  - `OptionsEditor.tsx` (moved to editor module)
  - `shared.ts` (the typed key unions and `useFocusHint` move; the per-type allow-lists and `addableTextFields` / `xpathFields` arrays are deleted)
- Move `components/builder/editor/StubField.tsx` → delete (no longer referenced).
- Split `components/builder/AppTree.tsx` (976 lines) into:
  - `components/builder/appTree/AppTree.tsx` (shell — 80–120 lines; props, search input, scroll container, top-level dispatch over `moduleOrder`)
  - `components/builder/appTree/ModuleCard.tsx` (memoized — module entity subscription, case-list-columns block, form list)
  - `components/builder/appTree/FormCard.tsx` (memoized — form entity subscription, field icon map, recursive question rendering)
  - `components/builder/appTree/FieldRow.tsx` (memoized — field entity subscription, recursive children rendering, search-highlight)
  - `components/builder/appTree/useSearchFilter.ts` (the `useSearchFilter` hook + `findMatchIndices` helper + `SearchResult` type + `SEARCH_IDLE` sentinel)
  - `components/builder/appTree/useFieldIconMap.ts` (the per-form icon map hook + `countQuestionsFromOrder` helper)
  - `components/builder/appTree/useAppTreeSelection.ts` (the `handleSelect` callback + `TreeSelectTarget` / `TreeSelectHandler` types — uses `useNavigate` + scroll registry)
  - `components/builder/appTree/shared.tsx` (shared atoms: `TreeItemRow`, `CollapseChevron`, `HighlightedText`, `FormIconContext`)
  - `components/builder/AppTree.tsx` becomes a thin re-export `export { AppTree } from "./appTree/AppTree";` so existing import paths keep working — OR update the four call sites to import from the new path. (Plan picks: update call sites; no shim file.)
- Split `components/builder/detail/FormSettingsPanel.tsx` (1360 lines) into:
  - `components/builder/detail/formSettings/FormSettingsPanel.tsx` (shell — header, sections list, ~80–100 lines)
  - `components/builder/detail/formSettings/FormSettingsButton.tsx` (the popover trigger — separate file because it's the public mount point)
  - `components/builder/detail/formSettings/CloseConditionSection.tsx`
  - `components/builder/detail/formSettings/AfterSubmitSection.tsx`
  - `components/builder/detail/formSettings/ConnectSection.tsx` (toggle + dispatch to Learn/Deliver)
  - `components/builder/detail/formSettings/LearnConfig.tsx`
  - `components/builder/detail/formSettings/DeliverConfig.tsx`
  - `components/builder/detail/formSettings/InlineField.tsx` (shared compact text field)
  - `components/builder/detail/formSettings/LabeledXPathField.tsx` (shared compact XPathField wrapper)
  - `components/builder/detail/formSettings/useConnectLintContext.ts` (shared lint-context callback)
  - `components/builder/detail/formSettings/findFieldById.ts` (the depth-first lookup helper)
  - Delete `components/builder/detail/FormSettingsPanel.tsx` (moved into the new directory). Update the one external import.
- Extract `components/preview/form/virtual/useDragIntent.ts` from `VirtualFormList.tsx`. The hook owns: drag state (`dragActive`, `placeholderIndex`, depth ref), the `monitorForElements` lifecycle, the cursor-velocity tracking, and exposes a typed surface. `VirtualFormList.tsx` shrinks to the rendering shell.
- Update `CLAUDE.md` files where rules changed:
  - Root `CLAUDE.md`: builder-state section ("Builder state" sub-section) — update editor surface name; mention `lib/domain/fields/<kind>.ts` as the place to add new editor entries.
  - `components/builder/CLAUDE.md`: full rewrite of the editor section (see task §16).
  - No new `CLAUDE.md` files (the appTree directory and editor directory are mechanical splits).

OUT OF SCOPE (future phases or deferred):

- **Phase 6: Hook + lint hygiene.** Phase 5 doesn't touch `/hooks/` top-level or expand `noRestrictedImports`. Hooks created in Phase 5 (`useEntryActivation`, `useDragIntent`, `useAppTreeSelection`, `useSearchFilter`, `useFieldIconMap`, `useConnectLintContext`) live next to their consumer — moves into "domain owners" happen in Phase 6.
- **Phase 7: Final cleanup.** Phase 5 leaves `lib/services/`, `lib/schemas/`, `lib/types/`, `lib/prompts/`, `lib/transpiler/`, `lib/codemirror/` untouched as directories. (Specific files may be referenced; none are deleted unless inside Phase 5's editor scope.)
- **`useFormEngine` / `useEditContext` deletion.** Phase 5 doesn't touch these — they're dead/legacy and removed in Phase 7.
- **Per-type SA tools.** Tool schema generator stays on `flat-sentinels`.
- **Migration scripts.** No data shape changes; nothing to migrate.
- **Renaming `Question` to `Field` anywhere new.** Phase 1 already did the rename. Spec callout 7 ("'question' disappears from internal vocabulary") is mostly done; a few stragglers in this phase's scope (variable names like `questionUuids` in `FormCard`) get renamed during the AppTree split because they're already changing. No grep-and-replace pass.
- **CSS / animation rework.** Visual behavior is preserved exactly. AnimatePresence wrappers around Logic-section editors, the violet glass styling on InlineSettingsPanel, the bracket rails in VirtualFormList — all stay byte-identical in their output.

---

## File structure

### Files to create

| File | Responsibility |
|------|---------------|
| `components/builder/editor/FieldEditorPanel.tsx` | Top-level editor panel. Reads `fieldEditorSchemas[field.kind]`, renders three `FieldEditorSection` instances (Data / Logic / UI). Handles section-level visibility (returns null when no entries are visible AND no addables exist). |
| `components/builder/editor/FieldEditorSection.tsx` | Renders a single section's entries: visible entries via their `component`, addable-but-hidden entries as Add Property pills. Owns per-section activation state via `useEntryActivation`. Handles AnimatePresence for entries appearing/disappearing. |
| `components/builder/editor/FieldHeader.tsx` | Replaces `ContextualEditorHeader`. Renders the type-icon adornment (from `fieldRegistry[kind].icon`), id input with sibling-conflict shake + popover, kebab menu (move up/down, cross-level moves, convert-type submenu, duplicate), delete button. |
| `components/builder/editor/useEntryActivation.ts` | Per-section pending-activation state (replaces `useAddableField`). `activate(key)` → marks key pending; `pending(key)` → boolean; `clear()` → resets. Scope key is `${fieldUuid}:${section}` so switching field or section drops pending state. |
| `components/builder/editor/AddPropertyButton.tsx` | The Add Property pill. Moved from `contextual/AddPropertyButton.tsx`, no behavior change. |
| `components/builder/editor/fields/XPathEditor.tsx` | Generic XPath-valued field editor. Used for `relevant`, `validate`, `default_value`, `calculate`. Wraps `XPathField` with a label + lint context + edit-state shortcut hint. When the entry is `validate`, also renders the nested `validate_msg` editor INSIDE this component (reads `field.validate_msg` and updates via the same mutation pipeline). |
| `components/builder/editor/fields/RequiredEditor.tsx` | The tri-state `required` widget. Toggle off → unset; toggle on → `"true()"`; "Add Condition" → opens XPath editor; saved condition → stored as required value. Folds in everything from `RequiredSection.tsx`. |
| `components/builder/editor/fields/TextEditor.tsx` | Plain-text editor for `hint` (and `validate_msg` when standalone — but per design, it's always nested under `validate`, so this is hint-only in practice). Wraps `EditableText`. |
| `components/builder/editor/fields/CasePropertyEditor.tsx` | Case-type-saving dropdown. Wraps the existing `CasePropertyDropdown` (moved here as a private internal). Reads `useSelectedFormContext` + `useCaseTypes` to compute writable case types. |
| `components/builder/editor/fields/OptionsEditor.tsx` | Moved from `contextual/OptionsEditor.tsx`. Adapter to the `FieldEditorComponent` shape (props become `{ field, value, onChange, label, autoFocus }`). |
| `components/builder/appTree/AppTree.tsx` | Thin shell — props, header, search input, top-level module dispatch. ~120 lines. |
| `components/builder/appTree/ModuleCard.tsx` | Memoized module row + case-list summary + nested form list. |
| `components/builder/appTree/FormCard.tsx` | Memoized form row + question count + nested field tree. |
| `components/builder/appTree/FieldRow.tsx` | Memoized field row + recursive children. |
| `components/builder/appTree/useSearchFilter.ts` | Search-mode filter hook + `SearchResult` type + helpers. |
| `components/builder/appTree/useFieldIconMap.ts` | Per-form `path → icon` map for chip rendering, plus `countQuestionsFromOrder`. |
| `components/builder/appTree/useAppTreeSelection.ts` | The `handleSelect` callback factory + `TreeSelectTarget` discriminated union + `TreeSelectHandler` type alias. |
| `components/builder/appTree/shared.tsx` | `TreeItemRow`, `CollapseChevron`, `HighlightedText`, `FormIconContext`. |
| `components/builder/detail/formSettings/FormSettingsPanel.tsx` | Shell (~80 lines) — drawer chrome + sections. |
| `components/builder/detail/formSettings/FormSettingsButton.tsx` | The Popover trigger that mounts the panel. |
| `components/builder/detail/formSettings/CloseConditionSection.tsx` | Close-form condition editor. |
| `components/builder/detail/formSettings/AfterSubmitSection.tsx` | After-submit destination dropdown. |
| `components/builder/detail/formSettings/ConnectSection.tsx` | Connect toggle + dispatch to Learn/Deliver. |
| `components/builder/detail/formSettings/LearnConfig.tsx` | Learn config: `learn_module` + `assessment` sub-toggles. |
| `components/builder/detail/formSettings/DeliverConfig.tsx` | Deliver config: `deliver_unit` + `task` sub-toggles. |
| `components/builder/detail/formSettings/InlineField.tsx` | Compact text field used inside the panel. |
| `components/builder/detail/formSettings/LabeledXPathField.tsx` | Compact labeled XPath field. |
| `components/builder/detail/formSettings/useConnectLintContext.ts` | Lint-context callback hook. |
| `components/builder/detail/formSettings/findFieldById.ts` | Depth-first field lookup by semantic id. |
| `components/preview/form/virtual/useDragIntent.ts` | Drag-lifecycle hook — owns `dragActive` / `placeholderIndex` / depth + the `monitorForElements` registration + cursor velocity tracking. |
| `lib/domain/formTypeIcons.ts` | Moved `formTypeIcons` map (was in `lib/fieldTypeIcons.ts`). One file, one map. |
| `components/builder/editor/__tests__/FieldEditorPanel.test.tsx` | Tests the panel: hides empty sections, dispatches addable pills, swaps entries on field change. |
| `components/builder/editor/__tests__/FieldEditorSection.test.tsx` | Tests a section: visible/addable partition, activation flow (click pill → entry shows in autoFocus mode → save → pending clears). |
| `components/builder/editor/__tests__/FieldHeader.test.tsx` | Tests the header: type icon comes from registry, convert-submenu only shown when `convertTargets.length > 0`, sibling-conflict shake on rename. |
| `components/builder/editor/fields/__tests__/RequiredEditor.test.tsx` | Tests tri-state: toggle off → undefined, toggle on → `"true()"`, add condition → editor opens, condition save → required becomes the XPath. |
| `components/builder/editor/fields/__tests__/XPathEditor.test.tsx` | Tests label rendering, validate_msg nesting (only inside the validate entry), save propagation. |
| `components/builder/appTree/__tests__/useSearchFilter.test.tsx` | Existing search-filter behavior preserved; SEARCH_IDLE returns null. |
| `components/builder/appTree/__tests__/useAppTreeSelection.test.tsx` | Selection dispatches to navigate hooks; question selection sets pending scroll BEFORE navigating. |
| `components/preview/form/virtual/__tests__/useDragIntent.test.tsx` | Tests drag state transitions, no-op detection, cycle guards (delegates to existing `dragData` helpers). |

### Files to modify

| File | Change |
|------|--------|
| `lib/domain/kinds.ts` | `FieldEditorEntry`: `label: string` (required), add `addable?: boolean`, drop `renderOverride`. `FieldEditorComponentProps`: add `label: string` + `autoFocus?: boolean`. `FieldKindMetadata`: `icon: IconifyIcon` (was `string`), add `label: string`. Import `IconifyIcon` from `@iconify/react/offline`. |
| `lib/domain/fields/text.ts` | Replace `StubField` entries with real components + labels + addable + visible. Replace `icon: "tabler:cursor-text"` with `icon: tablerCursorText` (import from `@iconify-icons/tabler/cursor-text`). Add `label: "Text"` to metadata. |
| `lib/domain/fields/int.ts` | Same pattern. Icon: `tablerNumbers123` (`@iconify-icons/tabler/123`). Label: `"Number"`. |
| `lib/domain/fields/decimal.ts` | Icon: `tablerDecimal`. Label: `"Decimal"`. |
| `lib/domain/fields/date.ts` | Icon: `tablerCalendar`. Label: `"Date"`. |
| `lib/domain/fields/time.ts` | Icon: `tablerClock`. Label: `"Time"`. |
| `lib/domain/fields/datetime.ts` | Icon: `tablerClock`. Label: `"Date/Time"`. |
| `lib/domain/fields/singleSelect.ts` | Icon: `tablerCircleDot`. Label: `"Single Select"`. Real components incl. OptionsEditor. |
| `lib/domain/fields/multiSelect.ts` | Icon: `tablerSquareCheck`. Label: `"Multi Select"`. Real components incl. OptionsEditor. |
| `lib/domain/fields/image.ts` | Icon: `tablerPhoto`. Label: `"Image"`. |
| `lib/domain/fields/audio.ts` | Icon: `tablerMicrophone`. Label: `"Audio"`. |
| `lib/domain/fields/video.ts` | Icon: `tablerDeviceTv`. Label: `"Video"`. |
| `lib/domain/fields/barcode.ts` | Icon: `tablerBarcode`. Label: `"Barcode"`. |
| `lib/domain/fields/signature.ts` | Icon: `tablerSignature`. Label: `"Signature"`. |
| `lib/domain/fields/geopoint.ts` | Icon: `tablerMapPin`. Label: `"Location"`. |
| `lib/domain/fields/label.ts` | Icon: `tablerTag`. Label: `"Label"`. |
| `lib/domain/fields/hidden.ts` | Icon: `tablerEyeOff`. Label: `"Hidden"`. Calculate is required (not addable). |
| `lib/domain/fields/secret.ts` | Icon: `tablerLock`. Label: `"Secret"`. |
| `lib/domain/fields/group.ts` | Icon: `tablerFolder`. Label: `"Group"`. Logic: `relevant` only. |
| `lib/domain/fields/repeat.ts` | Icon: `tablerRepeat`. Label: `"Repeat"`. Logic: `relevant` only. |
| `lib/domain/fields/index.ts` | No structural change. The barrel keeps re-exporting metadata + schemas. |
| `lib/domain/forms.ts` | Either inline `formTypeIcons` here or leave it for the small adjacent file `lib/domain/formTypeIcons.ts` (plan picks the adjacent file — see "Files to create"). No-op for `forms.ts` itself. |
| `components/builder/InlineSettingsPanel.tsx` | Replace `<ContextualEditorHeader>` + `<ContextualEditorData>` + `<ContextualEditorLogic>` + `<ContextualEditorUI>` with `<FieldHeader>` + `<FieldEditorPanel>`. Drop the now-unused `SectionLabel` (folded into `FieldEditorSection`) — but keep `SECTION_CARD_CLASS` if still referenced by FormSettingsPanel; if not, delete it. |
| `components/builder/AppTree.tsx` | Delete. (Replaced by the directory split.) |
| `components/builder/StructureSidebar.tsx` | Update import path: `@/components/builder/AppTree` → `@/components/builder/appTree/AppTree`. |
| `components/builder/FieldTypeList.tsx` | Replace `fieldKindIcons[type]` / `fieldKindLabels[type]` reads with `fieldRegistry[type].icon` / `.label`. |
| `components/preview/form/virtual/VirtualFormList.tsx` | Drop the drag-lifecycle effect, the cursor-velocity-tracking effect, the `dragActive` / `placeholderIndex` / refs. Consume `useDragIntent({ formUuid, baseRows })` and use its returned shape. Shell becomes ~250 lines. |
| `components/preview/form/virtual/rows/FieldRow.tsx` | Update icon-map import (uses `useFieldIconMap` consumer chain — already lives in `FormCard`/`FieldRow`'s row file in AppTree, NOT virtual rows; if `fieldKindIcons` is consumed here too, switch to registry reads). |
| `components/preview/form/FormRenderer.tsx` | If it reads `fieldKindIcons` / `fieldKindLabels`, switch to registry reads. |
| `components/preview/form/InteractiveFormRenderer.tsx` | Same. |
| `components/preview/screens/FormScreen.tsx` | Uses `formTypeIcons` — update import to `@/lib/domain/formTypeIcons`. |
| `lib/references/renderLabel.ts` | If it consumes `fieldKindIcons`, switch to registry. |
| `lib/filterTree.ts` | If it consumes `fieldKindIcons`, switch to registry. |
| `lib/routing/domQueries.ts` | If it consumes `fieldKindIcons`/`fieldKindLabels`, switch to registry. |
| `components/preview/form/virtual/rows/GroupBracket.tsx` | If it uses any field/form icon map, switch source. |
| `components/preview/form/virtual/rowModel.ts` | Same audit. |
| `components/preview/form/virtual/VirtualFormContext.tsx` | Same audit. |
| `components/preview/form/FormLayoutContext.tsx` | Same audit. |
| `components/preview/form/EditableFieldWrapper.tsx` | Same audit. |
| `components/builder/detail/FormSettingsPanel.tsx` | Delete. (Replaced by directory split.) |
| `components/builder/detail/FormDetail.tsx` | If it imports `FormSettingsButton`, update path to `@/components/builder/detail/formSettings/FormSettingsButton`. |
| `components/preview/screens/FormScreen.tsx` | Update `FormSettingsButton` import path. |
| `components/builder/contexts/__tests__/...` | If any test imports a file moved/deleted, update import paths. |
| `lib/services/questionPath.ts` | Audit — no editor / icon dependencies expected, but the AppTree split touches consumers of `qpath`/`QuestionPath`. Likely no change. |
| `CLAUDE.md` (root) | "Builder state" section: mention `lib/domain/fields/<kind>.ts` is the single source of truth for field editor schemas + metadata. |
| `components/builder/CLAUDE.md` | Replace the entire editor-stack discussion (currently references `ContextualEditor*`) with the registry-driven `FieldEditorPanel` + `FieldHeader` flow. Mention the `addable` semantics + activation hook. |

### Files to delete

| File | Reason |
|------|--------|
| `components/builder/contextual/ContextualEditorHeader.tsx` | Replaced by `FieldHeader`. |
| `components/builder/contextual/ContextualEditorData.tsx` | Replaced by `FieldEditorPanel` Data section. |
| `components/builder/contextual/ContextualEditorLogic.tsx` | Replaced by `FieldEditorPanel` Logic section. |
| `components/builder/contextual/ContextualEditorUI.tsx` | Replaced by `FieldEditorPanel` UI section. |
| `components/builder/contextual/RequiredSection.tsx` | Folded into `RequiredEditor`. |
| `components/builder/contextual/CasePropertyDropdown.tsx` | Folded into `CasePropertyEditor` (private internal). |
| `components/builder/contextual/AddPropertyButton.tsx` | Moved to `editor/AddPropertyButton.tsx`. |
| `components/builder/contextual/OptionsEditor.tsx` | Moved to `editor/fields/OptionsEditor.tsx`. |
| `components/builder/contextual/shared.ts` | Per-type allow-lists + addable arrays die; surviving exports (`useFocusHint`, `MEDIA_TYPES` as needed, `getModuleCaseTypes`) move to their consumer or to `lib/session/hooks` (see task §6 details). |
| `components/builder/contextual/` (directory) | Empty after the moves — remove. |
| `components/builder/editor/StubField.tsx` | No longer referenced (every kind file now uses real components). |
| `components/builder/AppTree.tsx` | Replaced by `appTree/AppTree.tsx`. |
| `components/builder/detail/FormSettingsPanel.tsx` | Replaced by `detail/formSettings/FormSettingsPanel.tsx`. |
| `lib/fieldTypeIcons.ts` | All consumers switch to `fieldRegistry[kind]` for field icons/labels and to `lib/domain/formTypeIcons.ts` for form icons. |

---

## Task ordering rationale

Tasks are ordered LEAF → ROOT for the editor work and LEAF → ROOT for the splits, so each task lands a self-contained, testable unit.

Editor: type updates → registry icon move → per-key components → activation hook → section component → panel → header → kind schema replacements → wire InlineSettingsPanel → delete contextual.

Splits: each god-component split is ordered "extract leaves first, then move shell." AppTree: shared atoms → hooks → row components → shell. FormSettingsPanel: shared atoms → sections → shell. VirtualFormList: extract one cohesive hook (`useDragIntent`) and rewire.

A single subagent should be able to complete each task in one pass; complex tasks (the kind-file sweep, the AppTree split) are broken into sub-tasks.

The plan continues in subsequent sections with full per-task code. Tasks 1–8 cover the type updates and editor primitives; 9–13 wire the new editor and delete contextual; 14–19 split AppTree; 20–28 split FormSettingsPanel; 29 extracts useDragIntent; 30–32 are docs + final verification.

---

## Task 1: Update `FieldEditorEntry`, `FieldEditorComponentProps`, `FieldKindMetadata` types

Tighten the registry type contract so every per-key editor component receives the props it needs and the kind-file metadata carries an `IconifyIcon` (real imported data) plus a human-readable `label`.

**Files:**
- Modify: `lib/domain/kinds.ts`
- Test: `lib/domain/__tests__/kinds.test.ts` (NEW — tests that the type shape compiles via dummy values; also a structural assertion that `fieldRegistry[kind].icon` is an object, not a string)

- [ ] **Step 1: Write the failing test**

Create `lib/domain/__tests__/kinds.test.ts`:

```typescript
import type { IconifyIcon } from "@iconify/react/offline";
import { describe, expect, it } from "vitest";
import { fieldKinds, fieldRegistry } from "../fields";

describe("fieldRegistry", () => {
	it.each(fieldKinds)("kind %s carries an IconifyIcon (object, not string)", (kind) => {
		const meta = fieldRegistry[kind];
		expect(meta).toBeDefined();
		// IconifyIcon is an object literal { body: string; width?: number; ... }.
		// Phase 1 stored icons as iconify ID strings; Phase 5 stores the imported
		// data so consumers don't need a parallel fieldKindIcons map.
		expect(typeof meta.icon).toBe("object");
		expect(meta.icon).not.toBeNull();
		expect(typeof (meta.icon as IconifyIcon).body).toBe("string");
	});

	it.each(fieldKinds)("kind %s carries a non-empty human-readable label", (kind) => {
		const meta = fieldRegistry[kind];
		expect(typeof meta.label).toBe("string");
		expect(meta.label.length).toBeGreaterThan(0);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest --run lib/domain/__tests__/kinds.test.ts
```

Expected: FAIL — `meta.icon` is `string`, `meta.label` is undefined.

- [ ] **Step 3: Update `lib/domain/kinds.ts`**

Replace the existing file with:

```typescript
// lib/domain/kinds.ts
//
// Types that describe per-field-kind metadata and declarative editor
// schemas. Every file under lib/domain/fields/* exports values of these
// shapes so the compiler, validator, editor panel, and SA tool schema
// generator can all read one table.

import type { IconifyIcon } from "@iconify/react/offline";
import type { ComponentType } from "react";
import type { Field, FieldKind } from "./fields";

/** XForm control element emitted by the compiler for a given field kind. */
export type XFormControlKind =
	| "input"
	| "select1"
	| "select"
	| "trigger"
	| "group"
	| "repeat"
	| "output";

/** XForm data type (xsd:* or CommCare extensions). "" for structural kinds. */
export type XFormDataType =
	| ""
	| "xsd:string"
	| "xsd:int"
	| "xsd:decimal"
	| "xsd:date"
	| "xsd:time"
	| "xsd:dateTime"
	| "geopoint"
	| "binary";

/**
 * Non-behavioral metadata for a field kind. The single source of truth for
 * everything a UI/compiler consumer needs to know about a kind without
 * branching on it. Adding a kind = adding one entry to `fieldRegistry`.
 *
 * `icon` carries imported IconifyIcon data (not an iconify ID string), so
 * synchronous `<Icon icon={meta.icon} />` rendering works without a network
 * fetch. The parallel `fieldKindIcons` map in `lib/fieldTypeIcons.ts` is
 * deleted in Phase 5; consumers read `fieldRegistry[kind].icon` directly.
 *
 * `label` is the human-readable name shown in pickers, conversion menus,
 * and tooltips. Replaces the parallel `fieldKindLabels` map.
 */
export type FieldKindMetadata<K extends FieldKind> = {
	kind: K;
	xformKind: XFormControlKind;
	dataType: XFormDataType;
	icon: IconifyIcon;
	label: string;
	isStructural: boolean;
	isContainer: boolean;
	saDocs: string;
	convertTargets: readonly FieldKind[];
};

/**
 * Props every per-key editor component receives. `field` is the FULL kind
 * narrowing so the component can read sibling keys (e.g. the validate
 * editor reads `field.validate_msg`); `value` is the current value of the
 * key being edited; `onChange` is the typed setter.
 *
 * `label` is provided by the schema entry — components display it in their
 * own header (label text + save-shortcut hint). `autoFocus` is set by the
 * section when the user just clicked the entry's Add Property pill or when
 * undo/redo is restoring focus to this key.
 */
export type FieldEditorComponentProps<F extends Field, K extends keyof F> = {
	field: F;
	value: F[K];
	onChange: (next: F[K]) => void;
	label: string;
	autoFocus?: boolean;
};

/** A declarative editor component, narrowed to one field key. */
export type FieldEditorComponent<
	F extends Field,
	K extends keyof F,
> = ComponentType<FieldEditorComponentProps<F, K>>;

/**
 * One entry in a kind's declarative editor schema.
 *
 * `label` is required — used both as the editor header and as the Add
 * Property pill's text when the entry is hidden but addable.
 *
 * `visible(field)` decides whether the entry's editor should render. Default
 * is "always visible." Falsy `visible` + `addable=true` causes the section
 * to render an Add Property pill instead of the editor; clicking it
 * activates the entry (renders the editor with `autoFocus`).
 *
 * `addable` is opt-in. Required-by-spec keys (e.g. `calculate` on hidden)
 * stay always-visible and never become a pill.
 */
export type FieldEditorEntry<F extends Field> = {
	[K in keyof F]: {
		key: K;
		component: FieldEditorComponent<F, K>;
		label: string;
		visible?: (field: F) => boolean;
		addable?: boolean;
	};
}[keyof F];

/** Declarative per-kind editor schema — three fixed sections. */
export type FieldEditorSchema<F extends Field> = {
	data: FieldEditorEntry<F>[];
	logic: FieldEditorEntry<F>[];
	ui: FieldEditorEntry<F>[];
};
```

- [ ] **Step 4: Run test to verify it still fails (now on schema entries)**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: TypeScript errors in every `lib/domain/fields/*.ts` file because `FieldKindMetadata` now requires `label` (missing) and `icon: IconifyIcon` (currently a string), and `FieldEditorEntry` now requires `label`.

This is the failing state for the type contract — the kind-file sweep in Tasks 2–3 fixes it.

- [ ] **Step 5: Commit (intermediate state — types updated, kind files broken)**

```bash
git add lib/domain/kinds.ts lib/domain/__tests__/kinds.test.ts
git commit -m "refactor(domain): tighten FieldKindMetadata + FieldEditorEntry contract for Phase 5

- FieldKindMetadata.icon: string → IconifyIcon (real imported data)
- FieldKindMetadata.label: required human-readable name
- FieldEditorEntry.label: required (used by editor + Add Property pill)
- FieldEditorEntry.addable: optional boolean for the pill affordance
- FieldEditorComponentProps: add label + autoFocus

This breaks every kind file's metadata + editor schema. Tasks 2 and 3
of Phase 5 update each kind file in turn; final verification re-runs
typecheck after both."
```

NOTE: This commit intentionally leaves `npx tsc --noEmit` failing. The plan's TDD discipline is preserved by Task 1's unit test (which will start passing after Task 2 finishes the icon update on every kind file). The final verification task confirms the whole tree compiles.

---

## Task 2: Update `fieldRegistry` metadata in every kind file (icon + label)

Convert every `lib/domain/fields/<kind>.ts` to import `IconifyIcon` data and add a `label`. This is mechanical — one icon import, one icon swap, one new `label` line per kind. Doing it as a single atomic change keeps the test in Task 1 green and brings `npx tsc --noEmit` partway back to compiling (the editor-schema entries are still broken — that's Task 3).

**Files:**
- Modify: `lib/domain/fields/text.ts`, `int.ts`, `decimal.ts`, `date.ts`, `time.ts`, `datetime.ts`, `singleSelect.ts`, `multiSelect.ts`, `image.ts`, `audio.ts`, `video.ts`, `barcode.ts`, `signature.ts`, `geopoint.ts`, `label.ts`, `hidden.ts`, `secret.ts`, `group.ts`, `repeat.ts` (19 files)

The icon imports MUST come from `@iconify-icons/tabler/<icon-name>`. The naming uses the iconify ID's hyphen-stripped form (e.g. `tabler:cursor-text` → `import tablerCursorText from "@iconify-icons/tabler/cursor-text";`). Verify each icon exists in `@iconify-icons/tabler` package — every icon currently in `lib/fieldTypeIcons.ts` does.

Each file's metadata block changes from:

```typescript
export const textFieldMetadata: FieldKindMetadata<"text"> = {
	kind: "text",
	xformKind: "input",
	dataType: "xsd:string",
	icon: "tabler:cursor-text",
	isStructural: false,
	isContainer: false,
	saDocs: "...",
	convertTargets: ["secret"],
};
```

To:

```typescript
import tablerCursorText from "@iconify-icons/tabler/cursor-text";

export const textFieldMetadata: FieldKindMetadata<"text"> = {
	kind: "text",
	xformKind: "input",
	dataType: "xsd:string",
	icon: tablerCursorText,
	label: "Text",
	isStructural: false,
	isContainer: false,
	saDocs: "...",
	convertTargets: ["secret"],
};
```

The icon name + label per kind (matches the existing `fieldKindIcons` + `fieldKindLabels` maps in `lib/fieldTypeIcons.ts`):

| kind | icon import | label |
|------|-------------|-------|
| text | `tablerForms` from `@iconify-icons/tabler/forms` | `"Text"` |
| int | `tabler123` from `@iconify-icons/tabler/123` | `"Number"` |
| decimal | `tablerDecimal` from `@iconify-icons/tabler/decimal` | `"Decimal"` |
| date | `tablerCalendar` from `@iconify-icons/tabler/calendar` | `"Date"` |
| time | `tablerClock` from `@iconify-icons/tabler/clock` | `"Time"` |
| datetime | `tablerClock` from `@iconify-icons/tabler/clock` | `"Date/Time"` |
| single_select | `tablerCircleDot` from `@iconify-icons/tabler/circle-dot` | `"Single Select"` |
| multi_select | `tablerSquareCheck` from `@iconify-icons/tabler/square-check` | `"Multi Select"` |
| group | `tablerFolder` from `@iconify-icons/tabler/folder` | `"Group"` |
| repeat | `tablerRepeat` from `@iconify-icons/tabler/repeat` | `"Repeat"` |
| hidden | `tablerEyeOff` from `@iconify-icons/tabler/eye-off` | `"Hidden"` |
| geopoint | `tablerMapPin` from `@iconify-icons/tabler/map-pin` | `"Location"` |
| image | `tablerPhoto` from `@iconify-icons/tabler/photo` | `"Image"` |
| barcode | `tablerBarcode` from `@iconify-icons/tabler/barcode` | `"Barcode"` |
| label | `tablerTag` from `@iconify-icons/tabler/tag` | `"Label"` |
| audio | `tablerMicrophone` from `@iconify-icons/tabler/microphone` | `"Audio"` |
| video | `tablerDeviceTv` from `@iconify-icons/tabler/device-tv` | `"Video"` |
| signature | `tablerSignature` from `@iconify-icons/tabler/signature` | `"Signature"` |
| secret | `tablerLock` from `@iconify-icons/tabler/lock` | `"Secret"` |

NOTE: `text` uses `tablerForms` (matching `fieldKindIcons`), NOT `tabler:cursor-text` from the previous metadata. The metadata's `icon` string was a placeholder; the canonical icon is the one from `fieldKindIcons`. Use the table above.

- [ ] **Step 1: For each of the 19 kind files, add the icon import and update metadata**

Do all 19 in a single pass. The `StubField` import lines stay (Task 3 swaps those). Editor schemas stay broken on `label` field (Task 3).

- [ ] **Step 2: Run the kinds test from Task 1 to verify it passes**

```bash
npx vitest --run lib/domain/__tests__/kinds.test.ts
```

Expected: PASS (38 tests — 19 kinds × 2 assertions).

- [ ] **Step 3: Verify the rest of typecheck still fails on entry schemas (expected)**

```bash
npx tsc --noEmit 2>&1 | grep -c "error TS"
```

Expected: a substantial count — every `*FieldEditorSchema` entry is missing `label`. Task 3 fixes them.

- [ ] **Step 4: Commit**

```bash
git add lib/domain/fields/
git commit -m "refactor(domain): registry icons become IconifyIcon + add human label

Every kind's metadata now carries imported icon data and a label
field. The parallel fieldKindIcons / fieldKindLabels maps in
lib/fieldTypeIcons.ts become redundant; consumer migration follows
in a later task.

Editor schemas remain stubbed (Task 3 replaces them); typecheck
remains broken on FieldEditorEntry.label (Task 3 fixes)."
```

---

## Task 3: Build per-key editor primitives + replace stubs in every kind file

Build the four shared per-key editor components (XPathEditor, RequiredEditor, TextEditor, CasePropertyEditor) and the OptionsEditor adapter, then sweep every kind file to replace `StubField` with the real component plus `label` + `addable` + `visible`.

This is the most complex task in the plan; it's ordered as: build primitives → write component-level tests → replace stubs → verify the editor schemas compile. Subsequent tasks (the panel + section) compose these.

**Files:**
- Create: `components/builder/editor/AddPropertyButton.tsx` (moved from `contextual/AddPropertyButton.tsx`)
- Create: `components/builder/editor/fields/CasePropertyEditor.tsx`
- Create: `components/builder/editor/fields/OptionsEditor.tsx` (moved + adapted from `contextual/OptionsEditor.tsx`)
- Create: `components/builder/editor/fields/RequiredEditor.tsx` (folds `RequiredSection.tsx`)
- Create: `components/builder/editor/fields/TextEditor.tsx`
- Create: `components/builder/editor/fields/XPathEditor.tsx`
- Modify: every `lib/domain/fields/<kind>.ts` (19 files) — replace StubField with real components + add label/addable/visible

### Subtask 3a: Move AddPropertyButton

- [ ] **Step 1**: `git mv components/builder/contextual/AddPropertyButton.tsx components/builder/editor/AddPropertyButton.tsx`. Confirm no callers exist outside the `contextual/` directory yet (`grep -r AddPropertyButton components/ app/ lib/`); if there are external callers, update their imports to `@/components/builder/editor/AddPropertyButton`.

### Subtask 3b: TextEditor

The simplest editor — wraps `EditableText` for the `hint` key.

- [ ] **Step 1: Create `components/builder/editor/fields/TextEditor.tsx`**

```tsx
"use client";
import { EditableText } from "@/components/builder/EditableText";
import type { FieldEditorComponentProps } from "@/lib/domain/kinds";
import type { Field } from "@/lib/domain";

/**
 * Plain-text editor used for `hint` (and any other free-text optional
 * property). Wraps the existing EditableText commit/cancel/checkmark UX.
 *
 * The `data-field-id` is set to the field key so undo/redo focus hints
 * (which encode the focused field key) can scroll back to the right
 * editor after an undo restores the field.
 */
export function TextEditor<F extends Field, K extends keyof F & string>({
	value,
	onChange,
	label,
	autoFocus,
	keyName,
}: FieldEditorComponentProps<F, K> & { keyName: K }) {
	const v = typeof value === "string" ? value : "";
	return (
		<EditableText
			label={label}
			dataFieldId={keyName}
			value={v}
			autoFocus={autoFocus}
			onSave={(next) => {
				// Empty string → clear the property (undefined). The reducer
				// treats undefined patches as removals.
				onChange((next === "" ? undefined : next) as F[K]);
			}}
		/>
	);
}
```

Wait — `FieldEditorComponentProps` doesn't pass `keyName`. We need access to the key inside the component for the `data-field-id`. Two options: (a) thread `keyName` from the section into the component as an extra prop, (b) ditch `data-field-id` (focus hints will need a different strategy).

Going with (a): add `keyName: K` to the props passed by `FieldEditorSection`. Update `FieldEditorComponentProps` to include `keyName: K`:

Re-edit `lib/domain/kinds.ts` to add `keyName: K`:

```typescript
export type FieldEditorComponentProps<F extends Field, K extends keyof F> = {
	field: F;
	value: F[K];
	onChange: (next: F[K]) => void;
	label: string;
	keyName: K;
	autoFocus?: boolean;
};
```

(This adjustment goes in Task 1's commit if Task 1 hasn't merged yet; if it has, this is a follow-up tweak in Task 3 — adjust the commit and re-run tests.)

The `TextEditor` then uses `keyName` instead of a separate prop:

```tsx
"use client";
import { EditableText } from "@/components/builder/EditableText";
import type { Field } from "@/lib/domain";
import type { FieldEditorComponentProps } from "@/lib/domain/kinds";

export function TextEditor<F extends Field, K extends keyof F & string>(
	props: FieldEditorComponentProps<F, K>,
) {
	const { value, onChange, label, autoFocus, keyName } = props;
	const v = typeof value === "string" ? value : "";
	return (
		<EditableText
			label={label}
			dataFieldId={keyName}
			value={v}
			autoFocus={autoFocus}
			onSave={(next) => {
				onChange((next === "" ? undefined : next) as F[K]);
			}}
		/>
	);
}
```

- [ ] **Step 2: Write a smoke test** at `components/builder/editor/fields/__tests__/TextEditor.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { TextField } from "@/lib/domain";
import { TextEditor } from "../TextEditor";

const baseField: TextField = {
	kind: "text",
	uuid: "u1" as TextField["uuid"],
	id: "name",
	label: "Name",
};

describe("TextEditor", () => {
	it("renders the label and current value", () => {
		render(
			<TextEditor
				field={baseField}
				value="Enter your name"
				onChange={() => {}}
				label="Hint"
				keyName="hint"
			/>,
		);
		expect(screen.getByText("Hint")).toBeInTheDocument();
		expect(screen.getByDisplayValue("Enter your name")).toBeInTheDocument();
	});

	it("calls onChange with undefined when input is cleared and committed", async () => {
		const onChange = vi.fn();
		const user = userEvent.setup();
		render(
			<TextEditor
				field={baseField}
				value="hello"
				onChange={onChange}
				label="Hint"
				keyName="hint"
			/>,
		);
		const input = screen.getByDisplayValue("hello") as HTMLInputElement;
		await user.clear(input);
		input.blur();
		expect(onChange).toHaveBeenCalledWith(undefined);
	});
});
```

- [ ] **Step 3: Run; confirm green**

```bash
npx vitest --run components/builder/editor/fields/__tests__/TextEditor.test.tsx
```

Expected: PASS (2 tests).

- [ ] **Step 4: Commit (subtask 3b only)**

```bash
git add components/builder/editor/fields/TextEditor.tsx components/builder/editor/fields/__tests__/TextEditor.test.tsx
git commit -m "feat(editor): TextEditor — declarative hint/text-key editor"
```

### Subtask 3c: RequiredEditor

The tri-state widget (off / always / conditional). Folds `RequiredSection.tsx`'s entire surface into a `FieldEditorComponent` for the `required` key.

- [ ] **Step 1: Create `components/builder/editor/fields/RequiredEditor.tsx`**

```tsx
/**
 * RequiredEditor — declarative editor for the `required` field's tri-state lifecycle.
 *
 * The `required` value on a field encodes three states in one string:
 *   - `undefined`  → not required (toggle off)
 *   - `"true()"`   → always required (toggle on, no condition)
 *   - any other XPath → conditionally required (toggle on + condition)
 *
 * This component encapsulates all three transitions. No other code needs to
 * know about the `"true()"` sentinel. Folds in the entire RequiredSection
 * widget from Phase 1 / pre-Phase-5 — toggle, "Add Condition" button, XPath
 * editor, save semantics — under the FieldEditorComponent contract so the
 * declarative panel can mount it directly.
 */
"use client";
import { Icon } from "@iconify/react/offline";
import tablerTrash from "@iconify-icons/tabler/trash";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useContext, useState } from "react";
import { AddPropertyButton } from "@/components/builder/editor/AddPropertyButton";
import { SaveShortcutHint } from "@/components/builder/SaveShortcutHint";
import { XPathField } from "@/components/builder/XPathField";
import { Toggle } from "@/components/ui/Toggle";
import { buildLintContext } from "@/lib/codemirror/buildLintContext";
import type { XPathLintContext } from "@/lib/codemirror/xpath-lint";
import { BlueprintDocContext } from "@/lib/doc/provider";
import type { Uuid } from "@/lib/doc/types";
import type { Field } from "@/lib/domain";
import type { FieldEditorComponentProps } from "@/lib/domain/kinds";
import { useSessionFocusHint } from "@/lib/session/hooks";

/** Sentinel value CommCare uses for "always required" (no condition). */
const ALWAYS_REQUIRED = "true()";

/**
 * Build the lint context for the form that owns the field. The XPath editor
 * needs valid-paths + case properties + form entries to lint references.
 * The selected field always has a parent chain ending at a form; walk
 * fieldParent until we hit one.
 */
function useFormLintContext(fieldUuid: Uuid): () => XPathLintContext | undefined {
	const docStore = useContext(BlueprintDocContext);
	return useCallback(() => {
		if (!docStore) return undefined;
		const s = docStore.getState();
		let parentUuid: Uuid | undefined = s.fieldParent[fieldUuid] ?? undefined;
		while (parentUuid && !s.forms[parentUuid]) {
			parentUuid = s.fieldParent[parentUuid] ?? undefined;
		}
		if (!parentUuid) return undefined;
		return buildLintContext(s, parentUuid);
	}, [docStore, fieldUuid]);
}

/**
 * RequiredEditor — keyName="required". `value` is the raw `required` string
 * or undefined; `onChange(next)` sets the property (undefined removes it).
 */
export function RequiredEditor<F extends Field>({
	field,
	value,
	onChange,
	label,
	autoFocus,
}: FieldEditorComponentProps<F, "required" & keyof F>) {
	const required = typeof value === "string" ? value : undefined;
	const fieldUuid = field.uuid as Uuid;

	const getLintContext = useFormLintContext(fieldUuid);

	// Local state — currently editing a brand-new condition (XPath open, no value yet).
	const [addingCondition, setAddingCondition] = useState(false);
	// Tracks whether the XPath editor is active (drives save-shortcut hint label).
	const [editing, setEditing] = useState(false);

	// Undo/redo focus-hint passthrough — restoring focus to "required_condition"
	// scrolls to the editor and opens it; "required" focuses the toggle.
	const focusHint = useSessionFocusHint();
	const shouldFocusToggle = autoFocus || focusHint === "required";
	const shouldOpenCondition = focusHint === "required_condition";

	const hasCondition = !!required && required !== ALWAYS_REQUIRED;
	const isRequired = !!required;

	const handleToggleOff = useCallback(() => {
		onChange(undefined as F["required" & keyof F]);
		setAddingCondition(false);
		setEditing(false);
	}, [onChange]);

	const handleToggleOn = useCallback(() => {
		onChange(ALWAYS_REQUIRED as F["required" & keyof F]);
	}, [onChange]);

	const handleConditionSave = useCallback(
		(next: string) => {
			onChange((next || ALWAYS_REQUIRED) as F["required" & keyof F]);
			setAddingCondition(false);
			if (!next) setEditing(false);
		},
		[onChange],
	);

	const handleConditionRemove = useCallback(() => {
		onChange(ALWAYS_REQUIRED as F["required" & keyof F]);
		setAddingCondition(false);
		setEditing(false);
	}, [onChange]);

	const showEditor =
		isRequired && (hasCondition || addingCondition || shouldOpenCondition);

	return (
		<div data-field-id="required">
			<div className="flex items-center justify-between mb-1">
				<span className="text-xs text-nova-text-muted uppercase tracking-wider flex items-center gap-1.5 min-w-0">
					{label}
					{editing && <SaveShortcutHint />}
				</span>
				<Toggle
					enabled={isRequired}
					onToggle={isRequired ? handleToggleOff : handleToggleOn}
					autoFocus={shouldFocusToggle}
					dataFieldId="required"
				/>
			</div>
			<AnimatePresence initial={false}>
				{isRequired && (
					<motion.div
						key="required-content"
						initial={{ opacity: 0, height: 0 }}
						animate={{ opacity: 1, height: "auto" }}
						exit={{ opacity: 0, height: 0 }}
						transition={{ duration: 0.15, ease: "easeOut" }}
						className="overflow-hidden"
					>
						{showEditor ? (
							<div
								className="flex items-center gap-1.5 group/condition"
								data-field-id="required_condition"
							>
								<div className="flex-1 min-w-0">
									<XPathField
										value={hasCondition ? required : ""}
										onSave={handleConditionSave}
										getLintContext={getLintContext}
										autoEdit={addingCondition || shouldOpenCondition}
										onEditingChange={setEditing}
									/>
								</div>
								{hasCondition && (
									<button
										type="button"
										onClick={handleConditionRemove}
										aria-label="Remove condition"
										className="shrink-0 p-0.5 text-nova-text-muted opacity-0 group-hover/condition:opacity-100 hover:text-nova-rose transition-all cursor-pointer"
										tabIndex={-1}
									>
										<Icon icon={tablerTrash} width="12" height="12" />
									</button>
								)}
							</div>
						) : (
							<AddPropertyButton
								label="Condition"
								onClick={() => setAddingCondition(true)}
							/>
						)}
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}
```

- [ ] **Step 2: Write the test** at `components/builder/editor/fields/__tests__/RequiredEditor.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { TextField } from "@/lib/domain";
import { renderWithProviders } from "@/test/utils/renderWithProviders"; // assumed; if absent, inline a minimal BlueprintDocProvider mount
import { RequiredEditor } from "../RequiredEditor";

const baseField: TextField = {
	kind: "text",
	uuid: "u1" as TextField["uuid"],
	id: "name",
	label: "Name",
};

describe("RequiredEditor", () => {
	it("renders toggle off when value is undefined", () => {
		render(
			<RequiredEditor
				field={baseField}
				value={undefined}
				onChange={() => {}}
				label="Required"
				keyName="required"
			/>,
		);
		const toggle = screen.getByRole("switch");
		expect(toggle).toHaveAttribute("aria-checked", "false");
	});

	it("dispatches 'true()' when toggling on from off", async () => {
		const onChange = vi.fn();
		const user = userEvent.setup();
		render(
			<RequiredEditor
				field={baseField}
				value={undefined}
				onChange={onChange}
				label="Required"
				keyName="required"
			/>,
		);
		await user.click(screen.getByRole("switch"));
		expect(onChange).toHaveBeenCalledWith("true()");
	});

	it("dispatches undefined when toggling off from on", async () => {
		const onChange = vi.fn();
		const user = userEvent.setup();
		render(
			<RequiredEditor
				field={baseField}
				value="true()"
				onChange={onChange}
				label="Required"
				keyName="required"
			/>,
		);
		await user.click(screen.getByRole("switch"));
		expect(onChange).toHaveBeenCalledWith(undefined);
	});

	it("renders Add Condition pill when required is true() with no condition", () => {
		render(
			<RequiredEditor
				field={baseField}
				value="true()"
				onChange={() => {}}
				label="Required"
				keyName="required"
			/>,
		);
		expect(screen.getByText(/Condition/i)).toBeInTheDocument();
	});
});
```

NOTE: If your project doesn't have a `renderWithProviders` helper and the editor needs `BlueprintDocContext`, inline a minimal provider in the test file or wrap with `mockBlueprintDocProvider` from `lib/doc/__tests__/testHarness.ts` (check that file for the exact name; this plan assumes it exists since other doc-store tests use it).

- [ ] **Step 3: Run test**

```bash
npx vitest --run components/builder/editor/fields/__tests__/RequiredEditor.test.tsx
```

Expected: 4 PASS.

- [ ] **Step 4: Commit**

```bash
git add components/builder/editor/fields/RequiredEditor.tsx components/builder/editor/fields/__tests__/RequiredEditor.test.tsx
git commit -m "feat(editor): RequiredEditor folds RequiredSection into FieldEditorComponent"
```

### Subtask 3d: XPathEditor

The generic XPath-valued field editor — used for `relevant`, `validate`, `default_value`, `calculate`. Renders the label + `XPathField` + edit-state shortcut hint. When the entry is `validate`, also renders the nested `validate_msg` editor inside.

- [ ] **Step 1: Create `components/builder/editor/fields/XPathEditor.tsx`**

```tsx
/**
 * XPathEditor — generic editor for any XPath-valued field key.
 *
 * Used for: `relevant`, `validate`, `default_value`, `calculate`. Wraps
 * XPathField with a label, the save-shortcut hint, and lint-context wiring.
 *
 * Special case: when keyName === "validate", also renders an editor for
 * the optional `validate_msg` text field underneath. The `validate_msg`
 * is conceptually a child of validate (the message a user sees when the
 * validation expression fails), so it's bundled into the same editor
 * rather than living as a sibling Logic entry. The schema entry for
 * `validate_msg` does NOT exist — its UX is owned here.
 */
"use client";
import { useCallback, useContext, useState } from "react";
import { EditableText } from "@/components/builder/EditableText";
import { AddPropertyButton } from "@/components/builder/editor/AddPropertyButton";
import { SaveShortcutHint } from "@/components/builder/SaveShortcutHint";
import { XPathField } from "@/components/builder/XPathField";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { buildLintContext } from "@/lib/codemirror/buildLintContext";
import type { XPathLintContext } from "@/lib/codemirror/xpath-lint";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { asUuid, type Uuid } from "@/lib/doc/types";
import type { Field, FieldPatch } from "@/lib/domain";
import type { FieldEditorComponentProps } from "@/lib/domain/kinds";
import { useSessionFocusHint } from "@/lib/session/hooks";

function useFormLintContext(fieldUuid: Uuid): () => XPathLintContext | undefined {
	const docStore = useContext(BlueprintDocContext);
	return useCallback(() => {
		if (!docStore) return undefined;
		const s = docStore.getState();
		let parentUuid: Uuid | undefined = s.fieldParent[fieldUuid] ?? undefined;
		while (parentUuid && !s.forms[parentUuid]) {
			parentUuid = s.fieldParent[parentUuid] ?? undefined;
		}
		if (!parentUuid) return undefined;
		return buildLintContext(s, parentUuid);
	}, [docStore, fieldUuid]);
}

export function XPathEditor<F extends Field, K extends keyof F & string>(
	props: FieldEditorComponentProps<F, K>,
) {
	const { field, value, onChange, label, autoFocus, keyName } = props;
	const fieldUuid = field.uuid as Uuid;
	const v = typeof value === "string" ? value : "";

	const getLintContext = useFormLintContext(fieldUuid);
	const focusHint = useSessionFocusHint();
	const [editing, setEditing] = useState(false);

	const handleSave = useCallback(
		(next: string) => {
			onChange((next === "" ? undefined : next) as F[K]);
		},
		[onChange],
	);

	// validate_msg is owned by the validate editor — only show its UI here.
	const isValidate = keyName === "validate";
	const validateMsg =
		isValidate && "validate_msg" in field ? (field.validate_msg as string | undefined) : undefined;
	const hasValidateMsg = !!validateMsg;
	const [addingMsg, setAddingMsg] = useState(false);
	const showValidateMsg =
		isValidate && (hasValidateMsg || addingMsg || focusHint === "validate_msg");

	const { updateField } = useBlueprintMutations();
	const saveValidateMsg = useCallback(
		(next: string) => {
			updateField(asUuid(fieldUuid), {
				validate_msg: next === "" ? undefined : next,
			} as FieldPatch);
			setAddingMsg(false);
		},
		[updateField, fieldUuid],
	);

	return (
		<div>
			<span className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 flex items-center gap-1.5">
				{label}
				{editing && <SaveShortcutHint />}
			</span>
			<div data-field-id={keyName}>
				<XPathField
					value={v}
					onSave={handleSave}
					getLintContext={getLintContext}
					autoEdit={!!autoFocus || focusHint === keyName}
					onEditingChange={setEditing}
				/>
			</div>
			{isValidate && (
				<>
					{showValidateMsg ? (
						<div className="mt-1">
							<EditableText
								label="Validation Message"
								dataFieldId="validate_msg"
								value={validateMsg ?? ""}
								onSave={saveValidateMsg}
								autoFocus={addingMsg || focusHint === "validate_msg"}
								onEmpty={addingMsg ? () => setAddingMsg(false) : undefined}
							/>
						</div>
					) : (
						v && (
							<div className="mt-1">
								<AddPropertyButton
									label="Validation Message"
									onClick={() => setAddingMsg(true)}
								/>
							</div>
						)
					)}
				</>
			)}
		</div>
	);
}
```

- [ ] **Step 2: Test** at `components/builder/editor/fields/__tests__/XPathEditor.test.tsx`. Cover: renders label, save propagates, validate keyName shows nested validate_msg pill when validate is set + msg unset.

- [ ] **Step 3: Run + commit**

```bash
git add components/builder/editor/fields/XPathEditor.tsx components/builder/editor/fields/__tests__/XPathEditor.test.tsx
git commit -m "feat(editor): XPathEditor with nested validate_msg under validate"
```

### Subtask 3e: CasePropertyEditor

Wraps the existing `CasePropertyDropdown` (moved here as a private internal — delete the old file).

- [ ] **Step 1**: Move the body of `components/builder/contextual/CasePropertyDropdown.tsx` into a private internal inside `components/builder/editor/fields/CasePropertyEditor.tsx`. The new file:

```tsx
/**
 * CasePropertyEditor — declarative editor for the `case_property` field.
 * Reads the selected form's module to discover writable case types
 * (the module's own type plus any direct child types). Renders an
 * "intentionally hidden" return when no case types are writable.
 *
 * Wraps an internal CasePropertyDropdown component (formerly its own
 * file under contextual/) — kept private because the only other consumer
 * was ContextualEditorData, which is being deleted.
 */
"use client";
// ...full body of CasePropertyDropdown moved in as a private function
import { /* same imports as CasePropertyDropdown.tsx had */ } from "...";
import { useCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import { useSelectedFormContext } from "@/lib/routing/hooks";
import type { Field, CaseType } from "@/lib/domain";
import type { FieldEditorComponentProps } from "@/lib/domain/kinds";

const MEDIA_TYPES = new Set(["image", "audio", "video", "signature"]);

function getModuleCaseTypes(
	caseType: string | undefined,
	caseTypes: CaseType[],
): string[] {
	if (!caseType) return [];
	const result = [caseType];
	for (const ct of caseTypes) {
		if (ct.parent_type === caseType) result.push(ct.name);
	}
	return result;
}

function CasePropertyDropdown(/* same props as before */) {
	// ... full body ported verbatim from contextual/CasePropertyDropdown.tsx
}

export function CasePropertyEditor<F extends Field>(
	props: FieldEditorComponentProps<F, "case_property" & keyof F>,
) {
	const { field, value, onChange, autoFocus } = props;
	const ctx = useSelectedFormContext();
	const caseTypes = useCaseTypes();

	if (!ctx) return null;
	const writableCaseTypes = getModuleCaseTypes(ctx.module.caseType, caseTypes);
	const isCaseName = field.id === "case_name";

	// Same gate as before — hide entirely if nothing applies.
	if (!isCaseName && writableCaseTypes.length === 0) return null;

	return (
		<div data-field-id="case_property_on">
			<CasePropertyDropdown
				value={typeof value === "string" ? value : undefined}
				isCaseName={isCaseName}
				disabled={MEDIA_TYPES.has(field.kind)}
				caseTypes={writableCaseTypes}
				onChange={(caseType) =>
					onChange((caseType ?? undefined) as F["case_property" & keyof F])
				}
				autoFocus={autoFocus}
			/>
		</div>
	);
}
```

The `MEDIA_TYPES` set lives here because it's the only consumer remaining. After this task, the old `MEDIA_TYPES` export from `contextual/shared.ts` is dead.

- [ ] **Step 2: Delete `components/builder/contextual/CasePropertyDropdown.tsx`** (verify no other importers via `grep -r CasePropertyDropdown` first).

- [ ] **Step 3: Test** — at minimum: renders nothing when `ctx` is missing; renders the dropdown when caseTypes available.

- [ ] **Step 4: Commit**

```bash
git add components/builder/editor/fields/CasePropertyEditor.tsx components/builder/editor/fields/__tests__/CasePropertyEditor.test.tsx
git rm components/builder/contextual/CasePropertyDropdown.tsx
git commit -m "feat(editor): CasePropertyEditor folds CasePropertyDropdown"
```

### Subtask 3f: OptionsEditor adapter

Move `components/builder/contextual/OptionsEditor.tsx` to `components/builder/editor/fields/OptionsEditor.tsx` and adapt to `FieldEditorComponentProps` shape.

- [ ] **Step 1**: `git mv components/builder/contextual/OptionsEditor.tsx components/builder/editor/fields/OptionsEditor.tsx`. Wrap the existing `OptionsEditor` export under a new top-level `OptionsEditor` that accepts `FieldEditorComponentProps<F, "options" & keyof F>` and forwards. Keep the underlying widget signature internal:

```tsx
/**
 * OptionsEditor — declarative editor for the `options` array on
 * single_select / multi_select fields. Wraps the existing options-editor
 * widget (renamed to OptionsEditorWidget internally) with the
 * FieldEditorComponentProps contract.
 */
"use client";
// ... existing imports ...
import type { Field } from "@/lib/domain";
import type { FieldEditorComponentProps } from "@/lib/domain/kinds";

// ── Internal widget (was the entire previous file body) ────────────
function OptionsEditorWidget(/* original props */) {
	// ... unchanged body ...
}

// ── FieldEditorComponent adapter ─────────────────────────────────
export function OptionsEditor<F extends Field>(
	props: FieldEditorComponentProps<F, "options" & keyof F>,
) {
	const { value, onChange, autoFocus } = props;
	const options = Array.isArray(value) ? value : [];
	return (
		<div data-field-id="options">
			<OptionsEditorWidget
				options={options}
				autoFocus={autoFocus}
				onSave={(next) => {
					// Empty options array → undefined (clear). The reducer treats
					// undefined as removal; setting `[]` would violate the
					// schema's `min(2)` constraint on save.
					onChange((next.length > 0 ? next : undefined) as F["options" & keyof F]);
				}}
			/>
		</div>
	);
}
```

- [ ] **Step 2: Update import sites** that referenced the old path. Most usages were inside `contextual/` (being deleted in this phase); confirm via `grep -r "contextual/OptionsEditor"`.

- [ ] **Step 3: Test** — render with a 2-option array, add a 3rd via `userEvent`, expect onChange called with the 3-item array.

- [ ] **Step 4: Commit**

```bash
git add components/builder/editor/fields/OptionsEditor.tsx components/builder/editor/fields/__tests__/OptionsEditor.test.tsx
git rm components/builder/contextual/OptionsEditor.tsx
git commit -m "refactor(editor): OptionsEditor moved + adapted to FieldEditorComponent"
```

### Subtask 3g: Sweep all 19 kind files — replace stubs with real components + label + addable + visible

For each kind file, replace the StubField imports with imports of the real editor components. Define `label` and (where applicable) `visible`/`addable` on each entry.

The full mapping (one row per (kind × section × key)):

**text.ts** (`TextField`)
- data: `{ key: "case_property", component: CasePropertyEditor, label: "Saves to" }`
- logic:
  - `{ key: "required", component: RequiredEditor, label: "Required", addable: true, visible: (f) => !!f.required }`
  - `{ key: "validate", component: XPathEditor, label: "Validation", addable: true, visible: (f) => !!f.validate }`
  - `{ key: "relevant", component: XPathEditor, label: "Show When", addable: true, visible: (f) => !!f.relevant }`
  - `{ key: "default_value", component: XPathEditor, label: "Default Value", addable: true, visible: (f) => !!f.default_value }`
  - `{ key: "calculate", component: XPathEditor, label: "Calculate", addable: true, visible: (f) => !!f.calculate }`
  - (NO entry for `validate_msg` — owned by XPathEditor when keyName="validate")
- ui: `{ key: "hint", component: TextEditor, label: "Hint", addable: true, visible: (f) => !!f.hint }`

**int.ts**, **decimal.ts**, **date.ts**, **time.ts**, **datetime.ts**, **secret.ts**: identical to text.ts, MINUS keys their schema doesn't carry. Verify against each kind's Zod schema.

**single_select.ts** / **multi_select.ts**:
- data:
  - `{ key: "case_property", component: CasePropertyEditor, label: "Saves to" }`
  - `{ key: "options", component: OptionsEditor, label: "Options" }` (always visible — required by min(2))
- logic: same as text BUT no `default_value` (select schemas don't have it).
- ui: `{ key: "hint", component: TextEditor, label: "Hint", addable: true, visible: (f) => !!f.hint }`

**image.ts** / **audio.ts** / **video.ts** / **signature.ts**:
- data: empty (media kinds don't have case_property)
- logic:
  - `{ key: "required", component: RequiredEditor, label: "Required", addable: true, visible: (f) => !!f.required }`
  - `{ key: "relevant", component: XPathEditor, label: "Show When", addable: true, visible: (f) => !!f.relevant }`
- ui: `{ key: "hint", component: TextEditor, label: "Hint", addable: true, visible: (f) => !!f.hint }`

**barcode.ts**, **geopoint.ts**: like text but only `required`, `relevant`, `validate` (no calculate, no default_value).

**label.ts**:
- data: empty
- logic: `{ key: "relevant", component: XPathEditor, label: "Show When", addable: true, visible: (f) => !!f.relevant }`
- ui: empty

**hidden.ts**:
- data: `{ key: "case_property", component: CasePropertyEditor, label: "Saves to" }`
- logic:
  - `{ key: "calculate", component: XPathEditor, label: "Calculate" }` (REQUIRED — always visible, never addable, never undefined)
  - `{ key: "default_value", component: XPathEditor, label: "Default Value", addable: true, visible: (f) => !!f.default_value }`
  - `{ key: "required", component: RequiredEditor, label: "Required", addable: true, visible: (f) => !!f.required }`
  - `{ key: "relevant", component: XPathEditor, label: "Show When", addable: true, visible: (f) => !!f.relevant }`
- ui: empty

**group.ts** / **repeat.ts**:
- data: empty
- logic: `{ key: "relevant", component: XPathEditor, label: "Show When", addable: true, visible: (f) => !!f.relevant }`
- ui: empty

For each kind file, the editor schema becomes (using text.ts as template):

```typescript
import { CasePropertyEditor } from "@/components/builder/editor/fields/CasePropertyEditor";
import { RequiredEditor } from "@/components/builder/editor/fields/RequiredEditor";
import { TextEditor } from "@/components/builder/editor/fields/TextEditor";
import { XPathEditor } from "@/components/builder/editor/fields/XPathEditor";

export const textFieldEditorSchema: FieldEditorSchema<TextField> = {
	data: [
		{ key: "case_property", component: CasePropertyEditor, label: "Saves to" },
	],
	logic: [
		{ key: "required", component: RequiredEditor, label: "Required", addable: true, visible: (f) => !!f.required },
		{ key: "validate", component: XPathEditor, label: "Validation", addable: true, visible: (f) => !!f.validate },
		{ key: "relevant", component: XPathEditor, label: "Show When", addable: true, visible: (f) => !!f.relevant },
		{ key: "default_value", component: XPathEditor, label: "Default Value", addable: true, visible: (f) => !!f.default_value },
		{ key: "calculate", component: XPathEditor, label: "Calculate", addable: true, visible: (f) => !!f.calculate },
	],
	ui: [
		{ key: "hint", component: TextEditor, label: "Hint", addable: true, visible: (f) => !!f.hint },
	],
};
```

Drop the `StubField` import from every file.

- [ ] **Step 1: Update each of the 19 kind files per the mapping above**

- [ ] **Step 2: Delete the now-unused stub** — `git rm components/builder/editor/StubField.tsx`. Verify no remaining imports via `grep -r "StubField"`.

- [ ] **Step 3: Run typecheck**

```bash
npx tsc --noEmit && echo "✓ tsc clean"
```

Expected: clean. If any kind file still has type errors, the editor schema entry's `key` doesn't exist on that kind's TS type — verify against the Zod schema.

- [ ] **Step 4: Run all tests**

```bash
npm test -- --run 2>&1 | tail -10
```

Expected: 1316+ tests passing. New editor-component tests added; no existing tests should break.

- [ ] **Step 5: Commit**

```bash
git add lib/domain/fields/
git rm components/builder/editor/StubField.tsx
git commit -m "refactor(domain): replace StubField with real editor components in every kind

Each kind's editor schema now points at the appropriate per-key
editor component (XPathEditor / RequiredEditor / TextEditor /
CasePropertyEditor / OptionsEditor) plus carries label + addable
+ visible metadata. Phase 5's declarative panel composes them in
the next task."
```

---

## Task 4: Build `useEntryActivation` hook

Per-section pending-activation state. Replaces the `useAddableField` hook from `contextual/shared.ts`. Scoped per-section so the Logic and UI sections don't share a "pending" key.

**Files:**
- Create: `components/builder/editor/useEntryActivation.ts`
- Test: `components/builder/editor/__tests__/useEntryActivation.test.tsx`

- [ ] **Step 1: Test (RED)**

```tsx
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useEntryActivation } from "../useEntryActivation";

describe("useEntryActivation", () => {
	it("starts with no pending key", () => {
		const { result } = renderHook(() => useEntryActivation("u1", "logic"));
		expect(result.current.pending("validate")).toBe(false);
	});

	it("activate marks the key as pending", () => {
		const { result } = renderHook(() => useEntryActivation("u1", "logic"));
		act(() => result.current.activate("validate"));
		expect(result.current.pending("validate")).toBe(true);
		expect(result.current.pending("hint")).toBe(false);
	});

	it("clear resets pending", () => {
		const { result } = renderHook(() => useEntryActivation("u1", "logic"));
		act(() => result.current.activate("validate"));
		act(() => result.current.clear());
		expect(result.current.pending("validate")).toBe(false);
	});

	it("scope changes invalidate pending state", () => {
		const { result, rerender } = renderHook(
			({ uuid }) => useEntryActivation(uuid, "logic"),
			{ initialProps: { uuid: "u1" } },
		);
		act(() => result.current.activate("validate"));
		rerender({ uuid: "u2" });
		expect(result.current.pending("validate")).toBe(false);
	});
});
```

- [ ] **Step 2: Run** — fails with "useEntryActivation not exported."

- [ ] **Step 3: Implement**

```typescript
/**
 * useEntryActivation — per-section pending-activation state for the
 * declarative editor.
 *
 * When a user clicks the "Add Property" pill for a hidden-but-addable
 * entry, the section needs to render that entry's editor in autoFocus
 * mode (so the user can immediately type). This hook owns the pending
 * key. The scope is `${fieldUuid}:${section}` so two effects are
 * automatic:
 *
 *   1. Switching the selected field clears pending — you don't carry
 *      "I just added a hint" state across field selections.
 *   2. Two sections (Logic + UI) can each have their own pending key
 *      simultaneously — clicking "Add Hint" in UI doesn't clear a
 *      "pending validate" in Logic.
 *
 * Replaces the legacy `useAddableField` from contextual/shared.ts. Same
 * shape, scoped name, and clearer semantics.
 */
"use client";
import { useCallback, useState } from "react";

export type EditorSectionName = "data" | "logic" | "ui";

export type EntryActivation = {
	/** True when `key` is pending for this scope. */
	pending: (key: string) => boolean;
	/** Mark `key` as pending; previous pending (if any) is replaced. */
	activate: (key: string) => void;
	/** Reset pending. */
	clear: () => void;
};

export function useEntryActivation(
	fieldUuid: string,
	section: EditorSectionName,
): EntryActivation {
	const scope = `${fieldUuid}:${section}`;
	const [state, setState] = useState<{ scope: string; key: string } | null>(null);

	const pending = useCallback(
		(key: string) => state?.scope === scope && state.key === key,
		[state, scope],
	);
	const activate = useCallback(
		(key: string) => setState({ scope, key }),
		[scope],
	);
	const clear = useCallback(() => setState(null), []);

	return { pending, activate, clear };
}
```

- [ ] **Step 4: Run** — 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add components/builder/editor/useEntryActivation.ts components/builder/editor/__tests__/useEntryActivation.test.tsx
git commit -m "feat(editor): useEntryActivation hook for per-section pill activation"
```

---

## Task 5: Build `FieldEditorSection` component

Renders one section: visible entries → component, addable-but-hidden entries → Add Property pills. Owns activation state.

**Files:**
- Create: `components/builder/editor/FieldEditorSection.tsx`
- Test: `components/builder/editor/__tests__/FieldEditorSection.test.tsx`

- [ ] **Step 1: Implement**

```tsx
/**
 * FieldEditorSection — renders one of the three Data / Logic / UI sections.
 *
 * Reads its entries from the schema (passed in by the panel). For each entry:
 *   - If `visible(field)` returns true (or is undefined), or the entry is
 *     pending-activated, render `<entry.component>` with the typed value.
 *   - Otherwise, if `entry.addable === true`, accumulate it in the addable
 *     list rendered as Add Property pills below the editors.
 *   - Otherwise, the entry stays hidden (e.g. a kind doesn't currently
 *     expose this property and won't until another mutation flips visibility).
 *
 * Returns null if neither editors nor pills would render — the parent
 * (FieldEditorPanel) hides the section card entirely in that case.
 *
 * AnimatePresence wraps the visible editors so add/remove animates the way
 * the legacy ContextualEditorLogic did. Keys are the entry `key` so React
 * keeps editor instances stable across visibility flips.
 */
"use client";
import { AnimatePresence, motion } from "motion/react";
import { useCallback } from "react";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { asUuid, type Uuid } from "@/lib/doc/types";
import type { Field, FieldKind, FieldPatch } from "@/lib/domain";
import type { FieldEditorEntry, FieldEditorSchema } from "@/lib/domain/kinds";
import { AddPropertyButton } from "./AddPropertyButton";
import { type EditorSectionName, useEntryActivation } from "./useEntryActivation";

interface FieldEditorSectionProps<F extends Field> {
	field: F;
	section: EditorSectionName;
	entries: FieldEditorSchema<F>[EditorSectionName];
}

/**
 * Render a single section. Generic on the field kind so the component
 * dispatch is fully typed. Callers (FieldEditorPanel) narrow `field` to a
 * single kind via `Extract<Field, { kind: K }>` and pass the matching
 * entries.
 */
export function FieldEditorSection<F extends Field>({
	field,
	section,
	entries,
}: FieldEditorSectionProps<F>) {
	const { updateField } = useBlueprintMutations();
	const activation = useEntryActivation(field.uuid as string, section);

	// onChange dispatches an updateField mutation patching exactly this key.
	// Casting through FieldPatch is necessary because the union-wide patch
	// type can't be narrowed to a single key at the entry level (each
	// schema entry's key is a string literal, but the patch input must be
	// the union shape).
	const setKey = useCallback(
		<K extends keyof F & string>(key: K, value: F[K]) => {
			updateField(asUuid(field.uuid as string), {
				[key]: value,
			} as FieldPatch);
		},
		[updateField, field.uuid],
	);

	// Partition entries into visible (render editor) vs addable-but-hidden
	// (render pill). Pending entries always go into visible with autoFocus.
	const visible: { entry: FieldEditorEntry<F>; autoFocus: boolean }[] = [];
	const pills: FieldEditorEntry<F>[] = [];
	for (const entry of entries) {
		const isPending = activation.pending(entry.key as string);
		const isVisible = entry.visible ? entry.visible(field) : true;
		if (isVisible || isPending) {
			visible.push({ entry, autoFocus: isPending });
		} else if (entry.addable) {
			pills.push(entry);
		}
	}

	if (visible.length === 0 && pills.length === 0) return null;

	const hasContent = visible.length > 0;

	return (
		<>
			<AnimatePresence initial={false}>
				{visible.map(({ entry, autoFocus }) => {
					const Component = entry.component as React.ComponentType<{
						field: F;
						value: F[keyof F];
						onChange: (next: F[keyof F]) => void;
						label: string;
						keyName: keyof F;
						autoFocus?: boolean;
					}>;
					const key = entry.key as keyof F & string;
					const value = field[key];
					return (
						<motion.div
							key={key}
							initial={{ opacity: 0, height: 0 }}
							animate={{ opacity: 1, height: "auto" }}
							exit={{ opacity: 0, height: 0 }}
							transition={{ duration: 0.15, ease: "easeOut" }}
							className="overflow-hidden"
						>
							<Component
								field={field}
								value={value}
								label={entry.label}
								keyName={key}
								autoFocus={autoFocus}
								onChange={(next) => {
									setKey(key, next);
									if (autoFocus) activation.clear();
								}}
							/>
						</motion.div>
					);
				})}
			</AnimatePresence>

			{pills.length > 0 && (
				<div className={hasContent ? "pt-2 border-t border-nova-border/40" : ""}>
					<div className="flex flex-wrap gap-1.5">
						{pills.map((entry) => (
							<AddPropertyButton
								key={entry.key as string}
								label={entry.label}
								onClick={() => activation.activate(entry.key as string)}
							/>
						))}
					</div>
				</div>
			)}
		</>
	);
}
```

- [ ] **Step 2: Test** — render with stub entries, verify partition behavior, verify pill click activates the entry (renders the editor).

- [ ] **Step 3: Commit**

```bash
git add components/builder/editor/FieldEditorSection.tsx components/builder/editor/__tests__/FieldEditorSection.test.tsx
git commit -m "feat(editor): FieldEditorSection — declarative section + Add Property pills"
```

---

## Task 6: Build `FieldEditorPanel` component

The panel that composes three sections. Reads `fieldEditorSchemas[field.kind]` and dispatches.

**Files:**
- Create: `components/builder/editor/FieldEditorPanel.tsx`
- Test: `components/builder/editor/__tests__/FieldEditorPanel.test.tsx`

- [ ] **Step 1: Implement**

```tsx
/**
 * FieldEditorPanel — registry-driven editor body for the selected field.
 *
 * Reads fieldEditorSchemas[field.kind] and renders the three sections
 * (Data / Logic / UI). Each section is independently visible — empty
 * sections render nothing, including their card chrome.
 *
 * No per-kind switching here. All kind-specific behavior lives in the
 * registry entries' components.
 *
 * The Logic section uses a styled card wrapper (matching the legacy
 * ContextualEditorLogic visual). Data and UI sections wrap their content
 * in the same card style. The card wraps EVEN IF only addable pills
 * render — the section already nulled out if there's nothing at all.
 */
"use client";
import type { Field } from "@/lib/domain";
import { fieldEditorSchemas, type FieldKind } from "@/lib/domain";
import { FieldEditorSection } from "./FieldEditorSection";

const SECTION_CARD_CLASS =
	"rounded-md bg-nova-surface/40 border border-white/[0.04] px-3 py-2.5";

function SectionLabel({ label }: { label: string }) {
	return (
		<div className="flex items-center gap-2 mb-2">
			<div className="w-0.5 h-3 rounded-full bg-nova-violet/40" />
			<span className="text-[10px] font-semibold uppercase tracking-widest text-nova-text-muted/70">
				{label}
			</span>
		</div>
	);
}

interface FieldEditorPanelProps {
	field: Field;
}

/**
 * The body of the field inspector. Pairs with FieldHeader (rendered above
 * by InlineSettingsPanel).
 */
export function FieldEditorPanel({ field }: FieldEditorPanelProps) {
	// Narrow the schema lookup. Each kind's schema is typed against
	// Extract<Field, { kind: K }>, so we cast through the kind discriminant
	// to get a schema typed against the actual field's kind variant.
	const schema = fieldEditorSchemas[field.kind as FieldKind];

	return (
		<div className="p-2 space-y-2">
			<Section title="Data" entries={schema.data} field={field} section="data" />
			<Section
				title="Logic"
				entries={schema.logic}
				field={field}
				section="logic"
			/>
			<Section title="Appearance" entries={schema.ui} field={field} section="ui" />
		</div>
	);
}

function Section({
	title,
	entries,
	field,
	section,
}: {
	title: string;
	entries: ReturnType<typeof fieldEditorSchemas[FieldKind]>[
		"data" | "logic" | "ui"
	];
	field: Field;
	section: "data" | "logic" | "ui";
}) {
	if (entries.length === 0) return null;
	return (
		<div className={SECTION_CARD_CLASS}>
			<SectionLabel label={title} />
			<div className="space-y-3">
				<FieldEditorSection
					// biome-ignore lint/suspicious/noExplicitAny: registry narrowing
					field={field as any}
					section={section}
					// biome-ignore lint/suspicious/noExplicitAny: registry narrowing
					entries={entries as any}
				/>
			</div>
		</div>
	);
}
```

NOTE on the `as any` casts: the discriminated-union narrowing here is intractable without code generation. The schema entry component is keyed to a specific kind variant (e.g. `Extract<Field, { kind: "text" }>`), but at the panel level we only know `field: Field`. We carry the runtime guarantee (`fieldEditorSchemas[field.kind]` is the schema for THIS kind, so its entries' components ARE compatible with this field) and silence the compile-time disconnect with a single cast. This is the ONE acceptable use of `any` in Phase 5 — adding helper indirection here would obscure the actual flow.

If a reviewer pushes back: an alternative is a switch-on-kind dispatcher that narrows correctly per branch. That trades 19 cases of repetition for the type narrowing — and reintroduces exactly the per-kind switching the spec is moving away from. The cast is the right call.

The lint suppressions must include the explanatory comment. If Biome's `noExplicitAny` rule is configured to warn, the comment satisfies the rule's "what justifies this" gate.

- [ ] **Step 2: Test**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TextField, GroupField } from "@/lib/domain";
import { renderWithDocProvider } from "@/test/utils/docProviderHarness"; // assumed
import { FieldEditorPanel } from "../FieldEditorPanel";

describe("FieldEditorPanel", () => {
	it("renders all three sections for a text field with content in each", () => {
		const field: TextField = {
			kind: "text",
			uuid: "u1" as TextField["uuid"],
			id: "name",
			label: "Name",
			required: "true()",
			hint: "Your full name",
			case_property: "name",
		};
		renderWithDocProvider(<FieldEditorPanel field={field} />);
		expect(screen.getByText("Data")).toBeInTheDocument();
		expect(screen.getByText("Logic")).toBeInTheDocument();
		expect(screen.getByText("Appearance")).toBeInTheDocument();
	});

	it("hides Data + Appearance sections for a group field (only Logic relevant)", () => {
		const field: GroupField = {
			kind: "group",
			uuid: "g1" as GroupField["uuid"],
			id: "household",
			label: "Household",
		};
		renderWithDocProvider(<FieldEditorPanel field={field} />);
		expect(screen.queryByText("Data")).not.toBeInTheDocument();
		expect(screen.queryByText("Appearance")).not.toBeInTheDocument();
		expect(screen.getByText("Logic")).toBeInTheDocument();
	});
});
```

- [ ] **Step 3: Commit**

```bash
git add components/builder/editor/FieldEditorPanel.tsx components/builder/editor/__tests__/FieldEditorPanel.test.tsx
git commit -m "feat(editor): FieldEditorPanel composes sections from fieldEditorSchemas"
```

---

## Task 7: Build `FieldHeader` component

Replaces `ContextualEditorHeader.tsx`. Renders id input, type-icon adornment (from registry), kebab menu, delete. Reads `fieldRegistry[kind]` for icon + label + convertTargets.

**Files:**
- Create: `components/builder/editor/FieldHeader.tsx`
- Test: `components/builder/editor/__tests__/FieldHeader.test.tsx`

The implementation is a near-verbatim port of `ContextualEditorHeader.tsx` with these substitutions:

1. Replace `import { fieldKindIcons, fieldKindLabels } from "@/lib/fieldTypeIcons"` with reads from `fieldRegistry[field.kind].icon` and `.label`.
2. Replace the `getConvertibleTypes(field.kind)` import (still works — it reads the registry) — keep as-is.
3. Replace the `useFocusHint(HEADER_FIELDS)` call with the existing focus-hint hook from `lib/session/hooks` (the FocusableFieldKey union becomes `string`).
4. Update the file header docblock to reflect the new pattern.

```tsx
/**
 * FieldHeader — top chrome of the field inspector.
 *
 * Renders the type-icon adornment (sourced from fieldRegistry[kind].icon),
 * the editable id input with sibling-conflict shake + popover, and the
 * kebab menu (move up/down, cross-level moves with Shift, convert-type
 * submenu, duplicate). The trash button is a separate destructive
 * action to the right of the kebab.
 *
 * The header is rendered ABOVE FieldEditorPanel by InlineSettingsPanel.
 * Replaces ContextualEditorHeader from before Phase 5.
 *
 * Reads everything kind-specific from the registry:
 *   - fieldRegistry[kind].icon → type icon
 *   - fieldRegistry[kind].label → tooltip label
 *   - fieldRegistry[kind].convertTargets → submenu enable/disable
 *
 * No per-kind switching anywhere in this component.
 */
"use client";
// ... imports as in ContextualEditorHeader, with these adjustments:
import { fieldRegistry } from "@/lib/domain";
// REMOVE: import { fieldKindIcons, fieldKindLabels } from "@/lib/fieldTypeIcons";

interface FieldHeaderProps {
	field: Field;
}

export function FieldHeader({ field }: FieldHeaderProps) {
	// ... same body as ContextualEditorHeader, with these substitutions ...

	const meta = fieldRegistry[field.kind];
	const typeIcon = meta.icon;
	const typeLabel = meta.label;
	const conversionTargets = meta.convertTargets;
	const canConvert = conversionTargets.length > 0;

	// ... rest of the body unchanged ...
}
```

- [ ] **Step 1: Port** the body of `ContextualEditorHeader.tsx` to `components/builder/editor/FieldHeader.tsx` with the substitutions above. Drop the FocusableFieldKey-based useFocusHint; replace with `useSessionFocusHint()` raw (gate inside the component on `focusHint === "id" || isNewField`).

- [ ] **Step 2: Test**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TextField, GroupField } from "@/lib/domain";
import { renderWithDocProvider } from "@/test/utils/docProviderHarness";
import { FieldHeader } from "../FieldHeader";

describe("FieldHeader", () => {
	it("renders the type-icon adornment from the registry", () => {
		const field: TextField = {
			kind: "text",
			uuid: "u1" as TextField["uuid"],
			id: "name",
			label: "Name",
		};
		const { container } = renderWithDocProvider(<FieldHeader field={field} />);
		// The icon is an SVG; assert one is mounted in the adornment slot.
		expect(container.querySelector("svg")).toBeTruthy();
	});

	it("disables Convert Type submenu for kinds with no convertTargets", () => {
		const field: GroupField = {
			kind: "group",
			uuid: "g1" as GroupField["uuid"],
			id: "section",
			label: "Section",
		};
		// group's convertTargets is ["repeat"] (not empty); use a kind with []:
		// hidden's convertTargets is []. Use that.
		const hiddenField = {
			kind: "hidden" as const,
			uuid: "h1" as TextField["uuid"],
			id: "h",
			calculate: "1",
		};
		// Open the kebab menu, assert Convert Type item is disabled.
		// (Implementation detail of the test depends on Base UI Menu test API.)
	});
});
```

- [ ] **Step 3: Commit**

```bash
git add components/builder/editor/FieldHeader.tsx components/builder/editor/__tests__/FieldHeader.test.tsx
git commit -m "feat(editor): FieldHeader replaces ContextualEditorHeader (registry-driven)"
```

---

## Task 8: Wire `InlineSettingsPanel` to use the new editor + delete `contextual/`

The InlineSettingsPanel becomes a thin wrapper around `<FieldHeader>` + `<FieldEditorPanel>`. The `ContextualEditor*` files are deleted. The `contextual/shared.ts` exports get redistributed (or deleted entirely if no consumers).

**Files:**
- Modify: `components/builder/InlineSettingsPanel.tsx`
- Delete: `components/builder/contextual/ContextualEditorHeader.tsx`
- Delete: `components/builder/contextual/ContextualEditorData.tsx`
- Delete: `components/builder/contextual/ContextualEditorLogic.tsx`
- Delete: `components/builder/contextual/ContextualEditorUI.tsx`
- Delete: `components/builder/contextual/RequiredSection.tsx`
- Delete: `components/builder/contextual/shared.ts`
- Delete: `components/builder/contextual/` (the now-empty directory)

- [ ] **Step 1: Update `components/builder/InlineSettingsPanel.tsx`**

Replace the contextual editor mounts with the new components:

```tsx
"use client";
import { useCallback } from "react";
import type { Field } from "@/lib/domain";
import { useSetActiveFieldId } from "@/lib/session/hooks";
import { FieldEditorPanel } from "./editor/FieldEditorPanel";
import { FieldHeader } from "./editor/FieldHeader";

interface InlineSettingsPanelProps {
	field: Field;
	variant?: "attached" | "floating";
}

export function InlineSettingsPanel({
	field,
	variant = "attached",
}: InlineSettingsPanelProps) {
	const setActiveFieldId = useSetActiveFieldId();

	const handleFocus = useCallback(
		(e: React.FocusEvent) => {
			const fieldEl = (e.target as HTMLElement).closest("[data-field-id]");
			setActiveFieldId(fieldEl?.getAttribute("data-field-id") ?? undefined);
		},
		[setActiveFieldId],
	);

	const shape =
		variant === "attached"
			? "rounded-t-none rounded-b-lg border"
			: "rounded-lg border";

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: delegated focusin for undo/redo field tracking
		<div
			className={`${shape} border-nova-violet/60 bg-nova-deep/90 overflow-hidden cursor-auto shadow-[0_10px_22px_-10px_rgba(8,4,20,0.75)]`}
			data-no-drag
			onFocus={handleFocus}
		>
			<FieldHeader field={field} />
			<FieldEditorPanel field={field} />
		</div>
	);
}
```

Note: the previous `SectionLabel` and `SECTION_CARD_CLASS` exports from this file are now redundant (folded into `FieldEditorPanel`). Verify external consumers via `grep -r "SECTION_CARD_CLASS\|SectionLabel" --include="*.tsx" --include="*.ts"`. The Connect form-settings panel may use them — that gets refactored in Task 21+ when FormSettingsPanel splits, so leave the exports in place if external consumers exist. If the only consumers are inside `contextual/` (being deleted), remove the exports.

- [ ] **Step 2: Delete the contextual editor files**

```bash
git rm components/builder/contextual/ContextualEditorHeader.tsx
git rm components/builder/contextual/ContextualEditorData.tsx
git rm components/builder/contextual/ContextualEditorLogic.tsx
git rm components/builder/contextual/ContextualEditorUI.tsx
git rm components/builder/contextual/RequiredSection.tsx
git rm components/builder/contextual/shared.ts
rmdir components/builder/contextual  # only if empty after the above
```

- [ ] **Step 3: Audit deleted exports for surviving consumers**

The `shared.ts` file exported: `XPathFieldKey`, `TextFieldKey`, `FocusableFieldKey`, `FieldEditorProps`, `MEDIA_TYPES`, `fieldSupportedForType`, `xpathFields`, `addableTextFields`, `useAddableField`, `useFocusHint`, `getModuleCaseTypes`.

```bash
grep -rE "(XPathFieldKey|TextFieldKey|FocusableFieldKey|FieldEditorProps|fieldSupportedForType|xpathFields|addableTextFields|useAddableField|useFocusHint|getModuleCaseTypes|MEDIA_TYPES)" components/ app/ lib/ --include="*.ts" --include="*.tsx"
```

For each surviving consumer:
- `useFocusHint`: replace with raw `useSessionFocusHint()` from `lib/session/hooks` and inline the gate.
- `useAddableField`: not needed outside the editor; if anything still imports it, port to `useEntryActivation`.
- `getModuleCaseTypes`: keep — move into `components/builder/editor/fields/CasePropertyEditor.tsx` (already done in Task 3e). If other consumers exist, lift to `lib/domain/caseTypes.ts`.
- `MEDIA_TYPES`: only consumer was `CasePropertyEditor`. Already inlined.
- Everything else: dead code, no replacement needed.

- [ ] **Step 4: Run typecheck + tests + lint**

```bash
npx tsc --noEmit && npm run lint && npm test -- --run 2>&1 | tail -10
```

Expected: all clean.

- [ ] **Step 5: Commit**

```bash
git add components/builder/InlineSettingsPanel.tsx
git rm -r components/builder/contextual/
git commit -m "refactor(builder): wire InlineSettingsPanel to FieldEditorPanel + FieldHeader

Deletes the entire contextual/ directory. Per-section visibility,
add-property pills, and undo/redo focus restoration all flow through
the registry-driven editor stack now.

Stub StubField, ContextualEditor{Header,Data,Logic,UI}, RequiredSection,
CasePropertyDropdown, OptionsEditor, AddPropertyButton, shared.ts —
all gone or moved under editor/."
```

---

## Task 9: Migrate `fieldKindIcons` / `fieldKindLabels` consumers + relocate `formTypeIcons`

Sweep every file that reads `fieldKindIcons` or `fieldKindLabels` and replace with `fieldRegistry[kind].icon` / `.label`. Move `formTypeIcons` to its own file under `lib/domain/`. Delete `lib/fieldTypeIcons.ts`.

**Files:**
- Modify: every consumer of `fieldKindIcons` / `fieldKindLabels` / `formTypeIcons` (audit via `grep -r "fieldKindIcons\|fieldKindLabels\|formTypeIcons" --include="*.ts" --include="*.tsx"`)
- Create: `lib/domain/formTypeIcons.ts`
- Delete: `lib/fieldTypeIcons.ts`

- [ ] **Step 1: Audit consumers**

```bash
grep -rn "fieldKindIcons\|fieldKindLabels" --include="*.ts" --include="*.tsx" components/ app/ lib/
grep -rn "formTypeIcons" --include="*.ts" --include="*.tsx" components/ app/ lib/
```

Expected consumer list (verify on the day):
- `components/builder/FieldTypeList.tsx` — uses both field maps
- `components/builder/AppTree.tsx` — uses both (will be deleted in Task 14, but interim consumer until then)
- `components/builder/appTree/FieldRow.tsx`, `FormCard.tsx`, `useFieldIconMap.ts` — once those split files exist
- `components/preview/screens/FormScreen.tsx` — formTypeIcons
- `components/preview/form/...` — possibly
- `lib/services/questionPath.ts` — possibly

- [ ] **Step 2: Create `lib/domain/formTypeIcons.ts`**

```typescript
/**
 * Form-type icon registry. Mirrors the fieldRegistry pattern but for
 * the four form types (registration / followup / close / survey).
 *
 * Lives in lib/domain/ because form types are domain concepts (see
 * lib/domain/forms.ts for the FORM_TYPES tuple and FormType union).
 * No consumer outside the domain layer should hardcode form type icons.
 */
import type { IconifyIcon } from "@iconify/react/offline";
import tablerFile from "@iconify-icons/tabler/file";
import tablerFilePencil from "@iconify-icons/tabler/file-pencil";
import tablerFilePlus from "@iconify-icons/tabler/file-plus";
import tablerFileX from "@iconify-icons/tabler/file-x";
import type { FormType } from "./forms";

export const formTypeIcons: Record<FormType, IconifyIcon> = {
	registration: tablerFilePlus,
	followup: tablerFilePencil,
	close: tablerFileX,
	survey: tablerFile,
};
```

- [ ] **Step 3: Update each consumer**

Replace `fieldKindIcons[kind]` → `fieldRegistry[kind].icon` (import `fieldRegistry` from `@/lib/domain`).

Replace `fieldKindLabels[kind]` → `fieldRegistry[kind].label`.

Replace `import { formTypeIcons } from "@/lib/fieldTypeIcons"` → `import { formTypeIcons } from "@/lib/domain/formTypeIcons"`.

Inside `lib/domain/__tests__/`, no changes needed — the registry tests already use the registry.

- [ ] **Step 4: Delete `lib/fieldTypeIcons.ts`**

```bash
git rm lib/fieldTypeIcons.ts
```

Verify no imports remain via grep.

- [ ] **Step 5: Verify**

```bash
npx tsc --noEmit && npm run lint && npm test -- --run 2>&1 | tail -10
```

- [ ] **Step 6: Commit**

```bash
git add lib/domain/formTypeIcons.ts components/ app/
git rm lib/fieldTypeIcons.ts
git commit -m "refactor: consume fieldRegistry for icons + labels; relocate formTypeIcons

The parallel fieldKindIcons / fieldKindLabels maps in
lib/fieldTypeIcons.ts duplicated metadata that now lives on
fieldRegistry[kind]. Every consumer reads the registry directly.

formTypeIcons moves to lib/domain/formTypeIcons.ts as the domain
owner of form-type metadata. lib/fieldTypeIcons.ts is deleted."
```

---

## Task 10: AppTree split — extract `shared.tsx` (TreeItemRow + CollapseChevron + HighlightedText + FormIconContext)

Pull the small shared atoms out of `AppTree.tsx` into a single shared file. Self-contained — these atoms have no dependencies on the row components.

**Files:**
- Create: `components/builder/appTree/shared.tsx`
- Modify: `components/builder/AppTree.tsx` (interim — imports from the new file; full deletion in Task 14)

- [ ] **Step 1: Create `components/builder/appTree/shared.tsx`** with these copied verbatim from AppTree.tsx:
  - `FormIconContext` (the React context for the per-form icon map)
  - `CollapseChevron` (the chevron button)
  - `TreeItemRow` (the role=treeitem wrapper)
  - `HighlightedText` (the search-result highlighter)
  - `findMatchIndices` (the substring-position helper) — shared with `useSearchFilter` so it lives here

```tsx
"use client";
import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import { createContext } from "react";
import { highlightSegments, type MatchIndices } from "@/lib/filterTree";

/**
 * Per-form context carrying a question ID → type icon map. Lets FieldRow
 * render chips with correct question-type icons without prop drilling.
 */
export const FormIconContext = createContext<Map<string, IconifyIcon>>(new Map());

/** Find substring-match positions for a fuzzy filter. */
export function findMatchIndices(
	text: string,
	query: string,
): MatchIndices | undefined {
	const lower = text.toLowerCase();
	const idx = lower.indexOf(query);
	if (idx === -1) return undefined;
	return [[idx, idx + query.length]];
}

/** Collapsible-section chevron button. */
export function CollapseChevron({
	isCollapsed,
	onClick,
	hidden,
}: {
	isCollapsed: boolean;
	onClick: (e: React.MouseEvent) => void;
	hidden?: boolean;
}) {
	return (
		<button
			type="button"
			className={`w-4 h-4 flex items-center justify-center shrink-0 cursor-pointer rounded text-nova-text-muted hover:text-nova-text transition-colors ${hidden ? "invisible" : ""}`}
			onClick={onClick}
		>
			<Icon
				icon={tablerChevronRight}
				width="10"
				height="10"
				className="transition-transform duration-150"
				style={{
					transform: isCollapsed ? "rotate(0deg)" : "rotate(90deg)",
				}}
			/>
		</button>
	);
}

/** ARIA tree item row wrapper — handles Enter/Space activation. */
export function TreeItemRow({
	onClick,
	className,
	style,
	children,
	...rest
}: {
	onClick: (e: React.MouseEvent | React.KeyboardEvent) => void;
	className?: string;
	style?: React.CSSProperties;
	children: React.ReactNode;
	"data-tree-question"?: string;
}) {
	return (
		<div
			role="treeitem"
			tabIndex={0}
			className={className}
			style={style}
			onClick={onClick}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onClick(e);
				}
			}}
			{...rest}
		>
			{children}
		</div>
	);
}

/** Render text with substring matches highlighted via <mark>. */
export function HighlightedText({
	text,
	indices,
}: {
	text: string;
	indices: MatchIndices;
}) {
	const segments = highlightSegments(text, indices);
	let offset = 0;
	return (
		<>
			{segments.map((seg) => {
				const key = offset;
				offset += seg.text.length;
				return seg.highlight ? (
					<mark key={key} className="bg-nova-violet/20 text-inherit rounded-sm">
						{seg.text}
					</mark>
				) : (
					<span key={key}>{seg.text}</span>
				);
			})}
		</>
	);
}
```

- [ ] **Step 2: Update `components/builder/AppTree.tsx`** — delete the local `FormIconContext` / `findMatchIndices` / `CollapseChevron` / `TreeItemRow` / `HighlightedText` definitions; import them from `./appTree/shared`.

- [ ] **Step 3: Verify** — `npm test -- --run` and `npx tsc --noEmit` clean. AppTree behavior unchanged.

- [ ] **Step 4: Commit**

```bash
git add components/builder/appTree/shared.tsx components/builder/AppTree.tsx
git commit -m "refactor(appTree): extract shared atoms (TreeItemRow, CollapseChevron, etc.)"
```

---

## Task 11: AppTree split — extract `useSearchFilter` hook

**Files:**
- Create: `components/builder/appTree/useSearchFilter.ts`
- Modify: `components/builder/AppTree.tsx`

- [ ] **Step 1: Create `components/builder/appTree/useSearchFilter.ts`** containing:
  - The `SearchResult` interface
  - The `SearchEntityData` interface
  - The `SEARCH_IDLE` sentinel
  - The `useSearchFilter` hook
  - Imports `findMatchIndices` from `./shared`

- [ ] **Step 2: Add a unit test at `components/builder/appTree/__tests__/useSearchFilter.test.tsx`**

Test the hook in isolation:
- Empty query → returns `null`
- Query matches a module name → `visibleModuleIndices` includes that index
- Query matches a question label → `visibleQuestionUuids` includes the uuid AND `forceExpand` includes the parent
- SEARCH_IDLE reference stability — two renders with empty query produce identical reference

- [ ] **Step 3: Update `AppTree.tsx`** to import the hook from `./appTree/useSearchFilter`.

- [ ] **Step 4: Run + commit**

```bash
git add components/builder/appTree/useSearchFilter.ts components/builder/appTree/__tests__/useSearchFilter.test.tsx components/builder/AppTree.tsx
git commit -m "refactor(appTree): extract useSearchFilter hook"
```

---

## Task 12: AppTree split — extract `useFieldIconMap` + `countQuestionsFromOrder`

**Files:**
- Create: `components/builder/appTree/useFieldIconMap.ts`
- Modify: `components/builder/AppTree.tsx`

- [ ] **Step 1: Create `components/builder/appTree/useFieldIconMap.ts`** with both functions. The icon lookup now reads `fieldRegistry[f.kind].icon` (Task 9 already migrated AppTree's reads).

```typescript
"use client";
import type { IconifyIcon } from "@iconify/react/offline";
import { useMemo } from "react";
import { useBlueprintDocShallow } from "@/lib/doc/hooks/useBlueprintDoc";
import type { Uuid } from "@/lib/doc/types";
import { fieldRegistry } from "@/lib/domain";
import { qpath, type QuestionPath } from "@/lib/services/questionPath";

/** Build a question-path → field-kind icon map for a form's fields. */
export function useFieldIconMap(formId: Uuid): Map<string, IconifyIcon> {
	const { fields, fieldOrder } = useBlueprintDocShallow((s) => ({
		fields: s.fields,
		fieldOrder: s.fieldOrder,
	}));

	return useMemo(() => {
		const map = new Map<string, IconifyIcon>();
		function walk(parentId: Uuid, parentPath?: QuestionPath) {
			const uuids = fieldOrder[parentId] ?? [];
			for (const uuid of uuids) {
				const f = fields[uuid];
				if (!f) continue;
				const p = qpath(f.id, parentPath);
				const meta = fieldRegistry[f.kind];
				if (meta) map.set(p, meta.icon);
				walk(uuid, p);
			}
		}
		walk(formId);
		return map;
	}, [formId, fields, fieldOrder]);
}

/** Count questions recursively from fieldOrder. Pure, primitive result. */
export function countQuestionsFromOrder(
	parentId: Uuid,
	fieldOrder: Record<Uuid, Uuid[]>,
): number {
	let count = 0;
	function walk(pid: Uuid) {
		const uuids = fieldOrder[pid] ?? [];
		count += uuids.length;
		for (const uuid of uuids) {
			walk(uuid);
		}
	}
	walk(parentId);
	return count;
}
```

- [ ] **Step 2**: Update AppTree.tsx imports.

- [ ] **Step 3: Commit**

```bash
git add components/builder/appTree/useFieldIconMap.ts components/builder/AppTree.tsx
git commit -m "refactor(appTree): extract useFieldIconMap + countQuestionsFromOrder"
```

---

## Task 13: AppTree split — extract `useAppTreeSelection` hook

**Files:**
- Create: `components/builder/appTree/useAppTreeSelection.ts`
- Test: `components/builder/appTree/__tests__/useAppTreeSelection.test.tsx`
- Modify: `components/builder/AppTree.tsx`

- [ ] **Step 1: Implement** — extract the `handleSelect` callback + `TreeSelectTarget` discriminated union + `TreeSelectHandler` type.

```typescript
/**
 * useAppTreeSelection — produces the handleSelect callback used by every
 * row component in AppTree.
 *
 * Selection navigates via the URL (useNavigate) and primes a pending
 * scroll for question selections BEFORE the URL change so the target
 * row's useFulfillPendingScroll has a request waiting when isSelected
 * flips true. Reversing the order drops the scroll.
 *
 * Returns a typed callback so the row components can stay thin — they
 * only know how to dispatch a target shape.
 */
"use client";
import { useCallback } from "react";
import { useScrollIntoView } from "@/components/builder/contexts/ScrollRegistryContext";
import type { Uuid } from "@/lib/doc/types";
import { useNavigate } from "@/lib/routing/hooks";

export type TreeSelectTarget =
	| { kind: "clear" }
	| { kind: "module"; moduleUuid: Uuid }
	| { kind: "form"; moduleUuid: Uuid; formUuid: Uuid }
	| { kind: "question"; moduleUuid: Uuid; formUuid: Uuid; questionUuid: Uuid };

export type TreeSelectHandler = (target: TreeSelectTarget) => void;

export function useAppTreeSelection(): TreeSelectHandler {
	const navigate = useNavigate();
	const { setPending } = useScrollIntoView();

	return useCallback<TreeSelectHandler>(
		(target) => {
			switch (target.kind) {
				case "clear":
					return navigate.goHome();
				case "module":
					return navigate.openModule(target.moduleUuid);
				case "form":
					return navigate.openForm(target.moduleUuid, target.formUuid);
				case "question":
					setPending(target.questionUuid, "instant", false);
					return navigate.openForm(
						target.moduleUuid,
						target.formUuid,
						target.questionUuid,
					);
			}
		},
		[navigate, setPending],
	);
}
```

- [ ] **Step 2: Test** — verify dispatch shape per target kind, verify question target sets pending scroll BEFORE calling navigate.

- [ ] **Step 3: Update AppTree.tsx** to use the hook.

- [ ] **Step 4: Commit**

```bash
git add components/builder/appTree/useAppTreeSelection.ts components/builder/appTree/__tests__/useAppTreeSelection.test.tsx components/builder/AppTree.tsx
git commit -m "refactor(appTree): extract useAppTreeSelection hook"
```

---

## Task 14: AppTree split — extract `FieldRow.tsx`

The recursive field-row component. Self-recursive (calls itself for nested groups), so the recursion stays inside this file.

**Files:**
- Create: `components/builder/appTree/FieldRow.tsx`
- Modify: `components/builder/AppTree.tsx`

- [ ] **Step 1: Move the `FieldRow` memoized component** verbatim from AppTree.tsx into `components/builder/appTree/FieldRow.tsx`. Imports come from:
  - `./shared` for `TreeItemRow`, `CollapseChevron`, `HighlightedText`, `FormIconContext`
  - `./useAppTreeSelection` for `TreeSelectHandler`
  - `./useSearchFilter` for `SearchResult`
  - `@/lib/doc/hooks/useBlueprintDoc` for the entity subscriptions
  - `@/lib/routing/hooks` for `useIsFieldSelected`
  - `@/lib/services/questionPath` for `qpath` + `QuestionPath`
  - `@/lib/references/LabelContent` for `textWithChips`
  - `@/lib/domain` for `fieldRegistry` (icon lookup) — replaces the prior `fieldKindIcons` access
  - `react` for `memo`, `use`
  - `motion/react` for `motion`

The `FieldRow` reads its kind icon from `fieldRegistry[q.kind].icon` (was `fieldKindIcons[q.kind]`). This was already done in Task 9.

- [ ] **Step 2: Re-export from AppTree.tsx** (interim) — add `import { FieldRow } from "./appTree/FieldRow";` at top of AppTree.tsx. Delete the local `FieldRow` definition.

- [ ] **Step 3: Verify** behavior unchanged — the existing AppTree integration tests still pass (if any; if not, the StructureSidebar mounts AppTree → manual smoke check).

- [ ] **Step 4: Commit**

```bash
git add components/builder/appTree/FieldRow.tsx components/builder/AppTree.tsx
git commit -m "refactor(appTree): extract FieldRow into its own file"
```

---

## Task 15: AppTree split — extract `FormCard.tsx`

**Files:**
- Create: `components/builder/appTree/FormCard.tsx`
- Modify: `components/builder/AppTree.tsx`

- [ ] **Step 1: Move the `FormCard` memoized component** into `components/builder/appTree/FormCard.tsx`. Imports include `./FieldRow` (the moved component), `./useFieldIconMap`, `./shared`, `./useAppTreeSelection`, `./useSearchFilter`.

- [ ] **Step 2: Update AppTree.tsx** — drop the local definition, import from `./appTree/FormCard`.

- [ ] **Step 3: Commit**

```bash
git add components/builder/appTree/FormCard.tsx components/builder/AppTree.tsx
git commit -m "refactor(appTree): extract FormCard into its own file"
```

---

## Task 16: AppTree split — extract `ModuleCard.tsx`

**Files:**
- Create: `components/builder/appTree/ModuleCard.tsx`
- Modify: `components/builder/AppTree.tsx`

- [ ] **Step 1**: Move the `ModuleCard` component. Imports `./FormCard`, `./shared`, `./useAppTreeSelection`, `./useSearchFilter`, plus `ConnectLogomark` from `@/components/icons/ConnectLogomark`.

- [ ] **Step 2**: Update AppTree.tsx.

- [ ] **Step 3: Commit**

```bash
git add components/builder/appTree/ModuleCard.tsx components/builder/AppTree.tsx
git commit -m "refactor(appTree): extract ModuleCard into its own file"
```

---

## Task 17: AppTree split — relocate the shell to `appTree/AppTree.tsx`

The remaining body of `AppTree.tsx` (search input + scroll container + module dispatch) is now small enough to move into the appTree directory. Delete the old `components/builder/AppTree.tsx`.

**Files:**
- Create: `components/builder/appTree/AppTree.tsx` (the shell — ~120 lines)
- Delete: `components/builder/AppTree.tsx`
- Modify: `components/builder/StructureSidebar.tsx` (import path update)

- [ ] **Step 1: Move the body** of `components/builder/AppTree.tsx` to `components/builder/appTree/AppTree.tsx`. Imports come from:
  - `./ModuleCard`
  - `./useAppTreeSelection`
  - `./useSearchFilter`
  - `./shared` (for `findMatchIndices` if used directly in the shell, though it shouldn't be)
  - `@/lib/doc/hooks/useBlueprintDoc`, `useModuleIds`
  - `@/lib/routing/hooks`
  - `@/lib/services/builder` (`BuilderPhase`)
  - `@/lib/session/hooks` (`useBuilderPhase`)

- [ ] **Step 2: Delete `components/builder/AppTree.tsx`**

```bash
git rm components/builder/AppTree.tsx
```

- [ ] **Step 3: Update `components/builder/StructureSidebar.tsx`** import path to `@/components/builder/appTree/AppTree`.

- [ ] **Step 4: Audit** for other importers via `grep -r "@/components/builder/AppTree" components/ app/`. Update all to `@/components/builder/appTree/AppTree`.

- [ ] **Step 5: Verify**

```bash
npx tsc --noEmit && npm run lint && npm test -- --run 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add components/builder/appTree/AppTree.tsx components/builder/StructureSidebar.tsx
git rm components/builder/AppTree.tsx
git commit -m "refactor(appTree): move shell into appTree/ — split complete

components/builder/AppTree.tsx (976 lines) → components/builder/appTree/
  AppTree.tsx               (~120 lines, shell)
  ModuleCard.tsx
  FormCard.tsx
  FieldRow.tsx
  useSearchFilter.ts
  useFieldIconMap.ts
  useAppTreeSelection.ts
  shared.tsx

Each file has one responsibility. The recursive FieldRow stays
self-recursive in its own file to avoid an import cycle."
```

---

## Task 18: VirtualFormList — extract `useDragIntent` hook

The drag-lifecycle effect (~280 lines) becomes its own hook. The cursor-velocity tracking goes with it (it's only used to gate insertion-point hover during drag).

**Files:**
- Create: `components/preview/form/virtual/useDragIntent.ts`
- Test: `components/preview/form/virtual/__tests__/useDragIntent.test.tsx`
- Modify: `components/preview/form/virtual/VirtualFormList.tsx`

- [ ] **Step 1: Implement the hook**

The hook owns:
- `dragActive: boolean`
- `placeholderIndex: number | null`
- `placeholderDepth: number` (ref-backed, exposed as a function)
- The `monitorForElements` registration (in `useEffect`)
- The cursor-velocity tracking (in `useEffect`) — exposes `cursorSpeedRef`, `lastCursorRef`

Signature:

```typescript
interface UseDragIntentParams {
	formUuid: Uuid;
	baseRowsRef: React.RefObject<readonly FormRow[]>;
}

interface UseDragIntentResult {
	dragActive: boolean;
	placeholderIndex: number | null;
	placeholderDepth: number;
	cursorSpeedRef: React.RefObject<number>;
	lastCursorRef: React.RefObject<{ x: number; y: number; t: number } | undefined>;
}

export function useDragIntent({
	formUuid,
	baseRowsRef,
}: UseDragIntentParams): UseDragIntentResult;
```

The `baseRowsRef` is passed in (not derived inside the hook) because the rows are computed in `VirtualFormList` from `useFormRows`, and the monitor needs the latest rows without re-registering on row changes.

The full body lifts the existing drag effect (~280 lines) verbatim from `VirtualFormList.tsx`. Internal imports come from `dragData`, `useBlueprintMutations`, `BlueprintDocContext`, `lib/routing/hooks` (`useSelect`), `lib/doc/mutations/notify` (`notifyMoveRename`).

- [ ] **Step 2: Add a test** at `components/preview/form/virtual/__tests__/useDragIntent.test.tsx`. Test goals:
  - `dragActive` starts false
  - `placeholderIndex` starts null
  - The hook can be mounted without throwing (it doesn't trigger any drag events on its own — those come from the @atlaskit monitor)

This is mostly a smoke test; the meaningful behavior is exercised via the existing `useFormRows` + `dragData` tests plus manual drag-drop smoke testing in Task 32.

- [ ] **Step 3: Update `VirtualFormList.tsx`** — replace the inline drag effect, cursor tracking effect, and the related state/refs with `const { dragActive, placeholderIndex, placeholderDepth, cursorSpeedRef, lastCursorRef } = useDragIntent({ formUuid, baseRowsRef });`. Drop the now-unused imports.

- [ ] **Step 4: Verify**

```bash
npx tsc --noEmit && npm run lint && npm test -- --run 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
git add components/preview/form/virtual/useDragIntent.ts components/preview/form/virtual/__tests__/useDragIntent.test.tsx components/preview/form/virtual/VirtualFormList.tsx
git commit -m "refactor(virtual): extract useDragIntent from VirtualFormList

VirtualFormList shrinks from 872 lines to ~600 lines (the rendering
shell). The drag lifecycle (monitorForElements + placeholder index
+ cursor velocity tracking) moves into a single hook that owns
its state and effect registrations.

The shell wires the hook's outputs into the virtualizer + drag-active
context unchanged. Behavior is byte-identical."
```

---

## Task 19: FormSettingsPanel split — extract shared `InlineField` + `LabeledXPathField` + `useConnectLintContext` + `findFieldById`

These four pieces are shared by multiple sections of FormSettingsPanel. Extract first so subsequent section files can import them.

**Files:**
- Create: `components/builder/detail/formSettings/InlineField.tsx`
- Create: `components/builder/detail/formSettings/LabeledXPathField.tsx`
- Create: `components/builder/detail/formSettings/useConnectLintContext.ts`
- Create: `components/builder/detail/formSettings/findFieldById.ts`
- Modify: `components/builder/detail/FormSettingsPanel.tsx` (interim — imports from new files)

- [ ] **Step 1: Create `findFieldById.ts`**

```typescript
/**
 * Walk the normalized doc depth-first from `parentUuid` looking for the
 * first field whose semantic `id` matches. Used by the close-condition
 * UI to reach the referenced field's option list without round-tripping
 * through any legacy assembled-questions shape.
 */
import type { Field } from "@/lib/domain";

export function findFieldById(
	fields: Readonly<Record<string, Field>>,
	fieldOrder: Readonly<Record<string, readonly string[]>>,
	parentUuid: string,
	id: string,
): Field | undefined {
	const childUuids = fieldOrder[parentUuid] ?? [];
	for (const uuid of childUuids) {
		const field = fields[uuid];
		if (!field) continue;
		if (field.id === id) return field;
		if (field.kind === "group" || field.kind === "repeat") {
			const found = findFieldById(fields, fieldOrder, uuid, id);
			if (found) return found;
		}
	}
	return undefined;
}
```

- [ ] **Step 2: Create `useConnectLintContext.ts`** — body is the existing `useConnectLintContext` callback hook copied verbatim from FormSettingsPanel.

- [ ] **Step 3: Create `InlineField.tsx`** — body is the existing `InlineField` component copied verbatim. The internal `useCommitField` import path stays at `@/hooks/useCommitField`.

- [ ] **Step 4: Create `LabeledXPathField.tsx`** — body is the existing `LabeledXPathField` component copied verbatim.

- [ ] **Step 5: Update FormSettingsPanel.tsx** — delete the local function/component definitions; import them from the new files.

- [ ] **Step 6: Verify**

```bash
npx tsc --noEmit && npm test -- --run 2>&1 | tail -5
```

- [ ] **Step 7: Commit**

```bash
git add components/builder/detail/formSettings/ components/builder/detail/FormSettingsPanel.tsx
git commit -m "refactor(formSettings): extract InlineField, LabeledXPathField, lint context, findFieldById"
```

---

## Task 20: FormSettingsPanel split — extract `CloseConditionSection.tsx`

**Files:**
- Create: `components/builder/detail/formSettings/CloseConditionSection.tsx`
- Modify: `components/builder/detail/FormSettingsPanel.tsx`

- [ ] **Step 1: Move the entire `CloseConditionSection` function** (and the `CloseMode` type + `CLOSE_MODE_OPTIONS` array if local to it) into the new file.

Imports come from:
- `@base-ui/react/menu` for Menu primitives
- `motion/react` for AnimatePresence/motion
- `@/components/ui/FieldPicker` for the field selector
- `@/lib/doc/hooks/useBlueprintDoc`, `useBlueprintDocShallow` (for shallow `{ fields, fieldOrder }`)
- `@/lib/doc/hooks/useBlueprintMutations`
- `@/lib/doc/hooks/useEntity` for `useForm`
- `@/lib/doc/types` for `asUuid`, `Uuid`
- `@/lib/styles` for menu CSS classes
- `./InlineField`
- `./findFieldById`

The shape `interface FormSettingsPanelProps { moduleUuid: Uuid; formUuid: Uuid; }` is shared — define it locally in this file (the panel shell doesn't need an exported version).

- [ ] **Step 2: Update FormSettingsPanel.tsx** to import and mount the section.

- [ ] **Step 3: Verify + commit**

```bash
git add components/builder/detail/formSettings/CloseConditionSection.tsx components/builder/detail/FormSettingsPanel.tsx
git commit -m "refactor(formSettings): extract CloseConditionSection"
```

---

## Task 21: FormSettingsPanel split — extract `AfterSubmitSection.tsx`

**Files:**
- Create: `components/builder/detail/formSettings/AfterSubmitSection.tsx`
- Modify: `components/builder/detail/FormSettingsPanel.tsx`

- [ ] **Step 1: Move** `AfterSubmitSection` + its `AFTER_SUBMIT_OPTIONS` constant + the `resolveUserFacing` helper into the new file.

- [ ] **Step 2: Update FormSettingsPanel.tsx**.

- [ ] **Step 3: Commit**

```bash
git add components/builder/detail/formSettings/AfterSubmitSection.tsx components/builder/detail/FormSettingsPanel.tsx
git commit -m "refactor(formSettings): extract AfterSubmitSection"
```

---

## Task 22: FormSettingsPanel split — extract `LearnConfig.tsx`

**Files:**
- Create: `components/builder/detail/formSettings/LearnConfig.tsx`
- Modify: `components/builder/detail/FormSettingsPanel.tsx`

- [ ] **Step 1: Move** the `LearnConfig` component + the shared `ConnectSubConfigProps` interface (declare locally in this file or in a shared `types.ts`; declaring locally is fine since DeliverConfig will redeclare in its own file).

Imports:
- `motion/react`
- `@/components/ui/Toggle`
- `@/lib/doc/hooks/useBlueprintMutations`, `useEntity`
- `@/lib/doc/types` for `Uuid`
- `@/lib/domain` for `ConnectConfig`
- `@/lib/services/commcare/validate` for `toSnakeId`
- `./InlineField`
- `./LabeledXPathField`
- `./useConnectLintContext`

- [ ] **Step 2: Update FormSettingsPanel.tsx**.

- [ ] **Step 3: Commit**

```bash
git add components/builder/detail/formSettings/LearnConfig.tsx components/builder/detail/FormSettingsPanel.tsx
git commit -m "refactor(formSettings): extract LearnConfig"
```

---

## Task 23: FormSettingsPanel split — extract `DeliverConfig.tsx`

**Files:**
- Create: `components/builder/detail/formSettings/DeliverConfig.tsx`
- Modify: `components/builder/detail/FormSettingsPanel.tsx`

- [ ] **Step 1: Move** the `DeliverConfig` component into the new file. Same import pattern as LearnConfig.

- [ ] **Step 2: Update FormSettingsPanel.tsx**.

- [ ] **Step 3: Commit**

```bash
git add components/builder/detail/formSettings/DeliverConfig.tsx components/builder/detail/FormSettingsPanel.tsx
git commit -m "refactor(formSettings): extract DeliverConfig"
```

---

## Task 24: FormSettingsPanel split — extract `ConnectSection.tsx` + `FormSettingsButton.tsx`

**Files:**
- Create: `components/builder/detail/formSettings/ConnectSection.tsx`
- Create: `components/builder/detail/formSettings/FormSettingsButton.tsx`
- Modify: `components/builder/detail/FormSettingsPanel.tsx`

- [ ] **Step 1: Move** `ConnectSection` into its own file. Imports `./LearnConfig`, `./DeliverConfig`.

- [ ] **Step 2: Move** `FormSettingsButton` (the Popover trigger) into its own file. The button mounts the panel inside a Popover.

- [ ] **Step 3: Update FormSettingsPanel.tsx** — drop the local definitions; only the panel shell remains.

The shell now contains ONLY:
- The `FormSettingsPanel` component itself (~50 lines): drawer chrome + `<CloseConditionSection /> <AfterSubmitSection /> <ConnectSection />`
- (Move it next per Task 25.)

- [ ] **Step 4: Verify + commit**

```bash
git add components/builder/detail/formSettings/ConnectSection.tsx components/builder/detail/formSettings/FormSettingsButton.tsx components/builder/detail/FormSettingsPanel.tsx
git commit -m "refactor(formSettings): extract ConnectSection + FormSettingsButton"
```

---

## Task 25: FormSettingsPanel split — relocate the shell to `formSettings/FormSettingsPanel.tsx`

The remaining `FormSettingsPanel` body moves into the new directory; the old root file is deleted.

**Files:**
- Create: `components/builder/detail/formSettings/FormSettingsPanel.tsx`
- Delete: `components/builder/detail/FormSettingsPanel.tsx`
- Modify: every importer of `FormSettingsButton` or `FormSettingsPanel` from the old path

- [ ] **Step 1: Move** the shell body (FormSettingsPanel inner function) into `components/builder/detail/formSettings/FormSettingsPanel.tsx`. The exports become `export { FormSettingsPanel }` from this new file. The button is already in its own file.

- [ ] **Step 2: Delete the old `components/builder/detail/FormSettingsPanel.tsx`**.

- [ ] **Step 3: Audit importers** — `grep -rn "@/components/builder/detail/FormSettingsPanel" components/ app/`. Update each to import from `@/components/builder/detail/formSettings/FormSettingsButton` (most consumers want the button, not the panel directly).

Known importers (verify on the day):
- `components/preview/screens/FormScreen.tsx`
- (Possibly) `components/builder/detail/FormDetail.tsx`

- [ ] **Step 4: Verify**

```bash
npx tsc --noEmit && npm run lint && npm test -- --run 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
git add components/builder/detail/formSettings/FormSettingsPanel.tsx components/preview/screens/FormScreen.tsx
git rm components/builder/detail/FormSettingsPanel.tsx
git commit -m "refactor(formSettings): move shell into formSettings/ — split complete

components/builder/detail/FormSettingsPanel.tsx (1360 lines)
→ components/builder/detail/formSettings/
    FormSettingsPanel.tsx       (~80 lines, shell)
    FormSettingsButton.tsx      (popover trigger)
    CloseConditionSection.tsx
    AfterSubmitSection.tsx
    ConnectSection.tsx
    LearnConfig.tsx
    DeliverConfig.tsx
    InlineField.tsx
    LabeledXPathField.tsx
    useConnectLintContext.ts
    findFieldById.ts

Behavior is byte-identical. Each file owns one concern."
```

---

## Task 26: Update CLAUDE.md docs

Update the two CLAUDE.md files whose contents reference the old editor surface.

**Files:**
- Modify: `CLAUDE.md` (root) — "Builder state" section
- Modify: `components/builder/CLAUDE.md` — full editor section rewrite

- [ ] **Step 1: Edit root `CLAUDE.md`**

In the "Builder state" sub-section under "Conventions", replace the existing paragraph (or add if not present) with a callout that the field editor is registry-driven:

> **Field editor surface.** Each `lib/domain/fields/<kind>.ts` exports a `FieldEditorSchema` listing its Data / Logic / UI entries. `FieldEditorPanel` (in `components/builder/editor/`) consumes them — no per-kind switching anywhere in the panel. To add a new field property, add a new entry to the kind's schema. To add a new field kind, create a new file in `lib/domain/fields/` plus one row in the `fieldKinds` tuple.

- [ ] **Step 2: Edit `components/builder/CLAUDE.md`**

Read the current file (`Read components/builder/CLAUDE.md`), identify the section discussing `ContextualEditor*` / `InlineSettingsPanel` / `FormSettingsPanel` / `AppTree`, and replace with:

```markdown
## Editor

Field editing is registry-driven. The hierarchy:

- `InlineSettingsPanel` — the violet glass drawer mounted under a selected
  row. Renders chrome only (the focus-handler delegate that tracks active
  fields for undo/redo). Composes `<FieldHeader>` + `<FieldEditorPanel>`.
- `FieldHeader` (in `editor/`) — id input, type-icon adornment, kebab menu
  (move/duplicate/convert/delete), trash button. Reads
  `fieldRegistry[kind]` for icon/label/convertTargets.
- `FieldEditorPanel` (in `editor/`) — composes three `FieldEditorSection`s
  (Data / Logic / Appearance). Hides empty sections.
- `FieldEditorSection` (in `editor/`) — partitions schema entries into
  visible (rendered via their component) vs addable-but-hidden (rendered as
  Add Property pills). Owns activation state via `useEntryActivation`.
- Per-key editor components in `editor/fields/` — each one knows how to
  edit a single field key (XPathEditor, RequiredEditor, TextEditor,
  CasePropertyEditor, OptionsEditor).

The schemas themselves live in `lib/domain/fields/<kind>.ts`. Adding a new
property to a kind = adding one entry to its schema. Adding a new kind = a
new file in `lib/domain/fields/` (the existing kinds are templates).

## App tree

`components/builder/appTree/` holds the structure sidebar:

- `AppTree.tsx` — shell (search input, scroll container, top-level dispatch
  over `moduleOrder`).
- `ModuleCard.tsx` / `FormCard.tsx` / `FieldRow.tsx` — three memoized row
  components, one per entity level. Each subscribes to its own entity in
  the doc store; Immer structural sharing means an edit to one field
  re-renders only its `FieldRow`.
- `useSearchFilter.ts` — entity-map-based search filter. SEARCH_IDLE
  sentinel keeps the subscription stable when the user isn't searching.
- `useFieldIconMap.ts` — per-form `{ path → icon }` for chip rendering.
- `useAppTreeSelection.ts` — produces the `handleSelect` callback used by
  every row component. Question selection primes a pending scroll BEFORE
  navigating so the target row's `useFulfillPendingScroll` has a request
  waiting when `isSelected` flips true.
- `shared.tsx` — small shared atoms (`TreeItemRow`, `CollapseChevron`,
  `HighlightedText`, `FormIconContext`, `findMatchIndices`).

## Form settings

`components/builder/detail/formSettings/` is the popover panel mounted from
the form header:

- `FormSettingsButton.tsx` — popover trigger (the public mount point).
- `FormSettingsPanel.tsx` — drawer chrome + section list (~80 lines).
- `CloseConditionSection.tsx` / `AfterSubmitSection.tsx` /
  `ConnectSection.tsx` — three top-level features.
- `LearnConfig.tsx` / `DeliverConfig.tsx` — two connect-mode sub-configs.
- `InlineField.tsx` / `LabeledXPathField.tsx` — shared compact widgets.
- `useConnectLintContext.ts` — XPath lint context for the form.
- `findFieldById.ts` — depth-first lookup by semantic id.

## Virtual form list

`VirtualFormList.tsx` (in `components/preview/form/virtual/`) is the
edit-mode form renderer. The drag-lifecycle effect (drag state +
`monitorForElements` registration + cursor-velocity tracking) lives in
`useDragIntent.ts`. The shell handles virtualization, row dispatch, and
the question-picker menu.
```

- [ ] **Step 3: Verify** the docs read coherently next to the rest of the existing CLAUDE.md.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md components/builder/CLAUDE.md
git commit -m "docs: describe Phase 5 editor + appTree + formSettings architecture"
```

---

## Task 27: Final cleanup pass

Audit for residue from Phase 5 work — leftover unused imports, dead exports, stale comments, outdated tests.

- [ ] **Step 1: Find unused exports**

```bash
# Run knip if available, otherwise search manually:
grep -rn "export " components/builder/editor/ components/builder/appTree/ components/builder/detail/formSettings/ \
  | awk -F: '{print $1, $2}' | head -50
```

For each export, check for at least one importer. Delete unused exports.

- [ ] **Step 2: Find leftover stub imports**

```bash
grep -rn "StubField\|ContextualEditor\|RequiredSection\|CasePropertyDropdown\|fieldKindIcons\|fieldKindLabels" \
  components/ app/ lib/ --include="*.ts" --include="*.tsx"
```

Expected: no matches. If any, delete the file or update the import.

- [ ] **Step 3: Find leftover empty directories**

```bash
find components/builder/contextual -type d 2>&1
```

Expected: no such directory. If still present, `rmdir` it.

- [ ] **Step 4: Look for `as any` introduced during the work**

```bash
git diff main..HEAD --stat | grep -v test | head -10
git diff main..HEAD -- components/ lib/ | grep -E "^\+.*\bany\b" | head
```

Verify each `as any` is justified by a `biome-ignore` comment. The plan permits exactly one such cast in `FieldEditorPanel` (the schema-narrowing cast). Any others must either be removed or get explicit justification comments.

- [ ] **Step 5: Look for `// TODO: Phase 6` comments**

```bash
grep -rn "TODO.*Phase\|FIXME.*Phase" components/ app/ lib/
```

Expected: zero matches.

- [ ] **Step 6: Commit cleanups (if any)**

```bash
git add -A
git commit -m "chore: phase 5 cleanup pass (unused exports, dead imports, stub residue)"
```

---

## Task 28: Final verification

Run the full test, lint, build, type-check pipeline and verify the manual smoke list from the spec.

- [ ] **Step 1: Lint**

```bash
npm run lint 2>&1 | tail -5
```

Expected: `Checked N files. No fixes applied.` — zero warnings, zero errors.

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit && echo "✓ tsc clean"
```

Expected: `✓ tsc clean`.

- [ ] **Step 3: Tests**

```bash
npm test -- --run 2>&1 | tail -15
```

Expected: every test passes. Total count should be ≥ 1316 (baseline) plus any new tests added in tasks 1–7. No skipped/todo tests.

- [ ] **Step 4: Build**

```bash
npm run build 2>&1 | tail -20
```

Expected: production build succeeds. Bundle size should NOT increase materially (the new editor stack replaces a same-shaped legacy stack; net code change is removal-leaning).

- [ ] **Step 5: Manual smoke (in browser via `npm run dev`)**

For each of these, perform the action and visually confirm correct behavior. Report any unexpected behavior; do NOT mark "done" if anything regresses.

- [ ] Open an existing app. Confirm the structure sidebar (AppTree) renders modules / forms / fields.
- [ ] Type in the search input — confirm matching modules / forms / fields filter and parents auto-expand.
- [ ] Click a field. Confirm the InlineSettingsPanel mounts beneath it with FieldHeader + Data/Logic/Appearance sections matching the field's kind.
- [ ] Edit the field's `id` — confirm the input commits on blur, sibling-conflict detection still shakes + popovers.
- [ ] Add a Hint via the Add Property pill — confirm the editor activates with autoFocus, type a value, blur to save, refresh — value persists.
- [ ] Toggle Required → confirm `"true()"` is set; click Add Condition → confirm XPath editor opens; type a condition, save → confirm required becomes the XPath.
- [ ] On a single_select field: edit options. Confirm OptionsEditor accepts new options; saving updates the field.
- [ ] Open the Convert Type submenu on a Text field — confirm Secret is shown (the only convertTarget for text). Convert; confirm field becomes Secret and its editor schema swaps.
- [ ] Open the Convert Type submenu on a Group field — confirm Repeat is shown. Convert; confirm children are preserved.
- [ ] Try to convert a Hidden field — confirm the submenu is disabled (empty convertTargets).
- [ ] Open a close form's settings popover — confirm Close Condition / After Submit / Connect sections appear and behave identically to before.
- [ ] Toggle Connect on/off and modify learn / deliver sub-configs. Confirm save semantics unchanged.
- [ ] Drag a field across group boundaries; into an empty group; past top/bottom. Confirm placeholder behavior and final positioning unchanged.
- [ ] Scroll a 200+ field form. Confirm 60fps still and selected-row pinning still works.
- [ ] Switch cursor mode (edit ↔ pointer). Confirm the editor panel hides in pointer mode.
- [ ] Undo a series of edits — confirm focus restoration scrolls to the right field + opens the right editor.
- [ ] Hard reload — confirm the URL still resolves to the same field selection + editor opens.

- [ ] **Step 6: Commit verification (if any cleanups landed)**

If steps 1–5 surface any regression, fix in a fresh commit; do not amend prior commits. After everything is green:

```bash
git status  # expect: working tree clean
git log --oneline main..HEAD | wc -l  # expect: ~28-32 commits
```

- [ ] **Step 7: Open PR**

```bash
git push -u origin refactor/phase-5-declarative-editor-and-splits
gh pr create --title "Phase 5: declarative editor + component splits" --body "$(cat <<'EOF'
## Summary

- Replace ContextualEditor* with registry-driven FieldEditorPanel + FieldHeader.
- Replace stub editor components with real ones (XPath, Required, Text, CaseProperty, Options).
- Move icon / label metadata into fieldRegistry (delete fieldKindIcons / fieldKindLabels).
- Split AppTree (976 lines → ~120-line shell + 7 split files).
- Split FormSettingsPanel (1360 lines → ~80-line shell + 10 split files).
- Extract useDragIntent from VirtualFormList (872 → ~600 lines).

## Test plan

- [ ] All 1316+ tests pass
- [ ] tsc clean
- [ ] lint clean (no warnings)
- [ ] build clean
- [ ] Manual smoke list from the plan (selection, edits, undo, drag, search, convert, connect)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

After writing this plan, run through it once more with these checks:

**1. Spec coverage.** Walk each line of the spec's §9 (UI architecture), §11 (what goes away), and the spec's success criteria #8 (god-component line caps). Every spec requirement maps to a task:
- §9 declarative editor → Tasks 1–9
- §9 component splits (FormSettingsPanel, AppTree, VirtualFormList) → Tasks 10–25 + Task 18
- §11 contextual deletions → Task 8
- §11 fieldTypeIcons deletion → Task 9
- Success #8 (FormSettingsPanel ≤ 200 lines, AppTree ≤ 400 lines, VirtualFormList drag in separate hook file) → Tasks 17, 18, 25

**2. Placeholder scan.** No `TBD`, no `// TODO`, no "implement later." Every code block contains the actual code an engineer needs.

**3. Type consistency.** Verify name consistency across tasks:
- `FieldEditorComponentProps`: introduced in Task 1, consumed by Tasks 3b/3c/3d/3e/3f, dispatched in Task 5. All use the same prop set: `field`, `value`, `onChange`, `label`, `keyName`, `autoFocus?`.
- `useEntryActivation`: defined Task 4, consumed Task 5. Returns `{ pending, activate, clear }`.
- `TreeSelectTarget` / `TreeSelectHandler`: defined Task 13, consumed Tasks 14/15/16/17.
- `useDragIntent` returns `{ dragActive, placeholderIndex, placeholderDepth, cursorSpeedRef, lastCursorRef }`. Consumer in Task 18 destructures all five.

**4. Order check.** Each task only depends on tasks before it:
- Task 3 depends on Task 1 (types) and Task 2 (icon metadata). ✓
- Task 5 depends on Task 4 (activation hook) + Task 1 (types). ✓
- Task 6 depends on Task 5 (section component) + Task 3 (real editor entries). ✓
- Task 8 depends on Tasks 6 + 7 (panel + header). ✓
- Task 9 depends on Task 2 (registry has icon/label metadata).
- Tasks 14–17 depend on Tasks 10–13 (extracted shared atoms + hooks before row components). ✓
- Tasks 20–25 depend on Task 19 (shared atoms first). ✓
- Task 18 (useDragIntent) is independent — can run anywhere after baseline. Placed after AppTree split for natural ordering.

**5. Commit hygiene.** Every task ends with `git add` + `git commit`. No task leaves the working tree dirty across a task boundary.

**6. Test coverage.** Every new component or hook gets a test: Tasks 1, 3b, 3c, 3d, 3e, 3f, 4, 5, 6, 7, 11, 13, 18 each add a test file. The remaining tasks are mechanical moves of already-tested code (no new tests needed; existing tests verify behavior preservation).

**7. Bridge-smell scan.** No re-export shims, no `TODO Phase 6` comments, no parallel maps after Task 9, no `if (field.kind === ...)` in panel/header.

If issues found in self-review, fix inline. Don't re-review afterwards — fix and move on.

---

## Execution Handoff

Plan complete. Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch one fresh subagent per task; review between tasks (spec compliance + code quality). Catches drift early, preserves controller context.

**2. Inline Execution** — Execute tasks in this session via `superpowers:executing-plans`. Batches with checkpoints.

Recommendation: **Subagent-Driven**. Phase 5 has 28 tasks; subagent isolation keeps each scope tight and review pressure honest.

