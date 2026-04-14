# Phase 4 — Generation + Replay as Mutation Stream

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy builder store's generation lifecycle, the `applyDataPart` dispatcher, and the `ReplayStage.applyToBuilder` shim with a unified mutation stream architecture. All agent stream events translate to doc mutations through a pure `toDocMutations` mapper; lifecycle state moves to the BuilderSession store; `phase` becomes derived from session + doc state. After this phase the legacy store is functionally empty — Phase 6 deletes the file.

**Architecture:** Three new modules — (1) `lib/generation/mutationMapper.ts` (pure event→Mutation[] translator), (2) `lib/generation/streamDispatcher.ts` (routes events to doc mutations + session state + signal grid), (3) expanded `lib/session/store.ts` (generation lifecycle + replay + appId). `useBuilderPhase()` becomes a derived hook reading session + doc state. `applyDataPart` and the legacy store's generation machinery are deleted.

**Tech Stack:** TypeScript (strict), Zustand 5, React 19, Vitest, Biome.

**Spec reference:** `docs/superpowers/specs/2026-04-12-builder-state-rearchitecture-design.md`
- Section 7 "Generation + replay as one mutation stream"
- Section 2 "BuilderSession (the ephemeral store)" — `agentActive`, `agentStage`, `agentError`, `postBuildEdit`
- Migration-table row: **Phase 4**. Gate: "Full generation produces the same blueprint as before. Replay plays back correctly. Mid-stream error recovery tested."

**Depends on:** Phase 3 (merged `1b43403`). Current HEAD: `1b43403`.

---

## Phase 4 non-goals (stay for Phase 5+)

- `VirtualFormList` (spec Section 6) → **Phase 5**. The recursive `FormRenderer` keeps its current shape.
- Full deletion of `lib/services/builderStore.ts`, `hooks/useBuilder.tsx`, `lib/services/builderSelectors.ts` → **Phase 6**. Phase 4 empties the legacy store but leaves the files for Phase 6 cleanup.
- Full `noRestrictedImports` Biome enforcement → **Phase 6**.
- Convenience hook facades in `hooks/useBuilder.tsx` (`useModule`, `useForm`, `useQuestion`, `useOrderedModules`, `useOrderedForms`, `useAssembledForm`) → **Phase 6**.

---

## File Structure

### New files

```
lib/generation/
  mutationMapper.ts             # Pure toDocMutations(type, data, doc) → Mutation[].
                                # Covers: data-schema, data-scaffold, data-module-done,
                                # data-form-done/fixed/updated. (T2)
  streamDispatcher.ts           # applyStreamEvent(type, data, docStore, sessionStore).
                                # Routes ALL stream events: doc mutations via toDocMutations,
                                # lifecycle transitions on session store, signal grid energy. (T3)
  __tests__/
    mutationMapper.test.ts      # T2
    streamDispatcher.test.ts    # T3
```

### Modified files

```
lib/session/
  types.ts                      # Add GenerationStage enum, GenerationError type,
                                # PartialScaffoldData interface, ReplayData interface.
                                # Remove old AgentError stub (replaced by GenerationError). (T1)
  store.ts                      # Add generation lifecycle fields (agentActive, agentStage,
                                # agentError, statusMessage, postBuildEdit, justCompleted,
                                # loading, appId, partialScaffold) + replay fields +
                                # actions (beginAgentWrite, endAgentWrite, failAgentWrite,
                                # acknowledgeCompletion, setAppId, setLoading, advanceStage,
                                # setFixAttempt, setAgentActive, loadReplay, setReplayMessages). (T1)
  hooks.tsx                     # Add generation hooks (useAgentActive, useAgentStage,
                                # useAgentError, useStatusMessage, usePostBuildEdit,
                                # useInReplayMode, useReplayMessages, useAppId,
                                # usePartialScaffold). Add derived useBuilderPhase,
                                # useBuilderIsReady. (T1, T4)
  provider.tsx                  # Export useBuilderSessionApi for imperative access. (T1)
  __tests__/
    store.test.ts               # Add tests for new actions. (T1)

lib/doc/hooks/
  useDocTreeData.ts             # Simplify: remove phase/generationData params, remove
                                # mergeScaffoldWithPartials, remove Generating-phase
                                # fallback. Accept partialScaffold param directly. (T5)
  __tests__/
    useDocTreeData.test.tsx      # Update tests for simplified hook. (T5)

components/chat/
  ChatContainer.tsx             # Replace applyDataPart with applyStreamEvent.
                                # Replace legacy store reads with session store.
                                # Chat status effect calls session setAgentActive. (T6)
  ChatSidebar.tsx               # Replace legacy store reads for generationError,
                                # generationStage, agentActive, postBuildEdit,
                                # statusMessage with session hooks. Replace
                                # acknowledgeCompletion with session action. (T7)
  SignalGrid.tsx                # Replace legacy store imperative read for
                                # postBuildEdit/agentActive with session store. (T7)

components/builder/
  GenerationProgress.tsx        # Replace selectGenStage/selectGenError/selectStatusMsg
                                # with session hooks. (T7)
  BuilderLayout.tsx             # Replace useBuilderPhase + selectInReplayMode with
                                # session hooks. Auto-navigate on Generating→Completed
                                # uses session phase. (T8)
  BuilderContentArea.tsx        # Replace useBuilderPhase/useBuilderIsReady/selectInReplayMode
                                # with session hooks. (T8)
  AppTree.tsx                   # Replace useBuilderPhase with session hook. (T8)
  ReplayController.tsx          # Read replay state from session store.
                                # Use applyStreamEvent for stage emissions.
                                # Read/write replayMessages via session store. (T9)

app/build/replay/[id]/
  replay-builder.tsx            # Pass replay data to BuilderProvider unchanged. (T9)

hooks/useBuilder.tsx            # Remove generation lifecycle reads. Remove ReplayHydrator.
                                # Rewrite SyncBridge (session store only).
                                # loadApp effect stamps session store.
                                # Remove useBuilderPhase, useBuilderIsReady,
                                # useBuilderAgentActive, useBuilderInReplayMode,
                                # useBuilderTreeData — replaced by session hooks. (T10)

lib/services/
  builderStore.ts               # Remove all generation lifecycle fields + actions
                                # (startGeneration, setSchema, setPartialScaffold,
                                # setScaffold, setModuleContent, setFormContent,
                                # advanceStage, setFixAttempt, completeGeneration,
                                # setGenerationError, acknowledgeCompletion,
                                # scaffoldToMutations, computeProgress). Remove
                                # replay fields + actions (loadReplay, setReplayMessages).
                                # Remove _docStore/setDocStore. Remove phase, agentActive,
                                # postBuildEdit, appId. Leave near-empty shell. (T11)
  builder.ts                    # Delete applyDataPart + ApplyDataPartInputs.
                                # Keep BuilderPhase enum, GenerationStage enum,
                                # type definitions (they're imported elsewhere). (T11)
  builderSelectors.ts           # Delete selectInReplayMode, selectGenStage,
                                # selectGenError, selectStatusMsg. Leave selectIsReady
                                # for any remaining consumers during transition. (T11)
  scaffoldProgress.ts           # Rewrite to read session + doc state
                                # (no legacy store dependency). (T5)
  logReplay.ts                  # Change ReplayStage shape: store raw emissions
                                # instead of applyToBuilder closure. Remove
                                # applyDataPart import. (T9)
  resetBuilder.ts               # Remove legacy store reset call (store.reset()).
                                # The session store reset already exists. (T10)
```

---

### Task 1: Expand BuilderSession store with generation lifecycle + replay + appId

**Parallel with T2.** No shared files.

**Files:**
- Modify: `lib/session/types.ts`
- Modify: `lib/session/store.ts`
- Modify: `lib/session/hooks.tsx`
- Modify: `lib/session/provider.tsx`
- Modify: `lib/session/__tests__/store.test.ts`

**Context:** The BuilderSession store currently owns cursor mode, sidebars, connect stash, and UI hints. Phase 4 expands it with generation lifecycle state (currently on the legacy `builderStore.ts`) so that all builder session state lives in one store. The session store already holds a `docStoreRef` (installed by SyncBridge) which the new `setAgentActive` action needs to check for `docHasData`.

**Spec:** Section 2 defines the target BuilderSession shape. Section 7 defines `beginAgentWrite`/`endAgentWrite`/`failAgentWrite` coordination.

---

- [ ] **Step 1: Add types to `lib/session/types.ts`**

Add `GenerationStage` enum, `GenerationError` type, `PartialScaffoldData` interface, `ReplayData` interface. Remove the placeholder `AgentError` type (stub from Phase 0 — replaced by the actual `GenerationError` type).

```ts
/** Progress stages within a generation run. Only meaningful when
 *  `agentActive === true` and `postBuildEdit === false`. */
export enum GenerationStage {
  DataModel = "data-model",
  Structure = "structure",
  Modules = "modules",
  Forms = "forms",
  Validate = "validate",
  Fix = "fix",
}

/** Error state during generation — metadata, not a phase.
 *  The builder stays in Generating; this describes what went wrong. */
export type GenerationError = {
  message: string;
  severity: "recovering" | "failed";
} | null;

/** Status label for each generation stage, shown in the Signal Grid panel. */
export const STAGE_LABELS: Record<GenerationStage, string> = {
  [GenerationStage.DataModel]: "Designing data model",
  [GenerationStage.Structure]: "Designing app structure",
  [GenerationStage.Modules]: "Building app content",
  [GenerationStage.Forms]: "Building app content",
  [GenerationStage.Validate]: "Validating blueprint",
  [GenerationStage.Fix]: "Fixing validation errors",
};

/** Intermediate scaffold data streamed before the full Scaffold arrives.
 *  Drives the AppTree preview during the early Structure stage. */
export interface PartialScaffoldData {
  appName?: string;
  description?: string;
  modules: Array<{
    name: string;
    case_type?: string | null;
    purpose?: string;
    forms: Array<{
      name: string;
      type: string;
      purpose?: string;
    }>;
  }>;
}

/** Replay session data — stored on the session store for the duration of
 *  a replay session. Stages are data-only (raw emissions, not closures). */
export interface ReplayData {
  stages: ReplayStage[];
  doneIndex: number;
  exitPath: string;
  /** Chat messages for the current replay stage. Written by ReplayController
   *  when navigating, read by ChatContainer for display. */
  messages: UIMessage[];
}
```

The `ReplayStage` type referenced above is the updated shape from T9 (data-only, with `emissions` array). For T1, declare it forward:

```ts
import type { UIMessage } from "ai";

/** A single replay stage — header, subtitle, chat messages, and the raw
 *  emissions to dispatch. No closures — the consumer applies emissions
 *  through the stream dispatcher. */
export interface ReplayStage {
  header: string;
  subtitle?: string;
  messages: UIMessage[];
  emissions: Array<{ type: string; data: Record<string, unknown> }>;
}
```

- [ ] **Step 2: Write failing tests for session store generation actions**

In `lib/session/__tests__/store.test.ts`, add a new `describe("generation lifecycle")` block. Tests need a mock doc store — create a minimal factory helper:

```ts
import { createBlueprintDocStore } from "@/lib/doc/store";

function createTestDocStore() {
  const ds = createBlueprintDocStore();
  // Resume temporal so we can verify pause/resume behavior
  ds.temporal.getState().resume();
  return ds;
}
```

Write tests for:
- `beginAgentWrite(stage)` pauses doc undo tracking (verify `ds.temporal.getState().isTracking === false`), sets `agentActive=true`, `agentStage=stage`, `statusMessage` from `STAGE_LABELS`, clears `agentError`
- `endAgentWrite()` resumes doc undo tracking, sets `agentActive=false`, `justCompleted=true`, clears `agentStage`/`agentError`/`statusMessage`/`partialScaffold`
- `failAgentWrite(msg, severity)` sets `agentError={message, severity}` and `statusMessage=msg` without changing `agentActive`
- `acknowledgeCompletion()` sets `justCompleted=false`, no-ops when `justCompleted` is already false
- `setAgentActive(true)` with doc having data → sets `postBuildEdit=true`
- `setAgentActive(true)` with empty doc → sets `postBuildEdit=false`
- `setAgentActive(false)` always → `agentActive=false` (does NOT change `postBuildEdit`)
- `advanceStage("structure")` → `agentStage=Structure`, `statusMessage=STAGE_LABELS[Structure]`, clears `agentError`
- `setFixAttempt(2, 3)` → `statusMessage` contains "3 errors" and "attempt 2"
- `setAppId("abc")` → `appId="abc"`
- `setLoading(true/false)` → `loading` flag
- `setPartialScaffold(data)` → `partialScaffold` set, `agentStage=Structure`
- `loadReplay(stages, doneIndex, exitPath)` → replay data set, messages initialized from done stage
- `setReplayMessages(msgs)` → `replay.messages` updated
- `reset()` clears all generation fields, replay, appId, partialScaffold, loading

Run: `npx vitest --run lib/session/__tests__/store.test.ts`
Expected: FAIL (actions not implemented)

- [ ] **Step 3: Implement generation lifecycle fields + actions on `lib/session/store.ts`**

Add fields to `BuilderSessionState` interface and initial state:

```ts
// ── Generation lifecycle ────────────────────────────────────────────
agentActive: boolean;           // true when SA is actively streaming
agentStage: GenerationStage | null;  // current gen stage, null outside generation
agentError: GenerationError;    // null when no error
statusMessage: string;          // human-readable status for signal grid
postBuildEdit: boolean;         // true when agent edits a completed app
justCompleted: boolean;         // transient flag for Completed phase derivation
loading: boolean;               // true during initial app hydration

// App identity
appId: string | undefined;

// Generation UI state (transient)
partialScaffold: PartialScaffoldData | undefined;

// Replay
replay: ReplayData | undefined;
```

Add initial values (all falsy/empty/undefined).

Add actions. Key implementation details:

**`beginAgentWrite(stage?)`** — pauses doc undo via `docStoreRef`, sets `agentActive=true`, `postBuildEdit=false`, `agentStage=stage ?? DataModel`, `statusMessage` from `STAGE_LABELS`, clears error and justCompleted:
```ts
beginAgentWrite(stage?: GenerationStage) {
  if (docStoreRef) docStoreRef.getState().beginAgentWrite();
  const s = stage ?? GenerationStage.DataModel;
  set({
    agentActive: true,
    postBuildEdit: false,
    agentStage: s,
    agentError: null,
    statusMessage: STAGE_LABELS[s],
    justCompleted: false,
    partialScaffold: undefined,
  });
},
```

**`endAgentWrite()`** — resumes doc undo, sets completion flags:
```ts
endAgentWrite() {
  if (docStoreRef) docStoreRef.getState().endAgentWrite();
  set({
    agentActive: false,
    justCompleted: true,
    agentStage: null,
    agentError: null,
    statusMessage: "",
    partialScaffold: undefined,
  });
},
```

**`failAgentWrite(message, severity?)`** — sets error without changing agentActive:
```ts
failAgentWrite(message: string, severity: "recovering" | "failed" = "failed") {
  set({ agentError: { message, severity }, statusMessage: message });
},
```

**`setAgentActive(active)`** — called by chat status effect. When activating with an existing app (docStoreRef has data), sets `postBuildEdit=true`. Reads doc state from the non-reactive ref:
```ts
setAgentActive(active: boolean) {
  if (active === get().agentActive) return;
  if (active) {
    const docHasData = (docStoreRef?.getState().moduleOrder.length ?? 0) > 0;
    set({
      agentActive: true,
      postBuildEdit: docHasData,
      // When activating for a post-build edit, keep phase at Ready
      // (no Generating transition). For new builds, data-start-build
      // will call beginAgentWrite which sets postBuildEdit=false.
    });
  } else {
    set({ agentActive: false });
  }
},
```

**`advanceStage(stageStr)`** — maps string to GenerationStage enum:
```ts
advanceStage(stageStr: string) {
  const stageMap: Record<string, GenerationStage> = {
    structure: GenerationStage.Structure,
    modules: GenerationStage.Modules,
    forms: GenerationStage.Forms,
    validate: GenerationStage.Validate,
    fix: GenerationStage.Fix,
  };
  const stage = stageMap[stageStr];
  if (!stage) return;
  set({ agentStage: stage, agentError: null, statusMessage: STAGE_LABELS[stage] });
},
```

**`setFixAttempt(attempt, errorCount)`**:
```ts
setFixAttempt(attempt: number, errorCount: number) {
  set({
    statusMessage: `${STAGE_LABELS[GenerationStage.Fix]} — ${errorCount} error${errorCount !== 1 ? "s" : ""} (attempt ${attempt})`,
  });
},
```

**`acknowledgeCompletion()`**, **`setAppId(id)`**, **`setLoading(loading)`**, **`setPartialScaffold(data)`** — straightforward setters with no-op guards.

**`loadReplay(stages, doneIndex, exitPath)`**:
```ts
loadReplay(stages: ReplayStage[], doneIndex: number, exitPath: string) {
  set({
    replay: {
      stages,
      doneIndex,
      exitPath,
      messages: stages[doneIndex]?.messages ?? [],
    },
  });
},
```

**`setReplayMessages(messages)`**:
```ts
setReplayMessages(messages: UIMessage[]) {
  const r = get().replay;
  if (!r) return;
  set({ replay: { ...r, messages } });
},
```

Update `reset()` to clear all new fields.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest --run lib/session/__tests__/store.test.ts`
Expected: PASS

- [ ] **Step 5: Add session hooks for generation state in `lib/session/hooks.tsx`**

```ts
// ── Generation lifecycle ────────────────────────────────────────────

export function useAgentActive(): boolean {
  return useBuilderSession((s) => s.agentActive);
}

export function useAgentStage(): GenerationStage | null {
  return useBuilderSession((s) => s.agentStage);
}

export function useAgentError(): GenerationError {
  return useBuilderSession((s) => s.agentError);
}

export function useStatusMessage(): string {
  return useBuilderSession((s) => s.statusMessage);
}

export function usePostBuildEdit(): boolean {
  return useBuilderSession((s) => s.postBuildEdit);
}

export function useAppId(): string | undefined {
  return useBuilderSession((s) => s.appId);
}

export function usePartialScaffold(): PartialScaffoldData | undefined {
  return useBuilderSession((s) => s.partialScaffold);
}

export function useIsLoading(): boolean {
  return useBuilderSession((s) => s.loading);
}

// ── Replay ──────────────────────────────────────────────────────────

export function useInReplayMode(): boolean {
  return useBuilderSession((s) => s.replay !== undefined);
}

export function useReplayMessages(): UIMessage[] {
  return useBuilderSession((s) => s.replay?.messages ?? []);
}
```

- [ ] **Step 6: Export imperative session store access from `lib/session/provider.tsx`**

Add `useBuilderSessionApi()` hook alongside existing `useBuilderSession` / `useBuilderSessionShallow`:

```ts
/** Imperative handle on the session store — read/write via
 *  `api.getState()` without subscribing. Use for effect-time
 *  snapshots and callback closures. */
export function useBuilderSessionApi(): BuilderSessionStoreApi {
  const store = useContext(BuilderSessionContext);
  if (!store) {
    throw new Error("useBuilderSessionApi must be used within a BuilderSessionProvider");
  }
  return store;
}
```

- [ ] **Step 7: Run full test suite**

Run: `npx vitest --run`
Expected: all existing tests pass, new tests pass.

- [ ] **Step 8: Commit**

```
feat(session): add generation lifecycle, replay, and appId to BuilderSession store

Expands the BuilderSession store with fields and actions for:
- Generation lifecycle (agentActive, agentStage, agentError, statusMessage,
  postBuildEdit, justCompleted, loading)
- App identity (appId)
- Generation UI state (partialScaffold)
- Replay (stages, doneIndex, exitPath, messages)
- Actions: beginAgentWrite, endAgentWrite, failAgentWrite, acknowledgeCompletion,
  setAgentActive, advanceStage, setFixAttempt, setAppId, setLoading,
  setPartialScaffold, loadReplay, setReplayMessages

Phase 4 of builder state re-architecture.
Spec: Section 2 + Section 7.
```

---

### Task 2: Create mutation mapper (`toDocMutations`)

**Parallel with T1.** No shared files.

**Files:**
- Create: `lib/generation/mutationMapper.ts`
- Create: `lib/generation/__tests__/mutationMapper.test.ts`

**Context:** The legacy store's generation setters (`setScaffold`, `setModuleContent`, `setFormContent`, `setSchema`) each translate a server stream event into doc mutations by: (1) looking up UUIDs from index-based coordinates via the doc store's ordering arrays, (2) building `Mutation` objects, (3) calling `docStore.apply()` / `docStore.applyMany()`. This task extracts the pure "event → Mutation[]" translation into a standalone function with no side effects, no store references, no signal grid injection. The function receives a snapshot of the doc state (for UUID lookups) and returns mutations to apply.

The existing `scaffoldToMutations` function in `lib/services/builderStore.ts` (search for `function scaffoldToMutations(scaffold: Scaffold)`) is the template for the scaffold case. The form-content case mirrors the `setFormContent` action body (search for `setFormContent(moduleIndex` in `builderStore.ts`).

**Spec:** Section 7 — `toMutations(event, doc): Mutation[]`

---

- [ ] **Step 1: Write failing tests**

Create `lib/generation/__tests__/mutationMapper.test.ts`. Import `toDocMutations` (doesn't exist yet — will fail). Use fixture doc snapshots from `toDoc` or hand-built `BlueprintDoc` partials.

Test cases:

```ts
describe("toDocMutations", () => {
  describe("data-schema", () => {
    it("returns a setCaseTypes mutation", () => {
      const muts = toDocMutations("data-schema", { caseTypes: [{ name: "patient" }] }, EMPTY_DOC);
      expect(muts).toEqual([{ kind: "setCaseTypes", caseTypes: [{ name: "patient" }] }]);
    });
  });

  describe("data-scaffold", () => {
    it("returns addModule + addForm mutations for each module/form", () => {
      const scaffold = {
        app_name: "Test App",
        connect_type: "learn",
        modules: [{
          name: "Registration",
          case_type: "patient",
          forms: [
            { name: "Register", type: "registration" },
            { name: "Follow-up", type: "followup" },
          ],
        }],
      };
      const muts = toDocMutations("data-scaffold", scaffold, EMPTY_DOC);
      // setAppName + setConnectType + 1 addModule + 2 addForm = 5 mutations
      expect(muts).toHaveLength(5);
      expect(muts[0]).toEqual({ kind: "setAppName", name: "Test App" });
      expect(muts[1]).toEqual({ kind: "setConnectType", connectType: "learn" });
      expect(muts[2]).toMatchObject({ kind: "addModule" });
      // addForm mutations reference the module UUID from addModule
      const moduleUuid = (muts[2] as { module: { uuid: string } }).module.uuid;
      expect(muts[3]).toMatchObject({ kind: "addForm", moduleUuid });
      expect(muts[4]).toMatchObject({ kind: "addForm", moduleUuid });
    });

    it("skips setConnectType when connect_type is absent", () => {
      const scaffold = { app_name: "X", modules: [] };
      const muts = toDocMutations("data-scaffold", scaffold, EMPTY_DOC);
      expect(muts).toEqual([{ kind: "setAppName", name: "X" }]);
    });
  });

  describe("data-module-done", () => {
    it("returns updateModule with caseListColumns mapped by index", () => {
      // Build a doc with one module via toDoc
      const doc = buildDocWithOneModule(); // helper
      const muts = toDocMutations("data-module-done", {
        moduleIndex: 0,
        caseListColumns: [{ field: "name", header: "Name" }],
      }, doc);
      expect(muts).toEqual([{
        kind: "updateModule",
        uuid: doc.moduleOrder[0],
        patch: { caseListColumns: [{ field: "name", header: "Name" }] },
      }]);
    });

    it("returns empty array when moduleIndex is out of bounds", () => {
      const muts = toDocMutations("data-module-done", { moduleIndex: 5 }, EMPTY_DOC);
      expect(muts).toEqual([]);
    });
  });

  describe("data-form-done / data-form-updated / data-form-fixed", () => {
    it("returns a replaceForm mutation with decomposed form + flattened questions", () => {
      const doc = buildDocWithOneModuleOneForm(); // helper
      const form = { name: "Register", type: "registration", questions: [
        { id: "name", type: "text", label: "Name" },
      ]};
      const muts = toDocMutations("data-form-done", {
        moduleIndex: 0, formIndex: 0, form,
      }, doc);
      expect(muts).toHaveLength(1);
      expect(muts[0]).toMatchObject({ kind: "replaceForm" });
    });

    for (const type of ["data-form-done", "data-form-fixed", "data-form-updated"]) {
      it(`handles ${type} identically`, () => {
        const doc = buildDocWithOneModuleOneForm();
        const form = { name: "X", type: "registration", questions: [] };
        const muts = toDocMutations(type, { moduleIndex: 0, formIndex: 0, form }, doc);
        expect(muts).toHaveLength(1);
      });
    }
  });

  it("returns empty array for unknown event types", () => {
    expect(toDocMutations("data-unknown", {}, EMPTY_DOC)).toEqual([]);
  });
});
```

Run: `npx vitest --run lib/generation/__tests__/mutationMapper.test.ts`
Expected: FAIL (module doesn't exist)

- [ ] **Step 2: Implement `lib/generation/mutationMapper.ts`**

```ts
/**
 * mutationMapper — pure translation from server stream events to doc mutations.
 *
 * Given a stream event type + data blob + current doc state snapshot, returns
 * the Mutation[] to apply to the BlueprintDoc store. Handles only events that
 * produce doc mutations — lifecycle events (data-start-build, data-done,
 * data-error, data-phase, etc.) are handled by the stream dispatcher.
 *
 * Pure function: no side effects, no store references, no signal grid.
 * Testable in isolation with fixture doc snapshots.
 */

import { flattenQuestions } from "@/lib/doc/converter";
import type {
  BlueprintDoc,
  FormEntity,
  Mutation,
  QuestionEntity,
  Uuid,
} from "@/lib/doc/types";
import { asUuid } from "@/lib/doc/types";
import type { BlueprintForm, FormType, Scaffold } from "@/lib/schemas/blueprint";
import { decomposeFormEntity } from "@/lib/services/normalizedState";

/**
 * Translate a server stream event into doc mutations.
 *
 * @param type  - The stream event type string (e.g. "data-scaffold")
 * @param data  - The event payload (shape varies by type)
 * @param doc   - Current BlueprintDoc snapshot (for UUID lookups from indices)
 * @returns Mutation[] to apply to the doc store (may be empty)
 */
export function toDocMutations(
  type: string,
  data: Record<string, unknown>,
  doc: BlueprintDoc,
): Mutation[] {
  switch (type) {
    case "data-schema":
      return [{ kind: "setCaseTypes", caseTypes: data.caseTypes as CaseType[] }];

    case "data-scaffold":
      return scaffoldToDocMutations(data as unknown as Scaffold);

    case "data-module-done":
      return moduleDoneToMutations(data, doc);

    case "data-form-done":
    case "data-form-fixed":
    case "data-form-updated":
      return formContentToMutations(data, doc);

    default:
      return [];
  }
}
```

Implement `scaffoldToDocMutations` — moved from `lib/services/builderStore.ts` `scaffoldToMutations`. Exact same logic: iterate modules → addModule + addForm mutations with `crypto.randomUUID()` for UUIDs, setAppName, setConnectType.

Implement `moduleDoneToMutations` — looks up `moduleUuid` from `doc.moduleOrder[data.moduleIndex]`, returns `updateModule` mutation with `caseListColumns`. Returns `[]` if index out of bounds.

Implement `formContentToMutations` — looks up `formUuid` from `doc.moduleOrder[moduleIndex]` + `doc.formOrder[moduleUuid][formIndex]`. Calls `decomposeFormEntity` and `flattenQuestions` (same pattern as legacy `setFormContent`). Returns `replaceForm` mutation. Returns `[]` if indices are out of bounds. Preserves scaffold-set `purpose` from existing form.

- [ ] **Step 3: Run tests**

Run: `npx vitest --run lib/generation/__tests__/mutationMapper.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```
feat(generation): create pure toDocMutations mapper for stream events

Extracts the event→Mutation[] translation from the legacy store's generation
setters into a standalone pure function. Handles data-schema, data-scaffold,
data-module-done, data-form-done/fixed/updated. Used by the stream dispatcher
(T3) and replay rewrite (T9).

Phase 4 of builder state re-architecture.
Spec: Section 7 — toMutations(event, doc): Mutation[].
```

---

### Task 3: Create stream event dispatcher (`applyStreamEvent`)

**Depends on:** T1 (session store expansion) + T2 (mutation mapper). Both must be merged first.

**Files:**
- Create: `lib/generation/streamDispatcher.ts`
- Create: `lib/generation/__tests__/streamDispatcher.test.ts`

**Context:** `applyDataPart` in `lib/services/builder.ts` is the current central dispatcher. It routes ~12 stream event types to both the legacy store (lifecycle) and the doc store (entity data), and injects signal grid energy. This task creates its replacement: `applyStreamEvent` which routes events to doc mutations via `toDocMutations` (T2) + session store actions (T1) + signal grid energy. `applyStreamEvent` takes `docStore` and `sessionStore` as explicit parameters — no class wrapper, no legacy store dependency.

Key implementation difference from `applyDataPart`: the `data-done` and `data-blueprint-updated` events call `docStore.getState().load()` directly (full blueprint reconciliation), NOT through `toDocMutations` — the mutation mapper handles incremental events only.

---

- [ ] **Step 1: Write failing tests**

Create `lib/generation/__tests__/streamDispatcher.test.ts`. Set up a real doc store (from `createBlueprintDocStore`) and a real session store (from `createBuilderSessionStore`), with the doc store ref installed on the session store via `_setDocStore`.

Test cases:

```ts
describe("applyStreamEvent", () => {
  let docStore: BlueprintDocStoreApi;
  let sessionStore: BuilderSessionStoreApi;

  beforeEach(() => {
    docStore = createBlueprintDocStore();
    docStore.temporal.getState().resume();
    sessionStore = createBuilderSessionStore();
    sessionStore.getState()._setDocStore(docStore);
  });

  it("data-start-build: pauses doc undo, sets agentActive + agentStage", () => {
    applyStreamEvent("data-start-build", {}, docStore, sessionStore);
    expect(sessionStore.getState().agentActive).toBe(true);
    expect(sessionStore.getState().agentStage).toBe(GenerationStage.DataModel);
    // Doc undo paused
    expect(docStore.temporal.getState().isTracking).toBe(false);
  });

  it("data-schema: applies setCaseTypes mutation to doc", () => {
    applyStreamEvent("data-schema", { caseTypes: [{ name: "p" }] }, docStore, sessionStore);
    expect(docStore.getState().caseTypes).toEqual([{ name: "p" }]);
  });

  it("data-scaffold: creates modules + forms in doc", () => {
    const scaffold = { app_name: "App", modules: [{
      name: "M1", case_type: "c", forms: [{ name: "F1", type: "registration" }],
    }]};
    applyStreamEvent("data-scaffold", scaffold, docStore, sessionStore);
    expect(docStore.getState().moduleOrder).toHaveLength(1);
    const mUuid = docStore.getState().moduleOrder[0];
    expect(docStore.getState().formOrder[mUuid]).toHaveLength(1);
  });

  it("data-done: reconciles doc with final blueprint, sets justCompleted", () => {
    // First put something in doc
    applyStreamEvent("data-start-build", {}, docStore, sessionStore);
    // Then send done with a blueprint
    applyStreamEvent("data-done", {
      blueprint: { app_name: "Final", modules: [], case_types: null },
    }, docStore, sessionStore);
    expect(docStore.getState().appName).toBe("Final");
    expect(sessionStore.getState().justCompleted).toBe(true);
    expect(sessionStore.getState().agentActive).toBe(false);
  });

  it("data-blueprint-updated: loads replacement blueprint, stays Ready (no justCompleted)", () => {
    // Simulate post-build edit
    sessionStore.getState().setAgentActive(true);
    applyStreamEvent("data-blueprint-updated", {
      blueprint: { app_name: "Edited", modules: [], case_types: null },
    }, docStore, sessionStore);
    expect(docStore.getState().appName).toBe("Edited");
    expect(sessionStore.getState().justCompleted).toBe(false);
  });

  it("data-error: sets agentError on session store", () => {
    applyStreamEvent("data-error", { message: "boom", fatal: true }, docStore, sessionStore);
    assert(sessionStore.getState().agentError);
    expect(sessionStore.getState().agentError.severity).toBe("failed");
  });

  it("data-app-saved: stamps appId on session store", () => {
    applyStreamEvent("data-app-saved", { appId: "abc123" }, docStore, sessionStore);
    expect(sessionStore.getState().appId).toBe("abc123");
  });

  it("data-phase: advances session stage", () => {
    applyStreamEvent("data-phase", { phase: "forms" }, docStore, sessionStore);
    expect(sessionStore.getState().agentStage).toBe(GenerationStage.Forms);
  });

  it("data-fix-attempt: updates session statusMessage", () => {
    applyStreamEvent("data-fix-attempt", { attempt: 2, errorCount: 3 }, docStore, sessionStore);
    expect(sessionStore.getState().statusMessage).toContain("3 errors");
  });

  it("data-partial-scaffold: updates session partialScaffold", () => {
    applyStreamEvent("data-partial-scaffold", {
      modules: [{ name: "M", forms: [{ name: "F", type: "r" }] }],
    }, docStore, sessionStore);
    assert(sessionStore.getState().partialScaffold);
    expect(sessionStore.getState().partialScaffold.modules).toHaveLength(1);
  });
});
```

Run: `npx vitest --run lib/generation/__tests__/streamDispatcher.test.ts`
Expected: FAIL

- [ ] **Step 2: Implement `lib/generation/streamDispatcher.ts`**

```ts
/**
 * streamDispatcher — routes server stream events to doc mutations,
 * session store state, and signal grid energy.
 *
 * Replaces `applyDataPart` from `lib/services/builder.ts`. The key
 * architectural change: this function takes the doc store and session
 * store as explicit parameters (no legacy store dependency). Doc mutations
 * come from the pure `toDocMutations` mapper; lifecycle transitions
 * happen on the session store directly.
 *
 * Three event categories:
 * 1. Doc mutation events → toDocMutations → docStore.applyMany
 * 2. Doc lifecycle events → docStore.load (full replacements)
 * 3. Session-only events → sessionStore actions
 *
 * Signal grid energy is injected based on event significance (same
 * scale as the old applyDataPart).
 */
import type { BlueprintDocStoreApi } from "@/lib/doc/store";
import type { AppBlueprint, CaseType } from "@/lib/schemas/blueprint";
import type { BuilderSessionStoreApi } from "@/lib/session/store";
import type { PartialScaffoldData } from "@/lib/session/types";
import { signalGrid } from "@/lib/signalGrid/store";
import { toDocMutations } from "./mutationMapper";

export function applyStreamEvent(
  type: string,
  data: Record<string, unknown>,
  docStore: BlueprintDocStoreApi,
  sessionStore: BuilderSessionStoreApi,
): void {
  // ── Signal grid energy ────────────────────────────────────────
  injectSignalEnergy(type);

  // ── Route by category ─────────────────────────────────────────
  const session = sessionStore.getState();
  const doc = docStore.getState();

  switch (type) {
    // Category 3: session-only lifecycle events
    case "data-start-build":
      session.beginAgentWrite();
      return;

    case "data-phase":
      session.advanceStage(data.phase as string);
      return;

    case "data-fix-attempt":
      session.setFixAttempt(data.attempt as number, data.errorCount as number);
      return;

    case "data-partial-scaffold":
      session.setPartialScaffold(parsePartialScaffold(data));
      return;

    case "data-error":
      session.failAgentWrite(
        data.message as string,
        (data.fatal as boolean) ? "failed" : "recovering",
      );
      return;

    case "data-app-saved":
      session.setAppId(data.appId as string);
      return;

    // Category 2: doc lifecycle events (full replacements)
    case "data-done": {
      const result = data as { blueprint?: AppBlueprint };
      if (result.blueprint) {
        const appId = session.appId ?? "";
        doc.load(result.blueprint, appId);
      }
      session.endAgentWrite();
      return;
    }

    case "data-blueprint-updated": {
      const bp = data.blueprint as AppBlueprint;
      const appId = session.appId ?? "";
      doc.load(bp, appId);
      doc.endAgentWrite();
      // No justCompleted — edit-tool responses don't show celebration.
      // agentActive stays true until chat status effect flips it.
      return;
    }

    // Category 1: doc mutation events
    case "data-schema":
    case "data-scaffold":
    case "data-module-done":
    case "data-form-done":
    case "data-form-fixed":
    case "data-form-updated": {
      const mutations = toDocMutations(type, data, doc);
      if (mutations.length > 0) {
        doc.applyMany(mutations);
      }
      return;
    }
  }
}

/** Inject signal grid energy based on event significance. */
function injectSignalEnergy(type: string): void {
  switch (type) {
    case "data-module-done":
    case "data-form-done":
    case "data-form-fixed":
      signalGrid.injectEnergy(200);
      break;
    case "data-form-updated":
    case "data-blueprint-updated":
      signalGrid.injectEnergy(100);
      break;
    case "data-phase":
    case "data-schema":
    case "data-scaffold":
    case "data-partial-scaffold":
    case "data-fix-attempt":
      signalGrid.injectEnergy(50);
      break;
  }
}

/** Parse raw partial scaffold data from the stream. Mirrors the old
 *  setPartialScaffold action's parsing logic. */
function parsePartialScaffold(
  partial: Record<string, unknown>,
): PartialScaffoldData | undefined {
  const modules = partial?.modules as Array<Record<string, unknown>> | undefined;
  if (!modules?.length) return undefined;
  return {
    appName: partial.app_name as string | undefined,
    modules: modules
      .filter((m) => m?.name)
      .map((m) => ({
        name: m.name as string,
        case_type: m.case_type as string | undefined,
        purpose: m.purpose as string | undefined,
        forms: ((m.forms as Array<Record<string, unknown>> | undefined) ?? [])
          .filter((f) => f?.name)
          .map((f) => ({
            name: f.name as string,
            type: f.type as string,
            purpose: f.purpose as string | undefined,
          })),
      })),
  };
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest --run lib/generation/__tests__/streamDispatcher.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```
feat(generation): create stream event dispatcher replacing applyDataPart

Routes all server stream events to the appropriate handler:
- Doc mutation events → toDocMutations → docStore.applyMany
- Doc lifecycle events (data-done, data-blueprint-updated) → docStore.load
- Session events → sessionStore actions
- Signal grid energy injection

No legacy store dependency. Takes docStore + sessionStore as explicit params.

Phase 4 of builder state re-architecture.
Spec: Section 7 — stream consumer architecture.
```

---

### Task 4: Derive phase from session + doc state

**Depends on:** T1 (session store fields).

**Files:**
- Modify: `lib/session/hooks.tsx`
- Modify: `lib/session/__tests__/store.test.ts` (or create `lib/session/__tests__/hooks.test.tsx`)

**Context:** `BuilderPhase` was stored explicitly on the legacy store with manual transition calls (`startGeneration → Generating`, `completeGeneration → Completed`, etc.). Phase 4 derives it from session + doc state: `Loading` when `session.loading`, `Completed` when `session.justCompleted`, `Generating` when `session.agentActive && !session.postBuildEdit`, `Ready` when doc has data, `Idle` otherwise. `useBuilderPhase()` moves from `hooks/useBuilder.tsx` to `lib/session/hooks.tsx`.

The `BuilderPhase` enum is currently in `lib/services/builder.ts`. For T4, import it from there. Phase 6 will relocate the enum.

---

- [ ] **Step 1: Write failing tests for `derivePhase`**

Test the pure derivation function (not the hook — hooks need a provider wrapper). Create tests in `lib/session/__tests__/store.test.ts` or a new file:

```ts
describe("derivePhase", () => {
  it("returns Loading when loading=true", () => {
    expect(derivePhase({ loading: true }, true)).toBe(BuilderPhase.Loading);
  });
  it("returns Completed when justCompleted=true", () => {
    expect(derivePhase({ justCompleted: true }, true)).toBe(BuilderPhase.Completed);
  });
  it("returns Generating when agentActive && !postBuildEdit", () => {
    expect(derivePhase({ agentActive: true, postBuildEdit: false }, false)).toBe(BuilderPhase.Generating);
  });
  it("returns Ready when agentActive && postBuildEdit (post-build edit)", () => {
    expect(derivePhase({ agentActive: true, postBuildEdit: true }, true)).toBe(BuilderPhase.Ready);
  });
  it("returns Ready when docHasData && no agent", () => {
    expect(derivePhase({}, true)).toBe(BuilderPhase.Ready);
  });
  it("returns Idle when no data && no agent", () => {
    expect(derivePhase({}, false)).toBe(BuilderPhase.Idle);
  });
  it("Loading takes priority over everything", () => {
    expect(derivePhase({ loading: true, agentActive: true, justCompleted: true }, true))
      .toBe(BuilderPhase.Loading);
  });
});
```

Run: `npx vitest --run lib/session/__tests__/store.test.ts`
Expected: FAIL

- [ ] **Step 2: Implement `derivePhase` and hook**

In `lib/session/hooks.tsx`:

```ts
import { BuilderPhase } from "@/lib/services/builder";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";

/**
 * Derive the builder lifecycle phase from session + doc state.
 *
 * Priority: Loading > Completed > Generating > Ready > Idle.
 * Exported for unit testing — components use `useBuilderPhase()`.
 */
export function derivePhase(
  session: {
    loading?: boolean;
    justCompleted?: boolean;
    agentActive?: boolean;
    postBuildEdit?: boolean;
  },
  docHasData: boolean,
): BuilderPhase {
  if (session.loading) return BuilderPhase.Loading;
  if (session.justCompleted) return BuilderPhase.Completed;
  if (session.agentActive && !session.postBuildEdit) return BuilderPhase.Generating;
  if (docHasData) return BuilderPhase.Ready;
  return BuilderPhase.Idle;
}

/**
 * Current builder lifecycle phase — derived from session + doc state.
 *
 * Replaces the legacy `useBuilderPhase()` in `hooks/useBuilder.tsx`.
 * Not stored; computed on each render from:
 * - `loading` flag on session store
 * - `justCompleted` flag on session store
 * - `agentActive` + `postBuildEdit` on session store
 * - `moduleOrder.length > 0` on doc store (docHasData)
 */
export function useBuilderPhase(): BuilderPhase {
  const session = useBuilderSessionShallow((s) => ({
    loading: s.loading,
    justCompleted: s.justCompleted,
    agentActive: s.agentActive,
    postBuildEdit: s.postBuildEdit,
  }));
  const docHasData = useBlueprintDoc((s) => s.moduleOrder.length > 0);
  return derivePhase(session, docHasData);
}

/** True when the builder has entity data and is interactive. */
export function useBuilderIsReady(): boolean {
  const phase = useBuilderPhase();
  return phase === BuilderPhase.Ready || phase === BuilderPhase.Completed;
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest --run lib/session/__tests__/store.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```
feat(session): derive BuilderPhase from session + doc state

useBuilderPhase() is now a derived hook reading loading, justCompleted,
agentActive, postBuildEdit from session store + docHasData from doc store.
No more explicit setPhase calls — phase transitions happen automatically
when the underlying signals change.

Priority: Loading > Completed > Generating > Ready > Idle.

Phase 4 of builder state re-architecture.
Spec: Section 7 — "phase becomes derived."
```

---

### Task 5: Simplify `useDocTreeData` and `scaffoldProgress`

**Depends on:** T1 (partialScaffold on session store).

**Files:**
- Modify: `lib/doc/hooks/useDocTreeData.ts`
- Modify: `lib/doc/hooks/__tests__/useDocTreeData.test.tsx`
- Modify: `lib/services/scaffoldProgress.ts`

**Context:** `useDocTreeData` currently receives `{ phase, generationData }` from the legacy store, with a complex precedence chain: doc entities (non-Generating) → scaffold+partials (merged) → scaffold alone → partialScaffold → undefined. In the new model, scaffold modules ARE doc entities (they're created as mutations by `data-scaffold`). The only generation-only data is `partialScaffold` (for the brief pre-scaffold window). The hook simplifies to: doc entities (always, no phase check) → partialScaffold fallback.

`scaffoldProgress` currently reads `BuilderState` + `BlueprintDoc`. Rewrite to read session state (via `agentStage`, `partialScaffold`) + doc state (via `caseTypes`, `moduleOrder`).

---

- [ ] **Step 1: Update `useDocTreeData` tests**

In `lib/doc/hooks/__tests__/useDocTreeData.test.tsx`, update the test setup:
- Remove `DocTreeInputs` type references (no more `phase`/`generationData` params)
- Change the hook call to accept `partialScaffold` as the only param
- Add test: during generation with doc modules → derives from doc (not partialScaffold)
- Add test: during generation with empty doc + partialScaffold → uses partialScaffold
- Remove tests for scaffold/partialModules merge (dead path)

- [ ] **Step 2: Simplify `useDocTreeData`**

Remove the `DocTreeInputs` interface. Remove `phase` and `generationData` parameters. Remove `mergeScaffoldWithPartials` helper. Accept `partialScaffold` as the only optional parameter:

```ts
export function useDocTreeData(
  partialScaffold?: PartialScaffoldData,
): TreeData | undefined {
  const doc = useBlueprintDocShallow((s) => ({ /* same fields */ }));

  return useMemo(() => {
    if (doc.moduleOrder.length > 0) {
      // Derive from doc entities — works during BOTH generation and Ready
      return { /* same camelCase→snake_case translation */ };
    }

    // Fallback: partial scaffold during early generation (pre-scaffold)
    if (partialScaffold?.modules.length) {
      return {
        app_name: partialScaffold.appName ?? "",
        modules: partialScaffold.modules,
      };
    }

    return undefined;
  }, [doc, partialScaffold]);
}
```

- [ ] **Step 3: Update `useBuilderTreeData` in `hooks/useBuilder.tsx`**

Change the caller to read `partialScaffold` from the session store instead of `phase`/`generationData` from the legacy store:

```ts
export function useBuilderTreeData(): TreeData | undefined {
  const partialScaffold = usePartialScaffold(); // from lib/session/hooks
  return useDocTreeData(partialScaffold);
}
```

Remove the import of `useBuilderStoreShallow` if this was its last usage in this function.

- [ ] **Step 4: Rewrite `scaffoldProgress`**

Replace `BuilderState` parameter with a session-shaped input:

```ts
interface ScaffoldProgressInput {
  agentStage: GenerationStage | null;
  partialScaffold: PartialScaffoldData | undefined;
  loading: boolean;
  justCompleted: boolean;
  agentActive: boolean;
  postBuildEdit: boolean;
}

export function computeScaffoldProgress(
  session: ScaffoldProgressInput,
  doc: BlueprintDoc | null | undefined,
): number {
  // Derive phase inline instead of reading it
  const docHasData = (doc?.moduleOrder.length ?? 0) > 0;
  const isGenerating = session.agentActive && !session.postBuildEdit;
  const isReady = !session.loading && !session.agentActive && docHasData;

  if (!isGenerating) {
    return isReady || session.justCompleted ? 1.0 : 0;
  }

  if (session.agentStage === GenerationStage.DataModel) {
    const hasCaseTypes = (doc?.caseTypes?.length ?? 0) > 0;
    return hasCaseTypes ? 0.3 : 0.05;
  }
  if (session.agentStage === GenerationStage.Structure) {
    if (docHasData) return 0.85;      // scaffold created doc entities
    if (session.partialScaffold) return 0.55;
    return 0.35;
  }
  return 1.0;
}
```

Update all callers of `computeScaffoldProgress` (search for `computeScaffoldProgress`) to pass session store state instead of legacy store state.

- [ ] **Step 5: Run tests**

Run: `npx vitest --run`
Expected: PASS

- [ ] **Step 6: Commit**

```
refactor(doc): simplify useDocTreeData — derive from doc during generation

Removes phase/generationData parameters. During generation, scaffold modules
ARE doc entities (created via mutations), so the doc-based derivation works
at all phases. Only fallback: partialScaffold for the brief pre-scaffold window.

Deletes mergeScaffoldWithPartials (dead path — doc is the progressive state).

Also rewrites computeScaffoldProgress to read session store instead of legacy.

Phase 4 of builder state re-architecture.
```

---

### Task 6: Migrate `ChatContainer` to stream dispatcher + session store

**Depends on:** T3 (stream dispatcher), T4 (derived phase).

**Files:**
- Modify: `components/chat/ChatContainer.tsx`

**Context:** ChatContainer is the primary consumer of `applyDataPart` — it calls it in the `onData` callback of the Chat instance. It also reads `selectInReplayMode`, `replayMessages`, `appId`, and calls `setAgentActive` / `setGenerationError` on the legacy store. This task replaces ALL legacy store interactions with the stream dispatcher + session store.

---

- [ ] **Step 1: Update imports**

Replace:
```ts
import { applyDataPart, BuilderPhase } from "@/lib/services/builder";
import { selectInReplayMode, selectIsReady } from "@/lib/services/builderSelectors";
import type { BuilderStoreApi } from "@/lib/services/builderStore";
```

With:
```ts
import { applyStreamEvent } from "@/lib/generation/streamDispatcher";
import { BuilderPhase } from "@/lib/services/builder";
import { BuilderSessionContext, useBuilderSessionApi } from "@/lib/session/provider";
import { useInReplayMode, useReplayMessages, useAppId } from "@/lib/session/hooks";
```

- [ ] **Step 2: Replace `onData` callback in `createChatInstance`**

The `onData` callback currently calls `applyDataPart(inputs, type, data)` where `inputs = { store: storeRef.current, docStore: docStoreRef.current }`. Replace with `applyStreamEvent(type, data, docStoreRef.current!, sessionStoreRef.current!)`.

The function signature changes: `storeRef` (legacy) → `sessionStoreRef` (session store).

The `body` callback in the transport currently reads `s.appId` and `selectIsReady(s)` from the legacy store. Replace:
- `s.appId` → `sessionStoreRef.current!.getState().appId`
- `selectIsReady(s)` → derive from session + doc: `const session = sessionStoreRef.current!.getState(); const docHasData = (docStoreRef.current?.getState().moduleOrder.length ?? 0) > 0; const appReady = docHasData && !session.loading;`

- [ ] **Step 3: Replace store reads in the component**

- `useBuilderStore(selectInReplayMode)` → `useInReplayMode()` from session hooks
- `useBuilderStore((s) => s.replayMessages)` → `useReplayMessages()` from session hooks
- `useBuilderStoreApi()` → `useBuilderSessionApi()` (for imperative reads)
- The chat status effect (`useEffect` that calls `setAgentActive`) → call `sessionStore.getState().setAgentActive(active)` instead of `storeApi.getState().setAgentActive(active)`
- The chatError effect → call `sessionStore.getState().failAgentWrite(message, "failed")` instead of `storeApi.getState().setGenerationError(message, "failed")`, with a phase check derived from session state
- Thread persistence: `storeApi.getState().appId` → `sessionStore.getState().appId`

- [ ] **Step 4: Handle `data-app-saved` URL update**

The `data-app-saved` handler currently calls `applyDataPart` AND then does `window.history.replaceState(...)`. In the new model, `applyStreamEvent` handles `data-app-saved` (stamps appId on session store). The URL update stays in the `onData` callback:

```ts
if (type === "data-app-saved") {
  applyStreamEvent(type, data, docStoreRef.current!, sessionStoreRef.current!);
  window.history.replaceState({}, "", `/build/${data.appId as string}`);
  return;
}
applyStreamEvent(type, data, docStoreRef.current!, sessionStoreRef.current!);
```

- [ ] **Step 5: Keep legacy store ref for `selectIsReady` in transport body**

The transport `body` callback needs `appReady` to decide message strategy (one-shot vs full history). This currently reads from the legacy store via `selectIsReady(s)`. After Phase 4, it derives from session + doc state. The `body` callback runs outside of React (it's a closure), so it reads stores imperatively.

Note: `storeRef` for the legacy store is still needed for ChatContainer's `key` comparison (identity-based per-app Chat recreation). This will be removed in Phase 6 when the legacy store is deleted. For now, keep the legacy store ref for the identity check only.

- [ ] **Step 6: Run lint and tests**

Run: `npx tsc --noEmit && npm run lint && npx vitest --run`
Expected: PASS

- [ ] **Step 7: Commit**

```
refactor(chat): migrate ChatContainer to stream dispatcher + session store

Replaces all legacy store interactions:
- onData callback uses applyStreamEvent instead of applyDataPart
- Chat status effect calls sessionStore.setAgentActive
- Error handling calls sessionStore.failAgentWrite
- Reads inReplayMode, replayMessages, appId from session hooks
- Transport body derives appReady from session + doc state

Phase 4 of builder state re-architecture.
```

---

### Task 7: Migrate generation consumer components

**Depends on:** T1 (session hooks), T4 (derived phase).

**Files:**
- Modify: `components/chat/ChatSidebar.tsx`
- Modify: `components/chat/SignalGrid.tsx`
- Modify: `components/builder/GenerationProgress.tsx`

**Context:** These three components read generation metadata (agentActive, postBuildEdit, generationStage, generationError, statusMessage) from the legacy builder store. Migrate to session store hooks. `ChatSidebar` also calls `acknowledgeCompletion()` — migrate to session store action.

---

- [ ] **Step 1: Migrate `ChatSidebar.tsx`**

Replace legacy store reads. Search for `useBuilderPhase` and `useBuilderStoreShallow` calls that select generation fields:

```ts
// OLD
const phase = useBuilderPhase();
const { generationError, generationStage, agentActive, postBuildEdit, statusMessage } =
  useBuilderStoreShallow((s) => ({ ... }));
// ...
storeApi.getState().acknowledgeCompletion();

// NEW
import { useBuilderPhase, useBuilderIsReady } from "@/lib/session/hooks";
import { useBuilderSessionApi } from "@/lib/session/provider";
// ... or use individual hooks:
const phase = useBuilderPhase();
const { generationError, generationStage, agentActive, postBuildEdit, statusMessage } =
  useBuilderSessionShallow((s) => ({
    generationError: s.agentError,
    generationStage: s.agentStage,
    agentActive: s.agentActive,
    postBuildEdit: s.postBuildEdit,
    statusMessage: s.statusMessage,
  }));
// ...
const sessionApi = useBuilderSessionApi();
sessionApi.getState().acknowledgeCompletion();
```

Note the field renames: `generationError` → `agentError`, `generationStage` → `agentStage` on the session store. Either rename at the consumption site or use destructuring aliases to keep local variable names consistent.

For `computeScaffoldProgress` calls, pass session store state instead of legacy store state.

- [ ] **Step 2: Migrate `SignalGrid.tsx`**

Search for `useBuilderStoreApi` imperative reads of `postBuildEdit` and `agentActive`. Replace with session store imperative reads:

```ts
// OLD
const storeRef = useRef(useBuilderStoreApi());
// ... inside rAF callback:
const s = storeRef.current.getState();
if (s.postBuildEdit && s.agentActive) { ... }

// NEW
const sessionRef = useRef(useBuilderSessionApi());
// ... inside rAF callback:
const s = sessionRef.current.getState();
if (s.postBuildEdit && s.agentActive) { ... }
```

Also update the `computeScaffoldProgress` call inside the rAF loop.

- [ ] **Step 3: Migrate `GenerationProgress.tsx`**

Replace legacy selector imports:

```ts
// OLD
import { selectGenError, selectGenStage, selectStatusMsg } from "@/lib/services/builderSelectors";
const stage = useBuilderStore(selectGenStage);
const generationError = useBuilderStore(selectGenError);
const statusMessage = useBuilderStore(selectStatusMsg);

// NEW
import { useAgentStage, useAgentError, useStatusMessage } from "@/lib/session/hooks";
const stage = useAgentStage();
const generationError = useAgentError();
const statusMessage = useStatusMessage();
```

The rendering logic uses `GenerationStage` enum values — update imports from `@/lib/services/builder` to `@/lib/session/types`.

- [ ] **Step 4: Run tests**

Run: `npx tsc --noEmit && npm run lint && npx vitest --run`
Expected: PASS

- [ ] **Step 5: Commit**

```
refactor(ui): migrate generation consumers to session store

ChatSidebar, SignalGrid, GenerationProgress now read agentStage,
agentError, statusMessage, agentActive, postBuildEdit from the session
store. acknowledgeCompletion moves to session store action.

Phase 4 of builder state re-architecture.
```

---

### Task 8: Migrate builder layout components

**Depends on:** T4 (derived phase), T1 (session hooks).

**Files:**
- Modify: `components/builder/BuilderLayout.tsx`
- Modify: `components/builder/BuilderContentArea.tsx`
- Modify: `components/builder/AppTree.tsx`

**Context:** These components use `useBuilderPhase()`, `useBuilderIsReady()`, and `selectInReplayMode` from the legacy store. Migrate to session hooks.

---

- [ ] **Step 1: Migrate `BuilderLayout.tsx`**

Replace imports:
```ts
// OLD
import { useBuilderPhase, useBuilderStore, useBuilderStoreApi } from "@/hooks/useBuilder";
import { selectInReplayMode } from "@/lib/services/builderSelectors";
const phase = useBuilderPhase();
const inReplayMode = useBuilderStore(selectInReplayMode);

// NEW
import { useBuilderPhase, useInReplayMode } from "@/lib/session/hooks";
const phase = useBuilderPhase();
const inReplayMode = useInReplayMode();
```

The auto-navigate effect that watches for `Generating → Completed` transition stays the same — it reads `phase` which is now derived. The `useEffect` that runs on phase change triggers the auto-navigation to the first form. The logic is identical; only the import source changes.

For imperative reads, replace `useBuilderStoreApi` with `useBuilderSessionApi` where generation fields are accessed.

- [ ] **Step 2: Migrate `BuilderContentArea.tsx`**

Replace:
```ts
// OLD
import { useBuilderPhase, useBuilderIsReady, useBuilderHasData, useBuilderStore } from "@/hooks/useBuilder";
import { selectInReplayMode } from "@/lib/services/builderSelectors";

// NEW
import { useBuilderPhase, useBuilderIsReady, useInReplayMode } from "@/lib/session/hooks";
import { useBuilderHasData } from "@/hooks/useBuilder"; // still from old location (delegates to doc hook)
```

- [ ] **Step 3: Migrate `AppTree.tsx`**

Replace:
```ts
// OLD
import { useBuilderPhase } from "@/hooks/useBuilder";
// NEW
import { useBuilderPhase } from "@/lib/session/hooks";
```

- [ ] **Step 4: Run tests**

Run: `npx tsc --noEmit && npm run lint && npx vitest --run`
Expected: PASS

- [ ] **Step 5: Commit**

```
refactor(builder): migrate layout components to session store phase hooks

BuilderLayout, BuilderContentArea, AppTree now read phase and inReplayMode
from session hooks instead of the legacy store.

Phase 4 of builder state re-architecture.
```

---

### Task 9: Rewrite replay to use stream dispatcher + session store

**Depends on:** T3 (stream dispatcher), T1 (session store replay fields).

**Files:**
- Modify: `lib/services/logReplay.ts`
- Modify: `components/builder/ReplayController.tsx`
- Modify: `lib/services/resetBuilder.ts`

**Context:** The current replay pipeline: `extractReplayStages` creates `ReplayStage` objects with `applyToBuilder` closures that call `applyDataPart`. Phase 4 changes `ReplayStage` to data-only (storing raw `emissions` array instead of a closure), and the consumer applies emissions through `applyStreamEvent`.

**Key change:** `ReplayStage.applyToBuilder` is deleted. The `applyToBuilder` closure was the bridge between the old `applyDataPart` dispatcher and replay — with the new dispatcher, the consumer calls `applyStreamEvent` directly for each emission.

---

- [ ] **Step 1: Update `ReplayStage` type in `logReplay.ts`**

Change the interface:
```ts
// OLD
export interface ReplayStage {
  header: string;
  subtitle?: string;
  messages: UIMessage[];
  applyToBuilder: (inputs: ApplyDataPartInputs) => void;
}

// NEW — data-only, no closures
export interface ReplayStage {
  header: string;
  subtitle?: string;
  messages: UIMessage[];
  /** Raw emissions to dispatch through applyStreamEvent. */
  emissions: Array<{ type: string; data: Record<string, unknown> }>;
}
```

Also re-export from `lib/session/types.ts` (where T1 forward-declared it) — delete the forward declaration and import from logReplay instead, or move the canonical definition to session/types.ts. Choose one canonical location. Since `ReplayStage` is consumed by both logReplay (extraction) and session store (storage), `lib/session/types.ts` is the better home.

- [ ] **Step 2: Update `extractReplayStages` to build data-only stages**

Where it currently creates closures:
```ts
// OLD
applyToBuilder: (inputs) => {
  for (const em of stepEmissions)
    applyDataPart(inputs, em.type, em.data as Record<string, unknown>);
},

// NEW
emissions: stepEmissions.map((em) => ({
  type: em.type,
  data: em.data as Record<string, unknown>,
})),
```

The "Done" stage currently calls `completeGeneration()`. In the new model, the Done stage has no emissions — the consumer handles the completion transition:

```ts
// OLD Done stage
stages.push({
  header: "Done",
  messages: buildProgressiveMessages(),
  applyToBuilder: (inputs) => {
    inputs.store.getState().completeGeneration();
  },
});

// NEW Done stage — empty emissions
stages.push({
  header: "Done",
  messages: buildProgressiveMessages(),
  emissions: [],
});
```

Remove the `import { applyDataPart } from "./builder"` and `import type { ApplyDataPartInputs } from "./builder"`.

- [ ] **Step 3: Rewrite `ReplayController.tsx`**

Replace legacy store reads with session store reads:

```ts
// OLD
const stages = useBuilderStore((s) => s.replayStages) ?? [];
const doneIndex = useBuilderStore((s) => s.replayDoneIndex);

// NEW
const replay = useBuilderSession((s) => s.replay);
const stages = replay?.stages ?? [];
const doneIndex = replay?.doneIndex ?? 0;
```

Replace `goToStage` implementation:
```ts
// OLD
doReset();
for (let i = 0; i <= targetIndex; i++) {
  stages[i].applyToBuilder({ store: storeApi, docStore: docStore ?? null });
}
storeApi.getState().setReplayMessages(stages[targetIndex].messages);

// NEW
doReset();
for (let i = 0; i <= targetIndex; i++) {
  for (const em of stages[i].emissions) {
    applyStreamEvent(em.type, em.data, docStore!, sessionStore!);
  }
}
sessionStore!.getState().setReplayMessages(stages[targetIndex].messages);
```

Replace exit handler:
```ts
// OLD
const exitPath = storeApi.getState().replayExitPath ?? "/";

// NEW
const exitPath = sessionStore!.getState().replay?.exitPath ?? "/";
```

Remove `useBuilderStore` and `useBuilderStoreApi` imports. Add `useBuilderSession`, `useBuilderSessionApi` (or use context directly).

- [ ] **Step 4: Update `resetBuilder.ts`**

Remove the `store: BuilderStoreApi` parameter and `store.getState().reset()` call. The session store's `reset()` handles all session state. The legacy store reset is dead code after this change.

```ts
// OLD
export interface ResetBuilderInputs {
  store: BuilderStoreApi;
  sessionStore: BuilderSessionStoreApi;
  docStore: BlueprintDocStore;
  engineController: EngineController;
}

// NEW
export interface ResetBuilderInputs {
  sessionStore: BuilderSessionStoreApi;
  docStore: BlueprintDocStore;
  engineController: EngineController;
}
```

Update all callers of `resetBuilder` (search for `resetBuilder(`) to remove the `store` parameter.

- [ ] **Step 5: Run tests**

Run: `npx tsc --noEmit && npm run lint && npx vitest --run`
Expected: PASS (existing replay tests may need updates for the new stage shape)

- [ ] **Step 6: Commit**

```
refactor(replay): data-only stages + stream dispatcher integration

ReplayStage is now data-only (emissions array, no closure). Consumers
apply emissions through applyStreamEvent. ReplayController reads replay
state from session store. resetBuilder no longer depends on legacy store.

Deletes the applyDataPart → ReplayStage.applyToBuilder bridge.

Phase 4 of builder state re-architecture.
Spec: Section 7 — "Replay is a 15-line wrapper around the same machinery."
```

---

### Task 10: Update BuilderProvider + SyncBridge

**Depends on:** T1 (session store fields), T9 (replay rewrite).

**Files:**
- Modify: `hooks/useBuilder.tsx`

**Context:** `BuilderProviderInner` creates the legacy store, mounts the provider stack, and hydrates via `SyncBridge` + `ReplayHydrator`. Phase 4 changes: (1) `loadApp` effect stamps appId + loading flag on the session store, (2) `SyncBridge` only installs docStore on the session store (legacy store bridge is dead code), (3) `ReplayHydrator` uses `applyStreamEvent` instead of `applyToBuilder`.

---

- [ ] **Step 1: Update `loadApp` effect in `BuilderProviderInner`**

The effect currently calls `store.getState().loadApp(buildId)` to stamp appId and set phase=Ready on the legacy store. Replace with session store actions:

```ts
// OLD
useEffect(() => {
  if (replay) return;
  if (initialBlueprint) store.getState().loadApp(buildId);
}, [store, buildId, replay, initialBlueprint]);

// NEW — need session store context, but BuilderProviderInner is OUTSIDE
// BuilderSessionProvider. Solution: move the effect to a child component
// (same pattern as ReplayHydrator).
```

Create a `LoadAppHydrator` child component (rendered inside the provider stack) that reads session context and stamps appId + clears loading:

```ts
function LoadAppHydrator({ buildId }: { buildId: string }) {
  const sessionStore = useContext(BuilderSessionContext);
  const hydratedRef = useRef(false);

  useEffect(() => {
    if (hydratedRef.current || !sessionStore) return;
    hydratedRef.current = true;
    sessionStore.getState().setAppId(buildId);
    sessionStore.getState().setLoading(false);
  }, [buildId, sessionStore]);

  return null;
}
```

Mount it conditionally in the provider stack:
```tsx
{!replay && initialBlueprint ? <LoadAppHydrator buildId={buildId} /> : null}
```

- [ ] **Step 2: Simplify `SyncBridge`**

Remove the legacy store docStore bridge. Only install on session store:

```ts
function SyncBridge() {
  const docStore = useContext(BlueprintDocContext);
  const sessionStore = useContext(BuilderSessionContext);

  useEffect(() => {
    if (!docStore || !sessionStore) return;
    sessionStore.getState()._setDocStore(docStore);
    return () => {
      sessionStore.getState()._setDocStore(null);
    };
  }, [docStore, sessionStore]);

  return null;
}
```

Remove `StoreContext` import from SyncBridge (it no longer reads the legacy store).

- [ ] **Step 3: Rewrite `ReplayHydrator`**

Use `applyStreamEvent` instead of `applyToBuilder`:

```ts
function ReplayHydrator({ replay }: { replay: ReplayInit }) {
  const docStore = useContext(BlueprintDocContext);
  const sessionStore = useContext(BuilderSessionContext);
  const hydratedRef = useRef(false);

  useEffect(() => {
    if (hydratedRef.current || !docStore || !sessionStore) return;
    hydratedRef.current = true;

    sessionStore.getState().loadReplay(replay.stages, replay.doneIndex, replay.exitPath);
    for (let i = 0; i <= replay.doneIndex; i++) {
      const stage = replay.stages[i];
      for (const em of stage.emissions) {
        applyStreamEvent(em.type, em.data, docStore, sessionStore);
      }
    }
  }, [replay, docStore, sessionStore]);

  return null;
}
```

Remove `StoreContext` import from ReplayHydrator.

- [ ] **Step 4: Update initial phase logic**

The legacy store was created with `BuilderPhase.Loading` or `BuilderPhase.Idle`. With derived phase, we instead set `loading=true` on the session store for existing apps:

The `createBuilderStore` call can be simplified (or eventually removed). For now, pass `BuilderPhase.Idle` always — the legacy store's phase field is no longer read by any migrated consumer.

But wait — the session store's `loading` field needs to be initialized to `true` for existing apps. The session store is created inside `BuilderSessionProvider`. We need to pass initialization config down.

**Option:** Add a `loading` prop to `BuilderSessionProvider` that initializes the session store with `loading=true`. Add an `appId` prop too:

```tsx
<BuilderSessionProvider
  initialLoading={Boolean(initialBlueprint || replay)}
  initialAppId={buildId === "new" ? undefined : buildId}
>
```

Update `createBuilderSessionStore` to accept initial overrides:

```ts
export function createBuilderSessionStore(init?: {
  loading?: boolean;
  appId?: string;
}) {
  // ... set initial loading and appId from init
}
```

- [ ] **Step 5: Remove legacy convenience hooks that are now replaced**

In `hooks/useBuilder.tsx`, remove or deprecate:
- `useBuilderPhase()` — replaced by `lib/session/hooks.tsx` version
- `useBuilderIsReady()` — replaced by session version
- `useBuilderAgentActive()` — replaced by `useAgentActive()` in session hooks
- `useBuilderInReplayMode()` — replaced by `useInReplayMode()` in session hooks
- `useBuilderTreeData()` — still needed, but simplified in T5

Keep the entity-access convenience hooks (`useModule`, `useForm`, `useQuestion`, `useOrderedModules`, `useOrderedForms`, `useAssembledForm`, `useBuilderHasData`) — these delegate to doc hooks and are cleaned up in Phase 6.

- [ ] **Step 6: Run tests**

Run: `npx tsc --noEmit && npm run lint && npx vitest --run`
Expected: PASS

- [ ] **Step 7: Commit**

```
refactor(provider): update BuilderProvider for session-driven lifecycle

- loadApp effect moved to LoadAppHydrator (inside provider stack)
- SyncBridge simplified (session store only, no legacy bridge)
- ReplayHydrator uses applyStreamEvent instead of applyToBuilder
- Session store accepts initial loading + appId
- Removed legacy convenience hooks replaced by session hooks

Phase 4 of builder state re-architecture.
```

---

### Task 11: Delete legacy store generation/replay fields + `applyDataPart`

**Depends on:** T6, T7, T8, T9, T10 (all consumers migrated).

**Files:**
- Modify: `lib/services/builderStore.ts`
- Modify: `lib/services/builder.ts`
- Modify: `lib/services/builderSelectors.ts`

**Context:** After T6-T10, no component reads generation/replay/lifecycle fields from the legacy store. This task deletes them, leaving the legacy store as a near-empty shell (Phase 6 deletes the file entirely).

---

- [ ] **Step 1: Gut `builderStore.ts`**

Remove from `BuilderState` interface:
- `phase`, `generationStage`, `generationError`, `statusMessage`
- `agentActive`, `postBuildEdit`
- `generationData` (and `PartialScaffoldData`, `PartialModule`, `GenerationData` types)
- `progressCompleted`, `progressTotal`
- `replayStages`, `replayDoneIndex`, `replayExitPath`, `replayMessages`
- `_docStore`, `setDocStore`
- `appId`

Remove all actions:
- `startGeneration`, `setSchema`, `setPartialScaffold`, `setScaffold`
- `setModuleContent`, `setFormContent`, `advanceStage`, `setFixAttempt`
- `completeGeneration`, `acknowledgeCompletion`, `setAppId`
- `loadApp`, `setAgentActive`, `setGenerationError`
- `loadReplay`, `setReplayMessages`

Remove helper functions:
- `scaffoldToMutations`
- `computeProgress`

Remove imports: `UIMessage`, `ReplayStage`, `BlueprintDocStore`, `BlueprintForm`, `CaseType`, `FormType`, `Scaffold`, etc.

What remains: a near-empty store with `reset()`. The `createBuilderStore` function still needs to exist (called by BuilderProviderInner) but can return a minimal store. Leave a comment: `// Phase 6 deletes this file entirely.`

- [ ] **Step 2: Delete `applyDataPart` from `builder.ts`**

Remove the `applyDataPart` function and the `ApplyDataPartInputs` interface. Keep all type exports (`BuilderPhase`, `GenerationStage`, `GenerationError`, `STAGE_LABELS`, `SelectedElement`, `EditScope`, `TreeData`) — they're imported by other modules. Move `GenerationStage`, `GenerationError`, `STAGE_LABELS` to `lib/session/types.ts` if not already done in T1 (check for dual definitions and consolidate).

- [ ] **Step 3: Delete dead selectors from `builderSelectors.ts`**

Remove: `selectInReplayMode`, `selectGenStage`, `selectGenError`, `selectStatusMsg`.

Keep `selectIsReady` if any consumer still uses it (search for `selectIsReady` — ChatContainer's transport body may still reference it). If all consumers are migrated, delete the file entirely.

- [ ] **Step 4: Run full test suite + type check + lint**

Run: `npx tsc --noEmit && npm run lint && npx vitest --run`
Expected: PASS. Fix any remaining type errors from deleted fields.

- [ ] **Step 5: Commit**

```
chore(cleanup): delete generation/replay fields from legacy store

Removes all generation lifecycle, replay, and doc bridge fields from
builderStore.ts. Deletes applyDataPart from builder.ts. Deletes dead
selectors. The legacy store is now a near-empty shell — Phase 6 deletes
the file entirely.

Phase 4 of builder state re-architecture.
```

---

### Task 12: Final cleanup + CLAUDE.md update

**Depends on:** T11 (all deletions done).

**Files:**
- Modify: `CLAUDE.md`
- Various: remove unused imports, verify no dead code

**Context:** Update the root `CLAUDE.md` to document the post-Phase-4 architecture: generation stream goes through `applyStreamEvent`, lifecycle state lives on BuilderSession, phase is derived, replay stages are data-only.

---

- [ ] **Step 1: Run a final comprehensive check**

```bash
npx tsc --noEmit && npm run lint && npx vitest --run && npm run build && echo "✓"
```

All four must pass.

- [ ] **Step 2: Fix any remaining issues**

Search for stale imports:
- `grep -r "applyDataPart" --include="*.ts" --include="*.tsx" lib/ components/ hooks/ app/` — should return zero hits
- `grep -r "ApplyDataPartInputs" --include="*.ts" --include="*.tsx"` — zero hits
- `grep -r "from.*builderStore.*import.*generationData" --include="*.ts" --include="*.tsx"` — zero hits

- [ ] **Step 3: Update CLAUDE.md**

In the "Builder State (Zustand + URL)" section, update:

- Remove references to `generationData`, `partialModules`, `partialScaffold` as legacy store fields
- Add description of `applyStreamEvent` as the stream event dispatcher
- Update the BuilderSession store description to include generation lifecycle fields
- Note that `phase` is derived, not stored
- Update `applyDataPart` references → `applyStreamEvent`
- Update the provider stack description (SyncBridge simplified, LoadAppHydrator added)
- Note that `lib/generation/mutationMapper.ts` and `lib/generation/streamDispatcher.ts` are new
- Update the "Legacy builder store" section to note it's now a near-empty shell

- [ ] **Step 4: Commit**

```
docs: update CLAUDE.md for Phase 4 — generation stream as mutations

Documents the post-Phase-4 architecture:
- applyStreamEvent replaces applyDataPart
- Generation lifecycle on BuilderSession store
- Phase derived from session + doc state
- Replay stages data-only (no closures)
- Legacy store is near-empty, deleted in Phase 6

Phase 4 of builder state re-architecture.
```

---

## Parallelization strategy

```
Round 1 (parallel):  T1 (session store) + T2 (mutation mapper)
Round 2 (parallel):  T3 (dispatcher, needs T1+T2) + T4 (derive phase, needs T1) + T5 (tree data, needs T1)
Round 3 (parallel):  T6 (ChatContainer, needs T3+T4) + T7 (gen consumers, needs T1+T4) + T8 (layout, needs T4)
Round 4:             T9 (replay, needs T3) — can run alongside T7/T8 if T3 is done
Round 5:             T10 (provider, needs T1+T9)
Round 6:             T11 (delete legacy, needs T6-T10)
Round 7:             T12 (cleanup, needs T11)
```

Merge order within each round: smallest diff first, then larger.

Expect merge conflicts in `hooks/useBuilder.tsx` (touched by T5, T8, T10) and `lib/session/store.ts` (touched by T1 only, but T5/T7 import from it). Plan these as sequential within their round.

---

## Success criteria

1. `applyDataPart` function no longer exists.
2. `generationData`, `partialModules`, `partialScaffold` (as legacy store fields) no longer exist.
3. `replayStages`, `replayDoneIndex`, `replayExitPath`, `replayMessages` no longer exist on the legacy store.
4. `ReplayStage.applyToBuilder` closure no longer exists — stages are data-only.
5. `BuilderPhase` is derived from session + doc state, never stored.
6. `npx tsc --noEmit && npm run lint && npx vitest --run && npm run build` all pass.
7. Generation produces a working blueprint (manual smoke test).
8. Replay plays back correctly (manual smoke test).
9. Undo after generation reverses the entire build (manual smoke test).
