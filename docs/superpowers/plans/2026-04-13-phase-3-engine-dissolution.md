# Phase 3 — BuilderEngine Dissolution + BuilderSession Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dissolve the `BuilderEngine` class into domain-specific React contexts and a new `BuilderSession` store. Delete the `syncOldFromDoc` adapter and every legacy-store consumer of mirrored entity fields. Land the `MoveQuestionResult.renamed` + `QuestionRenameResult.xpathFieldsRewritten` instrumentation that Phase 2 deferred, wired into toast UX. Leave the legacy builderStore shrinking (generation/replay lifecycle stays for Phase 4).

**Architecture:** Every imperative responsibility `BuilderEngine` held moves to its natural owner — scroll → `ScrollRegistryContext`, edit guard → `EditGuardContext`, energy rAF → `signalGrid` module-level nanostore (pattern mirrors `toastStore`), drag state → `DragStateContext`, connect stash + `cursorMode` + sidebars → `BuilderSession` (scoped Zustand store with reducer-shaped actions, no Immer, no zundo). `BuilderProvider` becomes a stack of independent capability providers; no single imperative coordinator class. `EngineController` (the per-question form preview runtime) re-homes into its own context and resubscribes to the `BlueprintDoc` store directly — the bridge the adapter provided is no longer needed.

**Tech Stack:** TypeScript (strict), Zustand 5 (session store), React 19 (ref-callback cleanup, context providers), Vitest, @testing-library/react 16, Biome.

**Spec reference:** `docs/superpowers/specs/2026-04-12-builder-state-rearchitecture-design.md`
- Section 2 "BuilderSession (the ephemeral store)"
- Section 4 "BuilderEngine dissolution" (the dissolution table — every row is a Phase 3 task)
- Section 5 "Selector API unification" (partial — full lint enforcement lands Phase 6)
- Migration-table row: **Phase 3 — BuilderSession + Engine dissolution**. Gate: "Edit guard blocks selection during unsaved edits. Undo flash fires. Signal grid animates. Drag works."

**Depends on:** Phase 0 (`lib/session/types.ts`, `lib/doc/types.ts`), Phase 1a (doc store + mutations), Phase 1b (`useBlueprintMutations`, `syncOldFromDoc`), Phase 2 (URL routing hooks, `LocationRecoveryEffect`, `useSelect`, `builderActions.ts`). Current HEAD: `021acce`.

---

## Phase 3 non-goals (stay for Phase 4+)

- Generation + replay as mutation stream (spec Section 7) → **Phase 4**. Legacy store's `startGeneration`, `setSchema`, `setPartialScaffold`, `setScaffold`, `setModuleContent`, `setFormContent`, `completeGeneration`, `loadApp`, `loadReplay`, `setGenerationError`, `advanceStage`, `setFixAttempt`, `acknowledgeCompletion` all stay with their current signatures. Their `_docStore`-routed dispatches stay wired. `generationData`, `generationStage`, `generationError`, `statusMessage`, `progressCompleted/Total`, `replayStages`, `replayDoneIndex`, `replayExitPath`, `replayMessages` stay on the legacy store.
- `phase: BuilderPhase` stays on the legacy store (tightly coupled to generation lifecycle that Phase 4 owns). `useBuilderPhase`, `useBuilderIsReady`, `useBuilderHasData`, `useBuilderInReplayMode`, `useBuilderAgentActive` stay readable. Their implementations may change (T9 / T10c) but their call sites do not.
- `agentActive`, `postBuildEdit` stay on legacy store for Phase 3 — they transition phase in lock-step with generation. Phase 4 migrates them alongside the generation rewrite.
- `VirtualFormList` (spec Section 6) → **Phase 5**. The recursive `FormRenderer` keeps its current shape.
- Full deletion of `lib/services/builderStore.ts`, `lib/services/builderSelectors.ts`, `hooks/useBuilder.tsx` → **Phase 6**. Phase 3 shrinks them; full removal comes after generation migrates.
- Full `noRestrictedImports` lint enforcement of domain hooks → **Phase 6**. Phase 3 may add individual rules scoped to files it deletes, but global enforcement waits.
- Facade cleanup for `useModule` / `useForm` / `useQuestion` / `useOrderedModules` / `useOrderedForms` / `useAssembledForm` in `hooks/useBuilder.tsx` (they delegate to doc hooks already). Leave for Phase 6.

---

## File Structure

### New files

```
components/builder/contexts/
  ScrollRegistryContext.tsx             # Provider + useScrollIntoView + useRegisterScrollCallback (T1)
  EditGuardContext.tsx                  # Provider + useRegisterEditGuard + useConsultEditGuard (T2)
  DragStateContext.tsx                  # Provider + useSetDragActive + useIsDragActive (T4)
  __tests__/
    ScrollRegistryContext.test.tsx      # T1
    EditGuardContext.test.tsx           # T2
    DragStateContext.test.tsx           # T4

lib/signalGrid/
  store.ts                              # Module-level nanostore (injectEnergy, drainEnergy,
                                        # injectThinkEnergy, drainThinkEnergy, subscribe).
                                        # Pattern: mirrors lib/services/toastStore.ts. (T3)
  editFocus.ts                          # computeEditFocus(doc, scope) pure function,
                                        # clampEditFocus helper (moved from BuilderEngine).
                                        # Reads doc entity maps directly. (T10c)
  hook.ts                               # useSignalGridFrame(callback) — rAF loop hook (T3)
  __tests__/
    store.test.ts                       # T3
    editFocus.test.ts                   # T10c

lib/session/
  store.ts                              # createBuilderSessionStore — Zustand + subscribeWithSelector
                                        # + devtools. No Immer, no zundo. (T5 initial fields; T6/T7 additions)
  provider.tsx                          # BuilderSessionProvider + useBuilderSession*
                                        # context-bound hook factory. (T5)
  hooks.tsx                             # Named domain hooks: useCursorMode, useSidebarState,
                                        # useSwitchCursorMode, useActiveFieldId,
                                        # useConnectStash, useSwitchConnectMode,
                                        # useFocusHint. (T5/T6/T7)
  __tests__/
    store.test.ts                       # Reducer-shaped action tests (T5/T6/T7)
    hooks.test.tsx                      # Hook-level tests with provider wrapper

lib/preview/engine/
  provider.tsx                          # BuilderFormEngineProvider — owns one EngineController
                                        # instance per builder session, provides via context. (T13)
  __tests__/
    provider.test.tsx                   # T13

lib/doc/mutations/
  (modified) questions.ts               # Populate MoveQuestionResult.renamed and
                                        # QuestionRenameResult.xpathFieldsRewritten (T8)

lib/doc/
  applyWithResult.ts                    # New doc-store method that returns mutation result
                                        # metadata (renamed auto-dedup, xpath rewrite counts). (T8)
  __tests__/
    applyWithResult.test.ts             # T8

lib/doc/hooks/
  useDocHasData.ts                      # Replacement for selectHasData. (T9)
  useDocTreeData.ts                     # Replacement for useBuilderTreeData/deriveTreeData —
                                        # reads doc + legacy-store generationData. (T9)
```

### Modified files

```
hooks/useBuilder.tsx                    # Delete useBuilderEngine + EngineContext + SyncBridge;
                                        # rewrite BuilderProvider as a stack of providers (T13);
                                        # delete entity field readers the facade still uses (T9);
                                        # delete setDocStore wiring for engine (T13).

lib/services/builderStore.ts            # Delete cursorMode, activeFieldId, chatOpen, structureOpen,
                                        # sidebarStash + their actions (T5);
                                        # delete mirrored entity fields (modules, forms, questions,
                                        # moduleOrder, formOrder, questionOrder, appName,
                                        # connectType, caseTypes) + dead writes in
                                        # startGeneration/completeGeneration/loadApp (T11);
                                        # delete 13 mutation stub actions + renameCaseProperty stub +
                                        # move updateCaseProperty + searchBlueprint to doc-driven
                                        # helpers (T10b/T12). KEEP: phase, agentActive, postBuildEdit,
                                        # generationData, generation lifecycle actions, replay fields,
                                        # _docStore ref + setScaffold/setModuleContent/setFormContent/
                                        # setSchema (they dispatch to the doc — Phase 4 rewrites them).

lib/services/builderEngine.ts           # DELETED by T13.

lib/services/builderSelectors.ts        # Delete deriveTreeData + TreeDataSource (moved to doc hook) (T9);
                                        # delete selectHasData (moved to useDocHasData) (T9);
                                        # delete selectAppName, selectCursorMode, selectChatOpen,
                                        # selectStructureOpen (session migrated) (T5).
                                        # KEEP: selectIsReady, selectInReplayMode, selectEditMode,
                                        # selectGenStage, selectGenError, selectStatusMsg (legacy
                                        # store still owns these concepts for Phase 3).

lib/preview/engine/engineController.ts  # Swap BuilderStoreApi → BlueprintDocStore (T10a):
                                        # - import type change
                                        # - private blueprintStore: BlueprintDocStore | undefined
                                        # - setBlueprintStore accepts BlueprintDocStore
                                        # - all store.subscribe calls re-keyed to doc state shape
                                        #   (moduleOrder is Uuid[], formOrder is Record<Uuid,Uuid[]>,
                                        #   questions is Record<Uuid, QuestionEntity> — already
                                        #   structurally identical to legacy NQuestion thanks to
                                        #   toDoc's camelCase conversion, cast through unknown to
                                        #   bridge the brand boundary).
                                        # - activateForm resolves moduleUuid/formUuid from doc
                                        #   state via moduleOrder[mIdx], formOrder[modUuid][fIdx].
                                        # - the existing numeric moduleIndex/formIndex API stays:
                                        #   FormRenderer still passes indices, EngineController
                                        #   translates them into uuids internally.

components/builder/LocationRecoveryEffect.tsx   # No changes expected.
components/builder/BuilderLayout.tsx            # Swap engine.registerScrollCallback → ScrollRegistry (T1).
components/builder/BuilderContentArea.tsx       # Swap sidebar store reads → session hooks (T5).
components/builder/BuilderSubheader.tsx         # Keep phase reader; nothing else.
components/builder/useBuilderShortcuts.ts       # Swap engine.setPendingScroll → useScrollIntoView (T1);
                                                # wire MoveQuestionResult.renamed toast (T8);
                                                # delete engine.isNewQuestion/clearNewQuestion logic (T7).
components/builder/contextual/ContextualEditorHeader.tsx
                                                # Delete consumeRenameNotice logic — replaced by toast (T7/T8);
                                                # delete isNewQuestion/clearNewQuestion — URL sel= handles focus (T7);
                                                # swap setPendingScroll → useScrollIntoView (T1).
components/builder/contextual/shared.ts         # Swap engine.focusHint → session useFocusHint (T7).
components/builder/contextual/*                 # Reader-only files — may need imports cleaned.
components/builder/detail/AppConnectSettings.tsx        # Swap engine.switchConnectMode → session hook (T6).
components/builder/detail/FormSettingsPanel.tsx         # Swap engine.stashFormConnect/getFormConnectStash → session (T6).
components/builder/detail/FormDetail.tsx                # Reader-only cleanup if any imports touched.
components/builder/XPathField.tsx                       # Swap engine.setEditGuard/clearEditGuard → useRegisterEditGuard (T2).
components/builder/ReplayController.tsx                 # Replace engine.reset() → composite reset helper (T13).
components/builder/GenerationProgress.tsx               # No changes (keeps reading legacy store for Phase 3).

components/preview/form/FormRenderer.tsx        # Swap engine.fulfillPendingScroll → ScrollRegistry (T1);
                                                # swap engine.setDragging → useSetDragActive (T4);
                                                # wire MoveQuestionResult.renamed toast on drag-drop move (T8);
                                                # engineController access via new provider hook (T13).
components/preview/form/EditableQuestionWrapper.tsx     # Swap engine.setPendingScroll/scrollToQuestion → ScrollRegistry (T1).
components/preview/form/QuestionTypePicker.tsx          # Swap setPendingScroll → ScrollRegistry (T1);
                                                         # delete markNewQuestion — URL sel= is the focus signal (T7).
components/preview/form/fields/*                        # Reader-only; any entity reads migrate to doc hooks (T9).

components/preview/screens/*                    # Phase readers keep working; entity reads migrate to doc hooks (T9).
components/preview/PreviewShell.tsx             # Reader-only cleanup if any imports touched.
components/preview/PreviewHeader.tsx            # Reader-only cleanup if any imports touched.

components/chat/SignalGrid.tsx                  # Swap builder.injectThinkEnergy → signalGrid.injectThinkEnergy (T3);
                                                # swap builder.computeEditFocus → editFocus.ts (T10c);
                                                # swap builder.store.getState().postBuildEdit/agentActive →
                                                # useBuilderStore hooks (no change — stays legacy Phase 3).
components/chat/ChatContainer.tsx               # Swap builder.setAgentActive → keep, but access legacy store
                                                # via a hook instead of engine (T13); see per-task notes.
components/chat/ChatSidebar.tsx                 # Swap engine.injectEnergy → signalGrid.injectEnergy (T3);
                                                # entity readers migrate to doc hooks (T9).

lib/routing/hooks.tsx                           # Swap engine.checkEditGuard → useConsultEditGuard (T2).
lib/routing/builderActions.ts                   # Swap engine.setFocusHint → session useSetFocusHint (T7);
                                                # swap engine.findFieldElement (stays — DOM helper,
                                                # move to a pure function in lib/routing/domQueries.ts);
                                                # swap engine.flashUndoHighlight (move to
                                                # lib/routing/undoFlash.ts as a pure function);
                                                # swap engine.scrollToQuestion → useScrollIntoView (T1).

hooks/useFormEngine.ts                          # Swap builderEngine.engineController →
                                                # useBuilderFormEngine() hook (T13).

lib/services/builder.ts                         # Swap engine.injectEnergy → signalGrid.injectEnergy (T3).

lib/services/logReplay.ts (if it calls engine)  # Audit + migrate (T13).
```

### Deleted files

```
lib/services/builderEngine.ts                       # T13
lib/doc/adapters/syncOldFromDoc.ts                  # T11
lib/doc/__tests__/adapters-syncOldFromDoc.test.tsx  # T11
```

---

## Dependencies between tasks

- **T1 (Scroll), T2 (EditGuard), T3 (signalGrid), T4 (DragState)** are independent. Can land in any order.
- **T5 (BuilderSession: cursorMode + sidebars)** is independent.
- **T6 (Session: connect stash)** depends on T5.
- **T7 (Session: focus hint + delete new-question + rename notice)** depends on T5.
- **T8 (MoveQuestionResult + toast)** is independent of T1–T7, but the `useBuilderShortcuts.ts` and `FormRenderer.tsx` edits from T1 and T4 touch the same files — sequence T8 after T1 + T4 to avoid merge friction.
- **T9 (deriveTreeData → doc)** is independent.
- **T10a (EngineController → doc store)** depends on nothing.
- **T10b (updateCaseProperty + searchBlueprint migrate out of legacy store)** depends on nothing.
- **T10c (computeEditFocus → signalGrid/editFocus.ts reading doc)** depends on T3 (the signalGrid module exists).
- **T11 (delete adapter + mirrored fields)** depends on T9, T10a, T10b, T10c.
- **T12 (delete stub mutation actions)** is independent but kept after T11 so both legacy-store structural edits land back-to-back for easier review.
- **T13 (delete engine, refactor BuilderProvider, re-home EngineController)** depends on T1–T8 having moved every engine method call.
- **T14 (final verification + Phase 4 prompt)** is last.

Execution order: T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10a → T10b → T10c → T11 → T12 → T13 → T14.

---

## Worktree setup

Before Task 1:

```bash
cd /Users/braxtonperry/work/personal/code/commcare-nova
git worktree add -b phase-3-engine-dissolution ../commcare-nova-phase3 main
cd ../commcare-nova-phase3
npm install
npx tsc --noEmit && echo "✓"
npm test -- --run
```

Expected: worktree created at `../commcare-nova-phase3`, typecheck + tests clean. Do NOT push the branch. Every subsequent task runs inside `../commcare-nova-phase3`.

---

### Task 1: `ScrollRegistryContext` — replaces engine scroll callback + pending scroll

**Spec citation:** Section 4 dissolution table row 1 — "`_scrollCallback` + `_pendingScroll` + `scrollToQuestion()` → `ScrollRegistryContext` + `useScrollIntoView(uuid, opts)` hook".

**Files:**
- Create: `components/builder/contexts/ScrollRegistryContext.tsx`
- Create: `components/builder/contexts/__tests__/ScrollRegistryContext.test.tsx`
- Modify: `components/builder/BuilderLayout.tsx` — swap `engine.registerScrollCallback` / `engine.clearScrollCallback` (~lines 297-298) to `useRegisterScrollCallback(ref)`.
- Modify: `components/preview/form/FormRenderer.tsx` — swap `engine.fulfillPendingScroll(uuid)` (~line 226) to `useFulfillPendingScroll(uuid)` hook.
- Modify: `components/preview/form/EditableQuestionWrapper.tsx` — swap `engine.setPendingScroll(...)` (~line 88) and `engine.scrollToQuestion(...)` (~line 123) to the new hook API.
- Modify: `components/preview/form/QuestionTypePicker.tsx` — swap `engine.setPendingScroll(...)` (~line 96).
- Modify: `components/builder/useBuilderShortcuts.ts` — swap `engine.setPendingScroll(...)` (~line 79).
- Modify: `components/builder/contextual/ContextualEditorHeader.tsx` — swap `engine.setPendingScroll(...)` (~lines 301, 311).
- Modify: `lib/routing/builderActions.ts` — swap `engine.scrollToQuestion(...)` (~line 88) to a direct call through the registry (`useScrollIntoView` inside the composite hook).

**Design:**

```tsx
// ScrollRegistryContext.tsx
type ScrollTarget = HTMLElement | undefined;
type ScrollCallback = (
    questionUuid: string,
    overrideTarget?: ScrollTarget,
    behavior?: ScrollBehavior,
    hasToolbar?: boolean,
) => void;

interface ScrollRegistryApi {
    /** Consumed by BuilderLayout to register the DOM scroll implementation.
     *  Returns a cleanup function for ref-callback use. */
    registerCallback: (cb: ScrollCallback) => () => void;
    /** Request a pending scroll — fulfilled when a matching question's
     *  panel mount effect calls `fulfill(uuid)`. */
    setPending: (uuid: string, behavior: ScrollBehavior, hasToolbar: boolean) => void;
    /** Try to consume a pending request. Returns true if fired. */
    fulfillPending: (uuid: string) => boolean;
    /** Scroll immediately (no pending gate) — used by undo/redo where
     *  flushSync guarantees the DOM is already committed. */
    scrollTo: ScrollCallback;
}

const ScrollRegistryContext = createContext<ScrollRegistryApi | null>(null);

export function ScrollRegistryProvider({ children }: { children: ReactNode }) {
    // Non-reactive state stored in refs — never triggers re-renders.
    // This is the whole point of the scroll subsystem: DOM-level imperative
    // plumbing that belongs outside React's render path.
    const callbackRef = useRef<ScrollCallback | null>(null);
    const pendingRef = useRef<
        { uuid: string; behavior: ScrollBehavior; hasToolbar: boolean } | undefined
    >(undefined);

    const api = useMemo<ScrollRegistryApi>(
        () => ({
            registerCallback(cb) {
                callbackRef.current = cb;
                return () => {
                    if (callbackRef.current === cb) callbackRef.current = null;
                };
            },
            setPending(uuid, behavior, hasToolbar) {
                pendingRef.current = { uuid, behavior, hasToolbar };
            },
            fulfillPending(uuid) {
                const pending = pendingRef.current;
                if (pending?.uuid !== uuid) return false;
                pendingRef.current = undefined;
                callbackRef.current?.(uuid, undefined, pending.behavior, pending.hasToolbar);
                return true;
            },
            scrollTo(uuid, overrideTarget, behavior, hasToolbar) {
                callbackRef.current?.(uuid, overrideTarget, behavior, hasToolbar);
            },
        }),
        [],
    );

    return (
        <ScrollRegistryContext value={api}>{children}</ScrollRegistryContext>
    );
}

function useScrollRegistry(): ScrollRegistryApi {
    const ctx = useContext(ScrollRegistryContext);
    if (!ctx) throw new Error("ScrollRegistry hooks must be used within ScrollRegistryProvider");
    return ctx;
}

/** Ref callback for the scroll implementation owner (BuilderLayout).
 *  Returns a React 19 ref callback cleanup function. */
export function useRegisterScrollCallback(callback: ScrollCallback): void {
    const { registerCallback } = useScrollRegistry();
    /* Ref-callback cleanup pattern — aligned with `CLAUDE.md` convention:
     * DOM listeners use ref-callback cleanup, not useEffect. */
    useEffect(() => registerCallback(callback), [registerCallback, callback]);
}

/** Request a scroll that will fire once the target question's panel mounts. */
export function useScrollIntoView() {
    const { setPending, scrollTo } = useScrollRegistry();
    return useMemo(() => ({ setPending, scrollTo }), [setPending, scrollTo]);
}

/** Fire-once hook: the target question's panel calls this on mount,
 *  and any pending-scroll request that matches is consumed. */
export function useFulfillPendingScroll(uuid: string): void {
    const { fulfillPending } = useScrollRegistry();
    useEffect(() => {
        fulfillPending(uuid);
    }, [uuid, fulfillPending]);
}
```

**Provider wiring (temporary — T13 finalizes):** wrap `<ScrollRegistryProvider>` inside `BuilderProvider`'s tree, outside `BlueprintDocProvider` (order doesn't matter — independent contexts). For Phase 3, mount it directly inside `BuilderProvider`. T13 will place it inside the final provider stack.

- [ ] **Step 1: Create `ScrollRegistryContext.tsx` with the API above**

Write the full component as shown (no placeholders, include the `ScrollCallback` type, `ScrollRegistryApi` interface, context, provider, internal `useScrollRegistry` hook, and the three public hooks: `useRegisterScrollCallback`, `useScrollIntoView`, `useFulfillPendingScroll`).

- [ ] **Step 2: Write the test file**

Covers:
1. `registerCallback` installs the callback; the returned cleanup removes it.
2. `setPending` + `fulfillPending` with matching uuid → fires the registered callback exactly once with the stored behavior + hasToolbar.
3. `fulfillPending` with non-matching uuid → returns `false`, does not fire, pending state unchanged.
4. `scrollTo` fires the callback with full args regardless of pending state.
5. Hook without provider throws.

Example test shape:

```tsx
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
    ScrollRegistryProvider,
    useRegisterScrollCallback,
    useScrollIntoView,
    useFulfillPendingScroll,
} from "../ScrollRegistryContext";

describe("ScrollRegistryContext", () => {
    it("fires registered callback on fulfillPending match", () => {
        const cb = vi.fn();
        const wrapper = ({ children }: { children: React.ReactNode }) => (
            <ScrollRegistryProvider>{children}</ScrollRegistryProvider>
        );

        const { result } = renderHook(
            () => {
                useRegisterScrollCallback(cb);
                return useScrollIntoView();
            },
            { wrapper },
        );

        act(() => result.current.setPending("q-1", "smooth", false));
        // Fulfillment happens via useFulfillPendingScroll elsewhere; simulate:
        const { result: fulfillResult } = renderHook(() => useFulfillPendingScroll("q-1"), { wrapper });
        expect(cb).toHaveBeenCalledOnce();
        expect(cb).toHaveBeenCalledWith("q-1", undefined, "smooth", false);
    });
});
```

(Implementer: a single shared `wrapper` for the two hooks in one test will require a small helper that calls both hooks in the same `renderHook` body — see the full example in Phase 2's `hooks-useLocation.test.tsx` for the shared-wrapper pattern.)

- [ ] **Step 3: Wire the provider into `BuilderProvider`**

In `hooks/useBuilder.tsx`, add `<ScrollRegistryProvider>` inside `<BuilderProvider>`'s JSX, wrapping `{children}`. It can sit as a sibling of `<BlueprintDocProvider>` or inside it — ordering is irrelevant. Leave the engine's scroll methods in place for now; subsequent steps migrate call sites.

- [ ] **Step 4: Migrate `BuilderLayout.tsx`**

Replace `engine.registerScrollCallback(cb)` (~line 297) with `useRegisterScrollCallback(cb)`. The callback shape is identical. Remove `engine.clearScrollCallback()` — the hook cleanup handles it. Remove the `useBuilderEngine()` call if nothing else on this component uses the engine; if it still does, leave the engine reference alone (T13 cleans up).

- [ ] **Step 5: Migrate `FormRenderer.tsx`**

Replace `engine.fulfillPendingScroll(uuid)` (~line 226, inside the selected question's mount effect) with `useFulfillPendingScroll(uuid)` called at the top of the component (it's a hook, not a method).

- [ ] **Step 6: Migrate `EditableQuestionWrapper.tsx`**

- Line ~88: `engine.setPendingScroll(uuid, "instant", false)` → `const { setPending } = useScrollIntoView();` … `setPending(uuid, "instant", false)`.
- Line ~123: `engine.scrollToQuestion(uuid, undefined, "smooth", false)` → `const { scrollTo } = useScrollIntoView();` … `scrollTo(uuid, undefined, "smooth", false)`.

- [ ] **Step 7: Migrate `QuestionTypePicker.tsx`**

Line ~96: `engine.setPendingScroll(newUuid, "instant", false)` → `const { setPending } = useScrollIntoView();` … `setPending(newUuid, "instant", false)`.

- [ ] **Step 8: Migrate `useBuilderShortcuts.ts`**

Line ~79: `engine.setPendingScroll(uuid, "instant", true)` → inside the hook body, `const { setPending } = useScrollIntoView();` (already a hook-context so safe) … `setPending(uuid, "instant", true)`.

- [ ] **Step 9: Migrate `ContextualEditorHeader.tsx`**

Lines ~301, ~311: `engine.setPendingScroll(...)` → `setPending(...)` via `useScrollIntoView()`.

- [ ] **Step 10: Migrate `lib/routing/builderActions.ts`**

Line ~88: `engine.scrollToQuestion(selectedUuid, targetEl, "instant")` — inside `useUndoRedo` composite hook. Swap to `const { scrollTo } = useScrollIntoView();` and call `scrollTo(selectedUuid, targetEl, "instant")`. Only this line — leave `engine.findFieldElement` and `engine.flashUndoHighlight` alone; T13 pure-function-extracts them.

- [ ] **Step 11: Delete engine scroll members**

In `lib/services/builderEngine.ts`, delete:
- `_scrollCallback` field
- `_pendingScroll` field
- `registerScrollCallback` method
- `clearScrollCallback` method
- `fulfillPendingScroll` method
- `scrollToQuestion` method
- `setPendingScroll` method
- Line in `reset()` that would clear scroll state (there isn't one — nothing to do).

Leave `findFieldElement` and `flashUndoHighlight` in place — T13 migrates them.

- [ ] **Step 12: Typecheck + test**

```bash
npx tsc --noEmit && echo "✓"
npm test -- --run
```

Expected: clean. If the test file fails, the new provider isn't mounting — check the `BuilderProvider` wiring.

- [ ] **Step 13: Commit**

```bash
git add components/builder/contexts lib/services/builderEngine.ts \
        components/builder/BuilderLayout.tsx \
        components/preview/form/FormRenderer.tsx \
        components/preview/form/EditableQuestionWrapper.tsx \
        components/preview/form/QuestionTypePicker.tsx \
        components/builder/useBuilderShortcuts.ts \
        components/builder/contextual/ContextualEditorHeader.tsx \
        lib/routing/builderActions.ts \
        hooks/useBuilder.tsx
git commit -m "refactor(builder): ScrollRegistryContext replaces engine scroll"
```

---

### Task 2: `EditGuardContext` — replaces engine edit guard

**Spec citation:** Section 4 dissolution table row 2 — "`_editGuard` → `EditGuardContext` with `useRegisterEditGuard(predicate)`".

**Files:**
- Create: `components/builder/contexts/EditGuardContext.tsx`
- Create: `components/builder/contexts/__tests__/EditGuardContext.test.tsx`
- Modify: `components/builder/XPathField.tsx` — swap `engine.setEditGuard` / `engine.clearEditGuard` (6 call sites at ~lines 334, 343, 362, 373, 376) to `useRegisterEditGuard(predicate)`.
- Modify: `lib/routing/hooks.tsx` — swap `engine.checkEditGuard()` (~line 373, inside `useSelect`) to `useConsultEditGuard()` called at the top of `useSelect`.

**Design:**

A single current predicate is allowed (mirrors engine's behavior — there's only ever one inline editor with unsaved content at a time). `useRegisterEditGuard(predicate)` installs the predicate on mount and clears on unmount. If a second hook tries to register, the new predicate takes over (last-write-wins — matches today's imperative behavior). `useConsultEditGuard()` returns a function that runs the current predicate, returning `true` to allow, `false` to block.

```tsx
// EditGuardContext.tsx
type EditGuardPredicate = () => boolean;

interface EditGuardApi {
    register: (predicate: EditGuardPredicate) => () => void;
    consult: () => boolean;
}

const EditGuardContext = createContext<EditGuardApi | null>(null);

export function EditGuardProvider({ children }: { children: ReactNode }) {
    const predicateRef = useRef<EditGuardPredicate | null>(null);

    const api = useMemo<EditGuardApi>(
        () => ({
            register(predicate) {
                predicateRef.current = predicate;
                return () => {
                    if (predicateRef.current === predicate) predicateRef.current = null;
                };
            },
            consult() {
                const p = predicateRef.current;
                return p ? p() : true;
            },
        }),
        [],
    );

    return <EditGuardContext value={api}>{children}</EditGuardContext>;
}

function useEditGuardApi(): EditGuardApi {
    const ctx = useContext(EditGuardContext);
    if (!ctx) throw new Error("EditGuard hooks must be used within EditGuardProvider");
    return ctx;
}

/** Install an edit guard predicate. Called by inline editors that have
 *  unsaved content and want to block selection changes.
 *
 *  The predicate is evaluated on selection attempts. Return `true` if it's
 *  safe to leave, `false` to block. Registration is last-write-wins and
 *  auto-clears on unmount — the dependency array controls when the
 *  predicate is refreshed. */
export function useRegisterEditGuard(
    predicate: EditGuardPredicate,
    enabled: boolean,
): void {
    const { register } = useEditGuardApi();
    useEffect(() => {
        if (!enabled) return;
        return register(predicate);
    }, [register, predicate, enabled]);
}

/** Returns a function that evaluates the current edit guard. `true` means
 *  "safe to proceed", `false` means "block". Used by routing hooks
 *  (`useSelect`) to gate URL-driven selection changes. */
export function useConsultEditGuard(): () => boolean {
    const { consult } = useEditGuardApi();
    return consult;
}
```

- [ ] **Step 1: Create `EditGuardContext.tsx`**

Write the full component. Keep the `register → cleanup` contract identical to Task 1's pattern. The `enabled` flag in `useRegisterEditGuard` lets `XPathField` register only while an edit is in progress without re-registering on every keystroke — matches today's behavior where `setEditGuard` is called on focus and `clearEditGuard` on blur/commit/cancel.

- [ ] **Step 2: Write `EditGuardContext.test.tsx`**

Covers:
1. No predicate registered → `consult()` returns `true`.
2. Register a predicate that returns `false` → `consult()` returns `false`.
3. Register, then cleanup → `consult()` returns `true` again.
4. Register A, then register B (last-write-wins) → `consult()` evaluates B.
5. Register A, unmount A → `consult()` returns `true` (A's cleanup ran).
6. Hook without provider throws.

- [ ] **Step 3: Mount `<EditGuardProvider>` inside `BuilderProvider`**

Add as a sibling of `<ScrollRegistryProvider>` in `hooks/useBuilder.tsx`. Order is irrelevant.

- [ ] **Step 4: Migrate `XPathField.tsx`**

Current shape:

```tsx
// XPathField.tsx — before
const engine = useBuilderEngine();
// On focus:
engine.setEditGuard(() => confirm("You have unsaved changes..."));
// On blur/cancel/commit:
engine.clearEditGuard();
```

New shape:

```tsx
// XPathField.tsx — after
const [isEditing, setIsEditing] = useState(false);
const hasUnsavedContent = /* existing logic */;

useRegisterEditGuard(
    useCallback(() => {
        if (!hasUnsavedContent) return true;
        return confirm("You have unsaved XPath changes. Leave anyway?");
    }, [hasUnsavedContent]),
    isEditing,
);

// On focus: setIsEditing(true)
// On blur/cancel/commit: setIsEditing(false)
```

This removes all 6 engine edit-guard call sites and replaces them with a single hook call + state-driven enablement. The `isEditing` boolean already exists in most inline editors; if `XPathField` doesn't have one, add it.

Delete the `engine.setEditGuard` / `engine.clearEditGuard` / `engine.checkEditGuard` references entirely — the hook owns lifecycle. Remove the `useBuilderEngine` import from the file if nothing else in `XPathField` uses the engine.

- [ ] **Step 5: Migrate `lib/routing/hooks.tsx` `useSelect`**

Line ~373: `if (!engine.checkEditGuard()) return;` → first line of `useSelect`'s returned `select` function:

```tsx
export function useSelect() {
    const consultGuard = useConsultEditGuard();
    // ... existing router, location, etc.

    const select = useCallback(
        (uuid: Uuid | null) => {
            if (!consultGuard()) return; // ← spec Section 4: edit guard gates selection
            // ... existing router.replace logic
        },
        [consultGuard, /* existing deps */],
    );
    return select;
}
```

Double-check: read `lib/routing/hooks.tsx`'s current `useSelect` implementation end-to-end before editing. The spec line ("useSelect hook consults EditGuardContext.canLeave() before calling router.replace") must be structurally visible in the new code — spec reviewers will look for it.

- [ ] **Step 6: Delete engine edit-guard members**

In `lib/services/builderEngine.ts`, delete:
- `_editGuard` field
- `setEditGuard`, `clearEditGuard`, `checkEditGuard` methods
- Line in `reset()` that clears `_editGuard`.

- [ ] **Step 7: Typecheck + test**

```bash
npx tsc --noEmit && echo "✓"
npm test -- --run
```

Add a test to `lib/routing/__tests__/hooks-useNavigate.test.tsx` (or a new `hooks-useSelect-editGuard.test.tsx`) that:
1. Registers a guard returning `false`
2. Calls `useSelect()` to change selection
3. Asserts `router.replace` was NOT called

This is the regression test for the Phase 2 retrospective bug (the edit guard integration silently dropped). Phase 3 must have a test that would have caught it.

- [ ] **Step 8: Commit**

```bash
git add components/builder/contexts lib/services/builderEngine.ts \
        components/builder/XPathField.tsx lib/routing/hooks.tsx \
        lib/routing/__tests__ hooks/useBuilder.tsx
git commit -m "refactor(builder): EditGuardContext replaces engine._editGuard"
```

---

### Task 3: `signalGrid` nanostore — replaces engine energy counters + rAF loop

**Spec citation:** Section 4 dissolution table row 3 — "`_streamEnergy`, `_thinkEnergy`, rAF loop → `signalGrid` nanostore in its own file, `useSignalGridFrame()` hook".

**Files:**
- Create: `lib/signalGrid/store.ts`
- Create: `lib/signalGrid/hook.ts`
- Create: `lib/signalGrid/__tests__/store.test.ts`
- Modify: `components/chat/SignalGrid.tsx` — swap `builder.injectThinkEnergy`, `builder.drainEnergy`, `builder.drainThinkEnergy`, `builder.store.getState()` reads that pull the energy-related scaffoldProgress → signal grid module API.
- Modify: `lib/services/builder.ts` — swap `engine.injectEnergy(...)` (~lines 35, 39, 46) to `signalGrid.injectEnergy(...)`.
- Modify: `components/chat/ChatSidebar.tsx` — swap `engine.injectEnergy(...)` (~lines 539, 544, 549) to `signalGrid.injectEnergy(...)`.

**Design rationale:** The signal grid's rAF loop runs completely outside React's render cycle. The energy counters are non-reactive accumulators polled once per frame. A React context forces the state through re-render machinery that never runs. A module-level nanostore (the same pattern `lib/services/toastStore.ts` uses — plain class, `subscribe`/`notify`, no React) is the right shape.

Wider-scoped considerations:
- The rAF loop is **started when the signal grid component mounts and stopped on unmount**. It's not a global loop — the store doesn't run rAF itself. The store just holds the state; the hook owns the frame pump.
- Energy is injected from outside React (from `lib/services/builder.ts`'s data-part stream handlers) — a module-level singleton is callable from anywhere, no context threading.
- `computeEditFocus` is NOT part of this task (moves to `editFocus.ts` in T10c). `scaffoldProgress` stays a legacy-store read for now — Phase 4 migrates it alongside `generationData`.

```ts
// lib/signalGrid/store.ts
/**
 * signalGrid — module-level nanostore for the signal grid's non-reactive state.
 *
 * Pattern mirrors `lib/services/toastStore.ts`: plain class, module singleton,
 * callable from anywhere (route handlers, agent stream consumers, React). The
 * store holds energy counters; a consuming component calls `useSignalGridFrame`
 * to run an rAF loop that drains accumulated energy into frame-scoped animation
 * state.
 *
 * Why not Zustand: the state is non-reactive by design — consumers only read it
 * from inside an rAF callback, never from React render. Zustand's subscription
 * machinery is pure overhead for this use case.
 */

class SignalGridStore {
    private streamEnergy = 0;
    private thinkEnergy = 0;

    injectEnergy(amount: number): void {
        this.streamEnergy += amount;
    }
    injectThinkEnergy(amount: number): void {
        this.thinkEnergy += amount;
    }
    drainEnergy(): number {
        const e = this.streamEnergy;
        this.streamEnergy = 0;
        return e;
    }
    drainThinkEnergy(): number {
        const e = this.thinkEnergy;
        this.thinkEnergy = 0;
        return e;
    }
    /** Test-only — reset both counters. */
    _reset(): void {
        this.streamEnergy = 0;
        this.thinkEnergy = 0;
    }
}

export const signalGrid = new SignalGridStore();
```

```ts
// lib/signalGrid/hook.ts
import { useEffect } from "react";

/**
 * Run an rAF loop bound to the component's lifetime. The callback is
 * invoked once per frame with the delta since the previous frame
 * (clamped to avoid long-tab-switch surprises). The loop stops when
 * the component unmounts.
 *
 * Consumers call `signalGrid.drainEnergy()` / `drainThinkEnergy()`
 * inside the callback to consume accumulated energy.
 */
export function useSignalGridFrame(callback: (deltaMs: number) => void): void {
    useEffect(() => {
        let rafId = 0;
        let lastTs = performance.now();
        let cancelled = false;

        const tick = (ts: number) => {
            if (cancelled) return;
            const delta = Math.min(ts - lastTs, 100);
            lastTs = ts;
            callback(delta);
            rafId = requestAnimationFrame(tick);
        };

        rafId = requestAnimationFrame(tick);
        return () => {
            cancelled = true;
            cancelAnimationFrame(rafId);
        };
    }, [callback]);
}
```

- [ ] **Step 1: Create `store.ts`, `hook.ts`, and the test file**

Write all three files. The `store.test.ts` covers:
1. `injectEnergy(10) + drainEnergy() → 10, subsequent drain → 0`.
2. `injectThinkEnergy` tracked separately from `injectEnergy`.
3. `_reset()` clears both.

`hook.ts` doesn't need a unit test — testing rAF timing is brittle. The integration test is the existing `SignalGrid.tsx` behavior (no regression in the smoke test).

- [ ] **Step 2: Migrate `lib/services/builder.ts`**

Current (~lines 35, 39, 46) inside a `handleDataPart` function:

```ts
engine.injectEnergy(200);
// ...
engine.injectEnergy(100);
// ...
engine.injectEnergy(50);
```

Replace with:

```ts
import { signalGrid } from "@/lib/signalGrid/store";
// ...
signalGrid.injectEnergy(200);
signalGrid.injectEnergy(100);
signalGrid.injectEnergy(50);
```

Delete the `engine` parameter from the handler if no other engine methods are called there.

- [ ] **Step 3: Migrate `ChatSidebar.tsx`**

Lines ~539, ~544, ~549: swap `engine.injectEnergy(...)` → `signalGrid.injectEnergy(...)`. Remove the `useBuilderEngine()` call if no other engine methods are used in the file.

- [ ] **Step 4: Migrate `SignalGrid.tsx`**

Current shape (lines ~100-115):

```tsx
useEffect(() => {
    let raf = 0;
    const tick = (ts: number) => {
        // read builder state
        const s = builder.store.getState();
        builder.injectThinkEnergy(thinkDelta);
        // eventually call builder.computeEditFocus() — LEAVE FOR T10c
        // eventually drain builder.drainEnergy() / drainThinkEnergy()
        raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
}, [builder]);
```

New shape:

```tsx
import { signalGrid } from "@/lib/signalGrid/store";
import { useSignalGridFrame } from "@/lib/signalGrid/hook";

// Inside the component:
useSignalGridFrame(
    useCallback((deltaMs) => {
        // Existing per-frame logic — swap:
        //   builder.injectThinkEnergy(x) → signalGrid.injectThinkEnergy(x)
        //   builder.drainEnergy()        → signalGrid.drainEnergy()
        //   builder.drainThinkEnergy()   → signalGrid.drainThinkEnergy()
        // Leave builder.computeEditFocus() for T10c.
        // Leave builder.store.getState().postBuildEdit / agentActive reads
        // alone — they're legacy-store reads for Phase 3.
    }, [/* existing deps */]),
);
```

Read the current SignalGrid.tsx body before rewriting to preserve the exact animation logic — only the mechanism for running the frame loop and accumulating energy changes, not what happens inside each frame.

- [ ] **Step 5: Delete engine energy members**

In `lib/services/builderEngine.ts`, delete:
- `_streamEnergy` field
- `_thinkEnergy` field
- `injectEnergy`, `injectThinkEnergy`, `drainEnergy`, `drainThinkEnergy` methods
- Lines in `reset()` that clear the two counters

Keep `_editScope`, `setEditScope`, `computeEditFocus` for now — T10c dissolves them.

- [ ] **Step 6: Typecheck + test**

```bash
npx tsc --noEmit && echo "✓"
npm test -- --run
```

- [ ] **Step 7: Commit**

```bash
git add lib/signalGrid lib/services/builderEngine.ts \
        lib/services/builder.ts \
        components/chat/SignalGrid.tsx components/chat/ChatSidebar.tsx
git commit -m "refactor(builder): signalGrid nanostore replaces engine energy counters"
```

---

### Task 4: `DragStateContext` — replaces engine `_isDragging`

**Spec citation:** Section 4 dissolution table row 4 — "`_isDragging` → `DragStateContext` inside `<DragDropProvider>`".

**Files:**
- Create: `components/builder/contexts/DragStateContext.tsx`
- Create: `components/builder/contexts/__tests__/DragStateContext.test.tsx`
- Modify: `components/preview/form/FormRenderer.tsx` — swap `engine.setDragging(true)` / `engine.setDragging(false)` at lines ~646, ~667 (the `DragDropProvider`'s `onDragStart` / `onDragEnd` callbacks) to `useSetDragActive()`.

**Design:** A minimal context with a `setActive(boolean)` setter and an `isActive` reader. Scoped inside the `DragDropProvider` in `FormRenderer.tsx` so the lifetime matches the drag subsystem. If any future consumer outside `FormRenderer` wants to know about drag state, they read via `useIsDragActive()`.

```tsx
// DragStateContext.tsx
interface DragStateApi {
    isActive: boolean;
    setActive: (active: boolean) => void;
}

const DragStateContext = createContext<DragStateApi | null>(null);

export function DragStateProvider({ children }: { children: ReactNode }) {
    const [isActive, setActive] = useState(false);
    const api = useMemo<DragStateApi>(() => ({ isActive, setActive }), [isActive]);
    return <DragStateContext value={api}>{children}</DragStateContext>;
}

export function useSetDragActive(): (active: boolean) => void {
    const ctx = useContext(DragStateContext);
    if (!ctx) throw new Error("useSetDragActive must be used within DragStateProvider");
    return ctx.setActive;
}

export function useIsDragActive(): boolean {
    const ctx = useContext(DragStateContext);
    return ctx?.isActive ?? false;
}
```

- [ ] **Step 1: Create the context + test**

Tests:
1. Provider default → `useIsDragActive` returns `false`.
2. Call `setActive(true)` → `useIsDragActive` returns `true`; `setActive(false)` → returns `false` again.
3. Consumer outside provider → `useIsDragActive` returns `false` (graceful — the engine's default was `false`).
4. `useSetDragActive` outside provider throws.

- [ ] **Step 2: Wrap `FormRenderer.tsx`'s `<DragDropProvider>` with `<DragStateProvider>`**

Place `<DragStateProvider>` immediately inside `<DragDropProvider>` (or outside, whichever the JSX allows without restructuring; these don't interfere). Use the hook at the level of the component that owns `onDragStart`/`onDragEnd`.

- [ ] **Step 3: Migrate lines ~646 and ~667**

```tsx
// Before:
onDragStart={() => { builderEngine.setDragging(true); /* ... */ }}
onDragEnd={(ctx) => { if (ctx) builderEngine.setDragging(false); /* ... */ }}
```

```tsx
// After:
const setDragActive = useSetDragActive();
// ...
onDragStart={() => { setDragActive(true); /* ... */ }}
onDragEnd={(ctx) => { if (ctx) setDragActive(false); /* ... */ }}
```

Remove the `builderEngine.setDragging` calls. If `FormRenderer.tsx` no longer needs `useBuilderEngine()` for any other purpose, remove the import (likely still needed for `engineController` in Phase 3 — leave it).

- [ ] **Step 4: Delete engine drag members**

In `lib/services/builderEngine.ts`, delete:
- `_isDragging` field
- `setDragging` method
- `get isDragging` getter

- [ ] **Step 5: Typecheck + test + commit**

```bash
npx tsc --noEmit && echo "✓"
npm test -- --run
git add components/builder/contexts \
        components/preview/form/FormRenderer.tsx \
        lib/services/builderEngine.ts
git commit -m "refactor(builder): DragStateContext replaces engine._isDragging"
```

---

### Task 5: BuilderSession store — `cursorMode` + sidebars + reducer-shaped `switchCursorMode`

**Spec citation:** Section 2 "BuilderSession (the ephemeral store)" — `cursorMode`, `sidebars.{chat,structure}.{open,stashed}`, `activeFieldId`. Reducer-shaped `switchCursorMode` collapses `sidebarStash` into atomic sidebar transitions.

**Files:**
- Create: `lib/session/store.ts`
- Create: `lib/session/provider.tsx`
- Create: `lib/session/hooks.tsx`
- Create: `lib/session/__tests__/store.test.ts`
- Create: `lib/session/__tests__/hooks.test.tsx`
- Modify: `hooks/useBuilder.tsx` — mount `<BuilderSessionProvider>` inside `BuilderProvider`. Delete `useBuilderCursorMode` re-export (consumers switch to the session hook).
- Modify: `lib/services/builderStore.ts` — delete `cursorMode`, `activeFieldId`, `chatOpen`, `structureOpen`, `sidebarStash` fields + their actions (`setCursorMode`, `setActiveFieldId`, `setChatOpen`, `setStructureOpen`, `switchCursorMode`).
- Modify: `lib/services/builderSelectors.ts` — delete `selectCursorMode`, `selectChatOpen`, `selectStructureOpen`, `selectEditMode` (or migrate `selectEditMode` to session).
- Modify: `components/builder/BuilderContentArea.tsx` — swap `useBuilderStore((s) => s.chatOpen)` and `s.structureOpen` to `useSidebarState('chat')` / `useSidebarState('structure')`.
- Modify: `components/builder/BuilderLayout.tsx` — if it reads `cursorMode`, swap to `useCursorMode()` from session.
- Modify: `components/builder/CursorModeSelector.tsx` — swap `useBuilderStore((s) => s.cursorMode)` → `useCursorMode()`; `useBuilderStore((s) => s.switchCursorMode)` → `useSwitchCursorMode()`.
- Modify: `components/chat/ChatSidebar.tsx` — if it reads `chatOpen` / closing dispatch, migrate.
- Modify: `components/builder/StructureSidebar.tsx` — same.
- Modify: `components/preview/form/FormRenderer.tsx` — `cursorMode` reads.
- Modify: `components/preview/form/EditableQuestionWrapper.tsx` — `cursorMode` reads.
- Modify: `components/builder/useBuilderShortcuts.ts` — `cursorMode` + `activeFieldId` reads.
- Modify: `lib/routing/builderActions.ts` — `activeFieldId` read at line ~49.
- Modify: other readers as the implementer finds them (grep `cursorMode`, `chatOpen`, `structureOpen`, `sidebarStash`, `activeFieldId` in the legacy store consumers).

**Design:**

```ts
// lib/session/store.ts
import { devtools, subscribeWithSelector } from "zustand/middleware";
import { createStore } from "zustand/vanilla";
import type { CursorMode } from "./types";

export type SidebarKind = "chat" | "structure";

export interface BuilderSessionState {
    /** Current cursor mode — pointer (interact) or edit. */
    cursorMode: CursorMode;
    /** Which [data-field-id] element currently has focus. Transient UI hint,
     *  not undoable. Used by composite undo/redo to restore focus. */
    activeFieldId: string | undefined;
    /** Sidebar visibility. `stashed` holds the pre-pointer-mode value; it's
     *  set by `switchCursorMode` when entering pointer mode and read when
     *  switching back to edit. `undefined` means nothing is stashed. */
    sidebars: {
        chat: { open: boolean; stashed: boolean | undefined };
        structure: { open: boolean; stashed: boolean | undefined };
    };

    // Actions
    /** Atomically switch cursor mode with sidebar stash/restore. Replaces the
     *  legacy store's `sidebarStash` field — the reducer-shaped action collapses
     *  sidebar stash/restore into one set() call.
     *
     *  - pointer: stash current sidebar.open values, then close both.
     *  - edit (with stashed state): restore stashed values, clear stash.
     *  - edit (no stash): no sidebar change. */
    switchCursorMode: (mode: CursorMode) => void;
    /** Non-atomic cursor mode setter — used for non-toggle cases (initial mode). */
    setCursorMode: (mode: CursorMode) => void;
    setActiveFieldId: (fieldId: string | undefined) => void;
    setSidebarOpen: (kind: SidebarKind, open: boolean) => void;
}

export type BuilderSessionStoreApi = ReturnType<typeof createBuilderSessionStore>;

export function createBuilderSessionStore(): BuilderSessionStoreApi {
    return createStore<BuilderSessionState>()(
        devtools(
            subscribeWithSelector((set, get) => ({
                cursorMode: "edit",
                activeFieldId: undefined,
                sidebars: {
                    chat: { open: true, stashed: undefined },
                    structure: { open: true, stashed: undefined },
                },

                switchCursorMode(next) {
                    const s = get();
                    if (next === s.cursorMode) return;

                    if (next === "pointer") {
                        set({
                            cursorMode: next,
                            sidebars: {
                                chat: { open: false, stashed: s.sidebars.chat.open },
                                structure: { open: false, stashed: s.sidebars.structure.open },
                            },
                        });
                        return;
                    }

                    // next === "edit": restore stashed values if present.
                    const chatStashed = s.sidebars.chat.stashed;
                    const structureStashed = s.sidebars.structure.stashed;
                    set({
                        cursorMode: next,
                        sidebars: {
                            chat: {
                                open: chatStashed ?? s.sidebars.chat.open,
                                stashed: undefined,
                            },
                            structure: {
                                open: structureStashed ?? s.sidebars.structure.open,
                                stashed: undefined,
                            },
                        },
                    });
                },

                setCursorMode(mode) {
                    if (mode === get().cursorMode) return;
                    set({ cursorMode: mode });
                },

                setActiveFieldId(fieldId) {
                    if (fieldId === get().activeFieldId) return;
                    set({ activeFieldId: fieldId });
                },

                setSidebarOpen(kind, open) {
                    const s = get();
                    if (s.sidebars[kind].open === open) return;
                    set({
                        sidebars: {
                            ...s.sidebars,
                            [kind]: { ...s.sidebars[kind], open },
                        },
                    });
                },
            })),
            { name: "BuilderSession", enabled: process.env.NODE_ENV === "development" },
        ),
    );
}
```

```tsx
// lib/session/provider.tsx
"use client";
import { createContext, type ReactNode, useContext, useState } from "react";
import { useStore } from "zustand";
import { shallow } from "zustand/shallow";
import { useStoreWithEqualityFn } from "zustand/traditional";
import {
    type BuilderSessionState,
    type BuilderSessionStoreApi,
    createBuilderSessionStore,
} from "./store";

const BuilderSessionContext = createContext<BuilderSessionStoreApi | null>(null);

export function BuilderSessionProvider({ children }: { children: ReactNode }) {
    // Store is created once per provider mount — no hot-swap needed.
    // `buildId` on the parent provider controls lifetime.
    const [store] = useState(() => createBuilderSessionStore());
    return <BuilderSessionContext value={store}>{children}</BuilderSessionContext>;
}

export function useBuilderSession<T>(selector: (s: BuilderSessionState) => T): T {
    const store = useContext(BuilderSessionContext);
    if (!store) throw new Error("useBuilderSession must be used within BuilderSessionProvider");
    return useStore(store, selector);
}

export function useBuilderSessionShallow<T>(selector: (s: BuilderSessionState) => T): T {
    const store = useContext(BuilderSessionContext);
    if (!store) throw new Error("useBuilderSessionShallow must be used within BuilderSessionProvider");
    return useStoreWithEqualityFn(store, selector, shallow);
}
```

```tsx
// lib/session/hooks.tsx
"use client";
import { useBuilderSession, useBuilderSessionShallow } from "./provider";
import type { CursorMode, SidebarKind } from "./store";

export function useCursorMode(): CursorMode {
    return useBuilderSession((s) => s.cursorMode);
}

export function useActiveFieldId(): string | undefined {
    return useBuilderSession((s) => s.activeFieldId);
}

export function useSidebarState(kind: SidebarKind): { open: boolean; stashed: boolean | undefined } {
    return useBuilderSessionShallow((s) => s.sidebars[kind]);
}

export function useSwitchCursorMode(): (mode: CursorMode) => void {
    return useBuilderSession((s) => s.switchCursorMode);
}

export function useSetCursorMode(): (mode: CursorMode) => void {
    return useBuilderSession((s) => s.setCursorMode);
}

export function useSetActiveFieldId(): (fieldId: string | undefined) => void {
    return useBuilderSession((s) => s.setActiveFieldId);
}

export function useSetSidebarOpen(): (kind: SidebarKind, open: boolean) => void {
    return useBuilderSession((s) => s.setSidebarOpen);
}

/** Derive edit mode from cursor mode. `pointer` = test (live), else = edit. */
export function useEditMode(): "edit" | "test" {
    const mode = useCursorMode();
    return mode === "pointer" ? "test" : "edit";
}
```

- [ ] **Step 1: Create `lib/session/store.ts`, `provider.tsx`, `hooks.tsx`**

Write all three files as above. `CursorMode` already exists in `lib/session/types.ts` from Phase 0 — import from there (do not redefine). `SidebarKind` is new; export it from `store.ts`.

- [ ] **Step 2: Write tests**

`store.test.ts` covers the reducer-shaped action invariants:
1. Initial state: `cursorMode === 'edit'`, both sidebars open, no stash.
2. `switchCursorMode('pointer')` from edit with both sidebars open → both `open: false`, both `stashed: true`.
3. `switchCursorMode('edit')` after (2) → both `open: true`, both `stashed: undefined`.
4. `switchCursorMode('pointer')` with chat already closed → chat `{ open: false, stashed: false }`, structure `{ open: false, stashed: true }`; restoring switches back keeps chat closed (this is the specific sidebarStash invariant — it restores the pre-pointer state exactly).
5. `switchCursorMode('pointer')` twice in a row → no-op on the second call (guard against double-entry that would overwrite stash with `{ stashed: false, false }`).
6. `setSidebarOpen('chat', false)` → only chat changes; structure unchanged; stash fields untouched.

`hooks.test.tsx` covers the hook wrappers with a provider wrapper — smoke-level, verifies they read + write correctly.

- [ ] **Step 3: Mount `<BuilderSessionProvider>` inside `BuilderProvider`**

In `hooks/useBuilder.tsx`, add `<BuilderSessionProvider>` as a sibling of the other context providers from Tasks 1, 2, 4. Order irrelevant.

- [ ] **Step 4: Migrate call sites**

Grep for every consumer of the five legacy fields — the implementer must find them, not rely on this plan listing all. Representative list:

- `components/builder/BuilderContentArea.tsx` — reads `chatOpen`, `structureOpen`
- `components/builder/CursorModeSelector.tsx` — reads `cursorMode` + dispatches `switchCursorMode`
- `components/builder/BuilderLayout.tsx` — may read `cursorMode`
- `components/chat/ChatSidebar.tsx` — may read `chatOpen` and dispatch `setChatOpen`
- `components/builder/StructureSidebar.tsx` — may read `structureOpen`
- `components/preview/form/FormRenderer.tsx` — reads `cursorMode`
- `components/preview/form/EditableQuestionWrapper.tsx` — reads `cursorMode`
- `components/builder/useBuilderShortcuts.ts` — reads `cursorMode` + `activeFieldId`
- `lib/routing/builderActions.ts` (line ~49) — reads `activeFieldId`
- `hooks/useBuilder.tsx` — `useBuilderCursorMode` facade hook

For each site, replace `useBuilderStore((s) => s.cursorMode)` with `useCursorMode()` from `@/lib/session/hooks`. Same for the others. Replace dispatches (`useBuilderStore((s) => s.switchCursorMode)` etc.) with their session-hook equivalents.

Delete `useBuilderCursorMode` from `hooks/useBuilder.tsx`.

- [ ] **Step 5: Delete legacy-store fields + actions + selectors**

In `lib/services/builderStore.ts`:
- Delete fields: `cursorMode`, `activeFieldId`, `chatOpen`, `structureOpen`, `sidebarStash`
- Delete actions: `setCursorMode`, `setActiveFieldId`, `setChatOpen`, `setStructureOpen`, `switchCursorMode`
- Update `reset()` to stop touching them
- Remove `cursorMode: "edit" as CursorMode` from initial state etc.

In `lib/services/builderSelectors.ts`:
- Delete `selectCursorMode`, `selectChatOpen`, `selectStructureOpen`, `selectEditMode` (moved to `lib/session/hooks.tsx` as `useEditMode`).

- [ ] **Step 6: Typecheck + test**

```bash
npx tsc --noEmit && echo "✓"
npm test -- --run
```

Tests must pass. Any failing test indicates a missed call site.

- [ ] **Step 7: Commit**

```bash
git add lib/session hooks/useBuilder.tsx \
        lib/services/builderStore.ts lib/services/builderSelectors.ts \
        components/builder/BuilderContentArea.tsx \
        components/builder/CursorModeSelector.tsx \
        components/builder/BuilderLayout.tsx \
        components/builder/StructureSidebar.tsx \
        components/builder/useBuilderShortcuts.ts \
        components/chat/ChatSidebar.tsx \
        components/preview/form/FormRenderer.tsx \
        components/preview/form/EditableQuestionWrapper.tsx \
        lib/routing/builderActions.ts
git commit -m "feat(builder/session): BuilderSession store — cursorMode + sidebars"
```

(Add other modified files the implementer discovers via grep.)

---

### Task 6: BuilderSession — connect stash + `switchConnectMode` composite action

**Spec citation:** Section 4 dissolution table row 6 — "`_connectStash` / `_lastConnectType` → Fields on `BuilderSession`. `switchConnectMode` is a composite action that mutates BlueprintDoc (via `updateForm`) and updates session stash atomically."

**Files:**
- Modify: `lib/session/store.ts` — add `connectStash` + `lastConnectType` fields; `switchConnectMode`, `stashFormConnect`, `getFormConnectStash` actions.
- Modify: `lib/session/hooks.tsx` — add `useSwitchConnectMode`, `useStashFormConnect`, `useFormConnectStash` hooks.
- Modify: `lib/session/__tests__/store.test.ts` — tests for the new actions.
- Modify: `components/builder/detail/AppConnectSettings.tsx` — swap `builder.switchConnectMode(type)` (~line 22) to `useSwitchConnectMode()`.
- Modify: `components/builder/detail/FormSettingsPanel.tsx` — swap `engine.stashFormConnect(...)` (~line 755) and `engine.getFormConnectStash(...)` (~line 767).
- Modify: `lib/services/builderEngine.ts` — delete `_connectStash`, `_lastConnectType`, `switchConnectMode`, `stashFormConnect`, `getFormConnectStash`, `stashAllFormConnect`.

**Design note on cross-store dispatch:** The `switchConnectMode` action mutates the **doc store**, not the session store. The session stores the stash; the doc holds the result. To avoid coupling the session store to the doc store directly (which would require the provider to wire a doc-store reference into session creation), we use the same pattern as today's `engine._docStore`: the provider installs a reference on the session store right after both stores mount.

Alternative considered: pass the doc store as an argument to `switchConnectMode(type, docStore)` and have callers fetch it via context. This pushes knowledge of the doc store into every call site — worse.

Chosen: a `_docStore` field on the session store, set by `<BuilderSessionProvider>` via a one-shot effect inside `BuilderProvider`. The session store's `switchConnectMode` reads `get()._docStore` and dispatches doc mutations via it. Matches the legacy-store pattern and keeps consumers clean.

```ts
// Additions to lib/session/store.ts
import type { BlueprintDocStore } from "@/lib/doc/provider";
import type { Mutation } from "@/lib/doc/types";
import type { ConnectConfig, ConnectType } from "@/lib/schemas/blueprint";

export interface BuilderSessionState {
    // ... existing fields

    /** Installed by BuilderSessionProvider once the doc store is available.
     *  Used by `switchConnectMode` to dispatch doc mutations atomically
     *  alongside session-state updates. */
    _docStore: BlueprintDocStore | null;
    _setDocStore: (store: BlueprintDocStore | null) => void;

    /** Preserved form connect configs across mode switches. Keyed by
     *  connect type → form uuid → config. Uses uuid instead of
     *  moduleIndex/formIndex so renames and reorders don't invalidate
     *  the stash. */
    connectStash: Record<ConnectType, Record<string /* formUuid */, ConnectConfig>>;
    lastConnectType: ConnectType | undefined;

    switchConnectMode: (type: ConnectType | null | undefined) => void;
    stashFormConnect: (mode: ConnectType, formUuid: string, config: ConnectConfig) => void;
    getFormConnectStash: (mode: ConnectType, formUuid: string) => ConnectConfig | undefined;
}
```

Action implementation:

```ts
switchConnectMode(type) {
    const s = get();
    const docStore = s._docStore;
    if (!docStore) return;
    const docState = docStore.getState();
    if (docState.moduleOrder.length === 0) return;

    const currentType = docState.connectType ?? undefined;
    const resolved = type === undefined ? (s.lastConnectType ?? "learn") : type;
    if (resolved === currentType) return;

    // Stash outgoing mode — walk the doc to collect live form configs.
    let nextStash = s.connectStash;
    if (currentType) {
        const outgoing: Record<string, ConnectConfig> = {};
        for (const moduleUuid of docState.moduleOrder) {
            const formUuids = docState.formOrder[moduleUuid] ?? [];
            for (const formUuid of formUuids) {
                const form = docState.forms[formUuid];
                if (form?.connect) {
                    outgoing[formUuid] = structuredClone(form.connect);
                }
            }
        }
        nextStash = { ...nextStash, [currentType]: outgoing };
    }

    // Build doc mutations: setConnectType + restore/clear.
    const mutations: Mutation[] = [
        { kind: "setConnectType", connectType: resolved ?? null },
    ];
    if (resolved) {
        const stashed = nextStash[resolved] ?? {};
        for (const [formUuid, config] of Object.entries(stashed)) {
            if (docState.forms[formUuid]) {
                mutations.push({
                    kind: "updateForm",
                    uuid: formUuid as Uuid,
                    patch: { connect: structuredClone(config) },
                });
            }
        }
    } else {
        for (const moduleUuid of docState.moduleOrder) {
            const formUuids = docState.formOrder[moduleUuid] ?? [];
            for (const formUuid of formUuids) {
                if (docState.forms[formUuid]?.connect !== undefined) {
                    mutations.push({
                        kind: "updateForm",
                        uuid: formUuid as Uuid,
                        patch: { connect: undefined },
                    });
                }
            }
        }
    }

    // Atomic commit: update session state AND doc state.
    // Doc's applyMany collapses into one undo entry; zundo tracks the doc only,
    // so the session state change is not undoable (intended — stash is transient).
    set({
        connectStash: nextStash,
        lastConnectType: currentType ?? s.lastConnectType,
    });
    docStore.getState().applyMany(mutations);
},
```

Note the key shape change: the legacy engine stashed by `moduleIndex`/`formIndex` via `Map<number, Map<number, ConnectConfig>>`. The new version stashes by **formUuid** — stable across reorder + rename. This is an invariant upgrade that's worth an explicit callout; if the SA or any other caller passes indices, the implementer must convert to uuids at the call site (both remaining callers use `form.uuid` which is directly available).

- [ ] **Step 1: Extend `lib/session/store.ts`**

Add the fields + actions above. Initial state: `connectStash: { learn: {}, deliver: {} }`, `lastConnectType: undefined`, `_docStore: null`.

- [ ] **Step 2: Extend `lib/session/provider.tsx`**

Inside `BuilderSessionProvider`, after `createBuilderSessionStore`, wire the doc-store ref:

```tsx
// Alternative: BuilderProvider hooks both stores and installs the ref imperatively
// in a useEffect. See Step 4 below for the chosen pattern — keep the provider
// component itself free of cross-store wiring; the installation lives in
// `hooks/useBuilder.tsx` alongside the existing SyncBridge.
```

(Implementer: pick one — either install inside BuilderSessionProvider by reading BlueprintDocContext, or install in useBuilder.tsx's provider tree. Both work; the latter keeps session provider pure.)

- [ ] **Step 3: Extend `hooks.tsx` with new session hooks**

`useSwitchConnectMode`, `useStashFormConnect`, `useFormConnectStash`.

`useFormConnectStash` is a reader — subscribe with a narrow selector:

```tsx
export function useFormConnectStash(mode: ConnectType, formUuid: string): ConnectConfig | undefined {
    return useBuilderSession((s) => s.connectStash[mode]?.[formUuid]);
}
```

- [ ] **Step 4: Install doc-store ref on session**

In `hooks/useBuilder.tsx`'s `SyncBridge` (or equivalent), after installing the doc store on the legacy store:

```tsx
useEffect(() => {
    if (!docStore || !sessionStore) return;
    sessionStore.getState()._setDocStore(docStore);
    return () => {
        sessionStore.getState()._setDocStore(null);
    };
}, [docStore, sessionStore]);
```

The `sessionStore` reference comes from the `BuilderSessionContext` — lift it into the `SyncBridge` via `useContext`.

- [ ] **Step 5: Migrate `AppConnectSettings.tsx`**

Line ~22: `const builder = useBuilderEngine(); builder.switchConnectMode(type)` → `const switchMode = useSwitchConnectMode(); switchMode(type)`. Delete the `useBuilderEngine` import if nothing else in the file needs it.

- [ ] **Step 6: Migrate `FormSettingsPanel.tsx`**

Lines ~755, ~767: swap `engine.stashFormConnect(mode, mIdx, fIdx, config)` to `stashFormConnect(mode, formUuid, config)` and `engine.getFormConnectStash(mode, mIdx, fIdx)` to `useFormConnectStash(mode, formUuid)`.

**Critical uuid conversion.** The legacy calls used indices. The new ones use uuids. Find where `form.uuid` is available (it's on the `form` entity this panel already has in scope) and pass it. If for some reason only indices are available, resolve via `docStore.getState().moduleOrder[mIdx]` + `formOrder[moduleUuid][fIdx]`. The implementer must verify the call-site has the uuid directly before committing — do NOT swap in a fallback that re-introduces index-based lookup.

- [ ] **Step 7: Delete engine connect-stash members**

In `lib/services/builderEngine.ts`, delete:
- `_connectStash` field
- `_lastConnectType` field
- `switchConnectMode`, `stashFormConnect`, `getFormConnectStash`, `stashAllFormConnect` methods
- Lines in `reset()` that clear `_connectStash.learn`, `_connectStash.deliver`, `_lastConnectType`

- [ ] **Step 8: Test**

Add to `lib/session/__tests__/store.test.ts`:
1. `switchConnectMode('learn')` from `connectType === undefined` → doc's connectType becomes `"learn"`, session stash empty.
2. Set up a doc with `connectType === 'learn'` and a form with a `learn_module` connect config; call `switchConnectMode('deliver')` → doc connectType is `"deliver"`, session stash[`learn`][formUuid] has the stashed config, `lastConnectType === 'learn'`.
3. Then `switchConnectMode('learn')` → doc connectType is `"learn"`, form's connect restored to the stashed config.
4. `switchConnectMode(null)` → doc connectType becomes `null`, all forms' `connect` cleared.
5. `switchConnectMode(undefined)` with `lastConnectType === 'deliver'` → resolves to `"deliver"`.

Tests use a real `createBlueprintDocStore()` with a fixture app. This is integration-level but small enough to live in the session test file.

- [ ] **Step 9: Typecheck + test + commit**

```bash
npx tsc --noEmit && echo "✓"
npm test -- --run
git add lib/session lib/services/builderEngine.ts \
        components/builder/detail/AppConnectSettings.tsx \
        components/builder/detail/FormSettingsPanel.tsx \
        hooks/useBuilder.tsx
git commit -m "refactor(builder/session): move connect stash off engine"
```

---

### Task 7: Delete new-question marker + rename notice; migrate focus hint to session

**Spec citation:** Section 4 dissolution table row 5 — "`_focusHint`, `_renameNotice`, `_newQuestionUuid` → Removed or inverted — rename feedback uses a toast; new-question focus is URL-driven: `moveQuestion` returns new uuid → caller pushes `?sel=<newUuid>` → effect scrolls-on-selection-change."

**Files:**
- Modify: `lib/session/store.ts` — add `focusHint: string | undefined`, `setFocusHint`, `clearFocusHint` action.
- Modify: `lib/session/hooks.tsx` — add `useFocusHint`, `useSetFocusHint`, `useClearFocusHint`.
- Modify: `lib/services/builderEngine.ts` — delete `_focusHint`, `_renameNotice`, `_newQuestionUuid`, `setFocusHint`, `focusHint` getter, `clearFocusHint`, `renameNotice` getter, `setRenameNotice`, `consumeRenameNotice`, `markNewQuestion`, `isNewQuestion`, `clearNewQuestion`.
- Modify: `components/builder/contextual/shared.ts` (lines ~183, ~189) — swap `engine.focusHint` + `engine.clearFocusHint()` → session hooks.
- Modify: `lib/routing/builderActions.ts` (line ~72) — swap `engine.setFocusHint(activeFieldId)` → session `useSetFocusHint`.
- Modify: `components/preview/form/QuestionTypePicker.tsx` (line ~95) — delete `engine.markNewQuestion(newUuid)`. The URL selection (`router.replace({ sel: newUuid })` already done via `useSelect`) is the focus signal now.
- Modify: `components/builder/contextual/ContextualEditorHeader.tsx` — delete `engine.isNewQuestion(selectedUuid)` (~line 177), `engine.clearNewQuestion()` (~line 156), `engine.consumeRenameNotice()` (~line 120). The ID field's auto-focus + select-all on new questions is now triggered by a different mechanism — see next bullet.

**New-question focus mechanism.** Today the engine's `_newQuestionUuid` is checked on mount of `ContextualEditorHeader` to trigger auto-focus + select-all on the ID input. Spec says this becomes URL-driven — but the URL `?sel=<uuid>` is the selection signal, not the "this is brand new, focus and select-all" signal. How to distinguish a newly-added question from an existing-selected question on mount?

Design: add an ephemeral one-shot `newQuestionUuid?: string` field to `BuilderSession` that's set by `QuestionTypePicker` on add and consumed-once by `ContextualEditorHeader`. This is the same role the engine field played — we're just moving it to the session store with a narrower API and calling it what it is.

Wait — the spec says `_newQuestionUuid` is "Removed or inverted". If we keep the exact mechanism on session, we haven't removed it, we've relocated it. Reading more carefully: the spec's next sentence explains *how* the inversion works: "moveQuestion returns new uuid → caller pushes ?sel=<newUuid> → effect scrolls-on-selection-change." That's about **move** + scroll, not about **add** + focus. The add flow keeps needing a "this is new, focus and select-all" signal that's distinct from plain selection.

Decision: delete `_newQuestionUuid` off the engine, but **add** `newQuestionUuid` to BuilderSession with the same one-shot semantics. This matches the spec's "Removed or inverted" (relocated to the right home, not literally deleted). Document the decision in the task commit message for the spec reviewer.

Actions: `useMarkNewQuestion(uuid)`, `useIsNewQuestion(uuid)`, `useClearNewQuestion()`.

(The spec-reviewer check: "is the relocation justified or should this be deleted entirely in favor of a pure URL signal?" — the answer is that the URL signal can't carry the distinction between "selected because newly added, focus + select-all the ID" vs "selected because the user clicked it, just show the panel". Adding a second URL param for that would pollute the URL with transient flags.)

- [ ] **Step 1: Extend session store**

Add fields: `focusHint: string | undefined`, `newQuestionUuid: string | undefined`. Actions: `setFocusHint`, `clearFocusHint`, `markNewQuestion(uuid)`, `isNewQuestion(uuid): boolean` (reader-as-action for imperative use), `clearNewQuestion`.

- [ ] **Step 2: Extend `hooks.tsx`**

```tsx
export function useFocusHint(): string | undefined {
    return useBuilderSession((s) => s.focusHint);
}
export function useSetFocusHint() {
    return useBuilderSession((s) => s.setFocusHint);
}
export function useClearFocusHint() {
    return useBuilderSession((s) => s.clearFocusHint);
}
export function useIsNewQuestion(uuid: string): boolean {
    return useBuilderSession((s) => s.newQuestionUuid === uuid);
}
export function useMarkNewQuestion() {
    return useBuilderSession((s) => s.markNewQuestion);
}
export function useClearNewQuestion() {
    return useBuilderSession((s) => s.clearNewQuestion);
}
```

- [ ] **Step 3: Migrate `QuestionTypePicker.tsx`**

`engine.markNewQuestion(newUuid)` → `const markNew = useMarkNewQuestion(); markNew(newUuid)`. Same call site, same timing, new owner.

- [ ] **Step 4: Migrate `ContextualEditorHeader.tsx`**

- `engine.isNewQuestion(selectedUuid)` → `useIsNewQuestion(selectedUuid)`
- `engine.clearNewQuestion()` → `useClearNewQuestion()`
- Delete `engine.consumeRenameNotice()` call and any UI that rendered the rename notice inline (the toast replaces this — T8 wires the toast on the mutation-result metadata channel).

If the rename notice had its own UI (e.g. a small `<p>` under the ID field), delete that markup + its styles. The user feedback comes from a toast instead.

- [ ] **Step 5: Migrate `shared.ts` focus hint**

`engine.focusHint` → `useFocusHint()`. `engine.clearFocusHint()` → `useClearFocusHint()`.

- [ ] **Step 6: Migrate `builderActions.ts`**

Line ~72: `engine.setFocusHint(activeFieldId)` → the composite hook already has `useSetFocusHint` in scope (it's a React hook), call it before the imperative section.

- [ ] **Step 7: Delete engine members**

In `lib/services/builderEngine.ts`:
- Delete `_focusHint`, `_renameNotice`, `_newQuestionUuid` fields
- Delete `focusHint` getter, `setFocusHint`, `clearFocusHint`, `renameNotice` getter, `setRenameNotice`, `consumeRenameNotice`, `markNewQuestion`, `isNewQuestion`, `clearNewQuestion` methods
- Remove their clears from `reset()`

- [ ] **Step 8: Tests**

Add to `lib/session/__tests__/store.test.ts`:
1. `setFocusHint('case_name') + clearFocusHint() → focusHint === undefined`.
2. `markNewQuestion('q-uuid') + isNewQuestion('q-uuid') → true; isNewQuestion('other') → false`.
3. `clearNewQuestion() → isNewQuestion(anything) → false`.

- [ ] **Step 9: Typecheck + test + commit**

```bash
git add lib/session lib/services/builderEngine.ts \
        components/preview/form/QuestionTypePicker.tsx \
        components/builder/contextual/ContextualEditorHeader.tsx \
        components/builder/contextual/shared.ts \
        lib/routing/builderActions.ts
git commit -m "refactor(builder): delete rename notice; move focus hint + new-question marker to session"
```

---

### Task 8: MoveQuestionResult.renamed + QuestionRenameResult.xpathFieldsRewritten + toast wiring

**Spec citation:** Section 4 dissolution table row 5 (rename feedback → toast) + Phase 2 plan non-goal #10 ("MoveQuestionResult.renamed and QuestionRenameResult.xpathFieldsRewritten — deferred to Phase 3").

**Files:**
- Modify: `lib/doc/mutations/questions.ts` — populate `renamed` in `moveQuestion`'s result and `xpathFieldsRewritten` in `renameQuestion`'s result. These are already shipped as types; only the reducer needs to fill them.
- Modify: `lib/doc/store.ts` (or wherever `doc.apply()` lives) — add an `applyWithResult<T>(mut): T` method that returns the reducer's result, or extend the existing `apply` signature to return metadata. Implementer picks the API shape per the design note below.
- Modify: `lib/doc/hooks/useBlueprintMutations.ts` — `moveQuestion` and `renameQuestion` dispatch via `applyWithResult` and return the metadata.
- Modify: `components/builder/useBuilderShortcuts.ts` (lines ~221, ~253) — consume the new metadata and call `showToast("info", ...)` on auto-rename.
- Modify: `components/preview/form/FormRenderer.tsx` (line ~758) — same: toast on drag-drop auto-rename.
- Modify: `lib/doc/__tests__/hooks-useBlueprintMutations.test.tsx` — test that `moveQuestion` returns the renamed metadata and `renameQuestion` returns `xpathFieldsRewritten`.

**API design note.** The doc store's mutation dispatch today is `store.getState().apply(mutation): void`. Adding a return value to `apply` changes every call site's signature implicitly. Options:

1. **Extend `apply` to return `void | MutationResult`.** Callers that don't care ignore it. Forward-compatible; no new method. Downside: the type becomes `void | T` which TypeScript handles but looks odd.
2. **Add `applyWithResult<T>(mut): T`.** Separate method; `apply` stays `void`. Cleaner types. Downside: two methods doing the same thing.
3. **Return the result via a side-channel event.** Subscribers fire on every mutation with the result payload. Too indirect for this use case.

**Chosen: Option 2 — `applyWithResult<T>(mut): T`**. `apply` stays the fire-and-forget path for 90% of call sites; `applyWithResult` is the typed-return path for the 2 mutations that produce useful metadata. Easy to add more later.

```ts
// lib/doc/store.ts (additions)
import type { MoveQuestionResult, QuestionRenameResult } from "./mutations/questions";

// Overloads — typed per-mutation-kind result:
function applyWithResult(mut: { kind: "moveQuestion"; ... }): MoveQuestionResult;
function applyWithResult(mut: { kind: "renameQuestion"; ... }): QuestionRenameResult;
// ... the general case (void for all others)
function applyWithResult(mut: Mutation): void;
function applyWithResult(mut: Mutation): unknown {
    let result: unknown;
    set((draft) => {
        result = applyMutation(draft, mut); // reducer now returns metadata for these two kinds
    });
    return result;
}
```

- [ ] **Step 1: Populate `MoveQuestionResult.renamed` in the doc reducer**

Read `lib/doc/mutations/questions.ts`'s current `moveQuestion` reducer. The existing sibling-dedup logic (which handles cross-level moves where the target parent already has a sibling with the same id) is there — it just doesn't return metadata. Wrap that logic to capture:

```ts
let renameMeta: MoveQuestionResult["renamed"] = undefined;
// ... during move:
if (newSiblingId !== oldId) {
    // The dedup happened. Capture:
    const xpathFieldsRewritten = /* existing xpath rewrite count from the helper */;
    renameMeta = {
        oldId,
        newId: newSiblingId,
        newPath: /* built path */,
        xpathFieldsRewritten,
    };
}
return { renamed: renameMeta } as MoveQuestionResult;
```

The exact code depends on the reducer's current shape — read before writing. The xpath rewrite count likely comes from the `rewriteXPathReferences` helper; if it doesn't return a count today, extend it to do so.

- [ ] **Step 2: Populate `QuestionRenameResult.xpathFieldsRewritten` in `renameQuestion`**

Same pattern — the reducer already rewrites xpath references; just count them and return the count in the result.

- [ ] **Step 3: Add `applyWithResult` to the doc store**

Implement in `lib/doc/store.ts` (or wherever `apply` lives — find it via grep for `apply(mutation`). Keep the signature as an overload set so the call sites get typed returns.

- [ ] **Step 4: Update `useBlueprintMutations.ts`**

The `moveQuestion` hook-level wrapper currently calls `doc.apply({ kind: "moveQuestion", ... })` and returns `void`. Change it to call `doc.applyWithResult({ kind: "moveQuestion", ... })` and return the `MoveQuestionResult`. Same for `renameQuestion` → `QuestionRenameResult`.

Update the return type in the hook. Callers that ignored the return keep working.

- [ ] **Step 5: Wire toast on auto-rename**

`useBuilderShortcuts.ts` around line ~221 (the keyboard-driven cross-level move):

```ts
import { showToast } from "@/lib/services/toastStore";

const result = mutations.moveQuestion(uuid, { targetParent: ... });
if (result.renamed) {
    showToast(
        "info",
        "Question renamed to avoid conflict",
        `"${result.renamed.oldId}" → "${result.renamed.newId}" (${result.renamed.xpathFieldsRewritten} reference${result.renamed.xpathFieldsRewritten === 1 ? "" : "s"} updated)`,
    );
}
```

Delete the `// phase-1b-task-10` comment. Same pattern at line ~253 (the other move path).

`FormRenderer.tsx` around line ~758 (drag-drop move handler):

```ts
const result = mutations.moveQuestion(draggedUuid, dropOpts);
if (result.renamed) {
    showToast("info", "Question renamed to avoid conflict", ...);
}
```

Delete the `// phase-1b-task-10` comment.

- [ ] **Step 6: Tests**

Add to `lib/doc/__tests__/mutations-questions.test.ts` (or whatever the file is named):

1. Fixture doc with two forms; move a question from form A (id `case_name`) to form B which already has `case_name`. Result's `renamed` should have `oldId: 'case_name'`, `newId: 'case_name_2'` (or whatever the dedup suffix logic produces), and `xpathFieldsRewritten` matching the number of xpath references that pointed at the moved question.
2. Move a question where no dedup is needed → `renamed === undefined`.
3. Rename a question with xpath references in sibling fields → `xpathFieldsRewritten > 0`.
4. Rename with no xpath references → `xpathFieldsRewritten === 0`.

Add to `lib/doc/__tests__/hooks-useBlueprintMutations.test.tsx`:
1. `moveQuestion` returns `MoveQuestionResult` with populated `renamed` in the dedup case.
2. `renameQuestion` returns `QuestionRenameResult` with populated `xpathFieldsRewritten`.

- [ ] **Step 7: Typecheck + test + commit**

```bash
git add lib/doc \
        components/builder/useBuilderShortcuts.ts \
        components/preview/form/FormRenderer.tsx
git commit -m "feat(builder/doc): return move + rename metadata for toast UX"
```

---

### Task 9: Migrate `deriveTreeData` + `selectHasData` to doc hooks

**Spec citation:** Section 5 "Selector API unification" — all reads go through named domain hooks. Specific to Phase 3: the `useBuilderTreeData` React consumer migrates off the legacy store's mirrored entity maps and reads directly from the doc.

**Files:**
- Create: `lib/doc/hooks/useDocTreeData.ts` (or rename — implementer picks a name consistent with the existing `lib/doc/hooks/*` conventions).
- Create: `lib/doc/hooks/useDocHasData.ts`
- Create: `lib/doc/hooks/__tests__/useDocTreeData.test.tsx`
- Modify: `hooks/useBuilder.tsx` — delete `useBuilderTreeData` implementation (or re-export from the doc hook).
- Modify: `lib/services/builderSelectors.ts` — delete `deriveTreeData`, `TreeDataSource`, `selectHasData`, `mergeScaffoldWithPartials` (if only used by deriveTreeData).
- Modify: Every reader of `useBuilderTreeData` — keep the same hook name but switch the import to the new module (or re-export for compat).

**Design:**

`useDocTreeData(generationData)` takes the legacy store's `generationData` as a parameter (not a subscription) so the doc hook stays pure w.r.t. legacy-store state. The caller threads it in. The old `deriveTreeData` signature already had a `TreeDataSource` with `generationData` in it — we keep that decoupling.

```tsx
// lib/doc/hooks/useDocTreeData.ts
import { useMemo } from "react";
import { BuilderPhase } from "@/lib/services/builder";
import type { TreeData } from "@/lib/services/builder";
import type { GenerationData } from "@/lib/services/builderStore";
import { useBlueprintDocShallow } from "./useDocStore";
import type { Uuid } from "@/lib/doc/types";

interface DocTreeInputs {
    phase: BuilderPhase;
    generationData: GenerationData | undefined;
}

export function useDocTreeData({ phase, generationData }: DocTreeInputs): TreeData | undefined {
    // Subscribe to exactly the doc fields the derivation reads.
    const doc = useBlueprintDocShallow((s) => ({
        appName: s.appName,
        connectType: s.connectType,
        modules: s.modules,
        forms: s.forms,
        questions: s.questions,
        moduleOrder: s.moduleOrder,
        formOrder: s.formOrder,
        questionOrder: s.questionOrder,
    }));

    return useMemo(() => {
        // Ready/Completed: normalized entities
        if (doc.moduleOrder.length > 0 && phase !== BuilderPhase.Generating) {
            return {
                app_name: doc.appName,
                connect_type: doc.connectType ?? undefined,
                modules: doc.moduleOrder.map((moduleUuid: Uuid) => {
                    const mod = doc.modules[moduleUuid];
                    const formUuids = doc.formOrder[moduleUuid] ?? [];
                    return {
                        name: mod.name,
                        case_type: mod.caseType,
                        // ... rest of the existing deriveTreeData logic, translated
                        //     to read from doc entity fields with branded Uuid types
                    };
                }),
            };
        }

        // Generation phase: use generationData (legacy store) — identical to today
        if (!generationData) return undefined;
        if (generationData.scaffold && Object.keys(generationData.partialModules).length > 0) {
            return mergeScaffoldWithPartials(generationData.scaffold, generationData.partialModules);
        }
        if (generationData.scaffold) return generationData.scaffold;
        if (generationData.partialScaffold && generationData.partialScaffold.modules.length > 0) {
            return {
                app_name: generationData.partialScaffold.appName ?? "",
                modules: generationData.partialScaffold.modules,
            };
        }
        return undefined;
    }, [doc, phase, generationData]);
}
```

`useDocHasData`:

```ts
// lib/doc/hooks/useDocHasData.ts
import { useBlueprintDoc } from "./useDocStore";

export function useDocHasData(): boolean {
    return useBlueprintDoc((s) => s.moduleOrder.length > 0);
}
```

`useBuilderTreeData` in `hooks/useBuilder.tsx` becomes a thin wrapper that reads `phase` + `generationData` from the legacy store and delegates:

```tsx
export function useBuilderTreeData(): TreeData | undefined {
    const inputs = useBuilderStoreShallow((s) => ({
        phase: s.phase,
        generationData: s.generationData,
    }));
    return useDocTreeData(inputs);
}
```

- [ ] **Step 1: Create `useDocTreeData.ts` and `useDocHasData.ts`**

Port the full logic from `deriveTreeData` — `assembleQuestions`, `mergeScaffoldWithPartials`, and everything else it pulls in. Move `assembleQuestions` and `mergeScaffoldWithPartials` to `lib/doc/hooks/treeDataHelpers.ts` if they're only used by this hook; otherwise leave them where they are and import.

Types: the doc's `ModuleEntity`/`FormEntity`/`QuestionEntity` use branded `Uuid` keys and camelCase field names (`caseType` not `case_type`). The output `TreeData` uses snake_case (CommCare wire format). The translation already exists in `deriveTreeData` — preserve it exactly.

- [ ] **Step 2: Tests**

`useDocTreeData.test.tsx`:
1. Empty doc, phase=Idle → `undefined`.
2. Populated doc, phase=Ready → full `TreeData` with modules and forms.
3. Empty doc, phase=Generating, partialScaffold has 2 modules → TreeData with 2 unpopulated modules.
4. Populated doc, phase=Generating, full scaffold + partialModules → merged view.

These tests existed for `deriveTreeData` under `lib/services/__tests__/`. Port them — change the input shape from `TreeDataSource` to a `{ doc, phase, generationData }` triple; they should pass identically.

- [ ] **Step 3: Migrate `useBuilderTreeData` in `hooks/useBuilder.tsx`**

Rewrite as the thin wrapper above. Keep the exported name `useBuilderTreeData` so call sites don't have to change.

- [ ] **Step 4: Migrate `selectHasData` → `useDocHasData`**

Grep for `selectHasData` + `useBuilderHasData`. The facade hook `useBuilderHasData` in `hooks/useBuilder.tsx` becomes a thin re-export:

```tsx
export { useDocHasData as useBuilderHasData } from "@/lib/doc/hooks/useDocHasData";
```

- [ ] **Step 5: Delete `deriveTreeData` + `TreeDataSource` + `selectHasData` from `builderSelectors.ts`**

Delete the function definitions + `mergeScaffoldWithPartials` if unused elsewhere. Keep `selectIsReady` (still reads `phase` which stays on legacy).

- [ ] **Step 6: Typecheck + test + commit**

```bash
git add lib/doc/hooks hooks/useBuilder.tsx lib/services/builderSelectors.ts
git commit -m "refactor(builder): useDocTreeData reads from doc store directly"
```

---

### Task 10a: `EngineController` resubscribes to the doc store

**Spec citation:** Section 1 "BlueprintDoc (the domain store)" — "Consumers never read `store.questions` directly. Domain hooks ... are the only public surface." The engine controller is the one non-React consumer; it needs to subscribe to the doc directly.

**Files:**
- Modify: `lib/preview/engine/engineController.ts` — swap `BuilderStoreApi` → `BlueprintDocStore`. Update ~10 subscription + read call sites.
- Modify: `lib/preview/engine/engineController.ts` type imports.
- Modify: Tests in `lib/preview/engine/__tests__/*` (if any exist) — update fixtures to use a doc store instead of a legacy store. Find via `npm test -- --run engineController` after editing.

**Design:** The doc store's entity field shapes (`ModuleEntity`, `FormEntity`, `QuestionEntity`) are structurally identical to the legacy store's (`NModule`, `NForm`, `NQuestion`) — both are camelCase without nested arrays (the `toDoc` converter handles snake → camel at the wire boundary). The only runtime difference is branded vs. plain-string keys, which are irrelevant to runtime behavior and bridged via `as unknown as ...` casts where the compiler complains.

The engine controller takes `moduleIndex` / `formIndex` as its external API today — this stays. Internally, `activateForm` resolves the uuids via `s.moduleOrder[mIdx]` + `s.formOrder[moduleUuid][fIdx]`. The doc store has the same shape, so the translation is one-for-one.

Existing helper functions `assembleFormFromStore`, `collectFormUuids`, `buildPathMaps` — most of these take a `state` shape argument that's duck-typed. Check each:

- `assembleFormFromStore(state, mIdx, fIdx)` — reads `state.moduleOrder`, `state.formOrder`, `state.forms`, `state.questions`, `state.questionOrder`. All of those exist on the doc state with identical shapes. Update the parameter type.
- `collectFormUuids(formId, questionOrder)` — takes a bare `Record<string, string[]>`. Doc has `Record<Uuid, Uuid[]>` — cast through `unknown` at the call site.
- `buildPathMaps` — takes assembled `form.questions` array. Unrelated to store shape.
- `classifyChange(current, previous)` — takes `QuestionEntity`-ish objects; shapes already match.

- [ ] **Step 1: Read the full engineController.ts**

Before editing. It's ~720 lines; understand all subscription sites and what they read.

- [ ] **Step 2: Swap type imports**

```ts
// Before
import type { BuilderStoreApi } from "@/lib/services/builderStore";
// After
import type { BlueprintDocStore } from "@/lib/doc/provider";
```

Rename the private field:

```ts
// Before
private blueprintStore: BuilderStoreApi | undefined;
setBlueprintStore(blueprintStore: BuilderStoreApi): void
// After
private docStore: BlueprintDocStore | undefined;
setDocStore(docStore: BlueprintDocStore): void
```

(`setDocStore` name also eliminates the ambiguity with "blueprint store" — the engine controller specifically needs the doc.)

- [ ] **Step 3: Update `activateForm`**

```ts
activateForm(moduleIndex: number, formIndex: number, caseData?: Map<string, string>): void {
    this.deactivate();
    if (!this.docStore) return;
    const s = this.docStore.getState();
    const moduleUuid = s.moduleOrder[moduleIndex];
    if (!moduleUuid) return;
    const formUuid = s.formOrder[moduleUuid]?.[formIndex];
    if (!formUuid) return;

    // ... rest of the function — same logic, uuid-typed reads
}
```

- [ ] **Step 4: Update `setupPerQuestionSubscriptions`, `setupStructuralSubscription`, `setupMetadataSubscription`**

All three use `store.subscribe(selector, listener)` with selectors that read `s.questions[uuid]`, `s.questionOrder`, `s.forms`, `s.modules`, `s.moduleOrder`, `s.formOrder`, `s.caseTypes`. Doc state has all of these — update type annotations + selector code. No semantic changes.

Example (current):

```ts
const unsub = store.subscribe(
    (s) => s.questions[uuid],
    (current, previous) => { /* ... */ },
);
```

New:

```ts
const unsub = store.subscribe(
    (s) => s.questions[uuid as Uuid],
    (current, previous) => { /* classifyChange still works unchanged */ },
);
```

- [ ] **Step 5: Update the internal helpers that read store state**

`assembleFormFromStore` and any others — change parameter type from `BuilderState` to `BlueprintDoc` (or leave as a narrow structural type that both shapes satisfy — either works). Prefer the structural type if it already exists.

- [ ] **Step 6: Update consumers that install the store**

`BuilderEngine.constructor` calls `this.engineController.setBlueprintStore(this.store)` today. This call site will be deleted by T13 when the engine itself goes away; for T10a, just update the method name:

```ts
// In builderEngine.ts constructor (temporary, until T13):
this.engineController.setDocStore(/* doc store not yet available in constructor */);
```

Actually the doc store isn't available in the engine constructor today — the engine's `setDocStore` is called by SyncBridge from React effect. Follow the existing pattern: add a new `SyncBridge` line `engine.engineController.setDocStore(docStore)` alongside `engine.setDocStore(docStore)`. Remove the old `setBlueprintStore(this.store)` call from the engine constructor.

Check `useFormEngine.ts` — it accesses `builderEngine.engineController` to call methods. Those calls don't touch the store wiring; no changes there for T10a.

- [ ] **Step 7: Tests**

Find engine controller tests — likely `lib/preview/engine/__tests__/engineController.test.ts` or similar. They'll be using a fixture legacy store. Swap the fixture to a doc store:

```ts
import { createBlueprintDocStore } from "@/lib/doc/store";
const store = createBlueprintDocStore();
store.getState().loadBlueprint(fixtureBlueprint);
const controller = new EngineController();
controller.setDocStore(store);
```

If the tests don't exist, add minimal coverage: `activateForm` activates correctly; per-question subscription fires on a question update; structural subscription fires on question add/remove.

- [ ] **Step 8: Typecheck + test + commit**

```bash
git add lib/preview/engine hooks/useBuilder.tsx lib/services/builderEngine.ts
git commit -m "refactor(preview/engine): EngineController subscribes to doc store"
```

---

### Task 10b: Move `updateCaseProperty` + `searchBlueprint` off the legacy store

**Spec citation:** Section 1 "BlueprintDoc (the domain store)" + Section 5 — reads and writes to entity data go through the doc API; the legacy store should not hold entity data.

**Files:**
- Modify: `lib/doc/hooks/useBlueprintMutations.ts` — add `updateCaseProperty(caseTypeName, propertyName, updates)` action that reads current `caseTypes` from doc + dispatches `setCaseTypes` with the modified array.
- Create: `lib/doc/hooks/useSearchBlueprint.ts` — hook returning `(query: string) => SearchResult[]` that reads doc state and calls the existing `searchBlueprint` function from `lib/services/blueprintHelpers.ts`.
- Modify: `lib/services/builderStore.ts` — delete `updateCaseProperty` + `searchBlueprint` actions + `renameCaseProperty` stub. Delete the internal `assembleBlueprint(getEntityData(s))` reads (they won't compile once entity fields are gone in T11 anyway).
- Find call sites of `updateCaseProperty` and `searchBlueprint` and migrate:
  - `updateCaseProperty`: probably in the case type editor — grep for it.
  - `searchBlueprint`: per the inventory this is called from the SA agent tool. Grep `searchBlueprint(` across `lib/services/tools/**`, `lib/services/solutionsArchitect.ts`.

- [ ] **Step 1: Implement `updateCaseProperty` on `useBlueprintMutations`**

```ts
export function useBlueprintMutations() {
    const docStore = useContext(BlueprintDocContext);
    if (!docStore) throw new Error(/* ... */);

    return useMemo(
        () => ({
            // ... existing mutations

            updateCaseProperty(caseTypeName: string, propertyName: string, updates: Record<string, unknown>) {
                const state = docStore.getState();
                const nextCaseTypes = state.caseTypes.map((ct) => {
                    if (ct.name !== caseTypeName) return ct;
                    return {
                        ...ct,
                        properties: ct.properties.map((p) =>
                            p.name === propertyName ? { ...p, ...updates } : p,
                        ),
                    };
                });
                docStore.getState().apply({ kind: "setCaseTypes", caseTypes: nextCaseTypes });
            },
        }),
        [docStore],
    );
}
```

- [ ] **Step 2: Implement `useSearchBlueprint`**

```ts
// lib/doc/hooks/useSearchBlueprint.ts
import { useContext, useCallback } from "react";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { searchBlueprint as searchBp } from "@/lib/services/blueprintHelpers";
import { assembleBlueprint, getEntityData } from "@/lib/services/normalizedState";
import type { SearchResult } from "@/lib/services/blueprintHelpers";

export function useSearchBlueprint(): (query: string) => SearchResult[] {
    const docStore = useContext(BlueprintDocContext);
    if (!docStore) throw new Error("useSearchBlueprint must be used within BlueprintDocProvider");

    return useCallback(
        (query: string) => {
            const s = docStore.getState();
            if (s.moduleOrder.length === 0) return [];
            // Doc state is structurally identical to the legacy state `getEntityData`
            // expects. Cast through unknown to bridge the branded-Uuid boundary.
            const bp = assembleBlueprint(getEntityData(s as unknown as Parameters<typeof getEntityData>[0]));
            return searchBp(bp, query);
        },
        [docStore],
    );
}
```

Caveat: `getEntityData` may rely on the legacy store's exact field types. Check its signature — if it works on any object with the same shape, great; if it's tightly typed to `BuilderState`, add a narrow structural type argument or write a small `getEntityDataFromDoc` helper that does the same thing.

- [ ] **Step 3: Find + migrate callers**

`updateCaseProperty`: likely called from `components/builder/detail/CaseTypeEditor.tsx` or similar. Grep `updateCaseProperty(`. For each React component caller, swap `useBuilderStore((s) => s.updateCaseProperty)` → `useBlueprintMutations().updateCaseProperty`.

`searchBlueprint`: find the SA tool caller. If it's in a non-React context (e.g. `lib/services/tools/search.ts`), it can't use a hook. Options:
- Export a module-level `searchBlueprintFromDoc(docStore, query)` function from `lib/doc/hooks/useSearchBlueprint.ts` for imperative callers.
- The SA tool probably receives the doc store via a context object (check `GenerationContext` in `lib/services/generationContext.ts`). Add a `searchBlueprint` method on `GenerationContext` that proxies to the doc store.

The implementer finds the caller and picks the appropriate integration.

- [ ] **Step 4: Delete legacy-store actions**

In `lib/services/builderStore.ts`:
- Delete `updateCaseProperty` action (line ~579)
- Delete `searchBlueprint` action (line ~589)
- Delete `renameCaseProperty` stub (line ~571)
- Delete these from the `BuilderState` interface + from the initial-state block

- [ ] **Step 5: Tests**

Add to `lib/doc/__tests__/hooks-useBlueprintMutations.test.tsx`:
1. `updateCaseProperty('person', 'dob', { data_type: 'date' })` → case type `person`'s `dob` property now has `data_type === 'date'`.
2. `updateCaseProperty` on a non-existent case type → no change, no throw.
3. `updateCaseProperty` on a non-existent property → no change, no throw.

Add to `lib/doc/__tests__/hooks-useSearchBlueprint.test.tsx`:
1. Empty doc → returns `[]`.
2. Populated doc, query matches a question label → returns the hit.

- [ ] **Step 6: Typecheck + test + commit**

```bash
git add lib/doc/hooks lib/services/builderStore.ts \
        components/builder/detail \
        lib/services/tools  # or wherever the SA caller is
git commit -m "refactor(builder): move updateCaseProperty + searchBlueprint to doc hooks"
```

---

### Task 10c: Move `computeEditFocus` to `lib/signalGrid/editFocus.ts`

**Spec citation:** Section 4 dissolution table row 3 — signalGrid nanostore owns the rAF loop; edit focus is a pure derivation from `doc + scope`.

**Files:**
- Create: `lib/signalGrid/editFocus.ts` — pure `computeEditFocus(doc, scope): EditFocus | null` function.
- Modify: `lib/signalGrid/store.ts` — optionally add `editScope` field + `setEditScope` action (if any caller sets it). Check — the inventory noted "No explicit call sites for `engine.setEditScope`". If nothing calls it, delete the whole edit-scope concept entirely.
- Modify: `components/chat/SignalGrid.tsx` — swap `builder.computeEditFocus()` → call `computeEditFocus(doc, scope)` using the docStore + session's scope.
- Modify: `lib/services/builderEngine.ts` — delete `_editScope`, `setEditScope`, `computeEditFocus`, `clampEditFocus` helper, `MIN_EDIT_ZONE` constant.

- [ ] **Step 1: Audit edit-scope call sites**

Grep `setEditScope` and `_editScope`:

```
# from the inventory: "No explicit call sites for `engine.setEditScope`"
```

If the grep confirms zero callers, **delete the entire concept** — no edit scope on session, no field on signalGrid. The `computeEditFocus` function becomes unreachable and can be deleted along with everything else. `SignalGrid.tsx`'s `builder.computeEditFocus()` returns `null` (scope is always null), which means the signal grid never shows a focus zone — which may or may not match today's behavior. Double-check before deleting.

If there's at least one `setEditScope` caller, keep the edit scope concept and:
- Add `editScope: EditScope | null` + `setEditScope` to `BuilderSession` (if it's session-scoped) or to `signalGrid` (if it's rAF-scoped).
- Write `computeEditFocus(doc, scope)` as a pure function in `lib/signalGrid/editFocus.ts`.

**Implementer decision point.** Read the grep output first, then pick the path. Document the choice in the commit message so the spec reviewer can verify.

- [ ] **Step 2: Create `lib/signalGrid/editFocus.ts` (if keeping)**

Pure function — copy the `computeEditFocus` body from `builderEngine.ts`, swap `s.moduleOrder` / `s.formOrder` / `s.questionOrder` reads from the legacy state to a `BlueprintDoc` parameter, keep everything else identical.

- [ ] **Step 3: Migrate `SignalGrid.tsx`**

If keeping:

```tsx
const docStore = useContext(BlueprintDocContext);
const scope = useBuilderSession((s) => s.editScope); // or however scope is sourced

useSignalGridFrame(
    useCallback((deltaMs) => {
        // ...
        const focus = docStore && scope
            ? computeEditFocus(docStore.getState(), scope)
            : null;
        // ... use focus
    }, [docStore, scope /* others */]),
);
```

If deleting: remove the `computeEditFocus` call entirely; replace any usage of its result with `null` or remove dependent logic.

- [ ] **Step 4: Delete engine members**

In `lib/services/builderEngine.ts`:
- Delete `_editScope` field
- Delete `setEditScope` method
- Delete `computeEditFocus` method
- Delete `clampEditFocus` helper function
- Delete `MIN_EDIT_ZONE` constant
- Delete `EditFocus` / `EditScope` imports from `lib/signalGridController`

- [ ] **Step 5: Tests**

`lib/signalGrid/__tests__/editFocus.test.ts`:
1. Empty doc → `null`.
2. Doc with 1 module, 1 form, 5 questions, scope `{ moduleIndex: 0, formIndex: 0, questionIndex: 2 }` → returns a `{ start, end }` centered near `2/5`.
3. Scope `{ moduleIndex: 0 }` (module-level) → returns focus spanning the module's forms.

Same test cases that existed for the engine method (if any) — port them.

- [ ] **Step 6: Typecheck + test + commit**

```bash
git add lib/signalGrid lib/services/builderEngine.ts components/chat/SignalGrid.tsx
git commit -m "refactor(builder): computeEditFocus → lib/signalGrid/editFocus.ts"
```

---

### Task 11: Delete `syncOldFromDoc` adapter + mirrored entity fields

**Spec citation:** Migration table row 3, phase 3 gate — "sync adapter deleted; consumers read from doc".

**Files:**
- Delete: `lib/doc/adapters/syncOldFromDoc.ts`
- Delete: `lib/doc/__tests__/adapters-syncOldFromDoc.test.tsx`
- Modify: `hooks/useBuilder.tsx` — delete the `startSyncOldFromDoc` call in `SyncBridge`. Keep the `setDocStore` wiring for legacy store (generation-stream setters still dispatch via `_docStore` — that stays for Phase 4).
- Modify: `lib/services/builderStore.ts` — delete fields: `appName`, `connectType`, `caseTypes`, `modules`, `forms`, `questions`, `moduleOrder`, `formOrder`, `questionOrder`. Update `BuilderState` interface. Update initial-state block. Update `reset()` to stop touching these. Update `completeGeneration` + `loadApp` to stop writing them (keep phase transitions + statusMessage/generationData clearing).
- Modify: `lib/services/builderStore.ts` — update zundo `partialize` to drop the 9 fields (zundo's UndoSlice type is now just `appName`? No, appName is deleted too. The legacy store has no entity data to undo. Does zundo stay? It still tracks nothing — the doc owns undo. **Delete the zundo middleware entirely from the legacy store.** This is a simplification aligned with the spec: "`zundo.partialize` allow-list" is in the "What goes away" list in the spec.)
- Modify: `lib/services/builderStore.ts` — imports: delete `temporal` import from `zundo` if no longer used (it's still used for `temporal.getState().pause()` etc. by Phase 4 generation — check and decide). Actually: the doc's zundo is the only undo now. Legacy store's zundo is dead. DELETE it from the legacy store and DELETE all legacy `temporal` access call sites.
- Modify: Check `hooks/useBuilder.tsx` — it calls `engine.store.temporal.getState().pause()` / `.resume()` on hydration. Those are the legacy store's temporal calls. Delete them; the doc store's temporal is controlled via `BlueprintDocProvider`'s `startTracking` prop (already Phase 1b behavior).
- Modify: `lib/services/builderSelectors.ts` — delete any selectors that reference the deleted fields. `deriveTreeData` and `TreeDataSource` were deleted in T9. Delete `selectAppName`.

**Non-deletion list (stays on legacy store for Phase 4):**
- `phase`, `agentActive`, `postBuildEdit`
- `generationStage`, `generationError`, `statusMessage`, `progressCompleted/Total`, `generationData`
- `replayStages`, `replayDoneIndex`, `replayExitPath`, `replayMessages`
- `appId`
- `_docStore` + `setDocStore`
- Generation lifecycle actions: `startGeneration`, `setSchema`, `setPartialScaffold`, `setScaffold`, `setModuleContent`, `setFormContent`, `advanceStage`, `setFixAttempt`, `completeGeneration` (simplified), `acknowledgeCompletion`, `setAppId`, `loadApp` (simplified), `loadReplay`, `setReplayMessages`, `setAgentActive`, `setGenerationError`, `reset` (simplified)

- [ ] **Step 1: Delete adapter files**

```bash
git rm lib/doc/adapters/syncOldFromDoc.ts lib/doc/__tests__/adapters-syncOldFromDoc.test.tsx
```

- [ ] **Step 2: Remove adapter call from `useBuilder.tsx`**

In `SyncBridge`:

```tsx
// Before
const stop = startSyncOldFromDoc(docStore, oldStore);
return () => { /* ... */ stop(); };
// After
// Just install the doc store reference on legacy store for generation-stream
// setters. No adapter subscription.
```

Delete the `startSyncOldFromDoc` import.

- [ ] **Step 3: Delete mirrored fields from `builderStore.ts`**

Remove from:
- `BuilderState` interface declarations
- Initial state block in `createBuilderStore`
- `reset()` action body
- `loadApp()` action body — it still sets `phase`, `appId`, `generationStage`, `statusMessage`, `postBuildEdit`, `generationData`, but NOT entity fields. The entity data flow is now: caller invokes doc's `loadBlueprint` directly; legacy store's `loadApp` just handles non-entity state. Actually — review the provider: `createEngine` calls `engine.store.getState().loadApp(...)` to trigger the legacy store's loadApp. Phase 4 deletes loadApp entirely; Phase 3 simplifies it. The provider also loads the doc directly (`<BlueprintDocProvider initialBlueprint={...}>`), so the legacy loadApp is just bookkeeping.
- `completeGeneration()` action body — same: strip entity writes, keep phase transition + status clearing
- `startGeneration()` action body — strip entity clearing, keep phase transition + generationData initialization

- [ ] **Step 4: Remove zundo from legacy store entirely**

In `createBuilderStore`:

```ts
// Before
createStore<BuilderState>()(
    devtools(
        temporal(
            subscribeWithSelector(immer((set, get) => ({ /* ... */ }))),
            { partialize: ..., equality: ..., limit: 50 },
        ),
        { name: "BuilderStore", /* ... */ },
    ),
)

// After
createStore<BuilderState>()(
    devtools(
        subscribeWithSelector(immer((set, get) => ({ /* ... */ }))),
        { name: "BuilderStore", /* ... */ },
    ),
)
```

Delete the `UndoSlice` type. Delete the `temporal` import. Delete the `temporal` field from `BuilderStoreApi` (it's inferred from `createStore`'s return — recheck how the type is exported).

- [ ] **Step 5: Delete legacy `temporal` access in `hooks/useBuilder.tsx`**

Search for `engine.store.temporal` — find and delete all call sites. Typically:
- `engine.store.temporal.getState().pause()` in the engine constructor
- `engine.store.temporal.getState().resume()` after `loadApp`
- Any other `pause`/`resume`/`clear` calls

The doc store's undo tracking is independent and controlled by `BlueprintDocProvider`'s `startTracking` prop. Nothing in the legacy store owns undo anymore.

- [ ] **Step 6: Delete `selectAppName` from `builderSelectors.ts`**

Delete the function. Grep for callers; if any remain, migrate them to `useBlueprintDoc((s) => s.appName)`.

- [ ] **Step 7: Typecheck**

```bash
npx tsc --noEmit
```

Likely fallout: the `updateCaseProperty` (T10b already migrated), `searchBlueprint` (T10b already migrated), `deriveTreeData` (T9 already migrated) call sites are gone. Remaining readers of mirrored fields: if typecheck surfaces any, T9/T10a/T10b missed them. Migrate inline.

- [ ] **Step 8: Test + commit**

```bash
npm test -- --run
git add lib/doc hooks/useBuilder.tsx \
        lib/services/builderStore.ts \
        lib/services/builderSelectors.ts
git commit -m "refactor(builder): delete syncOldFromDoc + mirrored entity fields"
```

---

### Task 12: Delete stub mutation actions from legacy store

**Spec citation:** Section "What goes away" — the legacy mutation actions are dead once the doc owns mutations.

**Files:**
- Modify: `lib/services/builderStore.ts` — delete 13 stub actions:
  - `updateQuestion`, `addQuestion`, `removeQuestion`, `moveQuestion`, `duplicateQuestion`, `renameQuestion`
  - `updateModule`, `addModule`, `removeModule`
  - `updateForm`, `replaceForm`, `addForm`, `removeForm`
  - `updateApp`
  - Action signatures in the `BuilderState` interface
  - Action implementations in the store factory
- Modify: `hooks/useBuilder.tsx` — if any facade hook reads these action stubs, delete.

- [ ] **Step 1: Delete from interface**

Remove the 14 action signatures from `BuilderState` (lines ~204-282 in the pre-Phase-3 file).

- [ ] **Step 2: Delete from store factory**

Remove the 14 no-op action implementations (lines ~492-569 in the pre-Phase-3 file).

- [ ] **Step 3: Delete imports that are no longer used**

Types like `NewQuestion`, `QuestionRenameResult`, `QuestionUpdate`, `RenameResult`, `SearchResult`, `MoveQuestionResult`, `MoveQuestionResult` (the interface itself was declared in this file!) — review what stays. If `MoveQuestionResult` is the real type used by the doc store (imported from `lib/doc/mutations/questions.ts`), keep the doc's definition; delete the duplicate in `builderStore.ts`.

- [ ] **Step 4: Grep for anything that still imports the deleted interface members**

```
# implementer runs:
rg "\\bupdateQuestion\\b|\\baddQuestion\\b|\\bremoveQuestion\\b|\\bmoveQuestion\\b|\\bduplicateQuestion\\b|\\brenameQuestion\\b" --type ts --type tsx lib/services
```

Anything in `lib/services/*` that references these action names should only be the deleted stubs; if a real implementation references them, it's already migrated via `useBlueprintMutations`.

- [ ] **Step 5: Typecheck + test + commit**

```bash
npx tsc --noEmit && echo "✓"
npm test -- --run
git add lib/services/builderStore.ts hooks/useBuilder.tsx
git commit -m "refactor(builder/store): delete stub mutation actions"
```

---

### Task 13: Delete `BuilderEngine` class + rewrite `BuilderProvider` as a provider stack + re-home `EngineController`

**Spec citation:** Section 4 — "Result: `BuilderEngine` class deleted. `BuilderProvider` shrinks to a stack of independent capability providers". Section gives the exact provider tree.

**Files:**
- Delete: `lib/services/builderEngine.ts`
- Create: `lib/preview/engine/provider.tsx`
- Create: `lib/preview/engine/__tests__/provider.test.tsx`
- Create: `lib/routing/domQueries.ts` — pure helpers for `findFieldElement` + `flashUndoHighlight` (moved out of the engine).
- Modify: `hooks/useBuilder.tsx` — rewrite `BuilderProvider` as a stack of providers; delete `useBuilderEngine`, `EngineContext`, `SyncBridge` (or simplify SyncBridge to only install the doc-store ref on the legacy store).
- Modify: `hooks/useFormEngine.ts` — swap `builderEngine.engineController` → `useBuilderFormEngine()`.
- Modify: `components/preview/form/FormRenderer.tsx` — swap `builderEngine.engineController.setBlueprintForm` (~lines 223, 409) → `useBuilderFormEngine().setBlueprintForm`.
- Modify: `components/builder/ReplayController.tsx` — swap `builder.reset()` → a composite reset helper (calls `sessionStore.reset()` + `legacyStore.reset()` + doc's `loadBlueprint(empty)` if that's the right shape; or keep legacy's reset + add session reset).
- Modify: `lib/routing/builderActions.ts` — swap `engine.findFieldElement` + `engine.flashUndoHighlight` to pure functions from `lib/routing/domQueries.ts`.
- Modify: `components/chat/ChatContainer.tsx` (~line 185) — `builder.setAgentActive(active)` still needs to work. Since legacy store keeps `agentActive` (non-goal for Phase 3) + `setAgentActive` action, just read it from the legacy store directly: `useBuilderStore((s) => s.setAgentActive)(active)`.

**Design — the new provider stack:**

```tsx
export function BuilderProvider({
    buildId,
    children,
    replay,
    initialBlueprint,
}: {
    buildId: string;
    children: ReactNode;
    replay?: ReplayInit;
    initialBlueprint?: AppBlueprint;
}) {
    const [state, setState] = useState(() => ({
        store: createBuilderStore(
            replay || initialBlueprint ? BuilderPhase.Loading : BuilderPhase.Idle,
        ),
        buildId,
    }));

    if (buildId !== state.buildId) {
        setState({
            store: createBuilderStore(
                replay || initialBlueprint ? BuilderPhase.Loading : BuilderPhase.Idle,
            ),
            buildId,
        });
    }

    const { store } = state;

    // Legacy-store hydration still runs here — Phase 4 deletes this path.
    useEffect(() => {
        if (replay) {
            store.getState().loadReplay(replay.stages, replay.doneIndex, replay.exitPath);
            for (let i = 0; i <= replay.doneIndex; i++) {
                replay.stages[i]?.applyToBuilder(/* ... what now?  no engine */);
            }
        } else if (initialBlueprint) {
            store.getState().loadApp(buildId, initialBlueprint);
        }
    }, [store, buildId, replay, initialBlueprint]);

    return (
        <StoreContext value={store}>
            <BlueprintDocProvider
                appId={buildId === "new" ? undefined : buildId}
                initialBlueprint={initialBlueprint}
                startTracking={Boolean(initialBlueprint || replay)}
            >
                <BuilderSessionProvider>
                    <ScrollRegistryProvider>
                        <EditGuardProvider>
                            <BuilderFormEngineProvider>
                                <SyncBridge />
                                <LocationRecoveryEffect />
                                {children}
                            </BuilderFormEngineProvider>
                        </EditGuardProvider>
                    </ScrollRegistryProvider>
                </BuilderSessionProvider>
            </BlueprintDocProvider>
        </StoreContext>
    );
}
```

Note: `DragStateProvider` is scoped inside `FormRenderer.tsx` (already mounted in T4), not in the top-level stack. SignalGrid is a module-level nanostore (no provider).

`ReplayStage.applyToBuilder(engine)` is a problem. Let me check.

The implementer should grep `applyToBuilder` — it's a method on `ReplayStage` that takes an engine. The current engine-based API can't survive T13. Options:
1. Change the stage interface to `applyToBuilder(store: BuilderStoreApi): void` — same legacy-store reference the engine wrapped.
2. Inline the stage application into BuilderProvider and route it to the legacy store directly.

**Decision:** Phase 4 owns generation + replay; Phase 3 should not rewrite the replay interface. Instead, keep the `applyToBuilder` method but change its parameter type from `BuilderEngine` to `{ store: BuilderStoreApi }` — an ad-hoc adapter object. Phase 4 rewrites this properly.

```ts
// lib/services/logReplay.ts — temporary shim
export interface ReplayStage {
    // ...
    applyToBuilder(shim: { store: BuilderStoreApi }): void;
}
```

All call sites in `lib/services/logReplay.ts` that do `engine.store.getState().setX(...)` already use `.store.getState()`, so the shim works without deeper changes.

Caller in `BuilderProvider`:

```ts
replay.stages[i]?.applyToBuilder({ store });
```

- [ ] **Step 1: Extract DOM helpers**

Create `lib/routing/domQueries.ts`:

```ts
/** Find a specific field element within a question's InlineSettingsPanel.
 *  Queries by stable UUID so the element is found even after renames. */
export function findFieldElement(questionUuid: string, fieldId?: string): HTMLElement | null {
    if (!fieldId) return null;
    const questionEl = document.querySelector(
        `[data-question-uuid="${questionUuid}"]`,
    ) as HTMLElement | null;
    const panel = questionEl?.nextElementSibling as HTMLElement | null;
    if (!panel?.hasAttribute("data-settings-panel")) return null;
    return panel.querySelector(`[data-field-id="${fieldId}"]`);
}

/** Flash a subtle violet highlight on an element to signal an undo/redo
 *  state change. Web Animations API — fire-and-forget, no cleanup needed. */
export function flashUndoHighlight(el: HTMLElement): void {
    // ... exact body from builderEngine.ts (lines 412-431)
}
```

Update `lib/routing/builderActions.ts` to import from `./domQueries` instead of `engine.findFieldElement` / `engine.flashUndoHighlight`.

- [ ] **Step 2: Create `BuilderFormEngineProvider`**

```tsx
// lib/preview/engine/provider.tsx
"use client";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { EngineController } from "./engineController";
import { BlueprintDocContext } from "@/lib/doc/provider";

const BuilderFormEngineContext = createContext<EngineController | null>(null);

export function BuilderFormEngineProvider({ children }: { children: ReactNode }) {
    const [controller] = useState(() => new EngineController());
    const docStore = useContext(BlueprintDocContext);

    useEffect(() => {
        if (!docStore) return;
        controller.setDocStore(docStore);
        return () => {
            controller.deactivate();
        };
    }, [controller, docStore]);

    return <BuilderFormEngineContext value={controller}>{children}</BuilderFormEngineContext>;
}

export function useBuilderFormEngine(): EngineController {
    const ctx = useContext(BuilderFormEngineContext);
    if (!ctx) throw new Error("useBuilderFormEngine must be used within BuilderFormEngineProvider");
    return ctx;
}
```

Test: mount the provider, call `useBuilderFormEngine()`, assert the returned controller is a real instance with `activateForm` method.

- [ ] **Step 3: Migrate `useFormEngine.ts`**

Swap `useBuilderEngine().engineController` → `useBuilderFormEngine()`. Same method surface, same call patterns.

- [ ] **Step 4: Migrate `FormRenderer.tsx` engineController calls**

Lines ~223, ~409: `builderEngine.engineController.setBlueprintForm(...)` → `useBuilderFormEngine().setBlueprintForm(...)`. Remove the `useBuilderEngine()` reference.

- [ ] **Step 5: Rewrite `BuilderProvider`**

Delete `createEngine`. Replace with the provider-stack pattern above. `BuilderEngine` is gone.

Delete `EngineContext`, `useBuilderEngine`. Delete the `SyncBridge` component or simplify it — it just installs the `docStore` on the legacy store now:

```tsx
function SyncBridge() {
    const docStore = useContext(BlueprintDocContext);
    const store = useContext(StoreContext);
    useEffect(() => {
        if (!docStore || !store) return;
        store.getState().setDocStore(docStore);
        return () => {
            store.getState().setDocStore(null);
        };
    }, [docStore, store]);
    return null;
}
```

Note: The legacy store's `_docStore` stays for generation-stream setters. Phase 4 deletes it.

- [ ] **Step 6: Update `ReplayController.tsx`**

`builder.reset()` → a helper that resets everything:

```tsx
// lib/services/resetBuilder.ts (new, tiny)
export function resetBuilder(inputs: {
    store: BuilderStoreApi;
    sessionStore: BuilderSessionStoreApi;
    docStore: BlueprintDocStore;
}): void {
    inputs.store.getState().reset();
    inputs.sessionStore.getState().reset(); // implementer adds reset() to session store
    // Doc store is reset by creating a fresh doc from an empty blueprint:
    inputs.docStore.getState().loadBlueprint(EMPTY_BLUEPRINT);
}
```

Or — simpler for Phase 3 — make `ReplayController` read all three stores via hooks and call reset on each. Avoid the extra helper unless it's used more than once.

Add a `reset()` action to `BuilderSession` that clears cursor mode, sidebars, connect stash, focus hint, new-question uuid to their initial values.

- [ ] **Step 7: Migrate `ChatContainer.tsx`**

Line ~185: `const builder = useBuilderEngine(); builder.setAgentActive(active)` → `const setAgentActive = useBuilderStore((s) => s.setAgentActive); setAgentActive(active)`. Legacy store still owns `setAgentActive` (non-goal for Phase 3).

Also check: `builder.markEditMadeMutations()` is called somewhere. Grep and migrate — it becomes `useBuilderStore((s) => s.markEditMadeMutations)` or, if the legacy store doesn't own it either... actually look at the inventory: `markEditMadeMutations` is on the engine, not the legacy store. For Phase 3, it moves to the legacy store as a real action (with a real backing `_editMadeMutations` field that lives on the legacy store, not the session store). OR — cleaner — add `editMadeMutations` + `markEditMadeMutations` to `BuilderSession`. The inventory says it's only called from engine internals (inside `setAgentActive`). If the legacy-store `setAgentActive` is the only caller of `markEditMadeMutations`, it becomes an internal transition in the legacy store's `setAgentActive` action body:

```ts
setAgentActive(active) {
    set((draft) => {
        draft.agentActive = active;
        if (active && (phase === Ready || Completed)) {
            draft.postBuildEdit = true;
            draft._editMadeMutations = false; // reset on agent start
        }
        if (!active && draft.postBuildEdit && draft._editMadeMutations) {
            draft._editMadeMutations = false; // consume flag
        }
    });
}
```

If that's the only logic, `_editMadeMutations` + `markEditMadeMutations` + `editMadeMutations` getter can ALL move to the legacy store as a private field + `markEditMadeMutations` action. Simplest.

**Decision:** Move `editMadeMutations` + `markEditMadeMutations` to the legacy store as first-class state, since it's tied to the `agentActive` / `postBuildEdit` lifecycle that stays on the legacy store for Phase 3.

- [ ] **Step 8: Delete `builderEngine.ts`**

```bash
git rm lib/services/builderEngine.ts
```

Check `lib/services/builderEngine.test.ts` if it exists — delete or rewrite.

- [ ] **Step 9: Grep for any remaining `useBuilderEngine` references**

```
# implementer runs:
rg "useBuilderEngine" --type ts --type tsx
```

Expected: zero hits. If any remain, migrate them.

- [ ] **Step 10: Grep for any remaining `BuilderEngine` references**

```
# implementer runs:
rg "BuilderEngine" --type ts --type tsx
```

Expected: zero hits. Type imports should be gone too.

- [ ] **Step 11: Typecheck + test**

```bash
npx tsc --noEmit && echo "✓"
npm test -- --run
```

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "refactor(builder): delete BuilderEngine; BuilderProvider is a provider stack"
```

---

### Task 14: Final verification + Phase 4 prompt

**Files:** none (verification + one new file).
- Create: `docs/superpowers/prompts/phase-4-session-prompt.md`

- [ ] **Step 1: Clean typecheck**

```bash
npx tsc --noEmit && echo "✓ typecheck"
```

Expected: clean.

- [ ] **Step 2: Biome lint**

```bash
npm run lint
```

Expected: clean.

- [ ] **Step 3: Full test suite**

```bash
npm test -- --run
```

Expected: all tests pass. Compare count with pre-Phase-3 count (from `npm test -- --run` on `main` before the worktree). Report the delta in the merge summary.

- [ ] **Step 4: Production build**

```bash
npm run build
```

Expected: clean. No Biome or TypeScript errors.

- [ ] **Step 5: Manual smoke test**

```bash
npm run dev
```

Verify each scenario:

1. **Cursor mode toggle** — switch pointer ↔ edit. Both sidebars stash into pointer mode and restore into edit mode. Close chat manually, switch to pointer, switch back to edit — chat stays closed. Close both, switch to pointer, switch back — both stay closed.
2. **Edit guard** — start editing an XPath field (leave it with unsaved changes), click on a different question. Browser confirms or selection is blocked.
3. **Signal grid animation** — send a chat message that triggers a data-part stream. Signal grid animates.
4. **Drag + drop** — drag a question across group boundaries. Auto-rename fires a toast if ids conflict. Drag-end fires the right animation.
5. **Undo / redo** — make an edit, Cmd/Ctrl+Z, the change reverts. Violet flash animates on the affected field. Selection follows. Sidebar state unchanged.
6. **Connect mode switch** — app settings → switch connect_type from learn to deliver. Form-level configs for learn forms stash; switching back restores them.
7. **New question focus** — add a new question via the `+` button. ID field is focused + select-all.
8. **Move with auto-rename toast** — set up two forms, give each a question named `case_name`. Drag the one from form A into form B (below `case_name` in form B). The moved question auto-renames; toast appears saying "Question renamed to avoid conflict" with the rewrite count.
9. **Rename with xpath rewrite toast** — create a question X, add a question Y with a `calculate` that references X. Rename X. Y's calculate is updated (inspect). No toast for rename without conflict; toast only for auto-rename.
10. **Browser back/forward** — navigate home → module → form. Back traverses the sequence. No regressions from Phase 2.
11. **Select with edit guard** — no silent drops (regression test from the Phase 2 retrospective).
12. **Post-build edit signal** — after a generation completes, edit a question. Signal grid shows post-build edit state.
13. **Replay mode** — load a replay URL; step through stages. Signal grid animates; no engine errors.
14. **EngineController resubscribe** — load any app, edit a question's calculate. Preview in pointer mode updates correctly on change.
15. **Delete selected** — delete the currently selected question. Selection jumps to neighbor. No stale sel= remains.

Document any issue with a new commit under T14 fixes before merge approval.

- [ ] **Step 6: Write Phase 4 session prompt**

Create `docs/superpowers/prompts/phase-4-session-prompt.md` with the following shape. Use the Phase 3 kickoff prompt as the template:

```markdown
# Phase 4 Session Prompt — Generation + Replay as Mutation Stream

Paste this into a fresh session verbatim.

---

You're executing Phase 4 of a multi-phase builder state re-architecture in commcare-nova...

## READ IN THIS ORDER

1. Invoke Skill(superpowers:using-superpowers), Skill(superpowers:subagent-driven-development), Skill(superpowers:writing-plans).
2. docs/superpowers/specs/2026-04-12-builder-state-rearchitecture-design.md — Section 7 "Generation + replay as one mutation stream".
3. docs/superpowers/plans/2026-04-12-phase-2-url-state.md
4. docs/superpowers/plans/2026-04-13-phase-3-engine-dissolution.md  # Phase 3 reference
5. CLAUDE.md (root).
6. lib/services/builderStore.ts — what's LEFT: generation lifecycle + replay + agent status + phase. All Phase 4 territory.

## MERGED PHASES (lineage)

- Phase 0 (merged)
- Phase 1a (merged)
- Phase 1b (merged c738781)
- Phase 2 (merged 021acce) — URL-driven nav + selection
- Phase 3 (merged <PHASE-3-MERGE-HASH>) — BuilderEngine class deleted, BuilderSession store created, syncOldFromDoc adapter deleted, mirrored entity fields deleted, MoveQuestionResult instrumentation landed, scroll + edit guard + signalGrid + drag state live in scoped contexts. <ONE-PARAGRAPH-SUMMARY>

## WHAT PHASE 4 OWNS

Per spec Section 7 + Phase 4 migration-table row:

1. Translation layer: `lib/generation/mutationMapper.ts` — pure `toMutations(event, doc): Mutation[]`.
2. Stream consumer: `useAgentStream(stream)` hook wrapping `beginAgentWrite` → `applyMany` per event → `endAgentWrite`. Pauses zundo tracking for the duration; one undo captures the whole generation.
3. Delete: `generationData`, `partialScaffold`, `partialModules`, `setScaffold`, `setModuleContent`, `setFormContent`, `setPartialScaffold`, `scaffoldToMutations`.
4. Delete: `replayStages`, `replayDoneIndex`, `replayExitPath`, `ReplayController` (if class exists), legacy-store replay fields.
5. `inReplayMode` becomes `useAgentStatus().stage === 'replay'`.
6. Move `agentActive`, `postBuildEdit`, `editMadeMutations` from legacy store to BuilderSession.
7. Delete `phase` from the legacy store; derive `phase` from agent status + doc populated state.
8. Delete legacy-store lifecycle actions: `startGeneration`, `setSchema`, `setPartialScaffold`, `setScaffold`, `setModuleContent`, `setFormContent`, `advanceStage`, `setFixAttempt`, `completeGeneration`, `acknowledgeCompletion`, `loadApp`, `loadReplay`, `setReplayMessages`, `setGenerationError`.
9. At the end of Phase 4, the legacy store holds essentially nothing — Phase 6 will delete the file.

Phase 4 NON-GOALS:
- VirtualFormList (Phase 5)
- Full lint enforcement (Phase 6)

## WORKFLOW

<same workflow block as Phase 3 — use Phase 3's verbatim, updating only what went wrong>

## WHAT WENT WRONG IN PHASE 3 — DO NOT REPEAT

<fill in honestly after executing Phase 3 — at least 3 concrete items, each with a behavioral rule. Examples:

- If a task grew beyond ~300 LOC during implementation, stop and split it.
- If a spec section is cited in multiple tasks, each task's spec reviewer must re-verify the section's language against the code in THAT task's scope (not the previous task's).
- Anything else that surfaced.>

## CHAIN FORWARD

When Phase 4 merges, write docs/superpowers/prompts/phase-5-session-prompt.md before ending the session.

Execute when the user gives the go-ahead. Start by reading the spec.
```

Fill in the `<PHASE-3-MERGE-HASH>` from `git log --format=%H -n 1 main` after the merge. Fill the retrospective section based on actual Phase 3 experience — do NOT leave the lesson block empty or copy from Phase 2.

- [ ] **Step 7: Commit the Phase 4 prompt**

```bash
git add docs/superpowers/prompts/phase-4-session-prompt.md
git commit -m "docs(phase-4): session prompt for the next phase"
```

- [ ] **Step 8: Report branch status + pause for merge approval**

Output for the user:
- Commit list (`git log --oneline main..HEAD`)
- Diff stats (`git diff --stat main..HEAD`)
- Test count delta (before and after)
- New + deleted files list
- Any manual-smoke issues discovered

Then: "Phase 3 branch ready for merge approval. Manual smoke passed. Await go-ahead before merging into main."

Do NOT merge `phase-3-engine-dissolution` into `main` without explicit user approval. Report status; wait for the go-ahead.

---

## Self-review checklist (spec coverage)

1. **Section 2 "BuilderSession"** — T5 creates the store with `cursorMode` + `sidebars` + `activeFieldId` + reducer-shaped `switchCursorMode`; T6 adds `connectStash` + `switchConnectMode`; T7 adds `focusHint` + `newQuestionUuid`. ✓
2. **Section 4 dissolution table row 1 (scroll)** — T1. ✓
3. **Section 4 dissolution table row 2 (edit guard)** — T2 + `useSelect` gate in `lib/routing/hooks.tsx`. ✓
4. **Section 4 dissolution table row 3 (energy + rAF + computeEditFocus)** — T3 (nanostore) + T10c (editFocus.ts). ✓
5. **Section 4 dissolution table row 4 (drag state)** — T4. ✓
6. **Section 4 dissolution table row 5 (focus hint, rename notice, new-question)** — T7 (focus hint → session, new-question → session, rename notice → toast via T8). ✓
7. **Section 4 dissolution table row 6 (connect stash)** — T6. ✓
8. **Section 4 dissolution table row 7 (editMadeMutations)** — T13 internalizes into legacy store's `setAgentActive` (legacy owns phase + agentActive for Phase 3). Note deviation: spec says "derived from temporal.pastStates delta" but that requires doc-owned generation which is Phase 4. Phase 3 keeps the boolean on the legacy store as a transient flag. ✓ (deviation documented)
9. **Section 4 dissolution table row 8 (undo/redo orchestration)** — `useUndoRedo` in `lib/routing/builderActions.ts` stays (landed in Phase 2); T1 migrates its scroll call; T7 migrates its focus hint call; T13 migrates its `findFieldElement` + `flashUndoHighlight` to pure functions. ✓
10. **Section 4 dissolution table row 9 (nav composite hooks)** — already landed in Phase 2. ✓
11. **Section 4 dissolution table row 10 (useSelect gate)** — T2. ✓
12. **MoveQuestionResult.renamed + QuestionRenameResult.xpathFieldsRewritten** — T8. ✓
13. **Delete `syncOldFromDoc` adapter** — T11. ✓
14. **Delete `BuilderEngine` class** — T13. ✓
15. **BuilderProvider is a provider stack** — T13. ✓
16. **Spec Section 5 "selector API unification"** — partial (T9 migrates treeData + hasData; full enforcement is Phase 6). ✓
17. **Spec Section 7 "generation + replay as mutation stream"** — **non-goal**, Phase 4. ✓
18. **Spec Section 6 "VirtualFormList"** — **non-goal**, Phase 5. ✓
19. **Gate: "Edit guard blocks selection during unsaved edits. Undo flash fires. Signal grid animates. Drag works."** — verified by T2 regression test + T3 smoke test + T4 smoke test + T1 smoke test. ✓

No placeholders, no TBDs. Each task commits to a single logical change with test coverage. The execution order (T1 → T14) respects the dependency graph and keeps the legacy store compilable at every step.
