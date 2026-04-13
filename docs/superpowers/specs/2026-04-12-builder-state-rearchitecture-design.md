# Builder State Re-architecture — Design Spec

**Date:** 2026-04-12
**Status:** Approved for planning
**Scope:** Full refactor of the builder state layer — stores, navigation, selection, generation, and form rendering.

---

## Problem

The current builder coordinates state across four overlapping layers: a single Zustand store that mixes the blueprint document with navigation/selection/UI state, a `BuilderEngine` imperative class of ~1000 lines that orchestrates anything React can't express reactively, a `generationData` bag with precedence rules, and a pair of selector styles (`select*` vs `derive*`) that are easy to confuse.

Every pain point traces back to these layers overlapping:

- **`sidebarStash`** exists because mode switches need atomic multi-field updates — a reducer-shaped problem solved with a setter-shaped tool.
- **`generationData.{scaffold, partialScaffold, partialModules}`** is a state machine encoded as three optional fields with precedence rules.
- **`Engine.undo()`** orchestrates "did the selected question get deleted and reorient" because selection and document are independent fields.
- **`select*` vs `derive*`** split exists because some selectors are `Object.is`-safe and some crash into an infinite loop — one API split in two to work around `useSyncExternalStore`'s identity check.
- **`BuilderSubheader` reads 5 slices** because nav + undo + breadcrumb state live in three different places (main store, temporal store, derived fn).
- **Drag state computed imperatively** on every `dragStart` because a reactive subscription would explode — the compromise is "build it manually."

The thread tying all of this together: **selection and navigation are stored, not derived.** That forces the `BuilderEngine` class into existence to keep them consistent with the document and with each other.

A React DevTools profile confirms the performance cost. A single form-open commit (frame 5 in the referenced trace) mounts **352 components in 59.5ms** — a recursive `FormRenderer` mounting an entire form tree at once, followed by a full settle pass in frame 6 (10.9ms across 243 components with `hooks=[6] | hooksChanged`). Memoization has already been squeezed; what remains is structural.

## Goals

1. **Make the blueprint the domain.** State shape follows the domain, not the components that read it. Every mutation path looks the same whether the user or the agent made it.
2. **Make navigation and selection derived.** The URL is the source of truth for "where you are" and "what's focused." Nothing in a store represents them.
3. **Dissolve `BuilderEngine`** into domain-specific React hooks and scoped contexts. No imperative coordinator class.
4. **One subscription API.** No `select*` vs `derive*` split. Components never pass a function to `useStore`; they import a named hook.
5. **Virtualize the form editor.** Frame 5's 59ms mount storm drops below 10ms by rendering only what's visible.
6. **Deliver deep-link support as a side effect.** Every screen and selection bookmarkable, shareable, Cmd+click-able.

## Non-goals

- Changing the agent (Solutions Architect) prompts, tools, or event shapes. Event translation happens in a new client-side mapper; the route handler is unchanged.
- Replacing Zustand, Immer, zundo, or `@dnd-kit/react`. Current library choices stay.
- Changing the interactive (pointer-mode) form preview. Virtualization applies to edit mode only.
- Redesigning the Firestore persistence schema. The blueprint-on-disk shape is unchanged.

## Architecture overview

```
┌─────────────────────────────────────────────────────────────────┐
│  URL  (/build/[id]?s=…&m=…&f=…&sel=…)                          │
│  source of truth for WHERE YOU ARE + WHAT'S FOCUSED             │
└─────────────────────────────────────────────────────────────────┘
          │
          ▼  useLocation() — derived from useSearchParams(), pure
┌─────────────────────────────────────────────────────────────────┐
│  BlueprintDoc  (Zustand + Immer + zundo + subscribeWithSelector)│
│  source of truth for THE DOMAIN                                 │
│  · modules / forms / questions (normalized, UUID-keyed)         │
│  · ordering maps                                                │
│  · appId, appName, connectType, caseTypes                       │
│  · mutations: addQuestion, moveQuestion, renameQuestion, …      │
│  · zundo tracks THIS STORE ENTIRELY (no partialize)             │
└─────────────────────────────────────────────────────────────────┘
          │
          ▼  domain hooks: useQuestion(uuid), useOrderedChildren(parentId)
┌─────────────────────────────────────────────────────────────────┐
│  BuilderSession  (Zustand, no Immer, no zundo)                  │
│  source of truth for EPHEMERAL UI                               │
│  · cursorMode, sidebar open/stash, activeFieldId                │
│  · phase, agentActive, agentStage, agentError                   │
└─────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────┐
│  Scoped contexts (not stores — React context, local lifetime)   │
│  · EditGuardContext  — register "canLeave" predicate            │
│  · DragStateContext  — scoped to <DragDropProvider>             │
│  · ScrollRegistryContext — refs to scroll containers            │
│  · SignalGridContext — rAF energy ticking                       │
└─────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────┐
│  VirtualFormList  (flattened tree + @tanstack/react-virtual)    │
│  · only visible rows mounted                                    │
│  · dnd-kit integrated with overscan + autoscroll                │
└─────────────────────────────────────────────────────────────────┘
```

**Three invariants the new architecture enforces structurally:**

1. **One domain store, one URL, one session store.** Not four overlapping layers.
2. **Selection and screen never desync from the document**, because they're derived. If `router.push` targets a uuid that was just deleted, `useSelectedQuestion()` returns `null` and a tiny root effect strips the stale param. There is nothing to "sync."
3. **Mutations are the only way state changes.** User edits, agent generation, and replay all call the same mutation API. No side channels.

### What goes away

- `BuilderEngine` class (~1000 lines)
- `navEntries`, `navCursor`, `screen`, `selected` fields in the store
- `generationData.{scaffold, partialScaffold, partialModules}` bag
- `replayStages`, `replayDoneIndex`, `replayExitPath`
- `ReplayController` (if a standalone class exists)
- `sidebarStash` as a free-floating field
- `select*` vs `derive*` API split
- `zundo.partialize` allow-list

---

## Detailed design

### 1. BlueprintDoc (the domain store)

The document store holds only the blueprint.

```ts
type BlueprintDoc = {
  appId: string;
  appName: string;
  connectType: ConnectType;
  caseTypes: CaseType[];

  // Normalized entity maps — UUID-keyed
  modules: Record<Uuid, ModuleEntity>;
  forms: Record<Uuid, FormEntity>;
  questions: Record<Uuid, QuestionEntity>;

  // Ordering (parent UUID → ordered child UUIDs)
  moduleOrder: Uuid[];
  formOrder: Record<Uuid /* moduleUuid */, Uuid[]>;
  questionOrder: Record<Uuid /* formUuid or groupUuid */, Uuid[]>;
};
```

Every entity is UUID-keyed. `ModuleEntity.id`, `FormEntity.id`, `QuestionEntity.id` hold the CommCare slug (mutable). No `mIdx`/`fIdx` anywhere in the store — indices become a view concern, computed from order arrays when absolutely necessary.

**Middleware:** `immer` + `subscribeWithSelector` + `temporal` (zundo) + `devtools`. **No `partialize`** — the whole doc is undoable. UI state isn't here, so there's nothing to exclude.

**Mutation API** — a flat, typed action surface. Every mutation takes UUID(s), not paths or indices:

```ts
// Structural
addModule, removeModule, moveModule, renameModule, updateModule
addForm, removeForm, moveForm, renameForm, updateForm, replaceForm
addQuestion, removeQuestion, moveQuestion, renameQuestion,
  duplicateQuestion, updateQuestion

// App-level
setAppName, setConnectType, setCaseTypes

// Bulk
applyMutations(muts: Mutation[])    // batched; one Immer pass, one undo entry
loadBlueprint(blueprint: Blueprint) // replaces doc; does NOT create an undo entry
```

**Undo tracking** is paused by default on creation. `loadBlueprint()` populates, then resumes tracking. Agent writes pause on `beginAgentWrite()`, resume on `endAgentWrite()`. This is the only gating mechanism — no `partialize` needed.

**Consumers never read `store.questions` directly.** Domain hooks (`useQuestion`, `useOrderedChildren`, `useForm`, `useModuleIds`) are the only public surface. This is enforced by a Biome `noRestrictedImports` rule.

### 2. BuilderSession (the ephemeral store)

Everything that lives only while the builder is mounted and is never undoable.

```ts
type BuilderSession = {
  phase: BuilderPhase;               // Idle | Loading | Ready | Completed
  agentActive: boolean;
  agentStage?: GenerationStage;
  agentError?: GenerationError;
  postBuildEdit: boolean;

  cursorMode: CursorMode;            // 'edit' | 'pointer'
  activeFieldId?: Uuid;

  sidebars: {
    chat: { open: boolean; stashed: boolean };
    structure: { open: boolean; stashed: boolean };
  };

  // Ephemeral connect-mode stash — preserved across learn↔deliver toggles
  // within a session, lost on reload (same as today's BuilderEngine field).
  connectStash: Partial<Record<ConnectType, Record<Uuid, FormConnect>>>;
  lastConnectType?: ConnectType;
};
```

**Middleware:** just `subscribeWithSelector` + `devtools`. No Immer (shape is flat), no zundo (nothing undoable).

**Reducer-shaped actions, not field-wise setters.** `switchCursorMode(next)` atomically stashes sidebar visibility on entering edit mode and restores it on exit — one `set()` call, all fields updated together. No more `sidebarStash` as a free-floating field.

`beginAgentWrite(stage?)`, `endAgentWrite()`, `failAgentWrite(err)` also toggle BlueprintDoc's zundo pause/resume. These two stores coordinate only here.

**Hook API:** `useCursorMode()`, `useEditMode()`, `usePhase()`, `useIsReady()`, `useSidebarState(kind)`, `useAgentStatus()`.

### 3. URL-driven navigation + selection

The URL carries the entire "where are you + what's focused" tuple. No store state represents the current screen or selection.

**Schema** — query params on the single `/build/[id]` route:

```
/build/[id]                                   → home
/build/[id]?s=m&m=<uuid>                      → module
/build/[id]?s=cases&m=<uuid>                  → case list
/build/[id]?s=cases&m=<uuid>&case=<caseId>    → case detail
/build/[id]?s=f&m=<uuid>&f=<uuid>             → form
/build/[id]?s=f&m=<uuid>&f=<uuid>&sel=<uuid>  → form with selected question
```

UUIDs in the URL, not indices — stable across renames and reordering. Not pretty, but this is a builder, not a marketing page.

**Parsing is one pure function** in `lib/routing/location.ts`:

```ts
type Location =
  | { kind: 'home' }
  | { kind: 'module';   moduleUuid: Uuid }
  | { kind: 'cases';    moduleUuid: Uuid; caseId?: string }
  | { kind: 'form';     moduleUuid: Uuid; formUuid: Uuid; selectedUuid?: Uuid };

function parseLocation(searchParams: ReadonlyURLSearchParams): Location
function serializeLocation(loc: Location): URLSearchParams
function isValidLocation(loc: Location, doc: BlueprintDoc): boolean
```

`isValidLocation` checks every UUID in the location actually exists. If the URL references a deleted entity, the hook that reads it returns `null`, and a tiny root effect calls `router.replace()` to strip the stale param.

**Consumer hooks:** `useLocation()`, `useSelectedQuestion()`, `useSelectedFormContext()`, `useBreadcrumbs()`, `useNavigate()`, `useSelect()`.

**Transition strategy:**

- **Screen changes** (home ↔ module ↔ form): `router.push` with `scroll: false`. Next.js App Router updates `searchParams` without unmounting the `/build/[id]` layout — `<Activity>` continues to preserve old screen trees.
- **Selection changes** (`?sel=` flips): `router.replace` — no history entry per click. Browsing back doesn't rewind through every question you clicked.
- **Deletion recovery**: `router.replace` strips the invalid `sel=`.

**Back/forward buttons:** free. Browser history is the nav history. `navEntries`/`navCursor` delete themselves from existence.

**First load:** the RSC page reads `searchParams`, validates against the fetched blueprint, and server-side redirects to a clean URL if the URL is stale. After that, all navigation is client-side.

### 4. BuilderEngine dissolution

| Current responsibility | New home |
|---|---|
| `_scrollCallback` + `_pendingScroll` + `scrollToQuestion()` | `ScrollRegistryContext` + `useScrollIntoView(uuid, opts)` hook |
| `_editGuard` | `EditGuardContext` with `useRegisterEditGuard(predicate)` |
| `_streamEnergy`, `_thinkEnergy`, rAF loop | `signalGrid` nanostore in its own file, `useSignalGridFrame()` hook |
| `_isDragging` | `DragStateContext` inside `<DragDropProvider>` |
| `_focusHint`, `_renameNotice`, `_newQuestionUuid` | Removed or inverted — rename feedback uses a toast; new-question focus is URL-driven: `moveQuestion` returns new uuid → caller pushes `?sel=<newUuid>` → effect scrolls-on-selection-change |
| `_connectStash` / `_lastConnectType` | Fields on `BuilderSession` (ephemeral, session-scoped — same lifecycle as today's class field). `switchConnectMode` is a composite action that mutates BlueprintDoc (via `updateForm`) and updates session stash atomically. |
| `_editMadeMutations` | Derived from `doc.temporal.pastStates.length` delta between `beginAgentWrite` and `endAgentWrite` |
| `undo()` / `redo()` orchestration | `useUndoRedo()` hook — calls `doc.temporal.undo()`, triggers flash via `data-attr` CSS. Selection-after-undo handled automatically: stale `?sel=` hits the deletion-recovery effect. |
| `navBackWithSync`, `navUpWithSync`, `navigateToScreen`, `navigateToSelection`, `deleteSelected` | Composite hooks in `lib/routing/builderActions.ts` |
| `select()` / `navigateTo()` with guard | `useSelect()` hook consults `EditGuardContext.canLeave()` before calling `router.replace` |

Result: `BuilderEngine` class deleted. `BuilderProvider` shrinks to a stack of independent capability providers:

```tsx
<BlueprintDocProvider doc={initialBlueprint}>
  <BuilderSessionProvider initialPhase={...}>
    <ScrollRegistryProvider>
      <EditGuardProvider>
        <SignalGridProvider>
          {children}
        </SignalGridProvider>
      </EditGuardProvider>
    </ScrollRegistryProvider>
  </BuilderSessionProvider>
</BlueprintDocProvider>
```

### 5. Selector API unification

**Rule:** components never pass a function to `useStore` directly. All data reads go through named domain hooks.

```ts
// ❌ never in component code
const order = useBlueprintDoc(s => s.moduleOrder.map(id => s.modules[id]));

// ✅ always
const modules = useOrderedModules();
```

**All memoization is internal.** Each hook owns its subscription shape and its derivation, and returns something reference-stable by construction.

Two-tier pattern inside hooks:

```ts
// TIER 1: primitive or single-entity return.
// Relies on Immer structural sharing — unchanged entities keep their reference.
export function useQuestion(uuid: Uuid): QuestionEntity | undefined {
  return useBlueprintDoc(s => s.questions[uuid]);
}

// TIER 2: computed / multi-source return.
// Shallow-selects inputs, then memoizes the derivation.
export function useOrderedChildren(parentUuid: Uuid): QuestionEntity[] {
  const { order, questions } = useBlueprintDocShallow(s => ({
    order: s.questionOrder[parentUuid],
    questions: s.questions,
  }));
  return useMemo(
    () => (order ?? []).map(uuid => questions[uuid]).filter(Boolean),
    [order, questions]
  );
}
```

**Store module exposes three hooks and nothing else:** `useBlueprintDoc`, `useBlueprintDocShallow`, `useBlueprintDocTemporal`. A Biome `noRestrictedImports` rule fails the build on any import of these from outside `lib/doc/hooks/**`.

### 6. VirtualFormList (the performance payload)

The recursive `FormRenderer` — where frame 5's 59ms mount storm lives — is replaced by a flattened row model and a single virtualizer.

**Row model:**

```ts
type FormRow =
  | { kind: 'insertion';       id: string; parentUuid: Uuid; beforeIndex: number }
  | { kind: 'question';        id: string; uuid: Uuid; depth: number }
  | { kind: 'group-open';      id: string; uuid: Uuid; depth: number; collapsed: boolean }
  | { kind: 'group-close';     id: string; uuid: Uuid; depth: number }
  | { kind: 'empty-container'; id: string; parentUuid: Uuid; depth: number };
```

`useFormRows(formUuid)` walks the doc once (memoized on doc + collapse state) and returns a flat `FormRow[]`. Depth drives indentation in CSS. Group-open/group-close rows bracket a group's children, enabling fold/unfold without special-casing in the virtualizer.

**Virtualizer config** (`@tanstack/react-virtual`):

- `count = rows.length`
- `estimateSize(index)` — questions use a per-row estimate cached by uuid, insertion points are constant 24px, group brackets are constant 40px
- `overscan: 10` — cheap insurance for fast scroll-drag and dnd drop-zone detection at the edges
- `measureElement` — real heights measured on mount, cached

`VirtualFormList` (~120 lines) owns the scroll container, the virtualizer, and the row dispatch switch. Inner components (`<QuestionRow>`, `<InsertionPointRow>`, `<GroupBracket>`, `<EmptyContainerRow>`) don't know about virtualization.

**dnd-kit integration** — three invariants:

1. **Sortable IDs are `FormRow.id` strings**, not entity UUIDs. Each row type is independently droppable; a single UUID doesn't uniquely identify a drop position.
2. **`<DragDropProvider>` wraps the scroll container.** dnd-kit reads DOM measurements of mounted sortables — off-screen items don't participate.
3. **Auto-scroll + overscan coordinate.** dnd-kit's autoscroll fires near viewport edges, advances the virtualizer, which mounts the next overscan batch, which dnd-kit sees on its next collision check.

**Freeze rows during drag.** `useFormRows` switches to a "frozen" mode on drag start; the row list is computed once and reused until drop. On drop, the freeze lifts, the mutation applies, the list recomputes once.

**Selected row pinning.** If `?sel=<uuid>` targets a row that would otherwise be virtualized out, the virtualizer's `rangeExtractor` pins its index into the mounted range. This keeps `InlineSettingsPanel` stable across scroll and preserves keyboard focus.

**InsertionPoint ownership of gaps.** Still enforced — insertion-point rows ARE the gap between questions. Each has `estimateSize(24)`. Question rows have `margin: 0`. The CLAUDE.md rule becomes structurally enforced by the row model: there's no way to accidentally add `mb-*` to a question, because the gap is a sibling row.

**Interact mode unchanged.** When `cursorMode === 'pointer'`, a separate `InteractiveFormRenderer` renders the form with answer-driven visibility, real repeat instances, etc. Virtualization applies to edit mode only — interactive preview semantics are different.

**Performance targets:**

| Scenario | Current | After |
|---|---|---|
| Opening a form with 60 questions | ~60ms first mount | ~6ms (12 visible + 10 overscan ≈ 22 mounted) |
| Selecting a question | Full form cascade | 2 affected rows re-render |
| Adding a question mid-form | Full form re-render | 1 new row mounted, adjacents transform-shift |
| Scrolling through 500 questions | — (doesn't exist yet) | ~6ms per frame at 60fps, bounded by overscan |

### 7. Generation + replay as one mutation stream

Generation becomes user-mutations produced by the SA. Every agent emission translates to the same mutation API the user calls when editing.

**Translation layer** — `lib/generation/mutationMapper.ts`:

```ts
type AgentEvent =
  | { type: 'scaffold';       modules: ScaffoldModule[] }
  | { type: 'moduleStart';    moduleUuid: Uuid }
  | { type: 'addForm';        moduleUuid: Uuid; form: FormSeed }
  | { type: 'addQuestion';    formUuid: Uuid; question: QuestionSeed; parent?: Uuid }
  | { type: 'updateQuestion'; uuid: Uuid; patch: Partial<QuestionEntity> }
  | { type: 'setCaseConfig';  formUuid: Uuid; config: CaseConfig }
  | { type: 'setConnect';     formUuid: Uuid; connect: FormConnect }
  | { type: 'error';          err: GenerationError };

function toMutations(event: AgentEvent, doc: BlueprintDoc): Mutation[];
```

`toMutations` is pure. Given the current doc state + an event, it returns the mutations to apply.

**Stream consumer** — `useAgentStream(stream)`:

```ts
sessionStore.beginAgentWrite(initialStage);
for await (const event of stream) {
  const muts = toMutations(event, doc.getState());
  doc.applyMutations(muts);
  if (event.type === 'error') {
    sessionStore.failAgentWrite(event.err);
    return;
  }
}
sessionStore.endAgentWrite();
```

`beginAgentWrite` pauses zundo tracking. `endAgentWrite` resumes and captures the entire generation as a single undo entry. Users can't mid-undo through a streaming build; one undo reverses the full generation.

**Replay is a 15-line wrapper** around the same machinery:

```ts
export async function replayEvents(
  events: AgentEvent[],
  exitAt?: number,
  delayPerEvent = 150,
  signal?: AbortSignal
): Promise<void> {
  sessionStore.beginAgentWrite('replay');
  for (let i = 0; i <= (exitAt ?? events.length - 1); i++) {
    if (signal?.aborted) break;
    doc.applyMutations(toMutations(events[i], doc.getState()));
    await sleep(delayPerEvent);
  }
  sessionStore.endAgentWrite();
}
```

`replayStages`, `replayDoneIndex`, `replayExitPath`, `ReplayController` all deleted. `inReplayMode` becomes `useAgentStatus().stage === 'replay'`.

**UI signals during generation.** The builder root reads `useAgentStatus()`:

- `active: true` — agent pill visible, signal grid animates, direct user edits blocked via `useCanEdit()`
- `stage: string` — shown in the agent status banner
- `error: GenerationError` — shown in error region, retry/abandon buttons

No component needs to distinguish "real module" from "scaffold module" — scaffold modules are real, just sparse, and fill in as events arrive. The `generationData` bag and its precedence rules are gone.

**Error mid-stream.** The doc is in whatever state it reached. `session.agentError` is set. The single undo entry is never closed, so undoing reverses the entire partial generation. This is the default; an alternative (close-on-error for partial recovery) is possible but not chosen — "undo a failed generation" almost always means "wipe this attempt."

---

## Migration strategy

Big-bang in a worktree, landed in phases. Each phase leaves the app runnable.

| # | Phase | Lands | Gate |
|---|---|---|---|
| 0 | **Scaffolding** | `lib/doc/`, `lib/session/`, `lib/routing/` directories with types + stubs. Biome `noRestrictedImports` rule defined but not yet enabled. Unit tests for `parseLocation` / `serializeLocation` / `isValidLocation`. | No behavior change. `npm test` passes. |
| 1 | **BlueprintDoc + mutation API** | New store. Full mutation surface. Domain hooks. Old and new stores coexist — old store reads forward to new doc via a temporary adapter. | Blueprint operations work through new mutations. Undo captures them. |
| 2 | **URL takes over navigation + selection** | `useLocation`, `useNavigate`, `useSelect` hooks. Components switch to URL reads. `navEntries`, `navCursor`, `screen`, `selected` deleted from old store. | Cmd+click opens a question in a new tab. Refreshing `/build/[id]?s=f&m=…` preserves state. |
| 3 | **BuilderSession + Engine dissolution** | Session store created. Capability contexts in place. `BuilderEngine` deleted. `useBuilder*` hooks replaced with domain hooks. | Edit guard blocks selection during unsaved edits. Undo flash fires. Signal grid animates. Drag works. |
| 4 | **Generation + replay as mutation stream** | `toMutations`, `useAgentStream`, pause/resume zundo. `generationData`, `ReplayController`, `replayStages` deleted. | Full generation produces the same blueprint as before. Replay plays back correctly. Mid-stream error recovery tested. |
| 5 | **VirtualFormList** | Flattened row model, `@tanstack/react-virtual`, dnd-kit integration, measured heights, selected-row pinning. Recursive `FormRenderer` replaced for edit mode. | 60fps on 200-question form. Drag across groups. Re-profile: frame 5 ≤10ms. |
| 6 | **Cleanup + lint enforcement** | Old `builderStore.ts`, `builderEngine.ts`, `builderSelectors.ts`, `useBuilder.tsx` deleted. `noRestrictedImports` enabled. `CLAUDE.md` updated. | `npm run lint` clean. `npm run build` clean. `npx tsc --noEmit` clean. |

### Adapter strategy (Phases 1–2)

Phases 1 and 2 need the old store to keep producing legacy data for components not yet migrated. A one-way `syncOldFromDoc()` effect in the provider bridges the two: every doc change writes a diff into the old store's shape. The old store becomes a read-only mirror of the doc during this window. Phase 3 deletes the adapter when the last consumer is gone.

This is the only point in the migration where two state models coexist. The adapter is ~50 lines in one file with its own test suite that diffs old-shape vs new-shape after a sequence of mutations.

## Testing strategy

**Unit (Vitest, already in stack):**

- `parseLocation` / `serializeLocation` round-trip for every `Location` shape
- `isValidLocation` against fixture docs with deleted entities
- Every mutation: input doc + args → expected doc (snapshot tests on the doc, not on React output)
- `toMutations(event, doc)` for each event shape
- `useFormRows(doc, collapseState)` — flattening on a nested-groups fixture
- `rangeExtractor` pinning for the selected row

**Integration (Vitest + @testing-library/react):**

- Full agent stream replay: fire events, assert doc reaches expected state
- Undo across an agent write: one undo reverses the whole generation
- Edit guard: register predicate returning `false`, call `useSelect()`, selection stays
- URL validation: push a stale `sel=`, expect it to be stripped

**Manual smoke test** (at the end of each phase, before merging into `main`):

- Browser back/forward across home → module → form → question
- Cmd+click deep link opens a question directly
- Undo/redo during and after generation
- Drag a question across group boundaries; into an empty group; to top/bottom with auto-scroll
- Scroll a 200-question form at 60fps; selected question stays mounted when scrolled away
- Switch cursor mode (edit ↔ pointer) — stash/restore
- Start generation, kill the network mid-stream, verify error banner + recoverable doc
- Load an old app — backward compat of the doc load path

**Re-profile at end of Phase 5** — same interaction that produced today's trace. Targets: frame 5 ≤10ms, total render time ≤30ms (from 101ms).

## Risks

- **dnd-kit + virtualization** is the highest-risk integration. If it has sharp edges we can't design around, Phase 5 gets its own spike before committing. Worst case the recursive `FormRenderer` stays and every other improvement still ships. The architecture doesn't depend on virtualization; virtualization depends on the architecture.
- **Adapter sync (Phase 1–2)** is the only place two state models run simultaneously. Mitigation: ~50 lines in one file, dedicated test suite diffing old vs new shape after mutations.

## Blast radius estimate

- **New:** ~20 files (stores, hooks, contexts, routing, mutation mapper, virtual list)
- **Modified:** every file under `components/preview/**`, `components/builder/**`, `components/chat/**`, `app/build/[id]/**`
- **Deleted:** `lib/services/builderStore.ts`, `lib/services/builderEngine.ts`, `lib/services/builderSelectors.ts`, `hooks/useBuilder.tsx`, `lib/generation/ReplayController.ts` (if present)

## Success criteria

1. `BuilderEngine` class no longer exists.
2. No field in any store represents "current screen" or "current selection."
3. `generationData` and `replayStages` no longer exist.
4. `select*` and `derive*` function styles no longer exist; all data reads go through named domain hooks.
5. Browser back/forward, Cmd+click deep links, and bookmarking all work without additional code.
6. Frame 5 in a fresh React DevTools profile is ≤10ms.
7. Total render time in the same trace is ≤30ms.
8. `npm run lint`, `npm run build`, `npx tsc --noEmit`, and `npm test` are clean.
9. A full SA generation produces an identical final blueprint to today's system (verified by diffing fixture outputs).
