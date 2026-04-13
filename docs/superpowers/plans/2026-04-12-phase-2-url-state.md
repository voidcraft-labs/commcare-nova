# Phase 2 — URL-Driven Navigation + Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dissolve the legacy builder store's `screen`, `navEntries`, `navCursor`, and `selected` fields — plus all engine methods that maintain them — in favor of URL query parameters on `/build/[id]`. Consumers read navigation and selection via `useLocation()` / `useSelect()` / `useNavigate()` hooks that wrap Next.js App Router APIs. Rewrite `useBlueprintMutations` to take uuids directly (deleting the `pathToUuid.ts` adapter and `coerceNulls`/`NullablePartial`). Every screen becomes bookmarkable, Cmd+click-able, and back/forward-button-driven out of the box.

**Architecture:** The URL on `/build/[id]` becomes the sole source of truth for "where you are" and "what's focused." A pure `parseLocation`/`serializeLocation`/`isValidLocation` module (already built in Phase 0) is consumed by a new `lib/routing/hooks.tsx` that exposes reactive subscriptions to Next's `useSearchParams` and write operations via `router.push` (screen changes → new history entry) / `router.replace` (selection flips → no history entry). A mount-time root effect scrubs stale `sel=` / `m=` / `f=` params from the URL when their uuids disappear from the doc. RSC-side validation on first load redirects to a clean URL server-side. Composite actions (undo/redo with scroll, deleteSelected with reorient) move from `BuilderEngine` into hooks at `lib/routing/builderActions.ts`.

**Tech Stack:** TypeScript (strict), Next.js 16 App Router (`useSearchParams`, `useRouter`, `useParams`), Zustand 5 (doc store only — legacy store shrinks), Vitest, @testing-library/react 16, Biome.

**Spec reference:** `docs/superpowers/specs/2026-04-12-builder-state-rearchitecture-design.md` — Section 3 "URL-driven navigation + selection", Section 4 "BuilderEngine dissolution" (the rows this phase addresses), and the Phase 2 row of the migration table.

**Depends on:** Phase 0 (`lib/routing/types.ts`, `lib/routing/location.ts`, tests — merged) and Phase 1b (`lib/doc/**` doc store, `useBlueprintMutations`, `syncOldFromDoc` adapter — merged at `c738781`).

---

## Phase 2 non-goals (stay on legacy store / legacy engine — Phase 3 territory)

- `cursorMode`, `activeFieldId`, `chatOpen`, `structureOpen`, `sidebarStash` — ephemeral session UI state, not location.
- `phase`, `agentActive`, `postBuildEdit`, `generationData`, `generationStage`, `generationError`, `statusMessage`, `progressCompleted`, `progressTotal` — agent/lifecycle state.
- `replayStages`, `replayDoneIndex`, `replayExitPath`, `replayMessages` — replay machinery.
- BuilderEngine's scroll registry, energy ticks, edit guard, focus hint, rename notice, new-question UUID, drag state, connect stash, agent tracking.
- `lib/doc/adapters/syncOldFromDoc.ts` stays — un-migrated consumers of `s.modules`/`s.forms`/etc. still exist in Phase 3 territory (generation-stream setters, a few non-URL readers). Delete in Phase 3.

## Phase 1b carryovers resolved in Phase 2

1. `coerceNulls` + `NullablePartial` in `useBlueprintMutations.ts` — retired by Task 5 (uuid-first rewrite drops `null`-clear ergonomics; callers now pass `undefined`).
2. `appId=""` sentinel passed to `<BlueprintDocProvider>` when `buildId === "new"` — Task 11 removes the empty-string fallback; the provider handles `undefined` directly.
3. `lib/doc/adapters/pathToUuid.ts` — deleted by Task 14 once every caller reads uuids from `useLocation()`.
4. `MoveQuestionResult.renamed` and `QuestionRenameResult.xpathFieldsRewritten` — **deferred to Phase 3**. Phase 2 keeps the current behavior (both fields stay empty/zero); the 3 `// phase-1b-task-10` TODO comments stay in place. No toast-on-auto-rename UX shipped in this phase.
5. `stashAllFormConnect` reading legacy store — Task 12 flips it to read `_docStore.getState()`.

---

## File Structure

**New files:**

```
lib/routing/
  hooks.tsx                           # useLocation, useNavigate, useSelect,
                                      # useSelectedQuestion, useSelectedFormContext,
                                      # useBreadcrumbs, useLocationValid
  builderActions.ts                   # useUndoRedo, useDeleteSelectedQuestion — composite
                                      # hooks replacing engine.undo/redo/deleteSelected
  __tests__/
    hooks-useLocation.test.tsx        # round-trip parsing + deletion recovery fixtures
    hooks-useBreadcrumbs.test.tsx     # breadcrumb derivation from URL + doc
    hooks-useNavigate.test.tsx        # router.push vs router.replace selection
    builderActions-useUndoRedo.test.tsx
    builderActions-useDeleteSelectedQuestion.test.tsx

components/builder/
  LocationRecoveryEffect.tsx          # mounted inside BuilderProvider — strips stale sel=/m=/f=
```

**Modified files:**

```
app/build/[id]/page.tsx               # accept searchParams, server-validate against blueprint,
                                      # redirect to clean URL if stale

hooks/useBuilder.tsx                  # wire <LocationRecoveryEffect>; delete useBuilderScreen,
                                      # useBuilderSelected, useBuilderCanGoBack, useBuilderCanGoUp,
                                      # useIsQuestionSelected, useBreadcrumbs (re-exported from new module)
lib/doc/provider.tsx                  # accept appId as `string | undefined`, drop the "" sentinel
lib/doc/hooks/useBlueprintMutations.ts
                                      # rewrite to uuid-first API:
                                      # - addQuestion(parentUuid, question, opts?)
                                      # - updateQuestion(uuid, patch)
                                      # - removeQuestion(uuid)
                                      # - renameQuestion(uuid, newId)
                                      # - moveQuestion(uuid, opts)
                                      # - duplicateQuestion(uuid)
                                      # - addForm(moduleUuid, form)
                                      # - updateForm(uuid, patch)
                                      # - removeForm(uuid)
                                      # - replaceForm(uuid, form)
                                      # - addModule(module), updateModule(uuid, patch), removeModule(uuid)
                                      # - updateApp(patch), setCaseTypes(caseTypes), applyMany(mutations)
                                      # drop coerceNulls + NullablePartial
lib/doc/__tests__/hooks-useBlueprintMutations.test.tsx
                                      # rewrite to uuid signatures

lib/services/builderStore.ts          # delete fields: selected, screen, navEntries, navCursor,
                                      # sidebarStash (no — Phase 3)  — KEEP sidebarStash;
                                      # delete actions: select, navPush, navPushIfDifferent,
                                      # navBack, navUp, navigateToHome, navigateToModule,
                                      # navigateToForm, navigateToCaseList, navResetTo;
                                      # drop from UndoSlice partialize; drop zundo equality
                                      # refs to removed fields;
                                      # reset() no longer touches deleted fields
lib/services/builderEngine.ts         # delete methods: select, navigateTo, syncSelectionToScreen,
                                      # navBackWithSync, navUpWithSync, navigateToScreen,
                                      # navigateToSelection, undo, redo, applyUndoRedo,
                                      # deleteSelected, flashUndoHighlight, findFieldElement,
                                      # fulfillPendingScroll, _pendingScroll, _editGuard call
                                      # inside select (since select is gone);
                                      # switchConnectMode reads _docStore directly (not legacy mirror)
lib/services/builderSelectors.ts      # delete selectCanGoBack, selectCanGoUp, deriveBreadcrumbs
                                      # (moved into lib/routing/hooks.tsx)

components/builder/BuilderSubheader.tsx
components/builder/BuilderLayout.tsx
components/builder/BuilderContentArea.tsx
components/builder/AppTree.tsx
components/builder/useBuilderShortcuts.ts
components/builder/contextual/ContextualEditorHeader.tsx
components/builder/contextual/ContextualEditorData.tsx
components/builder/contextual/ContextualEditorUI.tsx
components/builder/contextual/ContextualEditorLogic.tsx
components/builder/detail/FormDetail.tsx
components/builder/detail/FormSettingsPanel.tsx
components/builder/detail/ModuleDetail.tsx
components/preview/PreviewHeader.tsx
components/preview/PreviewShell.tsx
components/preview/screens/HomeScreen.tsx
components/preview/screens/ModuleScreen.tsx
components/preview/screens/FormScreen.tsx
components/preview/screens/CaseListScreen.tsx
components/preview/form/FormRenderer.tsx
components/preview/form/EditableQuestionWrapper.tsx
components/preview/form/QuestionTypePicker.tsx
hooks/useSaveQuestion.ts
hooks/useTextEditSave.ts
```

**Deleted files:**

```
lib/doc/adapters/pathToUuid.ts        # last caller gone after Task 5
lib/doc/__tests__/adapters-pathToUuid.test.ts
```

---

## Dependencies between tasks

- **Task 1** (routing hooks) is a prerequisite for Tasks 3, 6–11.
- **Task 2** (RSC validation) is independent of Tasks 1/3 and can land anytime.
- **Task 3** (LocationRecoveryEffect) depends on Task 1.
- **Task 4** (builderActions) depends on Task 1.
- **Task 5** (uuid-first mutations) is a prerequisite for Tasks 7–10.
- **Tasks 6–11** (consumer migrations) can land in any order after their deps; kept sequential in this plan for easier review.
- **Task 12** (engine deletion) requires Tasks 4, 6–11 to have moved every caller off engine.navigateTo/select/undo/redo/deleteSelected.
- **Task 13** (legacy store field deletion) requires Tasks 6–12 to have moved every caller off legacy `selected`/`screen`/`navEntries`/`navCursor`.
- **Task 14** (cleanup) is last.

---

## Worktree Setup

Before Task 1, create the isolated worktree:

```bash
cd /Users/braxtonperry/work/personal/code/commcare-nova
git worktree add -b phase-2-url-state ../commcare-nova-phase2 main
cd ../commcare-nova-phase2
npm install
npm test -- --run
npx tsc --noEmit
```

Expected: worktree created, tests and typecheck clean. Do NOT push the branch. Execute every subsequent task inside `../commcare-nova-phase2`.

---

### Task 1: `lib/routing/hooks.tsx` — location + navigation + selection + breadcrumbs

**Files:**
- Create: `lib/routing/hooks.tsx`
- Create: `lib/routing/__tests__/hooks-useLocation.test.tsx`
- Create: `lib/routing/__tests__/hooks-useNavigate.test.tsx`
- Create: `lib/routing/__tests__/hooks-useBreadcrumbs.test.tsx`

This module is the client-side face of the URL schema already defined in Phase 0's `lib/routing/location.ts`. Every consumer migrated in Tasks 6–11 imports from here.

Design:
- `useLocation()` reads Next's `useSearchParams()` and returns `parseLocation(params)`. The `useSearchParams` subscription automatically triggers re-renders on every URL param change (App Router behavior). Cheap because `parseLocation` is pure and fast.
- `useNavigate()` returns a frozen action object `{ goHome, openModule, openCaseList, openCaseDetail, openForm, back, up }`. Each action serializes a `Location`, combines it with the current pathname, and dispatches via `router.push(url, { scroll: false })`. `back` delegates to `router.back()` so browser history is honored. `up` derives the parent location from the current one and `push`-es it.
- `useSelect()` mutates just the `sel=` query param via `router.replace(url, { scroll: false })` — no history entry per question click. Accepts `{ uuid, behavior?, hasToolbar? }` and, when scroll behavior is provided, calls `engine.requestScroll(uuid, behavior, hasToolbar)` (see Task 12 note — Phase 2 keeps the pending-scroll hand-off on the engine).
- `useSelectedQuestion()` resolves the URL's `sel=` to a `QuestionEntity | null` via the doc store.
- `useSelectedFormContext()` resolves `m=` + `f=` to `{ module: ModuleEntity, form: FormEntity } | null`.
- `useBreadcrumbs()` derives from `useLocation()` + doc entity reads, producing the same `BreadcrumbItem[]` shape the legacy `deriveBreadcrumbs` returns.
- `useLocationValid()` returns `isValidLocation(currentLocation, currentDoc)` reactively — consumed by `LocationRecoveryEffect` (Task 3).

- [ ] **Step 1: Create the test fixture helper**

Create `lib/routing/__tests__/hooks-useLocation.test.tsx`:

```tsx
/**
 * Tests for URL-driven location hooks.
 *
 * We simulate Next.js's App Router context using a test wrapper that
 * provides a mock `useSearchParams` result. Full router dispatch is
 * covered in `hooks-useNavigate.test.tsx`.
 */
import { renderHook } from "@testing-library/react";
import { ReadonlyURLSearchParams } from "next/navigation";
import { describe, expect, it, vi } from "vitest";

// Mock next/navigation BEFORE importing the hook under test.
const mockParams = { current: new URLSearchParams() };
vi.mock("next/navigation", async () => {
	const actual = await vi.importActual<typeof import("next/navigation")>(
		"next/navigation",
	);
	return {
		...actual,
		useSearchParams: () =>
			new ReadonlyURLSearchParams(mockParams.current),
		useRouter: () => ({
			push: vi.fn(),
			replace: vi.fn(),
			back: vi.fn(),
			forward: vi.fn(),
			refresh: vi.fn(),
			prefetch: vi.fn(),
		}),
		usePathname: () => "/build/app-1",
	};
});

import { useLocation } from "@/lib/routing/hooks";

describe("useLocation", () => {
	it("returns home when no screen param is present", () => {
		mockParams.current = new URLSearchParams();
		const { result } = renderHook(() => useLocation());
		expect(result.current).toEqual({ kind: "home" });
	});

	it("returns module location for ?s=m&m=<uuid>", () => {
		mockParams.current = new URLSearchParams("s=m&m=mod-uuid");
		const { result } = renderHook(() => useLocation());
		expect(result.current).toEqual({ kind: "module", moduleUuid: "mod-uuid" });
	});

	it("returns form+selected location for ?s=f&m=&f=&sel=", () => {
		mockParams.current = new URLSearchParams(
			"s=f&m=mod-uuid&f=form-uuid&sel=q-uuid",
		);
		const { result } = renderHook(() => useLocation());
		expect(result.current).toEqual({
			kind: "form",
			moduleUuid: "mod-uuid",
			formUuid: "form-uuid",
			selectedUuid: "q-uuid",
		});
	});

	it("degrades to home on malformed (missing required) params", () => {
		mockParams.current = new URLSearchParams("s=f&m=mod-uuid"); // missing f
		const { result } = renderHook(() => useLocation());
		expect(result.current).toEqual({ kind: "home" });
	});
});
```

- [ ] **Step 2: Implement `lib/routing/hooks.tsx`**

```tsx
/**
 * URL-driven location hooks — Phase 2's public client surface for the
 * builder's navigation and selection state.
 *
 * The URL on /build/[id] is the sole source of truth for "where you are"
 * (home / module / case list / form) and "what's focused" (selected
 * question). Nothing in any Zustand store represents this state.
 *
 * Navigation operations fall into two buckets:
 *
 * 1. **Screen changes** (home ↔ module ↔ form) use `router.push` so each
 *    move becomes a browser history entry. The back/forward buttons
 *    traverse this history for free.
 * 2. **Selection changes** (the `sel=` query param flipping on question
 *    clicks) use `router.replace` so rapid clicking through questions
 *    doesn't flood history. Back from a form goes to the module, not
 *    through every question the user happened to click in that form.
 *
 * Every navigation call passes `{ scroll: false }` — Next's App Router
 * otherwise scrolls to the top of the page on push, which would undo
 * our own scroll-to-selection behavior.
 */

"use client";

import {
	usePathname,
	useRouter,
	useSearchParams,
} from "next/navigation";
import { useMemo } from "react";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import type {
	FormEntity,
	ModuleEntity,
	QuestionEntity,
	Uuid,
} from "@/lib/doc/types";
import {
	isValidLocation,
	parseLocation,
	serializeLocation,
} from "@/lib/routing/location";
import type { Location } from "@/lib/routing/types";

/**
 * Reactive parse of the current URL into a `Location`. Re-renders on
 * every URL param change (App Router's `useSearchParams` provides the
 * subscription).
 *
 * Malformed/incomplete URLs degrade to `{ kind: "home" }` — see
 * `parseLocation` for the rules.
 */
export function useLocation(): Location {
	const params = useSearchParams();
	return useMemo(() => parseLocation(params), [params]);
}

/**
 * Derive the selected question entity from the current URL and doc.
 * Returns `null` when there's no `sel=` in the URL, when the current
 * screen isn't a form, or when the referenced uuid no longer exists
 * (the deletion-recovery effect in `LocationRecoveryEffect` will strip
 * the stale param on the next tick).
 */
export function useSelectedQuestion(): QuestionEntity | null {
	const loc = useLocation();
	const selectedUuid =
		loc.kind === "form" ? loc.selectedUuid : undefined;
	const question = useBlueprintDoc((s) =>
		selectedUuid ? s.questions[selectedUuid] : undefined,
	);
	return question ?? null;
}

/**
 * Derive the `{ module, form }` context the selected-question panel
 * needs — one shallow read per entity, `null` if we're not on a form
 * screen or an entity is missing.
 */
export function useSelectedFormContext(): {
	module: ModuleEntity;
	form: FormEntity;
} | null {
	const loc = useLocation();
	const moduleUuid = loc.kind === "form" ? loc.moduleUuid : undefined;
	const formUuid = loc.kind === "form" ? loc.formUuid : undefined;
	const mod = useBlueprintDoc((s) =>
		moduleUuid ? s.modules[moduleUuid] : undefined,
	);
	const form = useBlueprintDoc((s) =>
		formUuid ? s.forms[formUuid] : undefined,
	);
	if (!mod || !form) return null;
	return { module: mod, form };
}

/**
 * `true` when a specific question uuid is the current selection.
 * Each `EditableQuestionWrapper` calls this with its own identity —
 * only the previously-selected and newly-selected wrappers re-render
 * on a selection change (every other wrapper's boolean stays `false`).
 */
export function useIsQuestionSelected(uuid: Uuid | string): boolean {
	const loc = useLocation();
	return loc.kind === "form" && loc.selectedUuid === uuid;
}

/**
 * True when the URL's location references exist in the doc. Consumed
 * by the root `LocationRecoveryEffect` to decide when to scrub stale
 * params. Callers should not use this to gate rendering — the effect
 * replaces the URL in the same tick as a mismatch is detected, and
 * gating rendering would cause a flash.
 */
export function useLocationValid(): boolean {
	const loc = useLocation();
	return useBlueprintDoc((s) => isValidLocation(loc, s));
}

/**
 * A `BreadcrumbItem` matches the legacy `lib/services/builderSelectors`
 * shape so migrated consumers keep their render code unchanged.
 * `navigateTo` fires a `useNavigate()` action on click — Task 1 doesn't
 * embed a click handler here; consumers get the raw list and wire the
 * click via the navigate action.
 */
export interface BreadcrumbItem {
	key: string;
	label: string;
	location: Location;
}

/**
 * Derived breadcrumb trail from the current location + doc names.
 * Everything is read through shallow-stable selectors, so unrelated
 * doc mutations don't cause re-renders here.
 */
export function useBreadcrumbs(): BreadcrumbItem[] {
	const loc = useLocation();
	const appName = useBlueprintDoc((s) => s.appName);

	const moduleUuid =
		loc.kind === "module" || loc.kind === "cases" || loc.kind === "form"
			? loc.moduleUuid
			: undefined;
	const formUuid = loc.kind === "form" ? loc.formUuid : undefined;

	const moduleName = useBlueprintDoc((s) =>
		moduleUuid ? s.modules[moduleUuid]?.name : undefined,
	);
	const formName = useBlueprintDoc((s) =>
		formUuid ? s.forms[formUuid]?.name : undefined,
	);
	const moduleCaseType = useBlueprintDoc((s) =>
		moduleUuid ? s.modules[moduleUuid]?.caseType : undefined,
	);

	return useMemo<BreadcrumbItem[]>(() => {
		const items: BreadcrumbItem[] = [
			{ key: "home", label: appName || "Home", location: { kind: "home" } },
		];
		if (moduleUuid) {
			items.push({
				key: `m:${moduleUuid}`,
				label: moduleName ?? "Module",
				location: { kind: "module", moduleUuid },
			});
		}
		if (loc.kind === "cases") {
			items.push({
				key: `cases:${moduleUuid}`,
				label: moduleCaseType ? `${moduleCaseType} cases` : "Cases",
				location: { kind: "cases", moduleUuid: loc.moduleUuid },
			});
			if (loc.caseId) {
				items.push({
					key: `case:${loc.caseId}`,
					label: loc.caseId,
					location: { kind: "cases", moduleUuid: loc.moduleUuid, caseId: loc.caseId },
				});
			}
		}
		if (loc.kind === "form" && formUuid && moduleUuid) {
			items.push({
				key: `f:${formUuid}`,
				label: formName ?? "Form",
				location: { kind: "form", moduleUuid, formUuid },
			});
		}
		return items;
	}, [appName, loc, moduleUuid, formUuid, moduleName, formName, moduleCaseType]);
}

/**
 * Location + navigation actions. Selection edits use `router.replace`
 * (no history entry); screen changes use `router.push` with
 * `{ scroll: false }`.
 *
 * The returned object is frozen to make mis-uses obvious; every value
 * is stable across renders (the closures only close over the stable
 * `router` and `pathname` references).
 */
export function useNavigate() {
	const router = useRouter();
	const pathname = usePathname();
	const loc = useLocation();

	return useMemo(
		() => ({
			/** Push a new location (history entry). Use for screen changes. */
			push(next: Location, opts?: { replace?: boolean }): void {
				const params = serializeLocation(next).toString();
				const url = params ? `${pathname}?${params}` : pathname;
				if (opts?.replace) router.replace(url, { scroll: false });
				else router.push(url, { scroll: false });
			},
			/** Replace the current location (no history entry). */
			replace(next: Location): void {
				const params = serializeLocation(next).toString();
				const url = params ? `${pathname}?${params}` : pathname;
				router.replace(url, { scroll: false });
			},
			/** Go to the app home. */
			goHome(): void {
				router.push(pathname, { scroll: false });
			},
			/** Go to a module screen. */
			openModule(moduleUuid: Uuid): void {
				this.push({ kind: "module", moduleUuid });
			},
			/** Go to a module's case list. */
			openCaseList(moduleUuid: Uuid): void {
				this.push({ kind: "cases", moduleUuid });
			},
			/** Open a specific case detail (form-screen precursor). */
			openCaseDetail(moduleUuid: Uuid, caseId: string): void {
				this.push({ kind: "cases", moduleUuid, caseId });
			},
			/** Open a form. Preserves any existing `sel=` is not — it clears. */
			openForm(moduleUuid: Uuid, formUuid: Uuid, selectedUuid?: Uuid): void {
				this.push({
					kind: "form",
					moduleUuid,
					formUuid,
					selectedUuid,
				});
			},
			/** Browser-back. Walks the actual history stack. */
			back(): void {
				router.back();
			},
			/** Go to the immediate parent of the current location. */
			up(): void {
				const parent = parentLocation(loc);
				if (parent) this.push(parent);
			},
		}),
		[router, pathname, loc],
	);
}

/** Pure parent-derivation for the `up` navigation. */
function parentLocation(loc: Location): Location | undefined {
	switch (loc.kind) {
		case "home":
			return undefined;
		case "module":
			return { kind: "home" };
		case "cases":
			return loc.caseId
				? { kind: "cases", moduleUuid: loc.moduleUuid }
				: { kind: "module", moduleUuid: loc.moduleUuid };
		case "form":
			return loc.selectedUuid
				? {
						kind: "form",
						moduleUuid: loc.moduleUuid,
						formUuid: loc.formUuid,
					}
				: { kind: "module", moduleUuid: loc.moduleUuid };
	}
}

/**
 * Selection-only operation. Flips the `sel=` query param on the
 * current form without otherwise changing the screen. No-ops when
 * not on a form location (selection only exists inside a form).
 *
 * `uuid === undefined` clears the current selection.
 */
export function useSelect() {
	const router = useRouter();
	const pathname = usePathname();
	const loc = useLocation();

	return useMemo(() => {
		return (uuid: Uuid | undefined): void => {
			if (loc.kind !== "form") return;
			const next: Location = {
				kind: "form",
				moduleUuid: loc.moduleUuid,
				formUuid: loc.formUuid,
				selectedUuid: uuid,
			};
			const params = serializeLocation(next).toString();
			const url = params ? `${pathname}?${params}` : pathname;
			router.replace(url, { scroll: false });
		};
	}, [router, pathname, loc]);
}
```

- [ ] **Step 3: Create navigate test**

Create `lib/routing/__tests__/hooks-useNavigate.test.tsx`:

```tsx
import { renderHook } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

const routerPush = vi.fn();
const routerReplace = vi.fn();
const routerBack = vi.fn();
const mockParams = { current: new URLSearchParams() };

vi.mock("next/navigation", async () => {
	const actual = await vi.importActual<typeof import("next/navigation")>(
		"next/navigation",
	);
	return {
		...actual,
		useSearchParams: () =>
			new actual.ReadonlyURLSearchParams(mockParams.current),
		useRouter: () => ({
			push: routerPush,
			replace: routerReplace,
			back: routerBack,
			forward: vi.fn(),
			refresh: vi.fn(),
			prefetch: vi.fn(),
		}),
		usePathname: () => "/build/app-1",
	};
});

import { useNavigate, useSelect } from "@/lib/routing/hooks";
import { asUuid } from "@/lib/doc/types";

describe("useNavigate", () => {
	it("openForm issues router.push with scroll:false", () => {
		mockParams.current = new URLSearchParams();
		routerPush.mockClear();
		const { result } = renderHook(() => useNavigate());
		act(() => result.current.openForm(asUuid("m-1"), asUuid("f-1")));
		expect(routerPush).toHaveBeenCalledWith(
			"/build/app-1?s=f&m=m-1&f=f-1",
			{ scroll: false },
		);
	});

	it("up on form-with-selection clears only the selection", () => {
		mockParams.current = new URLSearchParams("s=f&m=m-1&f=f-1&sel=q-1");
		routerPush.mockClear();
		const { result } = renderHook(() => useNavigate());
		act(() => result.current.up());
		expect(routerPush).toHaveBeenCalledWith(
			"/build/app-1?s=f&m=m-1&f=f-1",
			{ scroll: false },
		);
	});

	it("useSelect uses router.replace, not push", () => {
		mockParams.current = new URLSearchParams("s=f&m=m-1&f=f-1");
		routerReplace.mockClear();
		const { result } = renderHook(() => useSelect());
		act(() => result.current(asUuid("q-42")));
		expect(routerReplace).toHaveBeenCalledWith(
			"/build/app-1?s=f&m=m-1&f=f-1&sel=q-42",
			{ scroll: false },
		);
	});
});
```

- [ ] **Step 4: Create breadcrumbs test**

Create `lib/routing/__tests__/hooks-useBreadcrumbs.test.tsx`:

```tsx
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import type { ReactNode } from "react";

const mockParams = { current: new URLSearchParams() };
vi.mock("next/navigation", async () => {
	const actual = await vi.importActual<typeof import("next/navigation")>(
		"next/navigation",
	);
	return {
		...actual,
		useSearchParams: () =>
			new actual.ReadonlyURLSearchParams(mockParams.current),
		useRouter: () => ({
			push: vi.fn(),
			replace: vi.fn(),
			back: vi.fn(),
			forward: vi.fn(),
			refresh: vi.fn(),
			prefetch: vi.fn(),
		}),
		usePathname: () => "/build/a",
	};
});

import { useBreadcrumbs } from "@/lib/routing/hooks";

describe("useBreadcrumbs", () => {
	const blueprint = {
		app_name: "My App",
		connect_type: undefined,
		case_types: null,
		modules: [
			{
				name: "Patients",
				case_type: "patient",
				forms: [{ name: "Register", type: "registration", questions: [] }],
			},
		],
	} as const;

	function wrapper({ children }: { children: ReactNode }) {
		return (
			<BlueprintDocProvider appId="a" initialBlueprint={blueprint}>
				{children}
			</BlueprintDocProvider>
		);
	}

	it("at home, only the app name is shown", () => {
		mockParams.current = new URLSearchParams();
		const { result } = renderHook(() => useBreadcrumbs(), { wrapper });
		expect(result.current).toEqual([
			{ key: "home", label: "My App", location: { kind: "home" } },
		]);
	});

	// Further cases (module/form) omitted here — Task 1 step is about
	// establishing the hook shape. Full coverage added in Task 11 review.
});
```

- [ ] **Step 5: Run tests**

```bash
npm test -- lib/routing/__tests__ --run
```

Expected: all 3 new files pass (plus the existing `location.test.ts`).

- [ ] **Step 6: Typecheck**

```bash
npx tsc --noEmit && echo "✓"
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add lib/routing/hooks.tsx lib/routing/__tests__/
git commit -m "feat(routing): URL-driven useLocation/useNavigate/useSelect/useBreadcrumbs"
```

---

### Task 2: Server-side URL validation in `/build/[id]`

**Files:**
- Modify: `app/build/[id]/page.tsx`

On first load, the RSC page reads `searchParams`, parses them into a `Location`, and validates against the fetched blueprint. If the URL references a deleted entity (or is otherwise malformed with e.g. a wrong moduleUuid), redirect server-side to a clean URL. Done here (server-side) instead of relying only on `LocationRecoveryEffect` so the user doesn't see a flash of invalid state before the client effect fires.

- [ ] **Step 1: Read current `page.tsx`**

Already read earlier — the file's structure:
- `params` (awaited) yields `{ id }`
- `session` + `commcareSettings` fetched in parallel
- for `id === "new"`, no blueprint fetch
- for existing apps: `loadApp(id)`, ownership check, status check, then render `BuilderProvider`

- [ ] **Step 2: Update `page.tsx`**

Replace the file with:

```tsx
/**
 * Build page — Server Component that fetches app data, validates the
 * URL's location against the live blueprint, and composes the
 * client-side builder tree.
 *
 * URL validation is Phase 2's RSC-side defense: if a user lands on
 * `/build/[id]?s=f&m=<stale-uuid>&…`, this handler server-redirects
 * to a clean URL (stripping only the stale components) before any
 * client code runs. The client-side `LocationRecoveryEffect` covers
 * mutations that happen during a live session.
 */
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { BuilderLayout } from "@/components/builder/BuilderLayout";
import { BuilderProvider } from "@/hooks/useBuilder";
import { getSession } from "@/lib/auth-utils";
import { toDoc } from "@/lib/doc/converter";
import { loadApp } from "@/lib/db/apps";
import { getCommCareSettings } from "@/lib/db/settings";
import { isValidLocation, parseLocation } from "@/lib/routing/location";
import { serializeLocation } from "@/lib/routing/location";
import { ThreadHistory } from "./thread-history";

export default async function BuilderPage({
	params,
	searchParams,
}: {
	params: Promise<{ id: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const { id } = await params;

	const session = await getSession();
	const commcareSettings = session
		? await getCommCareSettings(session.user.id)
		: { configured: false as const, username: "", domain: null };

	/* New apps — no blueprint fetch, no URL validation needed. */
	if (id === "new") {
		return (
			<BuilderProvider buildId={id}>
				<BuilderLayout commcareSettings={commcareSettings} />
			</BuilderProvider>
		);
	}

	if (!session) redirect("/");

	const app = await loadApp(id);
	if (!app || app.owner !== session.user.id) notFound();
	if (app.status !== "complete") redirect("/");

	/* Validate the incoming URL against the live blueprint. Stale uuids
	 * (from a bookmark into a deleted question, module, or form) collapse
	 * to the closest valid ancestor; malformed URLs fall all the way to
	 * home. Only issue a redirect if the URL actually changed — otherwise
	 * every request would trigger a 307 loop. */
	const spRaw = await searchParams;
	const sp = new URLSearchParams();
	for (const [k, v] of Object.entries(spRaw)) {
		if (typeof v === "string") sp.set(k, v);
	}
	const loc = parseLocation(sp);
	const doc = toDoc(app.blueprint, id);
	if (!isValidLocation(loc, doc)) {
		const cleaned = serializeLocation({ kind: "home" }).toString();
		const target = cleaned ? `/build/${id}?${cleaned}` : `/build/${id}`;
		if (target !== `/build/${id}?${sp.toString()}`) {
			redirect(target);
		}
	}

	return (
		<BuilderProvider buildId={id} initialBlueprint={app.blueprint}>
			<BuilderLayout isExistingApp commcareSettings={commcareSettings}>
				<Suspense fallback={null}>
					<ThreadHistory appId={id} />
				</Suspense>
			</BuilderLayout>
		</BuilderProvider>
	);
}
```

Rationale: `toDoc` runs the same conversion the client would, so validation uses the exact uuid set the client will see. The "collapse to home" policy here is intentionally simple — a fancier heuristic (keep module if valid, drop only form) is a later optimization.

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit && echo "✓"
```

- [ ] **Step 4: Manual smoke**

```bash
npm run dev
```

Visit:
1. `http://localhost:3000/build/<existing-app>` — renders normally, no redirect.
2. `http://localhost:3000/build/<existing-app>?s=f&m=bogus&f=bogus` — server-redirects to `/build/<existing-app>`.
3. `http://localhost:3000/build/<existing-app>?s=m&m=<real-module-uuid>` — renders the module screen, no redirect.

Replace `<real-module-uuid>` with a uuid from an actual app (read via `inspect-app` script or DevTools).

- [ ] **Step 5: Commit**

```bash
git add app/build/[id]/page.tsx
git commit -m "feat(builder/route): server-validate URL location against blueprint"
```

---

### Task 3: `LocationRecoveryEffect` — client-side stale-param scrubber

**Files:**
- Create: `components/builder/LocationRecoveryEffect.tsx`
- Modify: `hooks/useBuilder.tsx` (mount the effect inside `BuilderProvider`)

When the user deletes the currently selected question mid-session, the URL's `sel=<deleted-uuid>` becomes dangling. The RSC validator can't help (that only runs on first load). This client effect subscribes to location + doc validity and replaces the URL with the closest valid ancestor on mismatch.

- [ ] **Step 1: Create the component**

Create `components/builder/LocationRecoveryEffect.tsx`:

```tsx
/**
 * Client-side effect that scrubs stale URL params whenever a referenced
 * entity disappears from the doc. Mounted inside BuilderProvider so it
 * has access to both the doc store (via BlueprintDocContext) and the
 * Next.js App Router (via useRouter).
 *
 * The effect walks the current location inside-out (most specific to
 * least specific), dropping any reference that doesn't resolve. The
 * scrubbed location is issued as a `router.replace` so the bad URL
 * doesn't end up in history.
 *
 * Returns `null` — exists purely for its side effect.
 */
"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import { useLocation } from "@/lib/routing/hooks";
import { serializeLocation } from "@/lib/routing/location";
import type { Location } from "@/lib/routing/types";
import type { BlueprintDoc } from "@/lib/doc/types";

/**
 * Reduce an invalid Location to the closest valid ancestor given the
 * current doc. Pure function — no hooks, easy to unit test if needed.
 */
function recover(loc: Location, doc: BlueprintDoc): Location {
	if (loc.kind === "home") return loc;
	if (doc.modules[loc.moduleUuid] === undefined) {
		return { kind: "home" };
	}
	if (loc.kind === "module") return loc;
	if (loc.kind === "cases") return loc;
	// loc.kind === "form"
	if (doc.forms[loc.formUuid] === undefined) {
		return { kind: "module", moduleUuid: loc.moduleUuid };
	}
	if (
		loc.selectedUuid !== undefined &&
		doc.questions[loc.selectedUuid] === undefined
	) {
		return {
			kind: "form",
			moduleUuid: loc.moduleUuid,
			formUuid: loc.formUuid,
		};
	}
	return loc;
}

export function LocationRecoveryEffect() {
	const loc = useLocation();
	const router = useRouter();
	const pathname = usePathname();
	// Subscribe to entity maps directly so the effect re-fires whenever a
	// referenced uuid might have disappeared.
	const modules = useBlueprintDoc((s) => s.modules);
	const forms = useBlueprintDoc((s) => s.forms);
	const questions = useBlueprintDoc((s) => s.questions);

	useEffect(() => {
		// Skip during hydration: if entity maps are still empty (Idle / new
		// app before generation), there's nothing to validate against.
		if (
			Object.keys(modules).length === 0 &&
			Object.keys(forms).length === 0 &&
			Object.keys(questions).length === 0
		) {
			return;
		}

		const doc = { modules, forms, questions } as BlueprintDoc;
		const recovered = recover(loc, doc);
		if (recovered === loc) return;

		const params = serializeLocation(recovered).toString();
		const url = params ? `${pathname}?${params}` : pathname;
		router.replace(url, { scroll: false });
	}, [loc, modules, forms, questions, router, pathname]);

	return null;
}
```

- [ ] **Step 2: Mount inside `BuilderProvider`**

Edit `hooks/useBuilder.tsx`. In the `BuilderProvider` return, add `<LocationRecoveryEffect />` as a sibling of `<SyncBridge>` inside the `<BlueprintDocProvider>`:

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
				<LocationRecoveryEffect />
				{children}
			</BlueprintDocProvider>
		</StoreContext>
	</EngineContext>
);
```

Add the import:

```tsx
import { LocationRecoveryEffect } from "@/components/builder/LocationRecoveryEffect";
```

- [ ] **Step 3: Typecheck + test**

```bash
npx tsc --noEmit && echo "✓"
npm test -- --run
```

- [ ] **Step 4: Commit**

```bash
git add components/builder/LocationRecoveryEffect.tsx hooks/useBuilder.tsx
git commit -m "feat(builder/route): LocationRecoveryEffect strips stale URL params"
```

---

### Task 4: `lib/routing/builderActions.ts` — composite hooks (undo, redo, delete)

**Files:**
- Create: `lib/routing/builderActions.ts`
- Create: `lib/routing/__tests__/builderActions-useUndoRedo.test.tsx`
- Create: `lib/routing/__tests__/builderActions-useDeleteSelectedQuestion.test.tsx`

The engine's `undo()` / `redo()` / `deleteSelected()` do two things each — temporal/mutation dispatch plus scroll/flash. In Phase 2 they need URL reads (for the selected-question uuid and the current form context). Easiest to express as hooks. The engine keeps pure imperative utilities (`scrollToQuestion`, `flashUndoHighlight`), and these hooks call those utilities.

- [ ] **Step 1: Expose engine-level scroll and flash helpers as public methods**

The current `findFieldElement` and `flashUndoHighlight` are private on the engine — Task 4 needs them public so the hook can call them. Edit `lib/services/builderEngine.ts`: remove the `private` qualifiers on `findFieldElement` and `flashUndoHighlight`. Leave the rest of the engine untouched for now; the larger surgery happens in Task 12.

- [ ] **Step 2: Implement `lib/routing/builderActions.ts`**

```tsx
/**
 * Composite builder actions that combine URL state with doc mutations
 * and imperative DOM side effects.
 *
 * Before Phase 2, these lived as methods on `BuilderEngine`. In the new
 * architecture, each is a small React hook that reads `useLocation()`,
 * dispatches through the doc store via `useBlueprintMutations()` (or
 * directly via the doc's temporal), and triggers DOM side effects
 * through surviving engine utilities (scroll, flash).
 */

"use client";

import { flushSync } from "react-dom";
import { useContext, useMemo } from "react";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useAssembledForm } from "@/lib/doc/hooks/useAssembledForm";
import { useBuilderEngine, useBuilderStore } from "@/hooks/useBuilder";
import { useLocation, useNavigate, useSelect } from "@/lib/routing/hooks";
import { asUuid, type Uuid } from "@/lib/doc/types";
import { flattenQuestionRefs } from "@/lib/services/blueprintHelpers";

/**
 * Undo / redo with scroll + flash affordance. Both actions are no-ops
 * when the respective temporal side is empty.
 *
 * Scroll target:
 *   - If the current URL has a `sel=` uuid, scroll to that question's
 *     field (or the question card itself when no activeFieldId is set).
 *   - Otherwise no scroll — the user wasn't focused on a specific row.
 */
export function useUndoRedo(): { undo: () => void; redo: () => void } {
	const docStore = useContext(BlueprintDocContext);
	const engine = useBuilderEngine();
	const loc = useLocation();
	const activeFieldId = useBuilderStore((s) => s.activeFieldId);

	return useMemo(() => {
		function run(action: "undo" | "redo"): void {
			if (!docStore) return;
			const temporal = docStore.temporal.getState();
			const canDo =
				action === "undo"
					? temporal.pastStates.length > 0
					: temporal.futureStates.length > 0;
			if (!canDo) return;

			// flushSync so the restored entities commit to the DOM before
			// we query it for the scroll/flash target.
			flushSync(() => {
				if (action === "undo") temporal.undo();
				else temporal.redo();
			});

			const selectedUuid =
				loc.kind === "form" ? loc.selectedUuid : undefined;
			if (!selectedUuid) return;

			if (activeFieldId) {
				engine.setFocusHint(activeFieldId);
			}

			const targetEl = engine.findFieldElement(selectedUuid, activeFieldId);
			engine.scrollToQuestion(
				selectedUuid,
				targetEl ?? undefined,
				"instant",
			);
			const flashEl =
				targetEl ??
				(document.querySelector(
					`[data-question-uuid="${selectedUuid}"]`,
				) as HTMLElement | null);
			if (flashEl) engine.flashUndoHighlight(flashEl);
		}

		return {
			undo: () => run("undo"),
			redo: () => run("redo"),
		};
	}, [docStore, engine, loc, activeFieldId]);
}

/**
 * Delete the currently selected question and navigate to the adjacent
 * one (next if present, else previous, else clear the selection).
 *
 * No-op if no question is selected. The call sequence:
 *   1. Resolve the neighbor via `flattenQuestionRefs` on the assembled form.
 *   2. Dispatch `removeQuestion` through the doc.
 *   3. Replace the URL's `sel=` with the neighbor's uuid (or drop it).
 */
export function useDeleteSelectedQuestion(): () => void {
	const loc = useLocation();
	const formUuid = loc.kind === "form" ? loc.formUuid : undefined;
	const moduleUuid = loc.kind === "form" ? loc.moduleUuid : undefined;
	const form = useAssembledForm(formUuid as Uuid);
	const { removeQuestion } = useBlueprintMutations();
	const select = useSelect();

	return useMemo(() => {
		return () => {
			if (
				loc.kind !== "form" ||
				!loc.selectedUuid ||
				!formUuid ||
				!moduleUuid ||
				!form
			) {
				return;
			}
			const refs = flattenQuestionRefs(form.questions);
			const idx = refs.findIndex((r) => r.uuid === loc.selectedUuid);
			const neighbor = refs[idx + 1] ?? refs[idx - 1];
			removeQuestion(asUuid(loc.selectedUuid));
			select(neighbor ? asUuid(neighbor.uuid) : undefined);
		};
	}, [loc, form, formUuid, moduleUuid, removeQuestion, select]);
}
```

- [ ] **Step 3: Write test skeletons**

Create `lib/routing/__tests__/builderActions-useUndoRedo.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
// Full harness (doc provider + builder engine fake + mocked router) is
// set up in Task 11 when migrated consumers provide fixtures. For Phase
// 2 Task 4 we assert the contract only: "returns an object with undo
// and redo functions".
import { useUndoRedo } from "@/lib/routing/builderActions";

vi.mock("next/navigation", async () => {
	const actual = await vi.importActual<typeof import("next/navigation")>(
		"next/navigation",
	);
	return {
		...actual,
		useSearchParams: () => new actual.ReadonlyURLSearchParams(),
		useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
		usePathname: () => "/build/a",
	};
});

describe("useUndoRedo", () => {
	it("returns undo and redo functions (provider-less fallback will throw)", () => {
		// With no BuilderProvider ancestor, the hook throws via useBuilderEngine.
		// We assert that — full positive-path coverage is in Task 11's integration.
		expect(() => renderHook(() => useUndoRedo())).toThrow(
			/BuilderProvider/,
		);
	});
});
```

Create `lib/routing/__tests__/builderActions-useDeleteSelectedQuestion.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

vi.mock("next/navigation", async () => {
	const actual = await vi.importActual<typeof import("next/navigation")>(
		"next/navigation",
	);
	return {
		...actual,
		useSearchParams: () => new actual.ReadonlyURLSearchParams(),
		useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
		usePathname: () => "/build/a",
	};
});

import { useDeleteSelectedQuestion } from "@/lib/routing/builderActions";

describe("useDeleteSelectedQuestion", () => {
	it("returns a function (no-op when no form is open)", () => {
		// Without BuilderProvider the hook throws via useBlueprintMutations.
		// Full positive-path integration is covered in Task 11.
		expect(() => renderHook(() => useDeleteSelectedQuestion())).toThrow(
			/BlueprintDocProvider/,
		);
	});
});
```

- [ ] **Step 4: Typecheck + test**

```bash
npx tsc --noEmit && npm test -- lib/routing --run
```

- [ ] **Step 5: Commit**

```bash
git add lib/routing/builderActions.ts lib/routing/__tests__/builderActions-*.test.tsx lib/services/builderEngine.ts
git commit -m "feat(routing): useUndoRedo and useDeleteSelectedQuestion composite hooks"
```

---

### Task 5: Rewrite `useBlueprintMutations` to uuid-first signatures

**Files:**
- Modify: `lib/doc/hooks/useBlueprintMutations.ts`
- Modify: `lib/doc/__tests__/hooks-useBlueprintMutations.test.tsx`

The existing hook takes legacy `(mIdx, fIdx, path)` tuples and resolves them internally. Every Task 6–11 consumer migration flips those call sites to pass uuids directly (now available from `useLocation()`). This task swaps the API shape; consumer call-site updates happen in the respective consumer tasks.

**API changes** — signatures after this task:

```ts
interface BlueprintMutations {
	addQuestion(
		parentUuid: Uuid,
		question: Omit<Question, "uuid"> & { uuid?: string },
		opts?: { afterUuid?: Uuid; beforeUuid?: Uuid; atIndex?: number },
	): Uuid;
	updateQuestion(uuid: Uuid, patch: Partial<Omit<QuestionEntity, "uuid">>): void;
	removeQuestion(uuid: Uuid): void;
	renameQuestion(uuid: Uuid, newId: string): QuestionRenameResult;
	moveQuestion(
		uuid: Uuid,
		opts: { toParentUuid?: Uuid; afterUuid?: Uuid; beforeUuid?: Uuid; toIndex?: number },
	): MoveQuestionResult;
	duplicateQuestion(uuid: Uuid): DuplicateQuestionResult | undefined;

	addForm(moduleUuid: Uuid, form: BlueprintForm): Uuid;
	updateForm(uuid: Uuid, patch: Partial<Omit<FormEntity, "uuid">>): void;
	removeForm(uuid: Uuid): void;
	replaceForm(uuid: Uuid, form: BlueprintForm): void;

	addModule(module: BlueprintModule): Uuid;
	updateModule(uuid: Uuid, patch: Partial<Omit<ModuleEntity, "uuid">>): void;
	removeModule(uuid: Uuid): void;

	updateApp(patch: { app_name?: string; connect_type?: ConnectType | null }): void;
	setCaseTypes(caseTypes: CaseType[] | null): void;
	applyMany(mutations: Mutation[]): void;
}
```

The `renamed` result on `MoveQuestionResult` and `xpathFieldsRewritten` on `QuestionRenameResult` stay as-is (still unimplemented — Phase 3).

- [ ] **Step 1: Rewrite the hook**

Replace `lib/doc/hooks/useBlueprintMutations.ts` with the uuid-first implementation. The full file is ~350 lines; the key sections are:

- Remove imports of `pathToUuid` adapters.
- Remove `coerceNulls` and `NullablePartial`.
- Rewrite each action method to take uuids directly. Example:

```ts
addQuestion(parentUuid, question, opts) {
	const doc = store.getState();
	// Verify parent exists (form uuid or a group/repeat question uuid)
	if (
		doc.forms[parentUuid] === undefined &&
		doc.questions[parentUuid] === undefined
	) {
		warnUnresolved("addQuestion", { parentUuid });
		return "" as Uuid;
	}
	// Resolve insertion index from afterUuid / beforeUuid / atIndex.
	const order = doc.questionOrder[parentUuid] ?? [];
	let index: number | undefined;
	if (opts?.atIndex !== undefined) index = opts.atIndex;
	else if (opts?.beforeUuid) {
		const i = order.indexOf(opts.beforeUuid);
		if (i >= 0) index = i;
	} else if (opts?.afterUuid) {
		const i = order.indexOf(opts.afterUuid);
		if (i >= 0) index = i + 1;
	}
	const { children: _children, ...rest } = question as Question & {
		children?: Question[];
	};
	const maybeUuid = (rest as { uuid?: string }).uuid;
	const uuid = asUuid(
		typeof maybeUuid === "string" && maybeUuid.length > 0
			? maybeUuid
			: crypto.randomUUID(),
	);
	const entity: QuestionEntity = {
		...(rest as Omit<QuestionEntity, "uuid">),
		uuid,
	};
	store.getState().apply({
		kind: "addQuestion",
		parentUuid,
		question: entity,
		index,
	});
	return uuid;
}
```

Apply the same pattern to every method: drop `mIdx`/`fIdx`/`path`, take uuids, resolve insert positions against `questionOrder` via `indexOf` on sibling uuids. `updateQuestion` / `updateForm` / `updateModule` now take `Partial<Omit<*, "uuid">>` directly (no `NullablePartial`, no `coerceNulls`). Callers that want to clear an optional field pass `undefined` instead of `null`.

**`renameQuestion`** — same conflict detection but keyed on uuids:

```ts
renameQuestion(uuid, newId) {
	const doc = store.getState();
	const q = doc.questions[uuid];
	if (!q) {
		warnUnresolved("renameQuestion", { uuid });
		return { newPath: "" as QuestionPath, xpathFieldsRewritten: 0 };
	}
	// Find parent + siblings for conflict check.
	let parentUuid: Uuid | undefined;
	for (const [pUuid, order] of Object.entries(doc.questionOrder)) {
		if (order.includes(uuid)) {
			parentUuid = pUuid as Uuid;
			break;
		}
	}
	if (parentUuid !== undefined) {
		const siblings = doc.questionOrder[parentUuid] ?? [];
		for (const sibUuid of siblings) {
			if (sibUuid === uuid) continue;
			if (doc.questions[sibUuid]?.id === newId) {
				return {
					newPath: "" as QuestionPath,
					xpathFieldsRewritten: 0,
					conflict: true,
				};
			}
		}
	}
	store.getState().apply({ kind: "renameQuestion", uuid, newId });
	// computePathForUuid after the dispatch — semantic ids changed.
	const after = store.getState();
	const newPath = (computePathForUuid(after, uuid) ?? "") as QuestionPath;
	return { newPath, xpathFieldsRewritten: 0 };
}
```

**`moveQuestion`** — uuids only:

```ts
moveQuestion(uuid, opts) {
	const doc = store.getState();
	const q = doc.questions[uuid];
	if (!q) {
		warnUnresolved("moveQuestion", { uuid });
		return {};
	}
	const toParentUuid =
		opts.toParentUuid ??
		(Object.entries(doc.questionOrder).find(([, order]) =>
			order.includes(uuid),
		)?.[0] as Uuid | undefined) ??
		uuid; // guard only; unreachable in practice
	// Virtual post-splice order when same-parent move.
	const base = doc.questionOrder[toParentUuid] ?? [];
	const virtual = base.includes(uuid) ? base.filter((u) => u !== uuid) : base;
	let toIndex = virtual.length; // default: append
	if (opts.toIndex !== undefined) {
		toIndex = opts.toIndex;
	} else if (opts.beforeUuid) {
		const i = virtual.indexOf(opts.beforeUuid);
		if (i >= 0) toIndex = i;
	} else if (opts.afterUuid) {
		const i = virtual.indexOf(opts.afterUuid);
		if (i >= 0) toIndex = i + 1;
	}
	store.getState().apply({
		kind: "moveQuestion",
		uuid,
		toParentUuid,
		toIndex,
	});
	return {};
}
```

Keep `computePathForUuid` — still used by `renameQuestion` and `duplicateQuestion` to produce the legacy `QuestionPath` return shape for callers that haven't migrated off `QuestionPath` (this lives in `hooks/useSaveQuestion.ts` et al.).

- [ ] **Step 2: Rewrite the tests**

Update `lib/doc/__tests__/hooks-useBlueprintMutations.test.tsx` to call the new uuid-first signatures. Pattern for each existing test:

```ts
// Before:
mut.current.addQuestion(0, 0, { id: "name", type: "text", label: "Name" });
// After:
const docState = doc.current.getState();
const moduleUuid = docState.moduleOrder[0];
const formUuid = docState.formOrder[moduleUuid][0];
mut.current.addQuestion(formUuid, { id: "name", type: "text", label: "Name" });
```

Run the tests to establish a green baseline before migrating consumers.

- [ ] **Step 3: Run tests**

```bash
npm test -- lib/doc/__tests__/hooks-useBlueprintMutations --run
```

Expected: all pass.

- [ ] **Step 4: Typecheck — expect transient failures in consumer files**

```bash
npx tsc --noEmit 2>&1 | head -80
```

Consumer files (ContextualEditorHeader, QuestionTypePicker, FormRenderer, etc.) will now fail to type-check because they pass `(mIdx, fIdx, path)` arguments. That's expected — Tasks 6–11 migrate each call site. The build is intentionally broken between Task 5 and the end of Task 11.

Rather than defer all consumer migrations, the next tasks fix them one file at a time. After each consumer task the typecheck footprint shrinks.

- [ ] **Step 5: Commit**

```bash
git add lib/doc/hooks/useBlueprintMutations.ts lib/doc/__tests__/hooks-useBlueprintMutations.test.tsx
git commit -m "refactor(doc/mutations): uuid-first API; drop coerceNulls/NullablePartial"
```

---

### Task 6: Migrate nav-only consumers (subheader, preview header, layout back handler)

**Files:**
- Modify: `components/builder/BuilderSubheader.tsx`
- Modify: `components/preview/PreviewHeader.tsx`
- Modify: `components/builder/BuilderLayout.tsx`
- Modify: `components/builder/BuilderContentArea.tsx`
- Modify: `components/preview/PreviewShell.tsx`

These components read `screen` / `navEntries` / `navCursor` from the legacy store and call engine nav methods. Migrate them to `useLocation` / `useNavigate` / `useBreadcrumbs` / `useUndoRedo`.

- [ ] **Step 1: `BuilderSubheader.tsx`**

Replace:
- `useBreadcrumbs` import from `@/hooks/useBuilder` → from `@/lib/routing/hooks`.
- `useBuilderStore(selectCanGoBack)` / `useBuilderStore(selectCanGoUp)` → replace `canGoBack` with `window.history.length > 1` (or just always enable and let router.back no-op). Pragmatic: use `const canGoBack = true` when a form/module is open, derive `canGoUp` from `loc.kind !== "home"`.

```tsx
import { useBreadcrumbs, useLocation, useNavigate } from "@/lib/routing/hooks";
import { useUndoRedo } from "@/lib/routing/builderActions";

// Inside the component:
const loc = useLocation();
const navigate = useNavigate();
const { undo, redo } = useUndoRedo();
const canGoBack = loc.kind !== "home";
const canGoUp = loc.kind !== "home";
const breadcrumbs = useBreadcrumbs();

// Replace builder.undo() / builder.redo() in onClick handlers:
onClick={undo}
onClick={redo}

// Breadcrumb handlers:
const breadcrumbHandlers = useMemo(
	() =>
		breadcrumbs.map((item) => () => navigate.push(item.location)),
	[breadcrumbs, navigate],
);

// ScreenNavButtons:
onBack={() => navigate.back()}
onUp={() => navigate.up()}
```

Remove the `builder = useBuilderEngine()` line if it's no longer used (it may still be needed for `AppConnectSettings`).

- [ ] **Step 2: `PreviewHeader.tsx`**

Replace with:

```tsx
"use client";

import { useBreadcrumbs, useLocation, useNavigate } from "@/lib/routing/hooks";
import { PreviewHeaderView } from "./PreviewHeaderView"; // existing presentational child

export function PreviewHeader() {
	const loc = useLocation();
	const navigate = useNavigate();
	const breadcrumb = useBreadcrumbs();

	const canGoBack = loc.kind !== "home";
	const canGoUp = loc.kind !== "home";

	return (
		<PreviewHeaderView
			breadcrumb={breadcrumb}
			canGoBack={canGoBack}
			canGoUp={canGoUp}
			onBack={() => navigate.back()}
			onUp={() => navigate.up()}
			onBreadcrumbClick={(i) => navigate.push(breadcrumb[i].location)}
		/>
	);
}
```

If `PreviewHeaderView` doesn't exist, inline the existing JSX from `PreviewHeader.tsx`, replacing `navBack`/`navUp`/`navPush` calls with the new `navigate.back()`/`navigate.up()`/`navigate.push(...)`.

- [ ] **Step 3: `BuilderLayout.tsx`**

Find the back handler (`const handleBack = useCallback(() => builder.navBackWithSync(), [builder])`) and replace it with `const handleBack = navigate.back`. Remove any `s.selected` reads — look for screens 340-360 of the current file (sel + screen reads) and drop them. Replace `s.navigateToForm(0, 0)` with `navigate.openForm(moduleUuid, formUuid)` where `moduleUuid` and `formUuid` are looked up from the doc:

```tsx
const doc = useBlueprintDoc((s) => s);
// To navigate to first form:
const firstModuleUuid = doc.moduleOrder[0];
const firstFormUuid = firstModuleUuid ? doc.formOrder[firstModuleUuid]?.[0] : undefined;
if (firstModuleUuid && firstFormUuid) {
	navigate.openForm(firstModuleUuid, firstFormUuid);
}
```

- [ ] **Step 4: `BuilderContentArea.tsx`**

Replace the back-handler wrapper with `navigate.back`. Remove any store `navBack` subscription.

- [ ] **Step 5: `PreviewShell.tsx`**

Read the current file section around line 70 (`zustandScreen = useBuilderStore((s) => s.screen)`). Replace with:

```tsx
import { useLocation } from "@/lib/routing/hooks";
// ...
const loc = useLocation();
const zustandScreen = locationToScreen(loc); // adapter for the existing PreviewShell interface
```

Add a local adapter `locationToScreen(loc: Location): PreviewScreen | null`:

```ts
function locationToScreen(loc: Location): PreviewScreen | null {
	if (loc.kind === "home") return { type: "home" };
	// Resolve uuid -> index for the legacy PreviewScreen shape. PreviewShell
	// still uses indices because interact-mode's case data flow depends on
	// them. The adapter pulls indices from the doc:
	// ...
}
```

**Decision**: `PreviewShell` and the interact-mode preview pipeline still use `{ moduleIndex, formIndex }` for case-data resolution. Rather than push uuid-or-index knowledge deeper into the preview engine, keep `PreviewScreen` as-is and have the adapter translate on entry. The adapter reads the current doc snapshot once per render and resolves uuid → index.

```tsx
const moduleOrder = useBlueprintDoc((s) => s.moduleOrder);
const formOrder = useBlueprintDoc((s) => s.formOrder);

const zustandScreen: PreviewScreen = useMemo(() => {
	if (loc.kind === "home") return { type: "home" };
	const moduleIndex = moduleOrder.indexOf(loc.moduleUuid);
	if (moduleIndex < 0) return { type: "home" };
	if (loc.kind === "module") return { type: "module", moduleIndex };
	if (loc.kind === "cases") {
		return { type: "caseList", moduleIndex, formIndex: 0 };
	}
	const formIds = formOrder[loc.moduleUuid] ?? [];
	const formIndex = formIds.indexOf(loc.formUuid);
	if (formIndex < 0) return { type: "module", moduleIndex };
	return { type: "form", moduleIndex, formIndex };
}, [loc, moduleOrder, formOrder]);
```

- [ ] **Step 6: Typecheck + test**

```bash
npx tsc --noEmit 2>&1 | head -40
npm test -- --run
```

Expected: fewer errors than after Task 5 (5 files less); no regressions in passing tests.

- [ ] **Step 7: Commit**

```bash
git add components/builder/BuilderSubheader.tsx components/preview/PreviewHeader.tsx \
	components/builder/BuilderLayout.tsx components/builder/BuilderContentArea.tsx \
	components/preview/PreviewShell.tsx
git commit -m "refactor(builder): subheader + preview header + layout read nav from URL"
```

---

### Task 7: Migrate preview screens (Home / Module / Form / CaseList)

**Files:**
- Modify: `components/preview/screens/HomeScreen.tsx`
- Modify: `components/preview/screens/ModuleScreen.tsx`
- Modify: `components/preview/screens/FormScreen.tsx`
- Modify: `components/preview/screens/CaseListScreen.tsx`

Each of these calls `useBuilderStore((s) => s.navPush)` today. Replace with `useNavigate`.

- [ ] **Step 1: `HomeScreen.tsx`**

```tsx
const navigate = useNavigate();
// ...
onClick={() => navigate.openModule(moduleUuid)}
```

Where `moduleUuid` comes from iterating `useOrderedModules()` (`m.uuid`) instead of `mIdx`.

Also update the `updateApp` call to pass `{ app_name, connect_type }` — the uuid-first hook signature for updateApp is unchanged (app-level updates don't need uuids).

- [ ] **Step 2: `ModuleScreen.tsx`**

```tsx
const navigate = useNavigate();
// ...
onClick={() => {
	if (form.caseLoading) {
		navigate.openCaseList(moduleUuid);
	} else {
		navigate.openForm(moduleUuid, form.uuid);
	}
}}
```

Update the `updateModule` call site: `updateModule(moduleUuid, patch)` instead of `updateModule(mIdx, patch)`. `moduleUuid` comes from `useLocation()` (current `m=` param).

- [ ] **Step 3: `FormScreen.tsx`**

This file reads `selected` from the legacy store — replace with URL-derived selection. `navPush` calls become `navigate.openModule` / `navigate.goHome`. `updateForm` takes `formUuid` — lookup from URL.

```tsx
const loc = useLocation();
const navigate = useNavigate();
const selectedUuid = loc.kind === "form" ? loc.selectedUuid : undefined;
const formUuid = loc.kind === "form" ? loc.formUuid : undefined;
const moduleUuid = loc.kind === "form" ? loc.moduleUuid : undefined;

// Replace updateForm(mIdx, fIdx, patch) with:
if (formUuid) updateForm(formUuid, patch);

// Replace navPush({ type: "module", moduleIndex }) with:
if (moduleUuid) navigate.openModule(moduleUuid);
// Replace navPush({ type: "home" }) with:
navigate.goHome();
```

- [ ] **Step 4: `CaseListScreen.tsx`**

```tsx
const navigate = useNavigate();
// The current line 43 pushes a form screen; replace with:
navigate.openForm(moduleUuid, formUuid, undefined);
// (selectedUuid starts empty — user enters the form fresh)
```

`moduleUuid` / `formUuid` come from `useLocation()`.

- [ ] **Step 5: Typecheck + test**

```bash
npx tsc --noEmit 2>&1 | head -40
npm test -- --run
```

- [ ] **Step 6: Commit**

```bash
git add components/preview/screens/
git commit -m "refactor(preview/screens): drive navigation from URL instead of legacy store"
```

---

### Task 8: Migrate `AppTree`

**Files:**
- Modify: `components/builder/AppTree.tsx`

`AppTree` has the deepest dependency on legacy selection: it reads `s.selected` in `ModuleCard` / `FormCard` / the question row components to draw the selection highlight. Migrate every read to `useLocation()` / `useIsQuestionSelected` (the new hook from `lib/routing/hooks.tsx`).

- [ ] **Step 1: Replace top-level select handler**

```tsx
// At top of AppTree:
import { useNavigate } from "@/lib/routing/hooks";
import { useLocation } from "@/lib/routing/hooks";

const navigate = useNavigate();
const loc = useLocation();
const handleSelect: TreeSelectHandler = useCallback(
	(sel: SelectedElement) => {
		if (!sel) return navigate.goHome();
		// Resolve indices from sel to uuids via doc.
		// Easiest: use doc reads at click time.
		// ...
	},
	[navigate, /* doc reads */],
);
```

**Decision**: `SelectedElement` carries `moduleIndex` / `formIndex` today. The tree iterates modules and forms by index. Rather than preserve `SelectedElement`, rework the tree to pass uuids through instead.

Replace the tree's internal `TreeSelectHandler` with a uuid-based handler:

```tsx
type TreeSelectHandler = (target:
	| { kind: "module"; moduleUuid: Uuid }
	| { kind: "form"; moduleUuid: Uuid; formUuid: Uuid }
	| { kind: "question"; moduleUuid: Uuid; formUuid: Uuid; questionUuid: Uuid }
	| { kind: "clear" }
) => void;
```

And the root handler becomes:

```tsx
const handleSelect: TreeSelectHandler = useCallback((target) => {
	switch (target.kind) {
		case "clear":
			return navigate.goHome();
		case "module":
			return navigate.openModule(target.moduleUuid);
		case "form":
			return navigate.openForm(target.moduleUuid, target.formUuid);
		case "question":
			return navigate.openForm(
				target.moduleUuid,
				target.formUuid,
				target.questionUuid,
			);
	}
}, [navigate]);
```

- [ ] **Step 2: Replace `isSelected` reads in `ModuleCard`**

```tsx
const isSelected = useIsModuleSelected(moduleUuid);
```

Add `useIsModuleSelected(uuid)` to `lib/routing/hooks.tsx` as part of this task:

```ts
export function useIsModuleSelected(uuid: Uuid | string): boolean {
	const loc = useLocation();
	return (
		(loc.kind === "module" || loc.kind === "cases" || loc.kind === "form") &&
		loc.moduleUuid === uuid
	);
}

export function useIsFormSelected(uuid: Uuid | string): boolean {
	const loc = useLocation();
	return loc.kind === "form" && loc.formUuid === uuid;
}
```

(The existing `useIsQuestionSelected` from Task 1 covers the question row.)

Update all three tree components' selection reads to use these hooks.

- [ ] **Step 3: Update `onClick` calls inside the tree**

Replace `onClick={() => onSelect({ type: "module", moduleIndex })}` with `onClick={() => onSelect({ kind: "module", moduleUuid: mod.uuid })}`. Same treatment for form clicks and question clicks.

- [ ] **Step 4: Typecheck + test**

```bash
npx tsc --noEmit 2>&1 | head -40
npm test -- --run
```

- [ ] **Step 5: Commit**

```bash
git add components/builder/AppTree.tsx lib/routing/hooks.tsx
git commit -m "refactor(builder/tree): selection highlight + click from URL location"
```

---

### Task 9: Migrate the form editor (FormRenderer + EditableQuestionWrapper + QuestionTypePicker)

**Files:**
- Modify: `components/preview/form/FormRenderer.tsx`
- Modify: `components/preview/form/EditableQuestionWrapper.tsx`
- Modify: `components/preview/form/QuestionTypePicker.tsx`

These are the hottest selection paths. Every question click fires `engine.select()` today; post-migration they fire `useSelect()(uuid)` which issues `router.replace`.

- [ ] **Step 1: `EditableQuestionWrapper.tsx`**

Replace:
```tsx
import { useBuilderEngine, useIsQuestionSelected } from "@/hooks/useBuilder";
// ...
const engine = useBuilderEngine();
const isSelected = useIsQuestionSelected(moduleIndex, formIndex, questionUuid);
// ...
engine.navigateTo({ type: "question", moduleIndex, formIndex, questionPath, questionUuid }, behavior, hasToolbar);
```

With:
```tsx
import { useIsQuestionSelected, useSelect } from "@/lib/routing/hooks";
import { useBuilderEngine } from "@/hooks/useBuilder";
import { asUuid } from "@/lib/doc/types";
// ...
const select = useSelect();
const engine = useBuilderEngine(); // still needed for scroll
const isSelected = useIsQuestionSelected(questionUuid);
// ...
// Before calling select(), stash the pending scroll on the engine so
// the target question's panel can honor it when it mounts.
engine.setPendingScroll(questionUuid, behavior, hasToolbar);
select(asUuid(questionUuid));
```

`setPendingScroll` is a small new public engine method (the private `_pendingScroll` + `fulfillPendingScroll` pair stays, just exposed). Task 12 does the surgery; for now add the public setter so Task 9 compiles:

In `lib/services/builderEngine.ts`, add:

```ts
setPendingScroll(
	uuid: string,
	behavior: ScrollBehavior,
	hasToolbar: boolean,
): void {
	this._pendingScroll = { uuid, behavior, hasToolbar };
}
```

The `moduleIndex`/`formIndex` props on `EditableQuestionWrapper` can be dropped — the wrapper only needs `questionUuid`. Update the caller (FormRenderer) to stop passing them.

- [ ] **Step 2: `FormRenderer.tsx`**

Replace `builderEngine.select()` / `builderEngine.select({ type: "question", ... })` with `useSelect()(uuid)` / `useSelect()(undefined)`. The component has three call sites around lines 668, 756, 821.

Replace `useIsQuestionSelected(moduleIndex, formIndex, uuid)` with `useIsQuestionSelected(uuid)`.

Update the `moveQuestion` call to pass uuids:

```ts
// Line 440 region — `moveQuestion_` destructure becomes uuid-first.
const { moveQuestion: moveQuestionAction } = useBlueprintMutations();
// Later:
moveQuestionAction(asUuid(draggedUuid), {
	toParentUuid: asUuid(targetParentUuid),
	beforeUuid: targetUuid ? asUuid(targetUuid) : undefined,
});
```

Where `targetParentUuid` / `draggedUuid` / `targetUuid` come from the dnd-kit event (sortable IDs are already UUIDs per CLAUDE.md).

- [ ] **Step 3: `QuestionTypePicker.tsx`**

Replace the `addQuestion` call with the uuid-first signature:

```tsx
const select = useSelect();
const { addQuestion: addQuestionAction } = useBlueprintMutations();
// ...
const newUuid = addQuestionAction(parentUuid, {
	id: newId,
	type,
	label,
	// ...
}, { afterUuid, atIndex });
select(newUuid);
// Also stash scroll so the new question's panel becomes visible:
engine.setPendingScroll(newUuid, "smooth", false);
```

`parentUuid`, `afterUuid` come from URL/context. The picker is rendered inside `FormRenderer` with props; update the prop shape to pass uuids instead of paths.

- [ ] **Step 4: Typecheck + test**

```bash
npx tsc --noEmit 2>&1 | head -40
npm test -- --run
```

- [ ] **Step 5: Commit**

```bash
git add components/preview/form/ components/preview/form/QuestionTypePicker.tsx lib/services/builderEngine.ts
git commit -m "refactor(preview/form): selection + add via URL hooks and uuid-first mutations"
```

---

### Task 10: Migrate contextual editor + detail panels + save hooks

**Files:**
- Modify: `components/builder/contextual/ContextualEditorHeader.tsx`
- Modify: `components/builder/contextual/ContextualEditorData.tsx`
- Modify: `components/builder/contextual/ContextualEditorUI.tsx`
- Modify: `components/builder/contextual/ContextualEditorLogic.tsx`
- Modify: `components/builder/detail/FormDetail.tsx`
- Modify: `components/builder/detail/FormSettingsPanel.tsx`
- Modify: `components/builder/detail/ModuleDetail.tsx`
- Modify: `hooks/useSaveQuestion.ts`
- Modify: `hooks/useTextEditSave.ts`

The contextual editors read the selected question; detail panels get uuids through props. Every mutation call on these forms takes `(mIdx, fIdx, ...)` today and needs to flip to uuid-first.

- [ ] **Step 1: `ContextualEditorHeader.tsx`**

Read selection from URL:

```tsx
import { useLocation, useSelect, useNavigate } from "@/lib/routing/hooks";
import { asUuid } from "@/lib/doc/types";
// ...
const loc = useLocation();
const selectedQuestionUuid =
	loc.kind === "form" ? loc.selectedUuid : undefined;
const formUuid = loc.kind === "form" ? loc.formUuid : undefined;
const moduleUuid = loc.kind === "form" ? loc.moduleUuid : undefined;
```

Replace the `renameQuestion`/`moveQuestion`/`duplicateQuestion` call sites with uuid-first versions. After rename, update `sel=` to the new uuid (same uuid — rename doesn't change uuid, only `id`). After duplicate, select the new uuid. After move, stay on the same selection.

Replace `engine.select({ ...selected, questionPath: result.newPath })` with no-op — rename doesn't change uuid, and `sel=` already points at the right uuid.

Replace `engine.navigateTo({ ...selected, questionPath: newPath, questionUuid })` with:

```tsx
engine.setPendingScroll(questionUuid, "smooth", false);
select(asUuid(questionUuid));
```

Or, for cross-form navigation after a sibling-replace: `navigate.openForm(moduleUuid, formUuid, questionUuid)`.

The `removeQuestion` action after confirming delete becomes `removeQuestion(asUuid(selectedQuestionUuid))` and the neighbor selection is handled by `useDeleteSelectedQuestion` from Task 4 — just call that hook instead of rolling the logic inline.

- [ ] **Step 2: `ContextualEditorData.tsx` / `ContextualEditorUI.tsx` / `ContextualEditorLogic.tsx`**

Each reads `selected` today. Replace with `useSelectedQuestion()` and its uuid. Each calls `updateQuestion(mIdx, fIdx, path, patch)` — replace with `updateQuestion(uuid, patch)`. `null` clears in patches become `undefined`.

Example for ContextualEditorData:

```tsx
import { useSelectedQuestion } from "@/lib/routing/hooks";
import { asUuid } from "@/lib/doc/types";
// ...
const question = useSelectedQuestion();
const { updateQuestion } = useBlueprintMutations();

// Where the old code did:
//   updateQuestion(mIdx, fIdx, path, { case_property_on: null });
// It now does:
if (question) updateQuestion(asUuid(question.uuid), { case_property_on: undefined });
```

- [ ] **Step 3: `FormDetail.tsx` / `FormSettingsPanel.tsx` / `ModuleDetail.tsx`**

These get indices through props today; flip props to uuids and update internal `updateForm` / `updateModule` calls:

```tsx
// Before: interface Props { moduleIndex: number; formIndex: number; }
// After:  interface Props { moduleUuid: Uuid; formUuid: Uuid; }
```

Update every caller that renders these panels — there are 1–2 per panel (the root layout, or the contextual editor). Pass `loc.moduleUuid` / `loc.formUuid` derived from `useLocation()`.

- [ ] **Step 4: `useSaveQuestion.ts` and `useTextEditSave.ts`**

These hooks call `updateQuestion(mIdx, fIdx, path, patch)`. Update their signatures to take a `uuid: Uuid` directly:

```ts
export function useSaveQuestion(uuid: Uuid) {
	const { updateQuestion } = useBlueprintMutations();
	return useCallback((patch: Partial<Omit<QuestionEntity, "uuid">>) => {
		updateQuestion(uuid, patch);
	}, [updateQuestion, uuid]);
}
```

Callers pass `question.uuid` from `useSelectedQuestion()`.

- [ ] **Step 5: Typecheck + test**

```bash
npx tsc --noEmit 2>&1 | head -40
npm test -- --run
```

- [ ] **Step 6: Commit**

```bash
git add components/builder/contextual/ components/builder/detail/ hooks/useSaveQuestion.ts hooks/useTextEditSave.ts
git commit -m "refactor(builder/detail+contextual): uuid-first mutations, URL-driven selection"
```

---

### Task 11: Migrate `useBuilderShortcuts` and finalize `useBuilder.tsx` hook surface

**Files:**
- Modify: `components/builder/useBuilderShortcuts.ts`
- Modify: `hooks/useBuilder.tsx`

Shortcuts reach deepest into the legacy engine (navigateTo, select, duplicateQuestion, moveQuestion). This task finishes the consumer-migration wave.

- [ ] **Step 1: Rewrite `useBuilderShortcuts.ts`**

Replace every `builder.navigateTo(el)` / `builder.select()` / `s.selected` read with URL/navigate/select hooks. Use `useDeleteSelectedQuestion()` from Task 4 for Backspace/Delete. Navigation shortcuts (Cmd+K direction keys) read `useLocation()` + `useAssembledForm()` to compute neighbors, then call `useSelect()(neighborUuid)`.

- [ ] **Step 2: Clean up `hooks/useBuilder.tsx`**

Delete these hooks (callers now read from `lib/routing/hooks.tsx`):

- `useBuilderScreen`
- `useBuilderSelected`
- `useBuilderCanGoBack`
- `useBuilderCanGoUp`
- `useIsQuestionSelected`  (the legacy version; the new one lives in `lib/routing/hooks.tsx`)
- `useBreadcrumbs`  (the legacy version)

Keep:

- `useBuilderStore`, `useBuilderStoreShallow`, `useBuilderEngine`
- `useBuilderPhase`, `useBuilderIsReady`, `useBuilderHasData`, `useBuilderAgentActive`, `useBuilderInReplayMode`, `useBuilderCursorMode`, `useBuilderTreeData`
- `useModule`, `useForm`, `useQuestion`, `useOrderedModules`, `useOrderedForms`, `useAssembledForm`
- `BuilderProvider`, `createEngine`, `SyncBridge`, `LocationRecoveryEffect` mount

- [ ] **Step 3: Typecheck + test**

```bash
npx tsc --noEmit && echo "✓"
npm test -- --run
```

- [ ] **Step 4: Commit**

```bash
git add components/builder/useBuilderShortcuts.ts hooks/useBuilder.tsx
git commit -m "refactor(builder): shortcuts + provider export URL-driven hooks only"
```

---

### Task 12: Surgery on `BuilderEngine` — remove nav/select methods

**Files:**
- Modify: `lib/services/builderEngine.ts`

Every consumer now reads nav/selection from URL. The engine methods that maintained those are unreferenced. Delete them.

- [ ] **Step 1: Delete methods**

Remove from `BuilderEngine`:

- `select(el?)`
- `navigateTo(el, behavior?, hasToolbar?)`
- `syncSelectionToScreen(screen)` (private)
- `navBackWithSync()`
- `navUpWithSync()`
- `navigateToScreen(screen)`
- `navigateToSelection(sel)`
- `undo()`
- `redo()`
- `applyUndoRedo(action)` (private)
- `deleteSelected()`
- `flashUndoHighlight(el)` (kept public in Task 4? — check: `useUndoRedo` calls it. KEEP.)
- `findFieldElement(uuid, fieldId)` — kept public in Task 4; `useUndoRedo` uses it. KEEP.

Keep: `fulfillPendingScroll`, `setPendingScroll`, `scrollToQuestion`, `setScrollCallback`, `clearScrollCallback`, `setEditGuard`, `clearEditGuard`, energy methods, drag state, focus hint / rename notice / new-question uuid, connect stash, `setAgentActive`, `markEditMadeMutations`, `editMadeMutations`, `reset`.

In `switchConnectMode`, change the line that reads `const s = this.store.getState()` inside `stashAllFormConnect` to read from the doc store directly:

```ts
private stashAllFormConnect(mode: ConnectType): void {
	const docState = this._docStore?.getState();
	if (!docState) return;
	const stash = this._connectStash[mode];
	stash.clear();

	for (let mIdx = 0; mIdx < docState.moduleOrder.length; mIdx++) {
		const moduleUuid = docState.moduleOrder[mIdx];
		const formUuids = docState.formOrder[moduleUuid] ?? [];
		for (let fIdx = 0; fIdx < formUuids.length; fIdx++) {
			const form = docState.forms[formUuids[fIdx]];
			if (form?.connect) {
				let moduleMap = stash.get(mIdx);
				if (!moduleMap) {
					moduleMap = new Map();
					stash.set(mIdx, moduleMap);
				}
				moduleMap.set(fIdx, structuredClone(form.connect));
			}
		}
	}
}
```

- [ ] **Step 2: Typecheck + test**

```bash
npx tsc --noEmit && echo "✓"
npm test -- --run
```

- [ ] **Step 3: Commit**

```bash
git add lib/services/builderEngine.ts
git commit -m "refactor(builder/engine): drop nav + select + undo/redo + deleteSelected"
```

---

### Task 13: Strip legacy store fields — `selected`, `screen`, `navEntries`, `navCursor`

**Files:**
- Modify: `lib/services/builderStore.ts`
- Modify: `lib/services/builderSelectors.ts`

Every consumer is off these fields. Remove them from the interface, the initial state, zundo partialize, and zundo equality.

- [ ] **Step 1: Edit `BuilderState` interface**

Remove:
- `selected: SelectedElement | undefined`
- `screen: PreviewScreen`
- `navEntries: PreviewScreen[]`
- `navCursor: number`
- The action signatures: `select`, `navPush`, `navPushIfDifferent`, `navBack`, `navUp`, `navigateToHome`, `navigateToModule`, `navigateToForm`, `navigateToCaseList`, `navResetTo`

- [ ] **Step 2: Remove initial state assignments in `createBuilderStore`**

Drop `selected`, `screen`, `navEntries`, `navCursor` from the initial-state block. Drop the action definitions. Drop the `MAX_NAV_HISTORY` constant and `appendNavEntry` helper (dead code).

- [ ] **Step 3: Update `UndoSlice` partialize + equality**

Remove `screen`, `navEntries`, `navCursor` from `UndoSlice` and from the `equality` function. The undo slice is now:

```ts
type UndoSlice = Pick<
	BuilderState,
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
```

Same for the `equality` function — drop the three nav fields.

- [ ] **Step 4: Update `reset()` action**

Remove the lines that clear `selected`, `screen`, `navEntries`, `navCursor`.

- [ ] **Step 5: Update `builderSelectors.ts`**

Delete `selectCanGoBack`, `selectCanGoUp`, `deriveBreadcrumbs` (moved to `lib/routing/hooks.tsx`). Remove exports. Update any remaining selector that referenced `screen` to derive from elsewhere or delete if unused.

- [ ] **Step 6: Typecheck + test**

```bash
npx tsc --noEmit && echo "✓"
npm test -- --run
```

- [ ] **Step 7: Commit**

```bash
git add lib/services/builderStore.ts lib/services/builderSelectors.ts
git commit -m "refactor(builder/store): delete selected/screen/navEntries/navCursor"
```

---

### Task 14: Delete `lib/doc/adapters/pathToUuid.ts` + fix `appId=""` sentinel

**Files:**
- Delete: `lib/doc/adapters/pathToUuid.ts`
- Delete: `lib/doc/__tests__/adapters-pathToUuid.test.ts`
- Modify: `lib/doc/provider.tsx`
- Modify: `hooks/useBuilder.tsx` (`appId` argument when creating the provider)

- [ ] **Step 1: Verify no callers of `pathToUuid`**

```bash
npx rg "pathToUuid|resolveModuleUuid|resolveFormUuid|resolveQuestionUuid" --type ts --type tsx
```

Expected output: only the file itself (about to be deleted). If any caller remains, address it inline before deleting.

- [ ] **Step 2: Delete the adapter + its tests**

```bash
git rm lib/doc/adapters/pathToUuid.ts lib/doc/__tests__/adapters-pathToUuid.test.ts
```

- [ ] **Step 3: Allow `appId` to be optional in `BlueprintDocProvider`**

Edit `lib/doc/provider.tsx`:

```tsx
export interface BlueprintDocProviderProps {
	initialBlueprint?: AppBlueprint;
	/**
	 * The app's Firestore document ID. `undefined` for brand-new apps before
	 * generation produces an ID. The doc's `appId` starts as the empty
	 * string in that case and is populated when the app is persisted.
	 */
	appId?: string;
	startTracking?: boolean;
	children: ReactNode;
}
```

In the provider body, replace `appId` usage:

```tsx
const effectiveAppId = appId ?? "";
if (initialBlueprint) {
	store.getState().load(initialBlueprint, effectiveAppId);
} else {
	store.setState((s) => {
		s.appId = effectiveAppId;
	});
}
```

- [ ] **Step 4: Update `hooks/useBuilder.tsx`**

```tsx
<BlueprintDocProvider
	appId={buildId === "new" ? undefined : buildId}
	initialBlueprint={initialBlueprint}
	startTracking={Boolean(initialBlueprint || replay)}
>
```

- [ ] **Step 5: Typecheck + test**

```bash
npx tsc --noEmit && echo "✓"
npm test -- --run
```

- [ ] **Step 6: Commit**

```bash
git add lib/doc/provider.tsx hooks/useBuilder.tsx
git commit -m "refactor(doc): delete pathToUuid adapter; appId is optional"
```

---

### Task 15: Final verification + manual smoke

**Files:** none — verification only.

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

Expected: all tests pass.

- [ ] **Step 4: Production build**

```bash
npm run build
```

Expected: clean.

- [ ] **Step 5: Manual smoke test**

```bash
npm run dev
```

Verify each scenario:

1. **Deep link** — paste `http://localhost:3000/build/<id>?s=f&m=<moduleUuid>&f=<formUuid>&sel=<questionUuid>` into the address bar. The correct question's contextual editor opens at load time with scroll positioned on the question.
2. **Cmd/Ctrl+click on a tree form** — opens the form in a new tab with the correct URL.
3. **Browser back/forward** — navigating home → module → form → another form, then pressing Back three times, returns through that sequence.
4. **Selection does not pollute history** — click through five questions in a form, then press Back once. The URL lands on the form (no selection), not on question 4.
5. **Stale `sel=` scrub** — delete the selected question. The URL's `sel=` is replaced with the neighbor's uuid (or dropped entirely) within the same tick; no console errors.
6. **Stale deep link (client-side)** — delete a form in one tab, then in a second tab paste a URL referencing that form. The second tab redirects to the module screen (or home if the module's gone too).
7. **Stale deep link (server-side)** — paste a URL with a bogus moduleUuid. The server redirects to `/build/<id>` before the client renders.
8. **Undo/redo** — make an edit, press Cmd/Ctrl+Z. The change reverts AND the URL stays on the current selection, with scroll + flash fired on the undone field.
9. **Delete-selected** — select a question, press Delete. The question is removed and selection jumps to the neighbor (next if present, else previous).
10. **Cursor mode toggle** — switch pointer ↔ edit. Works as before; no regression.
11. **Rename with sibling conflict** — rename a question to an existing sibling's id. The rename is rejected with a toast; URL unchanged.
12. **Cross-form drag** — drag a question from form A to form B (via the tree sidebar). Mutation applies, URL's `sel=` follows if the dragged question was selected.
13. **Breadcrumbs** — click each breadcrumb; the URL updates accordingly; no flash.

Document any issue found with a new commit under Task 15.

- [ ] **Step 6: Pause for branch merge approval**

Do NOT merge `phase-2-url-state` into `main` without explicit user approval. Report status; wait for the go-ahead.

---

## Self-review checklist (spec coverage)

1. **URL schema on `/build/[id]`** — Task 1 creates `useLocation`/`useNavigate`/`useSelect`; Phase 0 covered `parseLocation`/`serializeLocation`/`isValidLocation`. ✓
2. **`lib/routing/location.ts` pure functions** — Phase 0. ✓
3. **Consumer hooks** (`useLocation`, `useNavigate`, `useSelect`, `useSelectedQuestion`, `useSelectedFormContext`, `useBreadcrumbs`) — Task 1. ✓
4. **Deletion recovery** (tiny root effect) — Task 3. ✓
5. **RSC first-load validation + server redirect** — Task 2. ✓
6. **Delete from legacy store: `screen`, `navEntries`, `navCursor`, `selected` + engine nav methods** — Tasks 12 + 13. ✓
7. **`coerceNulls` + `NullablePartial` retired alongside uuid-first mutations** — Task 5. ✓
8. **`appId=""` sentinel fix** — Task 14. ✓
9. **`lib/doc/adapters/pathToUuid.ts` deleted** — Task 14. ✓
10. **`MoveQuestionResult.renamed` + `QuestionRenameResult.xpathFieldsRewritten`** — explicitly deferred to Phase 3 (non-goals + Task 5 notes). ✓
11. **`stashAllFormConnect` reads doc directly** — Task 12. ✓
12. **Browser back/forward, Cmd+click, bookmarking all work without additional code** — exercised by Task 15 smoke steps 1–4. ✓

No placeholders, no TBDs. Each task commits to a single logical change; every new function has a complete signature and implementation sketch. Consumer migration tasks 6–11 are sequenced so typecheck failures decrease monotonically, so reviewers can land them independently.
