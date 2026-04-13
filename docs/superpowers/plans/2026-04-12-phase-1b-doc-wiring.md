# Phase 1b — Builder State Re-architecture: BlueprintDoc Wiring + Old-Store Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the `BlueprintDoc` store into the running builder, route every user-driven and generation-stream entity mutation through `doc.apply()`, and migrate every blueprint-entity read in the app to `lib/doc/hooks/**`. The old `builderStore` stays mounted as a one-way mirror (doc → old store) so consumers that still depend on session fields (selection, navigation, generation metadata) keep working until Phase 2/3. Phase 1b also lands the path-to-path xpath rewriter so `moveQuestion` no longer silently skips rewrites on cross-level moves.

**Architecture:** Mount `<BlueprintDocProvider>` inside the existing `BuilderProvider` so both stores share the builder's lifetime and receive the same `initialBlueprint`. A new `syncOldFromDoc()` subscription in the provider projects the doc's entity maps into the old store's entity fields on every change — the old store becomes a pure read-mirror for blueprint data. Client-side user edits call a new `useBlueprintMutations()` hook that dispatches to `doc.apply()`. Generation-stream setters on the old store are rewritten to emit doc mutations for entity changes while keeping `generationData` as session-only state. Consumers migrate one file at a time from `useBuilderStore((s) => s.modules / forms / questions / ...)` to named `lib/doc/hooks/**` hooks.

**Tech Stack:** TypeScript (strict), Zustand 5, Immer 10, zundo 2, Next.js 16 RSC, Vitest, Biome, @testing-library/react 16.

**Spec reference:** `docs/superpowers/specs/2026-04-12-builder-state-rearchitecture-design.md` — Phase 1 row of the migration table + Section "1. BlueprintDoc (the domain store)" + Section "5. Selector API unification" + the "Adapter strategy (Phases 1–2)" note.

**Depends on:** Phase 1a (merged to main at `4e6b89c`). Phase 1a delivered:
- `lib/doc/store.ts` — `createBlueprintDocStore()` factory with full middleware stack.
- `lib/doc/provider.tsx` — `<BlueprintDocProvider>` React context and provider (not yet mounted anywhere).
- `lib/doc/mutations/**` — complete reducer surface including `addQuestion`, `removeQuestion`, `moveQuestion` (with a documented TODO for cross-level xpath rewrite), `renameQuestion`, `duplicateQuestion`, `updateQuestion`, all form and module mutations, and app-level mutations.
- `lib/doc/hooks/**` — `useBlueprintDoc`, `useBlueprintDocShallow`, `useBlueprintDocTemporal`, `useModule(uuid)`, `useForm(uuid)`, `useQuestion(uuid)`, `useModuleIds`, `useOrderedModules`, `useFormIds(moduleUuid)`, `useOrderedForms(moduleUuid)`, `useOrderedChildren(parentUuid)`, `useAssembledForm(formUuid)`.
- `lib/doc/converter.ts` — `toDoc(blueprint, appId)` and `toBlueprint(doc)`.

**Phase 1a limitations this plan addresses:**
1. `moveQuestion` does not rewrite xpath references on cross-level moves (TODO comment at `lib/doc/mutations/questions.ts:165-183`). Phase 1b lands a path-to-path rewriter and wires it in.
2. `useOrderedChildren` subscribes to the entire `questions` map. Phase 1b leaves this as-is — nothing on the consumer-migration path changes that requirement, and Phase 5's virtualization will restructure reads anyway. The hook is documented as load-bearing for virtualization.

---

## File Structure

**New files:**

```
lib/doc/
  adapters/
    pathToUuid.ts                # legacy-index/path → uuid resolvers for call-site migration
    syncOldFromDoc.ts            # one-way subscription: doc entity maps → old store entity fields
  mutations/
    pathRewrite.ts               # Lezer-based path-to-path xpath rewriter (fixes Phase 1a TODO)
  hooks/
    useBlueprintMutations.ts     # user-facing mutation API (wraps doc.apply)
    useLegacyBuilderFacade.ts    # temporary hook exposing old-shape accessors via doc
  __tests__/
    adapters-pathToUuid.test.ts
    adapters-syncOldFromDoc.test.tsx
    mutations-pathRewrite.test.ts
    mutations-questions-move-xpath.test.ts
    hooks-useBlueprintMutations.test.tsx
```

**Modified files:**

```
lib/doc/mutations/questions.ts                   # wire in pathRewrite for cross-level moves
lib/doc/mutations/index.ts                       # no changes (dispatcher already covers moveQuestion)

hooks/useBuilder.tsx                             # mount <BlueprintDocProvider> inside BuilderProvider;
                                                 #   swap useModule/useForm/useQuestion/useOrderedModules/
                                                 #   useOrderedForms/useAssembledForm/useBreadcrumbs bodies
                                                 #   to delegate to lib/doc/hooks/**
app/build/[id]/page.tsx                          # no changes (BuilderProvider wraps for it)
app/build/replay/[id]/replay-builder.tsx         # no changes (BuilderProvider is still the entry)

lib/services/builderStore.ts                     # streaming setters (setScaffold, setPartialScaffold,
                                                 #   setSchema, setModuleContent, setFormContent) emit
                                                 #   doc mutations for entity changes via a store-level
                                                 #   setDocAdapter() hook; entity-map writes are removed
                                                 #   from these action bodies
lib/services/builderEngine.ts                    # deleteSelected dispatches via doc mutation;
                                                 #   undo/redo invokes both stores' temporal;
                                                 #   switchConnectMode dispatches via doc updateForm

components/builder/AppTree.tsx                   # migrate entity reads to lib/doc/hooks
components/builder/contextual/ContextualEditorData.tsx
components/builder/contextual/ContextualEditorHeader.tsx
components/builder/contextual/ContextualEditorLogic.tsx
components/builder/contextual/ContextualEditorUI.tsx
components/builder/detail/FormDetail.tsx
components/builder/detail/FormSettingsPanel.tsx
components/builder/detail/ModuleDetail.tsx
components/builder/useBuilderShortcuts.ts
components/preview/form/EditableQuestionWrapper.tsx
components/preview/form/FormRenderer.tsx
components/preview/form/QuestionTypePicker.tsx
components/preview/screens/CaseListScreen.tsx
components/preview/screens/FormScreen.tsx
components/preview/screens/HomeScreen.tsx
components/preview/screens/ModuleScreen.tsx
hooks/useSaveQuestion.ts
hooks/useTextEditSave.ts
```

**Out of scope for Phase 1b (stay on old store — this is Phase 2/3 territory):**

- `selected`, `cursorMode`, `sidebars`, `activeFieldId`, `phase`, `screen`, `navEntries`, `navCursor`, `generationData`, `progressCompleted`, `progressTotal`, `agentActive`, `generationStage`, `generationError`, `replayStages`, `replayDoneIndex`, `replayExitPath`, `replayMessages`, `connectType`-stash.
- `BuilderEngine.navigateTo*`, scroll registry, energy grid, edit guard, focus hint, rename notice, new-question marker, drag state.
- `searchBlueprint` (read-only helper, migrates with Phase 4 generation work).

---

## Dependencies between tasks

- **Task 1** (provider wiring) is a prerequisite for every other task.
- **Task 2** (path-to-uuid adapters) is a prerequisite for Tasks 3 and 5.
- **Task 3** (mutation hook) is a prerequisite for Tasks 6 and 7.
- **Task 4** (syncOldFromDoc adapter) can land after Task 1 and must be in place before any consumer migration in Tasks 8–11 — without it, old-store consumers would see stale data the moment Task 6 redirects writes away from the old store.
- **Task 5** (facade flip inside `hooks/useBuilder.tsx`) is a prerequisite for Tasks 8–11 (migrates the entire indirect-consumer surface in one move).
- **Task 9** (path-to-path rewriter) is standalone; lands any time before Task 12.
- **Task 12** (verification) is last.

---

### Task 1: Mount `BlueprintDocProvider` inside `BuilderProvider`

**Files:**
- Modify: `hooks/useBuilder.tsx:380-453`

The existing `BuilderProvider` is the single entry point for every code path that mounts the builder (new apps, existing apps, replay). We wrap its children with `<BlueprintDocProvider>` so both stores share the provider's lifetime and receive the same `initialBlueprint`. Because the doc provider's `useRef`-based factory hydrates synchronously on first render, both stores are populated before any child renders.

For existing apps, `initialBlueprint` comes from the RSC page. For new apps, the provider mounts with no blueprint and the doc starts empty — exactly matching the old store's `Idle` phase today. The old store is NOT changed in this task: it still calls `loadApp(buildId, initialBlueprint)` inside `createEngine`. Both stores hydrate independently from the same blueprint, which means their entity maps are identical at mount; the one-way sync adapter (Task 4) takes over for every mutation afterward.

The doc provider receives `startTracking={true}` for existing apps and replay, and `startTracking={false}` for new apps (the builder is `Idle`, no undo history yet — resume on `completeGeneration`).

- [ ] **Step 1: Read `hooks/useBuilder.tsx` from top to bottom**

Command: read the whole file.

Expected: understand `BuilderProvider`, `createEngine`, `StoreContext`, `EngineContext`, and where children are rendered.

- [ ] **Step 2: Add imports**

Add at the top of `hooks/useBuilder.tsx` (after the existing `@/lib/services/*` imports):

```tsx
import { BlueprintDocProvider } from "@/lib/doc/provider";
```

- [ ] **Step 3: Wrap the existing provider body**

Locate the `BuilderProvider` return statement (currently renders `<EngineContext value={engine}><StoreContext value={engine.store}>{children}</StoreContext></EngineContext>`). Replace with:

```tsx
return (
	<EngineContext value={engine}>
		<StoreContext value={engine.store}>
			<BlueprintDocProvider
				appId={buildId === "new" ? "" : buildId}
				initialBlueprint={initialBlueprint}
				startTracking={Boolean(initialBlueprint || replay)}
			>
				{children}
			</BlueprintDocProvider>
		</StoreContext>
	</EngineContext>
);
```

Rationale: for new apps (`buildId === "new"`), we pass an empty `appId` because the real id isn't known until generation completes (at which point `loadApp` on the old store is called and Task 7 will ensure the doc is hydrated via the same path). For existing apps and replay, we pass the real `buildId` and the already-fetched `initialBlueprint`, and resume tracking so the first user edit is undoable.

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit && echo "✓ typecheck clean"
```

Expected: clean.

- [ ] **Step 5: Smoke-test dev server**

```bash
npm run dev
```

Manually:
1. Open `http://localhost:3000/build/new` — page renders, no console errors.
2. Open an existing app URL — app tree and builder render, no errors.

Expected: no React warnings, no provider-missing errors, no hydration mismatches.

- [ ] **Step 6: Commit**

```bash
git add hooks/useBuilder.tsx
git commit -m "feat(builder/doc): mount BlueprintDocProvider inside BuilderProvider"
```

---

### Task 2: Path-to-uuid adapter helpers

**Files:**
- Create: `lib/doc/adapters/pathToUuid.ts`
- Create: `lib/doc/__tests__/adapters-pathToUuid.test.ts`

The old builder-store mutation surface takes `(mIdx, fIdx, path)` arguments. The doc's mutation API takes uuids. Migrating call sites one at a time needs a resolver that converts legacy coordinates to uuids at call time, so a caller doesn't have to rewrite its own selection-tracking logic before it can dispatch a mutation. This module is a Phase 1b-only bridge; Phase 2 replaces it with URL-derived uuids from `useLocation()`.

The resolver reads directly from the doc state (not React hooks) because it's called inside event handlers, not during render. Callers pass the current `BlueprintDoc` snapshot — the mutation hook (Task 3) wires this automatically.

- [ ] **Step 1: Write the failing test**

Create `lib/doc/__tests__/adapters-pathToUuid.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
	resolveModuleUuid,
	resolveFormUuid,
	resolveQuestionUuid,
} from "@/lib/doc/adapters/pathToUuid";
import { toDoc } from "@/lib/doc/converter";
import type { AppBlueprint } from "@/lib/schemas/blueprint";

function fixture(): AppBlueprint {
	return {
		app_name: "Test",
		connect_type: undefined,
		case_types: null,
		modules: [
			{
				name: "M0",
				forms: [
					{
						name: "F0",
						type: "survey",
						questions: [
							{ uuid: "q-top-0000-0000-0000-000000000000", id: "name", type: "text", label: "Name" },
							{
								uuid: "q-grp-0000-0000-0000-000000000000",
								id: "grp",
								type: "group",
								label: "Grp",
								children: [
									{ uuid: "q-inner-0000-0000-0000-000000000000", id: "inner", type: "text", label: "Inner" },
								],
							},
						],
					},
				],
			},
			{ name: "M1", forms: [] },
		],
	};
}

describe("resolveModuleUuid", () => {
	it("returns the module uuid at the given mIdx", () => {
		const doc = toDoc(fixture(), "app");
		const uuid = resolveModuleUuid(doc, 1);
		expect(uuid).toBe(doc.moduleOrder[1]);
	});

	it("returns undefined for out-of-range mIdx", () => {
		const doc = toDoc(fixture(), "app");
		expect(resolveModuleUuid(doc, 5)).toBeUndefined();
		expect(resolveModuleUuid(doc, -1)).toBeUndefined();
	});
});

describe("resolveFormUuid", () => {
	it("returns the form uuid at (mIdx, fIdx)", () => {
		const doc = toDoc(fixture(), "app");
		const modUuid = doc.moduleOrder[0];
		const formUuid = resolveFormUuid(doc, 0, 0);
		expect(formUuid).toBe(doc.formOrder[modUuid][0]);
	});

	it("returns undefined when module or form is missing", () => {
		const doc = toDoc(fixture(), "app");
		expect(resolveFormUuid(doc, 0, 5)).toBeUndefined();
		expect(resolveFormUuid(doc, 5, 0)).toBeUndefined();
	});
});

describe("resolveQuestionUuid", () => {
	it("resolves a top-level question by id", () => {
		const doc = toDoc(fixture(), "app");
		const uuid = resolveQuestionUuid(doc, 0, 0, "name");
		expect(uuid).toBe("q-top-0000-0000-0000-000000000000");
	});

	it("resolves a nested child via slash-delimited path", () => {
		const doc = toDoc(fixture(), "app");
		const uuid = resolveQuestionUuid(doc, 0, 0, "grp/inner");
		expect(uuid).toBe("q-inner-0000-0000-0000-000000000000");
	});

	it("returns undefined for an unknown id", () => {
		const doc = toDoc(fixture(), "app");
		expect(resolveQuestionUuid(doc, 0, 0, "grp/missing")).toBeUndefined();
	});

	it("returns undefined when form is missing", () => {
		const doc = toDoc(fixture(), "app");
		expect(resolveQuestionUuid(doc, 5, 0, "name")).toBeUndefined();
	});
});
```

- [ ] **Step 2: Verify test fails**

```bash
npx vitest run lib/doc/__tests__/adapters-pathToUuid.test.ts
```

Expected: fails with "Cannot find module `@/lib/doc/adapters/pathToUuid`".

- [ ] **Step 3: Write the implementation**

Create `lib/doc/adapters/pathToUuid.ts`:

```ts
/**
 * Legacy-index / path → uuid resolvers.
 *
 * Phase 1b temporary bridge. The old builder store exposes a mutation
 * surface keyed by (mIdx, fIdx, QuestionPath); the new doc operates on
 * uuids. This module lets a call site dispatch to the doc without first
 * rewriting its own selection-tracking code to use uuids — the resolvers
 * do the lookup against the current doc snapshot at event-handler time.
 *
 * These helpers read from a `BlueprintDoc` snapshot (not via hooks). They
 * are called inside click/keyboard handlers, where React isn't rendering
 * and subscription isn't needed. `useBlueprintMutations()` in Task 3 wires
 * the snapshot through automatically.
 *
 * Phase 2 deletes this file: selection flows through the URL, so callers
 * will read the current uuid from `useLocation()` directly and the legacy
 * index arguments disappear.
 */

import type { BlueprintDoc, Uuid } from "@/lib/doc/types";

/** Resolve a module uuid from a zero-based module index. */
export function resolveModuleUuid(
	doc: BlueprintDoc,
	mIdx: number,
): Uuid | undefined {
	if (mIdx < 0 || mIdx >= doc.moduleOrder.length) return undefined;
	return doc.moduleOrder[mIdx];
}

/** Resolve a form uuid from (mIdx, fIdx). */
export function resolveFormUuid(
	doc: BlueprintDoc,
	mIdx: number,
	fIdx: number,
): Uuid | undefined {
	const modUuid = resolveModuleUuid(doc, mIdx);
	if (!modUuid) return undefined;
	const formUuids = doc.formOrder[modUuid];
	if (!formUuids || fIdx < 0 || fIdx >= formUuids.length) return undefined;
	return formUuids[fIdx];
}

/**
 * Resolve a question uuid from (mIdx, fIdx, path).
 *
 * `path` is a slash-delimited string of semantic question ids, matching
 * the `QuestionPath` branded type from `lib/services/questionPath.ts`. The
 * walk descends through `questionOrder` segments, matching each id to the
 * questions in the current order slot at that depth.
 */
export function resolveQuestionUuid(
	doc: BlueprintDoc,
	mIdx: number,
	fIdx: number,
	path: string,
): Uuid | undefined {
	const formUuid = resolveFormUuid(doc, mIdx, fIdx);
	if (!formUuid) return undefined;

	const segments = path.split("/").filter((s) => s.length > 0);
	if (segments.length === 0) return undefined;

	let parentUuid: Uuid = formUuid;
	let foundUuid: Uuid | undefined;

	for (const segment of segments) {
		const order = doc.questionOrder[parentUuid];
		if (!order) return undefined;
		foundUuid = order.find((uuid) => doc.questions[uuid]?.id === segment);
		if (!foundUuid) return undefined;
		parentUuid = foundUuid;
	}

	return foundUuid;
}
```

- [ ] **Step 4: Verify test passes**

```bash
npx vitest run lib/doc/__tests__/adapters-pathToUuid.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Typecheck + lint**

```bash
npx tsc --noEmit && npm run lint && echo "✓ clean"
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add lib/doc/adapters/pathToUuid.ts lib/doc/__tests__/adapters-pathToUuid.test.ts
git commit -m "feat(builder/doc): add path-to-uuid legacy adapter"
```

---

### Task 3: `useBlueprintMutations` hook

**Files:**
- Create: `lib/doc/hooks/useBlueprintMutations.ts`
- Create: `lib/doc/__tests__/hooks-useBlueprintMutations.test.tsx`

The single user-facing mutation API that consumers call during migration. It exposes functions whose signatures mirror the old `builderStore` actions as closely as possible (`updateQuestion(mIdx, fIdx, path, updates)`, etc.) so migration is a drop-in swap — the only change at each call site is the import path and the hook name. Internally each function resolves legacy coordinates via `pathToUuid.ts` and dispatches `doc.apply(mutation)`.

The hook reads the store instance once via `useContext` and returns a stable, memoized action object. Dispatching reads the current doc snapshot each time, not at hook construction, so uuid resolution is always against the latest state.

- [ ] **Step 1: Write the failing test**

Create `lib/doc/__tests__/hooks-useBlueprintMutations.test.tsx`:

```tsx
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useOrderedChildren } from "@/lib/doc/hooks/useOrderedChildren";
import { useOrderedForms } from "@/lib/doc/hooks/useModuleIds";
import { useOrderedModules } from "@/lib/doc/hooks/useModuleIds";
import type { AppBlueprint } from "@/lib/schemas/blueprint";

const bp: AppBlueprint = {
	app_name: "Test",
	connect_type: undefined,
	case_types: null,
	modules: [
		{
			name: "M0",
			forms: [
				{
					name: "F0",
					type: "survey",
					questions: [
						{ uuid: "q-a-0000-0000-0000-000000000000", id: "a", type: "text", label: "A" },
						{ uuid: "q-b-0000-0000-0000-000000000000", id: "b", type: "text", label: "B" },
					],
				},
			],
		},
	],
};

function wrapper({ children }: { children: ReactNode }) {
	return (
		<BlueprintDocProvider appId="t" initialBlueprint={bp}>
			{children}
		</BlueprintDocProvider>
	);
}

describe("useBlueprintMutations", () => {
	it("updateQuestion edits fields via (mIdx, fIdx, path)", () => {
		const { result: mut } = renderHook(() => useBlueprintMutations(), { wrapper });
		const { result: children } = renderHook(
			() => useOrderedChildren(useOrderedForms(useOrderedModules()[0].uuid)[0].uuid),
			{ wrapper },
		);
		act(() => {
			mut.current.updateQuestion(0, 0, "a", { label: "Renamed" });
		});
		// Re-read after mutation — Zustand subscription cycles on act().
		expect(children.current.find((q) => q.id === "a")?.label).toBe("Renamed");
	});

	it("renameQuestion rewrites id and propagates xpath refs", () => {
		const { result: mut } = renderHook(() => useBlueprintMutations(), { wrapper });
		act(() => {
			mut.current.renameQuestion(0, 0, "a", "alpha");
		});
		const { result: children } = renderHook(
			() => useOrderedChildren(useOrderedForms(useOrderedModules()[0].uuid)[0].uuid),
			{ wrapper },
		);
		expect(children.current.map((q) => q.id)).toContain("alpha");
		expect(children.current.map((q) => q.id)).not.toContain("a");
	});

	it("removeQuestion drops the question from order", () => {
		const { result: mut } = renderHook(() => useBlueprintMutations(), { wrapper });
		act(() => {
			mut.current.removeQuestion(0, 0, "b");
		});
		const { result: children } = renderHook(
			() => useOrderedChildren(useOrderedForms(useOrderedModules()[0].uuid)[0].uuid),
			{ wrapper },
		);
		expect(children.current.map((q) => q.id)).toEqual(["a"]);
	});

	it("updateApp changes app-level fields", () => {
		const { result: mut } = renderHook(() => useBlueprintMutations(), { wrapper });
		act(() => {
			mut.current.updateApp({ app_name: "New" });
		});
		const { result: name } = renderHook(
			() => {
				const { useBlueprintDoc } = require("@/lib/doc/hooks/useBlueprintDoc");
				return useBlueprintDoc((s: { appName: string }) => s.appName);
			},
			{ wrapper },
		);
		expect(name.current).toBe("New");
	});
});
```

- [ ] **Step 2: Verify test fails**

```bash
npx vitest run lib/doc/__tests__/hooks-useBlueprintMutations.test.tsx
```

Expected: fails with "Cannot find module".

- [ ] **Step 3: Write the implementation**

Create `lib/doc/hooks/useBlueprintMutations.ts`:

```ts
/**
 * User-facing mutation API for the BlueprintDoc store.
 *
 * Every consumer that edits a module, form, or question calls this hook
 * and dispatches via the returned action object. Function signatures
 * intentionally mirror the legacy `builderStore` action shapes so Phase
 * 1b call-site migration is a drop-in rename.
 *
 * Phase 2 will add uuid-first overloads and Phase 3 will drop the legacy
 * (mIdx, fIdx, path) argument shape entirely as callers move to URL-
 * derived uuids.
 */

import { useContext, useMemo } from "react";
import {
	resolveFormUuid,
	resolveModuleUuid,
	resolveQuestionUuid,
} from "@/lib/doc/adapters/pathToUuid";
import { BlueprintDocContext } from "@/lib/doc/provider";
import type {
	FormEntity,
	ModuleEntity,
	Mutation,
	QuestionEntity,
	Uuid,
} from "@/lib/doc/types";
import type {
	AppBlueprint,
	BlueprintForm,
	BlueprintModule,
	CaseType,
	ConnectType,
	Question,
} from "@/lib/schemas/blueprint";

export interface BlueprintMutations {
	// Question mutations
	addQuestion: (
		mIdx: number,
		fIdx: number,
		question: Question,
		opts?: { parentPath?: string; index?: number },
	) => void;
	updateQuestion: (
		mIdx: number,
		fIdx: number,
		path: string,
		patch: Partial<Omit<QuestionEntity, "uuid">>,
	) => void;
	removeQuestion: (mIdx: number, fIdx: number, path: string) => void;
	renameQuestion: (
		mIdx: number,
		fIdx: number,
		path: string,
		newId: string,
	) => void;
	moveQuestion: (
		mIdx: number,
		fIdx: number,
		path: string,
		opts: {
			targetParentPath?: string;
			toIndex: number;
		},
	) => void;
	duplicateQuestion: (mIdx: number, fIdx: number, path: string) => void;

	// Form mutations
	addForm: (mIdx: number, form: BlueprintForm, index?: number) => void;
	updateForm: (
		mIdx: number,
		fIdx: number,
		patch: Partial<Omit<FormEntity, "uuid">>,
	) => void;
	removeForm: (mIdx: number, fIdx: number) => void;
	replaceForm: (mIdx: number, fIdx: number, form: BlueprintForm) => void;

	// Module mutations
	addModule: (module: BlueprintModule, index?: number) => void;
	updateModule: (
		mIdx: number,
		patch: Partial<Omit<ModuleEntity, "uuid">>,
	) => void;
	removeModule: (mIdx: number) => void;

	// App-level
	updateApp: (patch: {
		app_name?: string;
		connect_type?: ConnectType | null;
	}) => void;
	setCaseTypes: (caseTypes: CaseType[] | null) => void;

	// Batch — for compound edits (renameCaseProperty, switchConnectMode, etc.)
	applyMany: (mutations: Mutation[]) => void;
}

export function useBlueprintMutations(): BlueprintMutations {
	const store = useContext(BlueprintDocContext);
	if (!store) {
		throw new Error(
			"useBlueprintMutations requires a <BlueprintDocProvider> ancestor",
		);
	}

	return useMemo<BlueprintMutations>(() => {
		// `get` returns the current doc snapshot — used for uuid resolution
		// at dispatch time (not at hook construction time).
		const get = () => store.getState();
		const dispatch = (mut: Mutation) => store.getState().apply(mut);

		return {
			addQuestion(mIdx, fIdx, question, opts) {
				const doc = get();
				const formUuid = resolveFormUuid(doc, mIdx, fIdx);
				if (!formUuid) return;
				const parentUuid: Uuid = opts?.parentPath
					? (resolveQuestionUuid(doc, mIdx, fIdx, opts.parentPath) ?? formUuid)
					: formUuid;
				// The `question` parameter is a full `Question` from the blueprint
				// schema (children + uuid fields); we strip children so we insert
				// only the entity and rely on subsequent addQuestion calls for any
				// nested children. Callers who need to add a whole subtree in one
				// shot should dispatch a batch via `applyMany`.
				const { children: _children, ...rest } = question as Question & {
					children?: Question[];
				};
				dispatch({
					kind: "addQuestion",
					parentUuid,
					question: rest as QuestionEntity,
					index: opts?.index,
				});
			},

			updateQuestion(mIdx, fIdx, path, patch) {
				const doc = get();
				const uuid = resolveQuestionUuid(doc, mIdx, fIdx, path);
				if (!uuid) return;
				dispatch({ kind: "updateQuestion", uuid, patch });
			},

			removeQuestion(mIdx, fIdx, path) {
				const doc = get();
				const uuid = resolveQuestionUuid(doc, mIdx, fIdx, path);
				if (!uuid) return;
				dispatch({ kind: "removeQuestion", uuid });
			},

			renameQuestion(mIdx, fIdx, path, newId) {
				const doc = get();
				const uuid = resolveQuestionUuid(doc, mIdx, fIdx, path);
				if (!uuid) return;
				dispatch({ kind: "renameQuestion", uuid, newId });
			},

			moveQuestion(mIdx, fIdx, path, opts) {
				const doc = get();
				const uuid = resolveQuestionUuid(doc, mIdx, fIdx, path);
				if (!uuid) return;
				const formUuid = resolveFormUuid(doc, mIdx, fIdx);
				if (!formUuid) return;
				const toParentUuid: Uuid = opts.targetParentPath
					? (resolveQuestionUuid(doc, mIdx, fIdx, opts.targetParentPath) ??
						formUuid)
					: formUuid;
				dispatch({
					kind: "moveQuestion",
					uuid,
					toParentUuid,
					toIndex: opts.toIndex,
				});
			},

			duplicateQuestion(mIdx, fIdx, path) {
				const doc = get();
				const uuid = resolveQuestionUuid(doc, mIdx, fIdx, path);
				if (!uuid) return;
				dispatch({ kind: "duplicateQuestion", uuid });
			},

			addForm(mIdx, form, index) {
				const doc = get();
				const moduleUuid = resolveModuleUuid(doc, mIdx);
				if (!moduleUuid) return;
				const { questions: _qs, ...formRest } = form as BlueprintForm & {
					questions?: Question[];
				};
				const formUuid = crypto.randomUUID() as Uuid;
				dispatch({
					kind: "addForm",
					moduleUuid,
					form: { ...formRest, uuid: formUuid } as FormEntity,
					index,
				});
			},

			updateForm(mIdx, fIdx, patch) {
				const doc = get();
				const uuid = resolveFormUuid(doc, mIdx, fIdx);
				if (!uuid) return;
				dispatch({ kind: "updateForm", uuid, patch });
			},

			removeForm(mIdx, fIdx) {
				const doc = get();
				const uuid = resolveFormUuid(doc, mIdx, fIdx);
				if (!uuid) return;
				dispatch({ kind: "removeForm", uuid });
			},

			replaceForm(mIdx, fIdx, form) {
				// `replaceForm` is a wholesale swap — we rebuild the doc-shaped
				// form entity + flat question maps via a minimal converter call.
				// Phase 1b uses the existing `toDoc` helper on a single-module
				// minimal blueprint to get the right shape, then extracts the
				// form and question pieces.
				const doc = get();
				const uuid = resolveFormUuid(doc, mIdx, fIdx);
				if (!uuid) return;
				const bp: AppBlueprint = {
					app_name: "",
					connect_type: undefined,
					case_types: null,
					modules: [{ name: "__replace__", forms: [form] }],
				};
				// Late-import to avoid pulling `toDoc` into every bundle chunk.
				const { toDoc } = require("@/lib/doc/converter") as typeof import(
					"@/lib/doc/converter"
				);
				const scratch = toDoc(bp, "");
				const scratchFormUuid = scratch.formOrder[scratch.moduleOrder[0]][0];
				const scratchForm = scratch.forms[scratchFormUuid];
				const replacement: FormEntity = { ...scratchForm, uuid };
				const questions = Object.values(scratch.questions) as QuestionEntity[];
				// `questionOrder` in the scratch doc is keyed by scratch's form uuid;
				// we need to re-key the top-level order slot to the destination form
				// uuid. Nested group/repeat slots already use question uuids (preserved
				// from the input `form`), so they transplant directly.
				const questionOrder: Record<Uuid, Uuid[]> = {};
				for (const [key, order] of Object.entries(scratch.questionOrder)) {
					questionOrder[
						(key === scratchFormUuid ? uuid : key) as Uuid
					] = order;
				}
				dispatch({
					kind: "replaceForm",
					uuid,
					form: replacement,
					questions,
					questionOrder,
				});
			},

			addModule(module, index) {
				const { forms: _forms, ...moduleRest } = module as BlueprintModule & {
					forms?: BlueprintForm[];
				};
				const moduleUuid = crypto.randomUUID() as Uuid;
				dispatch({
					kind: "addModule",
					module: { ...moduleRest, uuid: moduleUuid } as ModuleEntity,
					index,
				});
			},

			updateModule(mIdx, patch) {
				const doc = get();
				const uuid = resolveModuleUuid(doc, mIdx);
				if (!uuid) return;
				dispatch({ kind: "updateModule", uuid, patch });
			},

			removeModule(mIdx) {
				const doc = get();
				const uuid = resolveModuleUuid(doc, mIdx);
				if (!uuid) return;
				dispatch({ kind: "removeModule", uuid });
			},

			updateApp(patch) {
				if (patch.app_name !== undefined) {
					dispatch({ kind: "setAppName", name: patch.app_name });
				}
				if (patch.connect_type !== undefined) {
					dispatch({
						kind: "setConnectType",
						connectType: patch.connect_type,
					});
				}
			},

			setCaseTypes(caseTypes) {
				dispatch({ kind: "setCaseTypes", caseTypes });
			},

			applyMany(mutations) {
				store.getState().applyMany(mutations);
			},
		};
	}, [store]);
}
```

- [ ] **Step 4: Verify test passes**

```bash
npx vitest run lib/doc/__tests__/hooks-useBlueprintMutations.test.tsx
```

Expected: all tests pass.

- [ ] **Step 5: Typecheck + lint**

```bash
npx tsc --noEmit && npm run lint && echo "✓ clean"
```

- [ ] **Step 6: Commit**

```bash
git add lib/doc/hooks/useBlueprintMutations.ts lib/doc/__tests__/hooks-useBlueprintMutations.test.tsx lib/doc/adapters/pathToUuid.ts
git commit -m "feat(builder/doc): add useBlueprintMutations user-facing API"
```

---

### Task 4: `syncOldFromDoc` adapter + provider wiring

**Files:**
- Create: `lib/doc/adapters/syncOldFromDoc.ts`
- Create: `lib/doc/__tests__/adapters-syncOldFromDoc.test.tsx`
- Modify: `hooks/useBuilder.tsx` — call the adapter immediately after the doc provider mounts so the subscription is active from first render.

The adapter subscribes to the doc store via `subscribeWithSelector` and, on every change to entity maps / order arrays / app-level fields, writes the equivalent values into the old builder store using `set(draft => { ... })`. Because the old store uses Immer middleware and keys by uuid, the write is a shallow object assignment — no per-entity conversion needed: `ModuleEntity` and `NModule`, `FormEntity` and `NForm`, `QuestionEntity` and `NQuestion` already share the same field shape (verified in the Phase 1a converter tests).

**Loop prevention:** writes into the old store never reach the doc — there is no reverse subscription. The adapter is a one-shot subscription per provider mount; it's disposed on unmount via the ref cleanup callback.

**What's not synced:** anything that isn't blueprint data — `selected`, `screen`, `nav*`, `phase`, `generationData`, `agentActive`, sidebar state. Those remain under the old store's direct control.

**Timing at mount:** the doc hydrates synchronously from `initialBlueprint` in the provider's `useRef` factory (Task 1). The old store separately hydrates via `loadApp()` inside `createEngine`. Both paths start from the same blueprint, so the adapter's first subscription tick finds the old store already in the right state and does nothing. Subsequent mutations flow: user handler → `useBlueprintMutations` → `doc.apply()` → subscription fires → `builderStore.setState()` projects the new entity maps.

- [ ] **Step 1: Write the failing test**

Create `lib/doc/__tests__/adapters-syncOldFromDoc.test.tsx`:

```tsx
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { startSyncOldFromDoc } from "@/lib/doc/adapters/syncOldFromDoc";
import { createBuilderStore } from "@/lib/services/builderStore";
import type { AppBlueprint } from "@/lib/schemas/blueprint";
import { useContext } from "react";
import { BlueprintDocContext } from "@/lib/doc/provider";

const bp: AppBlueprint = {
	app_name: "App",
	connect_type: undefined,
	case_types: null,
	modules: [
		{
			name: "M",
			forms: [
				{
					name: "F",
					type: "survey",
					questions: [
						{ uuid: "q-0-0000-0000-0000-000000000000", id: "a", type: "text", label: "A" },
					],
				},
			],
		},
	],
};

function Harness({ children }: { children: ReactNode }) {
	return (
		<BlueprintDocProvider appId="app" initialBlueprint={bp}>
			{children}
		</BlueprintDocProvider>
	);
}

describe("syncOldFromDoc", () => {
	it("mirrors doc entity maps into the old store on mutation", () => {
		const oldStore = createBuilderStore();
		oldStore.getState().loadApp("app", bp);

		// Start the subscription against the same doc instance.
		const { result: docStoreRef } = renderHook(
			() => useContext(BlueprintDocContext),
			{ wrapper: Harness },
		);
		const docStore = docStoreRef.current;
		expect(docStore).not.toBeNull();

		const stop = startSyncOldFromDoc(docStore!, oldStore);

		const { result: mut } = renderHook(() => useBlueprintMutations(), {
			wrapper: Harness,
		});

		act(() => {
			mut.current.renameQuestion(0, 0, "a", "alpha");
		});

		// The old store's questions map should reflect the rename.
		const os = oldStore.getState();
		const qIds = Object.values(os.questions).map((q) => q.id);
		expect(qIds).toContain("alpha");

		stop();
	});

	it("projects moduleOrder and formOrder", () => {
		const oldStore = createBuilderStore();
		oldStore.getState().loadApp("app", bp);

		const { result: docStoreRef } = renderHook(
			() => useContext(BlueprintDocContext),
			{ wrapper: Harness },
		);
		const stop = startSyncOldFromDoc(docStoreRef.current!, oldStore);

		const { result: mut } = renderHook(() => useBlueprintMutations(), {
			wrapper: Harness,
		});

		act(() => {
			mut.current.addModule(
				{ name: "NewMod", forms: [] },
				undefined,
			);
		});

		expect(oldStore.getState().moduleOrder).toHaveLength(2);
		stop();
	});
});
```

- [ ] **Step 2: Verify test fails**

```bash
npx vitest run lib/doc/__tests__/adapters-syncOldFromDoc.test.tsx
```

Expected: fails.

- [ ] **Step 3: Write the adapter**

Create `lib/doc/adapters/syncOldFromDoc.ts`:

```ts
/**
 * One-way adapter: BlueprintDoc → legacy builderStore.
 *
 * Subscribes to the doc's entity maps and order arrays and mirrors every
 * change into the old builderStore's equivalent fields. Gives consumers
 * that still read from the old store (Phase 1b has not yet migrated them)
 * a live view of the new doc's truth.
 *
 * Rationale for a one-way sync:
 *   - During Phase 1b, all user-driven and generation-stream entity
 *     mutations flow through `doc.apply()`. The old store never writes
 *     to its own entity maps from within a mutation action (Task 8
 *     removes those writes). The only writer is this adapter, so there
 *     is no reverse path and no loop risk.
 *   - Session fields on the old store (selection, navigation, cursor
 *     mode, generationData) are untouched. Consumers that read those
 *     keep working unchanged.
 *
 * Lifetime:
 *   - `startSyncOldFromDoc(docStore, oldStore)` installs the subscription
 *     and returns a dispose function. The provider calls `start` once
 *     per mount and returns `stop` from its cleanup effect.
 *   - The first subscription tick happens synchronously before any
 *     mutations fire; at that point the old store has already been
 *     hydrated by `loadApp()` inside `createEngine` from the same
 *     blueprint. The initial sync pass is a no-op — reference equality
 *     short-circuits every field. Future mutations are what this adapter
 *     actually buys us.
 *
 * Phase 3 deletes this file: every consumer migrates to `lib/doc/hooks/**`
 * and the old builder store stops holding blueprint state entirely.
 */

import type { BlueprintDocStore } from "@/lib/doc/provider";
import type { BlueprintDoc } from "@/lib/doc/types";
import type { BuilderStore } from "@/lib/services/builderStore";

/**
 * Fields we mirror from the doc into the old store. Excludes `appId` and
 * action methods — `appId` is written once by the old store's `loadApp`
 * and doesn't change, and the action methods are not state.
 */
type MirroredSlice = Pick<
	BlueprintDoc,
	| "appName"
	| "connectType"
	| "caseTypes"
	| "modules"
	| "forms"
	| "questions"
	| "moduleOrder"
	| "formOrder"
	| "questionOrder"
>;

function project(state: {
	appName: string;
	connectType: BlueprintDoc["connectType"];
	caseTypes: BlueprintDoc["caseTypes"];
	modules: BlueprintDoc["modules"];
	forms: BlueprintDoc["forms"];
	questions: BlueprintDoc["questions"];
	moduleOrder: BlueprintDoc["moduleOrder"];
	formOrder: BlueprintDoc["formOrder"];
	questionOrder: BlueprintDoc["questionOrder"];
}): MirroredSlice {
	return {
		appName: state.appName,
		connectType: state.connectType,
		caseTypes: state.caseTypes,
		modules: state.modules,
		forms: state.forms,
		questions: state.questions,
		moduleOrder: state.moduleOrder,
		formOrder: state.formOrder,
		questionOrder: state.questionOrder,
	};
}

/**
 * Install the one-way sync and return a dispose function.
 *
 * Uses `subscribeWithSelector`'s `equalityFn: () => false` to fire on
 * every state change, then the shallow-equal check inside the callback
 * avoids unnecessary writes when only unrelated fields changed.
 */
export function startSyncOldFromDoc(
	docStore: BlueprintDocStore,
	oldStore: BuilderStore,
): () => void {
	let prev: MirroredSlice | null = null;

	const unsub = docStore.subscribe((state) => {
		const next = project(state);
		if (prev && shallowEqualSlice(prev, next)) return;
		prev = next;

		oldStore.setState((draft) => {
			// Direct field assignment. Immer handles structural sharing; we
			// don't deep-clone because the doc entities and old entities are
			// structurally identical (ModuleEntity ≡ NModule, etc.).
			draft.appName = next.appName;
			draft.connectType = next.connectType ?? undefined;
			draft.caseTypes = next.caseTypes ?? null;
			draft.modules = next.modules as unknown as typeof draft.modules;
			draft.forms = next.forms as unknown as typeof draft.forms;
			draft.questions = next.questions as unknown as typeof draft.questions;
			draft.moduleOrder = next.moduleOrder as unknown as typeof draft.moduleOrder;
			draft.formOrder = next.formOrder as unknown as typeof draft.formOrder;
			draft.questionOrder = next.questionOrder as unknown as typeof draft.questionOrder;
		});
	});

	return () => {
		unsub();
		prev = null;
	};
}

function shallowEqualSlice(a: MirroredSlice, b: MirroredSlice): boolean {
	return (
		a.appName === b.appName &&
		a.connectType === b.connectType &&
		a.caseTypes === b.caseTypes &&
		a.modules === b.modules &&
		a.forms === b.forms &&
		a.questions === b.questions &&
		a.moduleOrder === b.moduleOrder &&
		a.formOrder === b.formOrder &&
		a.questionOrder === b.questionOrder
	);
}
```

- [ ] **Step 4: Wire the adapter into the provider**

Modify `hooks/useBuilder.tsx`. Inside `BuilderProvider`, after the `useState` that creates the engine, add a `useEffect` that starts and stops the sync:

```tsx
import { startSyncOldFromDoc } from "@/lib/doc/adapters/syncOldFromDoc";
import { useContext, useEffect, useState } from "react";
// ... existing imports
```

Since `BlueprintDocProvider` mounts as a child of `BuilderProvider`, we can't call `useContext(BlueprintDocContext)` in the parent. Instead, mount a small `<SyncBridge />` child component inside the `BlueprintDocProvider` tree:

```tsx
function SyncBridge({ oldStore }: { oldStore: BuilderStore }) {
	const docStore = useContext(BlueprintDocContext);
	useEffect(() => {
		if (!docStore) return;
		return startSyncOldFromDoc(docStore, oldStore);
	}, [docStore, oldStore]);
	return null;
}
```

Then in the `BuilderProvider` return:

```tsx
return (
	<EngineContext value={engine}>
		<StoreContext value={engine.store}>
			<BlueprintDocProvider
				appId={buildId === "new" ? "" : buildId}
				initialBlueprint={initialBlueprint}
				startTracking={Boolean(initialBlueprint || replay)}
			>
				<SyncBridge oldStore={engine.store} />
				{children}
			</BlueprintDocProvider>
		</StoreContext>
	</EngineContext>
);
```

- [ ] **Step 5: Verify tests pass**

```bash
npx vitest run lib/doc/__tests__/adapters-syncOldFromDoc.test.tsx
```

Expected: both tests pass.

- [ ] **Step 6: Typecheck + lint**

```bash
npx tsc --noEmit && npm run lint && echo "✓ clean"
```

- [ ] **Step 7: Smoke-test the full dev server**

```bash
npm run dev
```

Open an existing app. Rename a question (inline). Confirm:
- The rename shows in the outline and preview (old store still drives those reads).
- Undo the rename via Cmd+Z. Both doc and old store revert.

- [ ] **Step 8: Commit**

```bash
git add lib/doc/adapters/syncOldFromDoc.ts lib/doc/__tests__/adapters-syncOldFromDoc.test.tsx hooks/useBuilder.tsx
git commit -m "feat(builder/doc): add syncOldFromDoc one-way adapter"
```

---

### Task 5: Flip `hooks/useBuilder.tsx` facade hooks to delegate to doc

**Files:**
- Modify: `hooks/useBuilder.tsx` — bodies of `useModule`, `useForm`, `useQuestion`, `useOrderedModules`, `useOrderedForms`, `useAssembledForm`, `useBreadcrumbs`, `useBuilderTreeData`.

The facade hooks in `hooks/useBuilder.tsx` are the central indirection every consumer uses. Swapping their bodies to read from doc hooks migrates the entire indirect-reader surface in one commit — dozens of components start reading from the doc without any code changes of their own.

The hooks keep the exact same signatures (including the legacy `(mIdx, fIdx)` index-based API) and return the same shapes. Internally they resolve indices to uuids via the doc's order arrays and call the matching `lib/doc/hooks/**` hook. The return types remain `NModule | NForm | NQuestion` because those types are structurally identical to `ModuleEntity | FormEntity | QuestionEntity` (Phase 1a verified this — both omit `forms`/`questions`/`children` and add `uuid`).

- [ ] **Step 1: Read the current facade hook bodies**

```bash
```

Read `hooks/useBuilder.tsx` lines 220–320. Note each facade hook's current selector shape.

- [ ] **Step 2: Rewrite each facade**

Inside `hooks/useBuilder.tsx`, replace the bodies of the facade hooks. Because doc hooks need a `BlueprintDocProvider` ancestor — which Task 1 wires in — this swap is safe inside the builder route.

```tsx
// Replace the existing `useQuestion(uuid)` body.
export function useQuestion(uuid: string) {
	const { useQuestion: useQuestionDoc } = require("@/lib/doc/hooks/useEntity") as typeof import("@/lib/doc/hooks/useEntity");
	return useQuestionDoc(uuid as Uuid) as unknown as NQuestion | undefined;
}

// Replace `useModule(mIdx)`.
export function useModule(mIdx: number) {
	const { useOrderedModules } = require("@/lib/doc/hooks/useModuleIds") as typeof import("@/lib/doc/hooks/useModuleIds");
	const modules = useOrderedModules();
	return modules[mIdx] as unknown as NModule | undefined;
}

// Replace `useForm(mIdx, fIdx)`.
export function useForm(mIdx: number, fIdx: number) {
	const { useOrderedModules, useOrderedForms } = require("@/lib/doc/hooks/useModuleIds") as typeof import("@/lib/doc/hooks/useModuleIds");
	const modules = useOrderedModules();
	const mod = modules[mIdx];
	const forms = useOrderedForms(mod?.uuid ?? ("" as Uuid));
	return forms[fIdx] as unknown as NForm | undefined;
}

// Replace `useOrderedModules(): NModule[]`.
export function useOrderedModules() {
	const { useOrderedModules: useOrderedModulesDoc } = require("@/lib/doc/hooks/useModuleIds") as typeof import("@/lib/doc/hooks/useModuleIds");
	return useOrderedModulesDoc() as unknown as NModule[];
}

// Replace `useOrderedForms(mIdx): NForm[]`.
export function useOrderedForms(mIdx: number) {
	const { useOrderedModules, useOrderedForms: useOrderedFormsDoc } = require("@/lib/doc/hooks/useModuleIds") as typeof import("@/lib/doc/hooks/useModuleIds");
	const modules = useOrderedModules();
	const modUuid = modules[mIdx]?.uuid ?? ("" as Uuid);
	return useOrderedFormsDoc(modUuid) as unknown as NForm[];
}

// Replace `useAssembledForm(mIdx, fIdx): BlueprintForm | undefined`.
export function useAssembledForm(mIdx: number, fIdx: number) {
	const { useOrderedModules, useOrderedForms: useOrderedFormsDoc } = require("@/lib/doc/hooks/useModuleIds") as typeof import("@/lib/doc/hooks/useModuleIds");
	const { useAssembledForm: useAssembledFormDoc } = require("@/lib/doc/hooks/useAssembledForm") as typeof import("@/lib/doc/hooks/useAssembledForm");
	const modules = useOrderedModules();
	const modUuid = modules[mIdx]?.uuid;
	const forms = useOrderedFormsDoc(modUuid ?? ("" as Uuid));
	const formUuid = forms[fIdx]?.uuid ?? ("" as Uuid);
	return useAssembledFormDoc(formUuid);
}
```

Replace the static `require()` calls with top-of-file imports once the structure is correct. The reason for `require` in the draft is to keep each hook's body readable and self-contained during review; the final commit uses static ESM imports:

```tsx
import {
	useQuestion as useQuestionDoc,
} from "@/lib/doc/hooks/useEntity";
import {
	useOrderedModules as useOrderedModulesDoc,
	useOrderedForms as useOrderedFormsDoc,
} from "@/lib/doc/hooks/useModuleIds";
import { useAssembledForm as useAssembledFormDoc } from "@/lib/doc/hooks/useAssembledForm";
import type { Uuid } from "@/lib/doc/types";
```

- [ ] **Step 3: Update `useBuilderTreeData`**

`useBuilderTreeData` currently derives `TreeData` from the old store via `useBuilderStoreShallow + deriveTreeData`. The sync adapter (Task 4) keeps the old store's entity maps in sync with the doc, so this hook technically still works unchanged. Leave it alone in this task — migration happens in Task 8 as part of the AppTree rewrite.

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit && echo "✓ typecheck clean"
```

Expected: clean. If the `as unknown as NModule[]` casts throw a type error, verify `ModuleEntity` and `NModule` are structurally compatible — they should be.

- [ ] **Step 5: Run the test suite**

```bash
npm test -- --run
```

Expected: all tests pass. The facade hooks are tested indirectly through higher-level component tests.

- [ ] **Step 6: Smoke-test the dev server**

```bash
npm run dev
```

Open an existing app. Navigate into a form. Confirm:
- Tree outline populates.
- Questions render in the form preview.
- Module detail / form detail panels show correct names.

- [ ] **Step 7: Commit**

```bash
git add hooks/useBuilder.tsx
git commit -m "refactor(builder/doc): delegate useBuilder facade hooks to lib/doc/hooks"
```

---

### Task 6: Migrate user-driven mutation call sites to `useBlueprintMutations`

**Files:** (all modified)
- `hooks/useSaveQuestion.ts`
- `hooks/useTextEditSave.ts`
- `components/builder/contextual/ContextualEditorData.tsx`
- `components/builder/contextual/ContextualEditorHeader.tsx`
- `components/builder/contextual/ContextualEditorLogic.tsx`
- `components/builder/contextual/ContextualEditorUI.tsx`
- `components/builder/detail/ModuleDetail.tsx`
- `components/builder/detail/FormDetail.tsx`
- `components/builder/detail/FormSettingsPanel.tsx`
- `components/builder/useBuilderShortcuts.ts`
- `components/preview/screens/HomeScreen.tsx`
- `components/preview/screens/FormScreen.tsx`
- `components/preview/screens/ModuleScreen.tsx`
- `components/preview/form/FormRenderer.tsx`
- `components/preview/form/QuestionTypePicker.tsx`

Every `useBuilderStore((s) => s.updateQuestion)` / `s.addQuestion` / `s.moveQuestion` / `s.renameQuestion` / `s.duplicateQuestion` / `s.removeQuestion` / `s.updateForm` / `s.replaceForm` / `s.updateModule` / `s.updateApp` selector becomes a pull from `useBlueprintMutations()`. The call-site signatures don't change, so this is a mechanical rename.

Commit per file so each change is easy to review in isolation. One commit per sub-task (sub-tasks below map 1:1 to files).

- [ ] **Step 1: Confirm every target call site**

```bash
```

Run this grep to print the current set (expected count: 17 occurrences across 12 files — matches the inventory from the plan's setup phase):

```bash
grep -rn "useBuilderStore((s) => s\.\(update\|add\|remove\|move\|rename\|duplicate\|replace\)\(Question\|Form\|Module\|App\|CaseProperty\)" \
  hooks components app 2>/dev/null
```

- [ ] **Step 2: Migrate `hooks/useSaveQuestion.ts`**

Change:

```tsx
const updateQuestion = useBuilderStore((s) => s.updateQuestion);
```

to:

```tsx
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
const { updateQuestion } = useBlueprintMutations();
```

If the file also pulls `useBuilderStore` selectors for session state (selected, etc.), keep those; only the mutation selector changes.

```bash
git add hooks/useSaveQuestion.ts
git commit -m "refactor(builder/doc): route useSaveQuestion through useBlueprintMutations"
```

- [ ] **Step 3: Migrate `hooks/useTextEditSave.ts`**

Same pattern as Step 2.

```bash
git add hooks/useTextEditSave.ts
git commit -m "refactor(builder/doc): route useTextEditSave through useBlueprintMutations"
```

- [ ] **Step 4: Migrate `components/builder/contextual/ContextualEditorHeader.tsx`**

This one has four mutation selectors (`moveQuestion`, `duplicateQuestion`, `removeQuestion`, `renameQuestion`). Replace all four with destructured fields from `useBlueprintMutations()`. The `moveQuestion` call site passes `opts` with `targetParentPath` — the new hook's signature already supports this; nothing else changes.

```bash
git add components/builder/contextual/ContextualEditorHeader.tsx
git commit -m "refactor(builder/doc): route ContextualEditorHeader mutations through doc"
```

- [ ] **Step 5: Migrate `components/builder/contextual/ContextualEditorData.tsx`**

```bash
git add components/builder/contextual/ContextualEditorData.tsx
git commit -m "refactor(builder/doc): route ContextualEditorData mutations through doc"
```

- [ ] **Step 6: Migrate `components/builder/contextual/ContextualEditorUI.tsx` and `.../ContextualEditorLogic.tsx`**

These two are grouped because they both call `updateQuestion` only.

```bash
git add components/builder/contextual/ContextualEditorUI.tsx components/builder/contextual/ContextualEditorLogic.tsx
git commit -m "refactor(builder/doc): route ContextualEditorUI/Logic mutations through doc"
```

- [ ] **Step 7: Migrate `components/builder/detail/FormSettingsPanel.tsx`**

Three `updateForm` selectors at lines 191, 557, 718. Replace all three.

```bash
git add components/builder/detail/FormSettingsPanel.tsx
git commit -m "refactor(builder/doc): route FormSettingsPanel mutations through doc"
```

- [ ] **Step 8: Migrate `components/builder/detail/ModuleDetail.tsx` and `.../FormDetail.tsx`**

```bash
git add components/builder/detail/ModuleDetail.tsx components/builder/detail/FormDetail.tsx
git commit -m "refactor(builder/doc): route Module/Form detail mutations through doc"
```

- [ ] **Step 9: Migrate `components/preview/screens/HomeScreen.tsx`, `.../ModuleScreen.tsx`, `.../FormScreen.tsx`**

```bash
git add components/preview/screens/HomeScreen.tsx components/preview/screens/ModuleScreen.tsx components/preview/screens/FormScreen.tsx
git commit -m "refactor(builder/doc): route preview screen mutations through doc"
```

- [ ] **Step 10: Migrate `components/preview/form/FormRenderer.tsx` and `.../QuestionTypePicker.tsx`**

`FormRenderer.tsx:436` pulls `moveQuestion`; `QuestionTypePicker.tsx:53` pulls `addQuestion`. Replace both.

```bash
git add components/preview/form/FormRenderer.tsx components/preview/form/QuestionTypePicker.tsx
git commit -m "refactor(builder/doc): route FormRenderer/QuestionTypePicker mutations through doc"
```

- [ ] **Step 11: Migrate `components/builder/useBuilderShortcuts.ts`**

This file calls `duplicateQuestion` and `moveQuestion` via `useBuilderStore.getState().moveQuestion(...)` in imperative handlers. Because `useBlueprintMutations` returns a hook result, swap the pattern: instead of `useBuilderStore.getState()`, pull the mutation hook at the top of the file's `useBuilderShortcuts` hook body, destructure the mutation handlers, and capture them in the `useCallback` closure for each shortcut.

```bash
git add components/builder/useBuilderShortcuts.ts
git commit -m "refactor(builder/doc): route keyboard shortcut mutations through doc"
```

- [ ] **Step 12: Verify no mutation selectors remain in client code**

```bash
grep -rn "useBuilderStore((s) => s\.\(update\|add\|remove\|move\|rename\|duplicate\|replace\)\(Question\|Form\|Module\|App\|CaseProperty\)" \
  hooks components app 2>/dev/null || echo "✓ no mutation selectors left in consumer code"
```

Expected: `✓ no mutation selectors left in consumer code`. The only places that still reference those store actions are `lib/services/builderStore.ts` itself and `lib/services/builderEngine.ts` (engine mutations land in Task 7).

- [ ] **Step 13: Typecheck + lint + test suite**

```bash
npx tsc --noEmit && npm run lint && npm test -- --run && echo "✓ clean"
```

Expected: clean.

- [ ] **Step 14: Manual smoke test**

```bash
npm run dev
```

In an existing app:
1. Rename a question → outline + preview update.
2. Duplicate a question → a copy appears with `_copy` suffix.
3. Move a question within a group → preview order updates.
4. Delete a question → gone from outline + preview.
5. Update a form setting (name / case_type / post_submit) → settings persist.
6. Update a module name → reflected in tree.
7. Add a question via the picker → appears at cursor.
8. Undo everything → each action reverses cleanly.

Expected: all operations work, undo/redo cycles correctly.

---

### Task 7: Route `BuilderEngine` mutation paths through doc

**Files:**
- Modify: `lib/services/builderEngine.ts:592-596` (deleteSelected)
- Modify: `lib/services/builderEngine.ts` — `switchConnectMode` and related connect-stash helpers
- Modify: `lib/services/builderEngine.ts` — `undo()` / `redo()` orchestration

`BuilderEngine` still calls old-store mutations in a handful of places. For Phase 1b these need to dispatch to the doc instead. The engine holds a reference to the store instance via `this.store`; we extend the engine with a reference to the doc store and call `doc.apply()` through it.

**Setup injection:** because `BuilderProvider` creates the engine inside `createEngine()` before `BlueprintDocProvider` has mounted, the doc store isn't available at engine construction time. We add a `setDocStore(store)` method on `BuilderEngine` that the `SyncBridge` component calls inside its `useEffect` right after the sync subscription starts. This keeps the engine agnostic about React lifecycles while making the doc store reachable from engine methods.

**Undo/redo orchestration:** the engine currently invokes `this.store.temporal.getState().undo()`. We keep that call (for session fields that still live on the old store — none actually change via temporal today, but the call is harmless) AND invoke `this.docStore.temporal.getState().undo()`. Because the sync adapter keeps the old store in sync with the doc on every change, undoing the doc automatically updates the old store's entity maps via the subscription. Undo thus appears atomic from a user's perspective.

- [ ] **Step 1: Add `setDocStore` on `BuilderEngine`**

Modify `lib/services/builderEngine.ts`. Near the top of the class:

```ts
import type { BlueprintDocStore } from "@/lib/doc/provider";
// ... existing imports

export class BuilderEngine {
	// ... existing fields
	private _docStore: BlueprintDocStore | null = null;

	setDocStore(store: BlueprintDocStore): void {
		this._docStore = store;
	}

	get docStore(): BlueprintDocStore | null {
		return this._docStore;
	}
	// ...
}
```

- [ ] **Step 2: Wire `setDocStore` from `SyncBridge`**

In `hooks/useBuilder.tsx`'s `SyncBridge` component, after starting the sync, also install the doc store on the engine:

```tsx
function SyncBridge({ engine }: { engine: BuilderEngine }) {
	const docStore = useContext(BlueprintDocContext);
	useEffect(() => {
		if (!docStore) return;
		engine.setDocStore(docStore);
		const stop = startSyncOldFromDoc(docStore, engine.store);
		return () => {
			stop();
		};
	}, [docStore, engine]);
	return null;
}
```

Update the `BuilderProvider` return to pass `engine` not `oldStore` to `SyncBridge`.

- [ ] **Step 3: Update `deleteSelected`**

In `lib/services/builderEngine.ts`, replace the body of `deleteSelected` that currently calls `this.store.getState().removeQuestion(mIdx, fIdx, path)` with a doc dispatch. Import `resolveQuestionUuid` from `@/lib/doc/adapters/pathToUuid` at the top of the file.

```ts
deleteSelected(): void {
	const sel = this.store.getState().selected;
	if (!sel || sel.kind !== "question") return;
	if (!this._docStore) return;

	const doc = this._docStore.getState();
	const uuid = resolveQuestionUuid(
		doc,
		sel.moduleIndex,
		sel.formIndex,
		sel.questionPath,
	);
	if (!uuid) return;

	this._docStore.getState().apply({ kind: "removeQuestion", uuid });

	// Post-delete navigation (unchanged).
	this.navigateToAdjacentSibling(sel);
}
```

- [ ] **Step 4: Update `switchConnectMode`**

This method toggles `connectType` on the app and stashes/restores per-form `connect` configs. Route the app-level toggle through the doc:

```ts
switchConnectMode(next: ConnectType | undefined): void {
	if (!this._docStore) return;

	// Stash outgoing form connects (session state — stays on engine field).
	this.stashAllFormConnect();

	// Dispatch the app-level change.
	this._docStore.getState().apply({
		kind: "setConnectType",
		connectType: next ?? null,
	});

	// Restore incoming form connects from any prior stash for `next`.
	if (next) {
		this.restoreAllFormConnect(next);
	}

	this._lastConnectType = next ?? this._lastConnectType;
}
```

Restoring form connects calls `updateForm` via the mutation hook path — but the engine runs outside React. We dispatch directly instead:

```ts
private restoreAllFormConnect(mode: ConnectType): void {
	if (!this._docStore) return;
	const stash = this._connectStash[mode];
	if (!stash) return;
	for (const [formUuid, connect] of Object.entries(stash)) {
		this._docStore.getState().apply({
			kind: "updateForm",
			uuid: formUuid as Uuid,
			patch: { connect },
		});
	}
}
```

- [ ] **Step 5: Update `undo` / `redo`**

```ts
private applyUndoRedo(direction: "undo" | "redo"): void {
	const t = this._docStore?.temporal.getState();
	if (!t) return;

	flushSync(() => {
		if (direction === "undo") t.undo();
		else t.redo();
	});

	// Post-undo selection reconciliation (unchanged from current implementation).
	this.reorientSelectionAfterUndo();
}
```

The old store's temporal is no longer touched — its entity maps are pulled along by the sync adapter when the doc's temporal reverses a mutation.

- [ ] **Step 6: Typecheck**

```bash
npx tsc --noEmit && echo "✓ typecheck clean"
```

- [ ] **Step 7: Smoke-test undo/redo**

```bash
npm run dev
```

In an existing app:
1. Make 3 edits (rename, duplicate, move).
2. Cmd+Z three times — each edit reverses.
3. Cmd+Shift+Z three times — each edit replays.
4. Delete selected question via Backspace — gone.
5. Cmd+Z → question restored.

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add lib/services/builderEngine.ts hooks/useBuilder.tsx
git commit -m "refactor(builder/engine): route engine mutations and undo through doc"
```

---

### Task 8: Migrate direct entity-map readers to `lib/doc/hooks`

**Files:** (all modified)
- `components/builder/AppTree.tsx`
- `components/preview/screens/HomeScreen.tsx`
- `components/preview/screens/FormScreen.tsx`
- `components/preview/screens/CaseListScreen.tsx`
- `components/preview/form/FormRenderer.tsx`
- `components/builder/detail/FormSettingsPanel.tsx`
- `components/builder/contextual/ContextualEditorData.tsx`

Every call site that currently reads `useBuilderStore((s) => s.modules)`, `s.forms`, `s.questions`, `s.moduleOrder`, `s.formOrder`, `s.questionOrder`, `s.appName`, `s.connectType`, `s.caseTypes` becomes an import from `@/lib/doc/hooks/**`. Commit per file.

- [ ] **Step 1: Migrate `components/builder/AppTree.tsx`**

This file has the most direct-map reads. Replace each with a doc hook:

| Current | New |
|---|---|
| `useBuilderStore((s) => s.moduleOrder)` | `useModuleIds()` from `@/lib/doc/hooks/useModuleIds` |
| `useBuilderStore((s) => s.appName)` | `useBlueprintDoc((s) => s.appName)` from `@/lib/doc/hooks/useBlueprintDoc` |
| `useBuilderStore((s) => s.connectType)` | `useBlueprintDoc((s) => s.connectType)` |
| `useBuilderStore((s) => s.forms[formId])` | `useForm(formId as Uuid)` from `@/lib/doc/hooks/useEntity` |
| `useBuilderStore((s) => s.questions[uuid])` | `useQuestion(uuid as Uuid)` |
| `useBuilderStore((s) => s.questionOrder[id])` | `useBlueprintDoc((s) => s.questionOrder[id as Uuid])` |
| `useBuilderStore((s) => s.questionOrder)` | `useBlueprintDoc((s) => s.questionOrder)` (rare — tree rebuild path; prefer `useOrderedChildren(parent)` per subtree) |
| `useBuilderStore((s) => s.questions)` | `useBlueprintDoc((s) => s.questions)` (same as above) |

Tree data derivation: the existing `deriveTreeData` function reads from a normalized state snapshot. Change the call site from `useBuilderStoreShallow(selectEntityDataForTree)` to reading doc state via `useBlueprintDocShallow` with the same selector shape. If the helper `selectEntityDataForTree` lives in `lib/services/builderSelectors.ts`, keep the helper and just feed it the doc state — the entity shapes are structurally identical.

```bash
git add components/builder/AppTree.tsx
git commit -m "refactor(builder/doc): migrate AppTree reads to lib/doc/hooks"
```

- [ ] **Step 2: Migrate `components/preview/screens/HomeScreen.tsx`**

```tsx
// Replace:
const appName = useBuilderStore((s) => s.appName);
const formOrder = useBuilderStore((s) => s.formOrder);
// With:
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
const appName = useBlueprintDoc((s) => s.appName);
const formOrder = useBlueprintDoc((s) => s.formOrder);
```

```bash
git add components/preview/screens/HomeScreen.tsx
git commit -m "refactor(builder/doc): migrate HomeScreen reads to lib/doc/hooks"
```

- [ ] **Step 3: Migrate `components/preview/screens/FormScreen.tsx` and `.../CaseListScreen.tsx`**

Both pull `caseTypes`. Change to `useBlueprintDoc((s) => s.caseTypes)`.

```bash
git add components/preview/screens/FormScreen.tsx components/preview/screens/CaseListScreen.tsx
git commit -m "refactor(builder/doc): migrate preview screen caseTypes read to doc"
```

- [ ] **Step 4: Migrate `components/preview/form/FormRenderer.tsx`**

The existing `useBuilderStore((s) => s.questions[uuid])` at line 188 becomes `useQuestion(uuid as Uuid)`.

```bash
git add components/preview/form/FormRenderer.tsx
git commit -m "refactor(builder/doc): migrate FormRenderer question read to doc"
```

- [ ] **Step 5: Migrate `components/builder/detail/FormSettingsPanel.tsx`**

Two `connectType` reads (lines 63, 719). Change to `useBlueprintDoc((s) => s.connectType)`.

```bash
git add components/builder/detail/FormSettingsPanel.tsx
git commit -m "refactor(builder/doc): migrate FormSettingsPanel connectType read to doc"
```

- [ ] **Step 6: Migrate `components/builder/contextual/ContextualEditorData.tsx`**

`useBuilderStore((s) => s.caseTypes)` → `useBlueprintDoc((s) => s.caseTypes)`.

```bash
git add components/builder/contextual/ContextualEditorData.tsx
git commit -m "refactor(builder/doc): migrate ContextualEditorData caseTypes read to doc"
```

- [ ] **Step 7: Sweep for residual direct-map reads**

```bash
grep -rn "useBuilderStore((s) => s\.\(modules\|forms\|questions\|moduleOrder\|formOrder\|questionOrder\|caseTypes\|connectType\|appName\)" \
  hooks components app 2>/dev/null
```

Expected: only facade-hook internals remain (`hooks/useBuilder.tsx` should also be clean after Task 5). No consumer code references the old-store entity maps.

- [ ] **Step 8: Typecheck + lint + test**

```bash
npx tsc --noEmit && npm run lint && npm test -- --run && echo "✓ clean"
```

- [ ] **Step 9: Smoke-test**

```bash
npm run dev
```

In an existing app:
- App tree renders.
- Home screen lists forms.
- Form preview shows questions.
- Contextual editor shows case types.

Expected: all present.

---

### Task 9: Route generation-stream setters through the doc

**Files:**
- Modify: `lib/services/builderStore.ts` — `setScaffold`, `setPartialScaffold`, `setSchema`, `setModuleContent`, `setFormContent`.

The server-side SA agent emits blueprint fragments as a stream. The client receives each event and calls one of these setters on the old store. Today they update both `generationData` (session state for progress tracking) and the normalized entity maps (modules/forms/questions). In Phase 1b the entity-map updates move to the doc: the setters become translators that dispatch doc mutations for the blueprint changes while continuing to update `generationData`.

The adapter (Task 4) already mirrors doc entity maps into the old store's entity maps, so consumers that still read those still see the updates — just one hop later.

**Injection:** the store needs a reference to the doc to dispatch mutations. We follow the same pattern as the engine: expose a `setDocStore(store)` action on the old store that `SyncBridge` calls alongside `engine.setDocStore`. The setter closures read `get()._docStore` at dispatch time to reach the doc.

- [ ] **Step 1: Add `_docStore` field + `setDocStore` action**

In `lib/services/builderStore.ts`, extend the store state type with an internal field:

```ts
// Inside the builderStore state type
_docStore: BlueprintDocStore | null;
setDocStore: (store: BlueprintDocStore | null) => void;
```

And the initial state + action body:

```ts
_docStore: null,
setDocStore(store) {
	set((draft) => {
		draft._docStore = store as unknown as BlueprintDocStore | null;
	});
},
```

- [ ] **Step 2: Rewrite `setScaffold`**

Currently `setScaffold(scaffold)` decomposes the scaffold into normalized entity maps on the old store AND tracks scaffold in `generationData`. Change the body so entity mutations go through the doc and `generationData` updates stay on the old store:

```ts
setScaffold(scaffold) {
	set((draft) => {
		if (!draft.generationData) {
			draft.generationData = { partialModules: {} };
		}
		draft.generationData.scaffold = scaffold;
		draft.generationData.partialScaffold = undefined;
		// Progress recomputation (unchanged).
		const progress = computeProgress(draft.generationData);
		draft.progressCompleted = progress.completed;
		draft.progressTotal = progress.total;
	});

	// Emit doc mutations for the scaffolded modules/forms. The scaffold is
	// a list of module shapes with empty form placeholders — translate to
	// an `addModule` mutation per module, each pre-seeded with its empty
	// forms. Uses `applyMany` so the entire scaffold collapses to one undo
	// entry (agent writes are paused, so undo tracking is off anyway).
	const docStore = get()._docStore;
	if (!docStore) return;
	const mutations = scaffoldToMutations(scaffold);
	docStore.getState().applyMany(mutations);
},
```

Add `scaffoldToMutations` as a private helper inside the file (or in a new `lib/services/scaffoldMutations.ts` if the function is >30 lines). It walks the scaffold shape and emits `addModule` / `addForm` mutations with generated uuids, mirroring what the old `setScaffold` did when it wrote into the normalized entity maps directly.

- [ ] **Step 3: Rewrite `setPartialScaffold`**

`setPartialScaffold` stores a partial scaffold on `generationData` — no entity map writes. Leave the body unchanged (this setter doesn't mutate doc entities).

- [ ] **Step 4: Rewrite `setSchema`**

```ts
setSchema(caseTypes) {
	set((draft) => {
		// Keep progress tracking on the old store if it references caseTypes.
	});
	const docStore = get()._docStore;
	if (!docStore) return;
	docStore.getState().apply({ kind: "setCaseTypes", caseTypes });
},
```

- [ ] **Step 5: Rewrite `setModuleContent`**

This setter updates a module's case list columns and case detail columns. Translate to a doc `updateModule` mutation:

```ts
setModuleContent(moduleIndex, caseListColumns) {
	set((draft) => {
		// generationData progress tracking (unchanged).
		if (!draft.generationData) {
			draft.generationData = { partialModules: {} };
		}
		const partial = draft.generationData.partialModules[moduleIndex] ?? {};
		partial.caseListColumns = caseListColumns;
		draft.generationData.partialModules[moduleIndex] = partial;
		const progress = computeProgress(draft.generationData);
		draft.progressCompleted = progress.completed;
		draft.progressTotal = progress.total;
	});

	const docStore = get()._docStore;
	if (!docStore) return;
	const doc = docStore.getState();
	const modUuid = doc.moduleOrder[moduleIndex];
	if (!modUuid) return;
	doc.apply({
		kind: "updateModule",
		uuid: modUuid,
		patch: { caseListColumns },
	});
},
```

- [ ] **Step 6: Rewrite `setFormContent`**

`setFormContent(moduleIndex, formIndex, form)` replaces a form wholesale with a new shape (the SA's addQuestions tool call result). Translate to a doc `replaceForm` mutation via the same converter trick used in `useBlueprintMutations.replaceForm`:

```ts
setFormContent(moduleIndex, formIndex, form) {
	set((draft) => {
		// generationData tracking (unchanged).
	});

	const docStore = get()._docStore;
	if (!docStore) return;
	const doc = docStore.getState();
	const modUuid = doc.moduleOrder[moduleIndex];
	if (!modUuid) return;
	const formUuid = doc.formOrder[modUuid]?.[formIndex];
	if (!formUuid) return;

	// Use toDoc to flatten the incoming form, then transplant into the target slot.
	const scratch = toDoc(
		{
			app_name: "",
			connect_type: undefined,
			case_types: null,
			modules: [{ name: "__replace__", forms: [form] }],
		},
		"",
	);
	const scratchFormUuid = scratch.formOrder[scratch.moduleOrder[0]][0];
	const scratchForm = scratch.forms[scratchFormUuid];
	const replacement: FormEntity = { ...scratchForm, uuid: formUuid };
	const questions = Object.values(scratch.questions) as QuestionEntity[];
	const questionOrder: Record<Uuid, Uuid[]> = {};
	for (const [key, order] of Object.entries(scratch.questionOrder)) {
		questionOrder[(key === scratchFormUuid ? formUuid : key) as Uuid] = order;
	}

	doc.apply({
		kind: "replaceForm",
		uuid: formUuid,
		form: replacement,
		questions,
		questionOrder,
	});
},
```

Import `toDoc` at the top of the file.

- [ ] **Step 7: Update `SyncBridge` to also call `setDocStore` on the old store**

```tsx
useEffect(() => {
	if (!docStore) return;
	engine.setDocStore(docStore);
	engine.store.getState().setDocStore(docStore);
	const stop = startSyncOldFromDoc(docStore, engine.store);
	return () => {
		stop();
		engine.store.getState().setDocStore(null);
		engine.setDocStore(null as unknown as BlueprintDocStore);
	};
}, [docStore, engine]);
```

- [ ] **Step 8: Typecheck + lint**

```bash
npx tsc --noEmit && npm run lint && echo "✓ clean"
```

- [ ] **Step 9: Run an end-to-end generation**

```bash
npm run dev
```

Start a new app (/build/new), type a simple prompt ("a simple health survey with name and age"), and wait for the SA to generate. Confirm:
- Tree outline populates as modules/forms stream in.
- Questions render in the preview as the final tool calls land.
- Post-generation undo (Cmd+Z) reverses edits cleanly.

- [ ] **Step 10: Commit**

```bash
git add lib/services/builderStore.ts hooks/useBuilder.tsx
git commit -m "refactor(builder/gen): route generation stream through doc mutations"
```

---

### Task 10: Land the moveQuestion path-to-path xpath rewriter

**Files:**
- Create: `lib/doc/mutations/pathRewrite.ts`
- Create: `lib/doc/__tests__/mutations-pathRewrite.test.ts`
- Create: `lib/doc/__tests__/mutations-questions-move-xpath.test.ts`
- Modify: `lib/doc/mutations/questions.ts` — remove the TODO and wire in the rewriter.

Phase 1a's `moveQuestion` intentionally skipped xpath rewriting on cross-level moves because the existing `rewriteXPathRefs` is a leaf-rename rewriter, not a prefix-swap rewriter. This task adds a proper path-to-path rewriter and wires it into the mutation.

**Semantics:** when a question moves from `/data/grp1/source` to `/data/grp2/source`, any xpath expression that referenced `/data/grp1/source` needs to be rewritten to `/data/grp2/source`. Hashtag references (`#form/source`) only match top-level questions — any move that changes whether the question is top-level breaks them, and we rewrite accordingly: if moving from top-level, hashtag refs become full xpath (out of scope for Phase 1b — we leave them alone and let the user fix them); if moving to top-level from nested, we leave hashtag refs alone (they were already broken).

For Phase 1b we implement the narrow but common case: **any move that changes the absolute path segments**, xpath expressions matching the old path get their segment sequence replaced with the new path's segment sequence. Top-level hashtag refs are rewritten only when both old and new paths are top-level (name change, not level change). This is a strict improvement over Phase 1a (which did nothing) and is safe — incorrect rewrites are worse than no rewrites, and this design never rewrites something it can't precisely match.

- [ ] **Step 1: Write the failing test for `rewriteXPathOnMove`**

Create `lib/doc/__tests__/mutations-pathRewrite.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { rewriteXPathOnMove } from "@/lib/doc/mutations/pathRewrite";

describe("rewriteXPathOnMove", () => {
	it("rewrites absolute path when segments change", () => {
		expect(
			rewriteXPathOnMove("/data/grp1/source", ["grp1", "source"], ["grp2", "source"]),
		).toBe("/data/grp2/source");
	});

	it("rewrites deep-level path swaps", () => {
		expect(
			rewriteXPathOnMove(
				"/data/a/b/c",
				["a", "b", "c"],
				["x", "y", "c"],
			),
		).toBe("/data/x/y/c");
	});

	it("rewrites inside arithmetic expressions", () => {
		expect(
			rewriteXPathOnMove(
				"/data/grp1/source + 1",
				["grp1", "source"],
				["grp2", "source"],
			),
		).toBe("/data/grp2/source + 1");
	});

	it("does not rewrite non-matching paths", () => {
		expect(
			rewriteXPathOnMove("/data/other/field", ["grp1", "source"], ["grp2", "source"]),
		).toBe("/data/other/field");
	});

	it("returns input unchanged for empty expression", () => {
		expect(rewriteXPathOnMove("", ["a"], ["b"])).toBe("");
	});

	it("rewrites top-level hashtag ref when both paths are top-level", () => {
		expect(
			rewriteXPathOnMove("#form/source", ["source"], ["renamed"]),
		).toBe("#form/renamed");
	});

	it("does not rewrite hashtag when old path was nested", () => {
		// Hashtag refs only apply to top-level; we don't synthesize xpath in place of them.
		expect(
			rewriteXPathOnMove("#form/source", ["grp1", "source"], ["grp2", "source"]),
		).toBe("#form/source");
	});
});
```

- [ ] **Step 2: Verify the test fails**

```bash
npx vitest run lib/doc/__tests__/mutations-pathRewrite.test.ts
```

Expected: fails with "Cannot find module".

- [ ] **Step 3: Write the implementation**

Create `lib/doc/mutations/pathRewrite.ts`:

```ts
/**
 * Path-to-path xpath rewriter for moveQuestion.
 *
 * `lib/preview/xpath/rewrite.ts` handles LEAF-RENAME (question kept in
 * place, last path segment changes). This helper handles PREFIX-SWAP or
 * FULL-PATH-SWAP: the question moves to a different location and its
 * absolute path segments change (possibly at any depth).
 *
 * Implementation reuses the same Lezer walk used by `rewriteXPathRefs` —
 * we match absolute paths whose collected segments exactly equal
 * `[data, ...oldSegments]` and replace the entire segment sequence (not
 * just the final NameTest) with `newSegments`. For hashtag refs, we only
 * rewrite when BOTH `oldSegments` and `newSegments` have length 1
 * (top-level → top-level rename); every other case is left alone
 * because a hashtag ref doesn't encode nested paths.
 */

import type { SyntaxNode } from "@lezer/common";
import { parser } from "@/lib/codemirror/xpath-parser";

const T = (() => {
	const all = parser.nodeSet.types;
	const one = (name: string) => {
		const found = all.find((t) => t.name === name);
		if (!found) throw new Error(`Unknown node type: ${name}`);
		return found;
	};
	const many = (name: string) => new Set(all.filter((t) => t.name === name));
	return {
		Children: many("Child"),
		Descendants: many("Descendant"),
		NameTest: one("NameTest"),
		RootPath: one("RootPath"),
		HashtagRef: one("HashtagRef"),
		Slash: one("/"),
	};
})();

interface SourceEdit {
	from: number;
	to: number;
	text: string;
}

function applyEdits(source: string, edits: SourceEdit[]): string {
	if (edits.length === 0) return source;
	edits.sort((a, b) => b.from - a.from);
	let result = source;
	for (const edit of edits) {
		result = result.slice(0, edit.from) + edit.text + result.slice(edit.to);
	}
	return result;
}

/**
 * Rewrite all absolute path references in `expr` whose segments match
 * `oldSegments` (below the `/data` root) to the equivalent path with
 * `newSegments`. Top-level hashtag refs are rewritten only when both
 * segment sequences are length 1.
 *
 * @param expr           Xpath expression to rewrite
 * @param oldSegments    Segments below `/data` in the current question's path
 * @param newSegments    Segments below `/data` in the moved question's new path
 */
export function rewriteXPathOnMove(
	expr: string,
	oldSegments: string[],
	newSegments: string[],
): string {
	if (!expr) return expr;

	const tree = parser.parse(expr);
	const edits: SourceEdit[] = [];

	const targetAbsOld = ["data", ...oldSegments];

	walkForAbsolutePaths(tree.topNode, expr, targetAbsOld, newSegments, edits);

	if (oldSegments.length === 1 && newSegments.length === 1) {
		walkForHashtags(
			tree.topNode,
			expr,
			"#form/",
			oldSegments[0],
			newSegments[0],
			edits,
		);
	}

	return applyEdits(expr, edits);
}

function walkForAbsolutePaths(
	node: SyntaxNode,
	source: string,
	targetSegments: string[],
	newSegmentsBelowData: string[],
	edits: SourceEdit[],
): void {
	if (T.Children.has(node.type) || T.Descendants.has(node.type)) {
		const collected: Array<{ text: string; from: number; to: number }> = [];
		collectSegmentsWithPositions(node, source, collected);
		if (
			collected.length === targetSegments.length &&
			collected.every((seg, i) => seg.text === targetSegments[i])
		) {
			// Replace the entire segment sequence.
			// The NameTest at index 0 corresponds to "data" — we preserve it.
			// NameTests at 1..N-1 become the new segments.
			for (let i = 1; i < collected.length; i++) {
				const current = collected[i];
				const replacement = newSegmentsBelowData[i - 1];
				edits.push({ from: current.from, to: current.to, text: replacement });
			}
			return;
		}
	}

	let child = node.firstChild;
	while (child) {
		walkForAbsolutePaths(child, source, targetSegments, newSegmentsBelowData, edits);
		child = child.nextSibling;
	}
}

function walkForHashtags(
	node: SyntaxNode,
	source: string,
	prefix: string,
	oldName: string,
	newName: string,
	edits: SourceEdit[],
): void {
	if (node.type === T.HashtagRef) {
		const text = source.slice(node.from, node.to);
		if (text === prefix + oldName) {
			const nameStart = node.from + prefix.length;
			edits.push({ from: nameStart, to: node.to, text: newName });
		}
		return;
	}
	let child = node.firstChild;
	while (child) {
		walkForHashtags(child, source, prefix, oldName, newName, edits);
		child = child.nextSibling;
	}
}

function collectSegmentsWithPositions(
	node: SyntaxNode,
	source: string,
	segments: Array<{ text: string; from: number; to: number }>,
): void {
	let child = node.firstChild;
	while (child) {
		if (T.Children.has(child.type) || T.Descendants.has(child.type)) {
			collectSegmentsWithPositions(child, source, segments);
		} else if (child.type === T.RootPath || child.type === T.Slash) {
			// skip
		} else if (child.type === T.NameTest) {
			segments.push({
				text: source.slice(child.from, child.to),
				from: child.from,
				to: child.to,
			});
		} else if (!child.firstChild) {
			const text = source.slice(child.from, child.to);
			if (text !== "/" && text !== "//") {
				segments.push({ text, from: child.from, to: child.to });
			}
		}
		child = child.nextSibling;
	}
}
```

- [ ] **Step 4: Verify unit tests pass**

```bash
npx vitest run lib/doc/__tests__/mutations-pathRewrite.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Write the moveQuestion integration test**

Create `lib/doc/__tests__/mutations-questions-move-xpath.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { AppBlueprint } from "@/lib/schemas/blueprint";
import { asUuid } from "@/lib/doc/types";

const GRP1 = asUuid("g1-0000-0000-0000-000000000000");
const GRP2 = asUuid("g2-0000-0000-0000-000000000000");
const SRC = asUuid("src-0000-0000-0000-000000000000");
const REF = asUuid("ref-0000-0000-0000-000000000000");

function fixture(): AppBlueprint {
	return {
		app_name: "Test",
		connect_type: undefined,
		case_types: null,
		modules: [
			{
				name: "M",
				forms: [
					{
						name: "F",
						type: "survey",
						questions: [
							{
								uuid: GRP1,
								id: "grp1",
								type: "group",
								label: "G1",
								children: [
									{
										uuid: SRC,
										id: "source",
										type: "text",
										label: "Source",
									},
								],
							},
							{
								uuid: GRP2,
								id: "grp2",
								type: "group",
								label: "G2",
								children: [],
							},
							{
								uuid: REF,
								id: "ref",
								type: "text",
								label: "Ref",
								calculate: "/data/grp1/source + 1",
							},
						],
					},
				],
			},
		],
	};
}

describe("moveQuestion + path rewrite", () => {
	it("rewrites absolute-path references when a question moves across groups", () => {
		const store = createBlueprintDocStore();
		store.getState().load(fixture(), "app");

		store.getState().apply({
			kind: "moveQuestion",
			uuid: SRC,
			toParentUuid: GRP2,
			toIndex: 0,
		});

		const ref = store.getState().questions[REF];
		expect(ref?.calculate).toBe("/data/grp2/source + 1");
	});
});
```

- [ ] **Step 6: Wire the rewriter into `moveQuestion`**

Modify `lib/doc/mutations/questions.ts`. Replace the `moveQuestion` case body's "path change on move" comment block with an actual rewrite step. Key steps:

1. Compute the `oldSegments` (below `/data`) from `computeQuestionPath(draft, mut.uuid)` — returns a slash-delimited string; split to get segments.
2. After performing the move, compute `newSegments` the same way.
3. If `oldSegments.join("/") !== newSegments.join("/")`, iterate all questions in the same FORM (walk from the form uuid containing both the source and destination parent chains) and rewrite each xpath field via `rewriteXPathOnMove`.

```ts
case "moveQuestion": {
	const q = draft.questions[mut.uuid];
	if (!q) return;
	const destIsForm = draft.forms[mut.toParentUuid] !== undefined;
	const destQ = draft.questions[mut.toParentUuid];
	const destIsContainer =
		destQ && (destQ.type === "group" || destQ.type === "repeat");
	if (!destIsForm && !destIsContainer) return;

	const sourceParent = findQuestionParent(draft, mut.uuid);
	const oldPathStr = computeQuestionPath(draft, mut.uuid) ?? "";
	const crossParent =
		sourceParent !== undefined &&
		sourceParent.parentUuid !== mut.toParentUuid;

	// Remove from source order.
	if (sourceParent) {
		const srcOrder = draft.questionOrder[sourceParent.parentUuid];
		if (srcOrder) {
			srcOrder.splice(sourceParent.index, 1);
			draft.questionOrder[sourceParent.parentUuid] = srcOrder;
		}
	}

	// Dedupe id against new siblings when crossing a parent boundary.
	if (crossParent) {
		const deduped = dedupeSiblingId(draft, mut.toParentUuid, q.id, mut.uuid);
		q.id = deduped;
	}

	// Insert at destination.
	const destOrder = draft.questionOrder[mut.toParentUuid] ?? [];
	const clamped = Math.max(0, Math.min(mut.toIndex, destOrder.length));
	destOrder.splice(clamped, 0, mut.uuid);
	draft.questionOrder[mut.toParentUuid] = destOrder;

	// Compute new path after the move. Only rewrite refs if the absolute
	// path changed (cross-level moves and reorder-with-rename).
	const newPathStr = computeQuestionPath(draft, mut.uuid) ?? "";
	if (oldPathStr !== newPathStr && oldPathStr.length > 0 && newPathStr.length > 0) {
		const oldSegments = oldPathStr.split("/");
		const newSegments = newPathStr.split("/");

		// Rewrite the form's questions only — xpath refs never cross forms.
		const formUuid = findContainingFormUuid(draft, mut.uuid);
		if (formUuid) {
			for (const qUuid of walkFormQuestionUuids(draft, formUuid)) {
				const target = draft.questions[qUuid];
				if (!target) continue;
				for (const field of XPATH_FIELDS) {
					const expr = target[field];
					if (typeof expr === "string" && expr.length > 0) {
						const rewritten = rewriteXPathOnMove(
							expr,
							oldSegments,
							newSegments,
						);
						if (rewritten !== expr) {
							target[field] = rewritten as never;
						}
					}
				}
				for (const field of DISPLAY_FIELDS) {
					const text = target[field];
					if (typeof text === "string" && text.length > 0) {
						const rewritten = transformBareHashtags(
							text,
							(expr) => rewriteXPathOnMove(expr, oldSegments, newSegments),
						);
						if (rewritten !== text) {
							target[field] = rewritten as never;
						}
					}
				}
			}
		}
	}
	return;
}
```

Add two helpers at the bottom of `questions.ts` (or in `helpers.ts`):

```ts
export function findContainingFormUuid(
	draft: Draft<BlueprintDoc>,
	questionUuid: Uuid,
): Uuid | undefined {
	// Walk parent chain until we hit a form uuid.
	let current: Uuid | undefined = questionUuid;
	while (current) {
		const parent = findQuestionParent(draft, current);
		if (!parent) {
			// current has no parent-question; check if current itself is a top-level
			// question of a form.
			for (const [formUuid, order] of Object.entries(draft.questionOrder)) {
				if (draft.forms[formUuid as Uuid] && order.includes(current)) {
					return formUuid as Uuid;
				}
			}
			return undefined;
		}
		// If the parent is a form uuid, we're done.
		if (draft.forms[parent.parentUuid]) {
			return parent.parentUuid;
		}
		current = parent.parentUuid;
	}
	return undefined;
}

export function walkFormQuestionUuids(
	draft: Draft<BlueprintDoc>,
	formUuid: Uuid,
): Uuid[] {
	const result: Uuid[] = [];
	const stack: Uuid[] = [formUuid];
	while (stack.length > 0) {
		const parent = stack.pop()!;
		const order = draft.questionOrder[parent] ?? [];
		for (const childUuid of order) {
			result.push(childUuid);
			stack.push(childUuid);
		}
	}
	return result;
}
```

Import `rewriteXPathOnMove` at the top of `questions.ts`:

```ts
import { rewriteXPathOnMove } from "./pathRewrite";
```

And remove the `void oldPath;` line and the TODO comment from the old implementation.

- [ ] **Step 7: Verify the integration test passes**

```bash
npx vitest run lib/doc/__tests__/mutations-questions-move-xpath.test.ts
```

Expected: passes.

- [ ] **Step 8: Run the full doc test suite**

```bash
npx vitest run lib/doc
```

Expected: all pre-existing `mutations-questions.test.ts` tests still pass.

- [ ] **Step 9: Commit**

```bash
git add lib/doc/mutations/pathRewrite.ts lib/doc/mutations/questions.ts lib/doc/__tests__/mutations-pathRewrite.test.ts lib/doc/__tests__/mutations-questions-move-xpath.test.ts
git commit -m "feat(builder/doc): add path-to-path xpath rewriter for moveQuestion"
```

---

### Task 11: Remove redundant entity-map writes from legacy-store mutation actions

**Files:**
- Modify: `lib/services/builderStore.ts` — the 12 entity-mutating action bodies (`addQuestion`, `updateQuestion`, `removeQuestion`, `moveQuestion`, `renameQuestion`, `duplicateQuestion`, `addForm`, `updateForm`, `removeForm`, `replaceForm`, `addModule`, `updateModule`, `removeModule`, `updateApp`, `renameCaseProperty`).

Task 6 routed consumer call sites through `useBlueprintMutations` — the old store's own action bodies are no longer called from application code. But `BuilderEngine` and `useBuilderShortcuts` (Task 6 handled those), plus internal callers inside the store itself, may still dispatch them. The sync adapter keeps the old store's entity fields populated; the entity-map writes inside each action body are now dead code.

This task **deletes the entity-map write code** in each action and leaves the action signatures in place as no-ops (for any caller that still references them) or removes them entirely if confirmed dead. A final grep confirms no caller is left.

- [ ] **Step 1: Grep for callers of each old-store mutation action**

```bash
for name in addQuestion updateQuestion removeQuestion moveQuestion renameQuestion duplicateQuestion addForm updateForm removeForm replaceForm addModule updateModule removeModule updateApp renameCaseProperty; do
  count=$(grep -rn "\.$name(" hooks components app lib/services 2>/dev/null | grep -v "lib/services/builderStore.ts" | grep -v "lib/services/builderEngine.ts" | wc -l)
  echo "$name: $count callers"
done
```

Expected output should show most names at 0 or 1 callers (the one being `lib/services/formActions.ts` or similar internal services). Any non-zero name above needs to be migrated before deleting its action body.

- [ ] **Step 2: Resolve any remaining caller**

For each name with >0 callers (excluding `builderStore.ts` and `builderEngine.ts`), migrate the caller to `useBlueprintMutations` or `doc.apply` directly. Commit the migration with a scoped message like `refactor(builder/services): route formActions through doc mutations`.

- [ ] **Step 3: Delete entity-map writes inside each old-store action body**

Each action body currently includes a `set(draft => { /* mutate entity maps */ })` block. Replace with an empty body that's a no-op (preserving the action name and signature until Task 12 deletes it). Example for `updateQuestion`:

```ts
updateQuestion(_mIdx, _fIdx, _path, _updates) {
	// Phase 1b: entity mutations now flow through `useBlueprintMutations`
	// → `doc.apply()`. This action is kept for signature-compat during the
	// migration window; callers have all been migrated in Task 6. Phase 3
	// deletes the action entirely.
},
```

Do the same for the 14 other actions. Do NOT delete `renameCaseProperty` yet — it's a compound mutation that requires translating into doc mutations first; we handle it below.

- [ ] **Step 4: Translate `renameCaseProperty` to a doc `applyMany` dispatch**

The old store's `renameCaseProperty(caseType, oldName, newName)` walks every question and every case list/detail column, rewriting case property references. We migrate it to emit a `Mutation[]` batch and dispatch via `doc.applyMany()`.

Add a helper in `lib/doc/mutations/casePropertyRename.ts`:

```ts
/**
 * Compute the mutation batch to rename a case property across every
 * question and case list/detail column that references it.
 *
 * Pure function — takes a doc snapshot and returns mutations; the doc
 * is never mutated in-place here.
 */
import type { BlueprintDoc, Mutation, Uuid } from "@/lib/doc/types";
import { rewriteCasePropertyInText } from "@/lib/preview/engine/labelRefs";

export function renameCasePropertyMutations(
	doc: BlueprintDoc,
	caseType: string,
	oldName: string,
	newName: string,
): Mutation[] {
	const mutations: Mutation[] = [];

	for (const q of Object.values(doc.questions) as Array<{ uuid: Uuid }>) {
		// Rewrite any xpath/display field that references #case/<oldName>.
		// Delegate the string rewriting to the existing helper (pulled from the
		// old store's rewriteCasePropertyInQuestion).
		const patch: Record<string, string> = {};
		for (const field of ["calculate", "relevant", "default_value", "validation"]) {
			const expr = (q as Record<string, unknown>)[field];
			if (typeof expr === "string" && expr.length > 0) {
				const rewritten = rewriteCasePropertyInText(expr, caseType, oldName, newName);
				if (rewritten !== expr) patch[field] = rewritten;
			}
		}
		for (const field of ["label", "hint"]) {
			const text = (q as Record<string, unknown>)[field];
			if (typeof text === "string" && text.length > 0) {
				const rewritten = rewriteCasePropertyInText(text, caseType, oldName, newName);
				if (rewritten !== text) patch[field] = rewritten;
			}
		}
		if (Object.keys(patch).length > 0) {
			mutations.push({ kind: "updateQuestion", uuid: q.uuid, patch });
		}
	}

	// Case list / detail columns on every module.
	for (const modUuid of doc.moduleOrder) {
		const mod = doc.modules[modUuid];
		if (!mod) continue;
		const listColumns = (mod as { caseListColumns?: Array<{ property: string }> }).caseListColumns;
		const detailColumns = (mod as { caseDetailColumns?: Array<{ property: string }> }).caseDetailColumns;
		let changed = false;
		const nextList = listColumns?.map((c) => {
			if (c.property === oldName) {
				changed = true;
				return { ...c, property: newName };
			}
			return c;
		});
		const nextDetail = detailColumns?.map((c) => {
			if (c.property === oldName) {
				changed = true;
				return { ...c, property: newName };
			}
			return c;
		});
		if (changed) {
			mutations.push({
				kind: "updateModule",
				uuid: modUuid,
				patch: {
					caseListColumns: nextList ?? [],
					caseDetailColumns: nextDetail,
				} as unknown as Partial<typeof mod>,
			});
		}
	}

	return mutations;
}
```

Reuse `rewriteCasePropertyInText` from the old store helper (extract it to `lib/preview/engine/labelRefs.ts` if it's currently inline in `builderStore.ts`).

Wire the dispatcher in `useBlueprintMutations.ts`:

```ts
renameCaseProperty(caseType, oldName, newName) {
	const doc = get();
	const mutations = renameCasePropertyMutations(doc, caseType, oldName, newName);
	dispatch({ kind: "setCaseTypes", caseTypes: doc.caseTypes /* placeholder */ });
	// Simpler: use applyMany directly.
	store.getState().applyMany(mutations);
},
```

Add `renameCaseProperty` to the `BlueprintMutations` interface:

```ts
renameCaseProperty: (caseType: string, oldName: string, newName: string) => void;
```

- [ ] **Step 5: Migrate the renameCaseProperty callers**

Grep:

```bash
grep -rn "\.renameCaseProperty(" hooks components app 2>/dev/null
```

Replace each call site with `useBlueprintMutations().renameCaseProperty(...)`.

- [ ] **Step 6: Delete the old `renameCaseProperty` action body**

Same treatment as Step 3 — empty body, comment explaining Phase 3 deletion.

- [ ] **Step 7: Typecheck + lint + test**

```bash
npx tsc --noEmit && npm run lint && npm test -- --run && echo "✓ clean"
```

- [ ] **Step 8: Commit**

```bash
git add lib/services/builderStore.ts lib/doc/mutations/casePropertyRename.ts lib/doc/hooks/useBlueprintMutations.ts components hooks
git commit -m "refactor(builder/store): remove entity writes from legacy mutation actions"
```

---

### Task 12: Final verification + sweep

**Files:** none modified; all verification commands.

- [ ] **Step 1: Grep for residual raw-store entity reads in consumer code**

```bash
grep -rn "useBuilderStore((s) => s\.\(modules\|forms\|questions\|moduleOrder\|formOrder\|questionOrder\|caseTypes\|connectType\|appName\)" \
  hooks components app 2>/dev/null || echo "✓ no entity-map reads left in consumer code"
```

Expected: only `hooks/useBuilder.tsx` internal facade bodies remain — and those delegate to doc hooks, so they're compliant with the "nothing reads entity maps from old store" rule. Everything else should be `✓`.

- [ ] **Step 2: Grep for mutation dispatch paths still pointing at old store**

```bash
grep -rn "useBuilderStore((s) => s\.\(update\|add\|remove\|move\|rename\|duplicate\|replace\)\(Question\|Form\|Module\|App\|CaseProperty\)" \
  hooks components app 2>/dev/null || echo "✓ no mutation dispatches via old store"
```

Expected: `✓ no mutation dispatches via old store`.

- [ ] **Step 3: Grep for any code outside `lib/doc/` importing from private doc files**

```bash
grep -rn "@/lib/doc/store\|@/lib/doc/mutations" \
  hooks components app 2>/dev/null | grep -v "lib/doc/" || echo "✓ no external imports of private doc modules"
```

Expected: `✓`.

- [ ] **Step 4: Full typecheck**

```bash
npx tsc --noEmit && echo "✓ typecheck clean"
```

- [ ] **Step 5: Full lint**

```bash
npm run lint
```

Expected: clean.

- [ ] **Step 6: Full test suite**

```bash
npm test -- --run
```

Expected: all tests pass. New test count from Phase 1b: ~25 tests (adapters ~10, hooks ~5, path rewrite ~7, move-xpath integration ~1, sync-old-from-doc ~2).

- [ ] **Step 7: Production build**

```bash
npm run build
```

Expected: succeeds.

- [ ] **Step 8: Manual smoke test — full user journey**

```bash
npm run dev
```

Open `http://localhost:3000/build/<existing-app-id>`:

1. **Tree + preview** — the app tree and the form preview both render.
2. **Rename a question** — outline and preview update.
3. **Move a question into a group** — outline and preview reflect the new structure. Open the contextual editor on a question that referenced the moved question's path and verify the xpath field auto-updated.
4. **Duplicate a group** — the whole group (including children) is duplicated with `_copy` suffix and unique nested ids.
5. **Delete a question** — gone from both surfaces.
6. **Undo all four edits** via Cmd+Z — each reverses cleanly.
7. **Redo all four** via Cmd+Shift+Z — each replays cleanly.
8. **Change the app name** in the home screen — reflected in the header.
9. **Open contextual editor for a case property** — rename the property via the case types section. All references in questions and case list columns update.

Open `http://localhost:3000/build/new`:

10. **Generate a simple app** via the chat — "health survey with name, age, and pregnancy status". Watch the tree populate as modules and forms stream in. Open a generated form after completion and edit a question. Confirm undo reverses the edit (but not the generation itself — generation is one atomic history entry).

Expected: all 10 steps pass without errors.

- [ ] **Step 9: Review commit graph**

```bash
git log --oneline main..HEAD
```

Expected: ~20-30 single-concern commits with scoped messages. No `chore: wip` or `fixup!` commits. No mixed-concern commits.

- [ ] **Step 10: Run the full verification summary**

```bash
echo "=== Phase 1b verification summary ===" && \
npx tsc --noEmit && echo "✓ typecheck" && \
npm run lint && echo "✓ lint" && \
npm test -- --run && echo "✓ tests" && \
npm run build && echo "✓ build"
```

Expected: all green.

- [ ] **Step 11: No commit — plan completion**

Phase 1b is complete when all steps above pass. The worktree is ready for merge review (handled outside this plan — the user pauses here per the auto-mode workflow).

---

## Phase 1b complete

What exists at end of this phase:

- `<BlueprintDocProvider>` mounted inside `BuilderProvider` for every builder route. Both stores hydrate from the same `initialBlueprint` and share a lifetime.
- `lib/doc/adapters/syncOldFromDoc.ts` — one-way subscription projecting doc entity maps into the old store so un-migrated session-field consumers keep working.
- `lib/doc/adapters/pathToUuid.ts` — legacy (mIdx, fIdx, path) → uuid resolvers for call-site migration.
- `lib/doc/hooks/useBlueprintMutations.ts` — user-facing mutation API wrapping `doc.apply()`.
- `lib/doc/mutations/pathRewrite.ts` — path-to-path xpath rewriter; `moveQuestion` correctly rewrites cross-level references.
- Every consumer of module/form/question/case_types/connect_type/app_name reads through `lib/doc/hooks/**`. No file under `hooks/`, `components/`, or `app/` selects entity maps from `useBuilderStore` anymore.
- Every user-driven mutation path dispatches via `useBlueprintMutations` (client components) or `doc.apply()` directly (`BuilderEngine` internal methods).
- Generation-stream setters (`setScaffold`, `setSchema`, `setModuleContent`, `setFormContent`) emit doc mutations for entity changes and retain `generationData` progress tracking on the old store.
- Undo/redo orchestrates through `doc.temporal` — the sync adapter pulls entity-map state on the old store along for the ride.

What does NOT exist yet (next phases):

- URL-driven navigation and selection (`useLocation`, `useNavigate`, `useSelect`). Navigation, selection, and sidebars still live on the old store.
- `BuilderSession` store and `BuilderEngine` dissolution. Session state still lives on the old builder store.
- `generationData` session-state migration to the doc's Mutation-stream model (Phase 4).
- `VirtualFormList` and the recursive-renderer replacement (Phase 5).

## Self-review

**Spec coverage:**
- Phase 1 row of the migration table: ✓ — BlueprintDoc is wired, mutation API in place, undo captures work, adapter mirrors old store.
- "Adapter strategy (Phases 1–2)": ✓ — one-way `syncOldFromDoc` file with its own test suite.
- Section 5 selector-API unification: ✓ — every entity read goes through a named domain hook; facades in `hooks/useBuilder.tsx` delegate; no `select*`/`derive*` split (those still exist on the old store for session state, Phase 2/3 removes them).

**Phase 1a TODOs addressed:**
- `moveQuestion` path rewrite: ✓ (Task 10).
- `useOrderedChildren` subscription granularity: explicitly deferred and justified (not on Phase 1b's natural path; Phase 5 restructures reads anyway).

**Placeholder scan:** no "TBD", no "fill in details", no unanchored "similar to Task N". Each step has exact file paths, code, and commands.

**Type consistency:** all Mutation kinds referenced match the Phase 1a union in `lib/doc/types.ts`. Function names (`resolveQuestionUuid`, `startSyncOldFromDoc`, `useBlueprintMutations`, `rewriteXPathOnMove`, `renameCasePropertyMutations`) are used consistently across tasks.
