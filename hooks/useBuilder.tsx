/**
 * useBuilder — Zustand-backed context for the BuilderEngine and store.
 *
 * BuilderProvider scopes one BuilderEngine (and its Zustand store) to each
 * /build/{id} page. When buildId changes, a fresh engine is created. When
 * the page unmounts, the engine is garbage collected.
 *
 * Components access state in two ways:
 * - `useBuilderStore(selector)` — reactive subscription to a precise slice
 *   of store state. Only re-renders when the selected value changes.
 * - `useBuilderEngine()` — imperative access to the engine for non-reactive
 *   state and composing methods (navigateTo, energy, guards, scroll).
 *
 * Convenience hooks (useBuilderPhase, useModule, useForm, etc.) wrap
 * `useBuilderStore` with common selectors for ergonomic call sites.
 */
"use client";

import { useRouter } from "next/navigation";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import { useStore } from "zustand";
import { shallow } from "zustand/shallow";
import { useStoreWithEqualityFn } from "zustand/traditional";
import type { PreviewScreen } from "@/lib/preview/engine/types";
import type { BlueprintForm } from "@/lib/schemas/blueprint";
import type { TreeData } from "@/lib/services/builder";
import { BuilderPhase, type SelectedElement } from "@/lib/services/builder";
import { BuilderEngine } from "@/lib/services/builderEngine";
import {
	type BreadcrumbItem,
	deriveBreadcrumbs,
	deriveTreeData,
	selectCanGoBack,
	selectCanGoUp,
	selectHasData,
	selectIsReady,
} from "@/lib/services/builderSelectors";
import type {
	BuilderState,
	BuilderStoreApi,
	CursorMode,
} from "@/lib/services/builderStore";
import type { NForm, NModule, NQuestion } from "@/lib/services/normalizedState";
import { assembleForm } from "@/lib/services/normalizedState";
import { showToast } from "@/lib/services/toastStore";

// ── Contexts ────────────────────────────────────────────────────────────

/** Zustand store context — provides reactive subscriptions via selectors. */
const StoreContext = createContext<BuilderStoreApi | null>(null);

/** Engine context — provides imperative access to non-reactive state and DOM glue. */
const EngineContext = createContext<BuilderEngine | null>(null);

// ── Core hooks ──────────────────────────────────────────────────────────

/**
 * Subscribe to a slice of builder store state. Components re-render ONLY
 * when the selected value changes (Object.is comparison by default).
 *
 * Use for any reactive state: phase, selected, entity maps, etc.
 * For selecting multiple primitives as an object, use `useBuilderStoreShallow`.
 */
export function useBuilderStore<T>(selector: (state: BuilderState) => T): T {
	const store = useContext(StoreContext);
	if (!store) {
		throw new Error("useBuilderStore must be used within a BuilderProvider");
	}
	return useStore(store, selector);
}

/**
 * Subscribe to a slice with shallow equality comparison.
 * Use when the selector returns a new object of primitives each call
 * (e.g. `{ canUndo, canRedo }`) — shallow equality prevents re-renders
 * when the individual values haven't changed.
 */
export function useBuilderStoreShallow<T>(
	selector: (state: BuilderState) => T,
): T {
	const store = useContext(StoreContext);
	if (!store) {
		throw new Error(
			"useBuilderStoreShallow must be used within a BuilderProvider",
		);
	}
	return useStoreWithEqualityFn(store, selector, shallow);
}

/**
 * Access the BuilderEngine for non-reactive state and composing methods.
 * Does NOT subscribe to any state — calling this hook never triggers re-renders.
 *
 * Use for: engine.navigateTo(), energy methods, guards, scroll callbacks,
 * focus hints, drag state, connect stash.
 */
export function useBuilderEngine(): BuilderEngine {
	const engine = useContext(EngineContext);
	if (!engine) {
		throw new Error("useBuilderEngine must be used within a BuilderProvider");
	}
	return engine;
}

// ── Convenience selector hooks ──────────────────────────────────────────

/** Current builder lifecycle phase. */
export function useBuilderPhase(): BuilderPhase {
	return useBuilderStore((s) => s.phase);
}

/**
 * Type-safe screen selector — returns the typed screen if it matches the
 * expected type, `undefined` otherwise.
 *
 * Returns `undefined` (not throws) because AnimatePresence `mode="wait"`
 * keeps the exiting screen component mounted briefly while the store's
 * screen has already changed to the next screen type. The component
 * early-returns `null` during this overlap window.
 */
export function useScreenData<T extends PreviewScreen["type"]>(
	type: T,
): Extract<PreviewScreen, { type: T }> | undefined {
	return useBuilderStore((s) =>
		s.screen.type === type
			? (s.screen as Extract<PreviewScreen, { type: T }>)
			: undefined,
	);
}

/** Currently selected module/form/question. */
export function useBuilderSelected(): SelectedElement | undefined {
	return useBuilderStore((s) => s.selected);
}

/** True when the builder has entity data and is interactive (Ready or Completed). */
export function useBuilderIsReady(): boolean {
	return useBuilderStore(selectIsReady);
}

/** True when entity data is populated (replaces `!!s.blueprint`). */
export function useBuilderHasData(): boolean {
	return useBuilderStore(selectHasData);
}

/**
 * Merged tree data for AppTree rendering — derived from store state.
 *
 * Subscribes to entity maps and generation state via `useBuilderStoreShallow`,
 * then memoizes the derivation. Immer structural sharing ensures unchanged
 * maps keep the same reference, so the shallow-equality selector returns a
 * stable object when nothing changed — and `useMemo` skips recomputation.
 *
 * During Ready/Completed phases, derives TreeData from normalized entities.
 * During generation, constructs a merged view from scaffold + partials.
 *
 * This CANNOT use `useBuilderStore(deriveTreeData)` directly — `deriveTreeData`
 * builds new objects via `.map()` on every call, which fails `Object.is`
 * comparison and triggers an infinite re-render loop in useSyncExternalStore.
 */
export function useBuilderTreeData(): TreeData | undefined {
	/* Subscribe to the exact fields deriveTreeData reads. Shallow equality
	 * compares each field by reference — only produces a new `data` object
	 * when at least one entity map, ordering array, or scalar changes. */
	const data = useBuilderStoreShallow((s) => ({
		phase: s.phase,
		appName: s.appName,
		connectType: s.connectType,
		modules: s.modules,
		forms: s.forms,
		questions: s.questions,
		moduleOrder: s.moduleOrder,
		formOrder: s.formOrder,
		questionOrder: s.questionOrder,
		generationData: s.generationData,
	}));

	/* `data` is referentially stable when nothing changed (shallow equality
	 * returned the previous result), so useMemo skips recomputation. When
	 * any field changes, `data` gets a new reference → memo recomputes. */
	return useMemo(() => deriveTreeData(data), [data]);
}

/** Whether the SA agent is currently active. */
export function useBuilderAgentActive(): boolean {
	return useBuilderStore((s) => s.agentActive);
}

/** Current preview screen (home, module, caseList, form). */
export function useBuilderScreen(): PreviewScreen {
	return useBuilderStore((s) => s.screen);
}

/** Current cursor mode (inspect, text, pointer). */
export function useBuilderCursorMode(): CursorMode {
	return useBuilderStore((s) => s.cursorMode);
}

/** Whether the user can navigate back in preview history. */
export function useBuilderCanGoBack(): boolean {
	return useBuilderStore(selectCanGoBack);
}

/** Whether the current screen has a parent (i.e. not home). */
export function useBuilderCanGoUp(): boolean {
	return useBuilderStore(selectCanGoUp);
}

// ── Entity hooks — select specific entities by index ───────────────────

/** Select a module entity by its position in moduleOrder. */
export function useModule(mIdx: number): NModule | undefined {
	return useBuilderStore((s) => {
		const moduleId = s.moduleOrder[mIdx];
		return moduleId ? s.modules[moduleId] : undefined;
	});
}

/** Select a form entity by module and form indices. */
export function useForm(mIdx: number, fIdx: number): NForm | undefined {
	return useBuilderStore((s) => {
		const moduleId = s.moduleOrder[mIdx];
		if (!moduleId) return undefined;
		const formId = s.formOrder[moduleId]?.[fIdx];
		return formId ? s.forms[formId] : undefined;
	});
}

/** Select a question entity by UUID. */
export function useQuestion(uuid: string): NQuestion | undefined {
	return useBuilderStore((s) => s.questions[uuid]);
}

/**
 * Returns an ordered array of NModule entities.
 * Derives from moduleOrder + modules map via useMemo.
 */
export function useOrderedModules(): NModule[] {
	const moduleOrder = useBuilderStore((s) => s.moduleOrder);
	const modules = useBuilderStore((s) => s.modules);
	return useMemo(
		() => moduleOrder.map((id) => modules[id]).filter((m): m is NModule => !!m),
		[moduleOrder, modules],
	);
}

/**
 * Returns an ordered array of NForm entities for a module.
 * Derives from formOrder + forms map via useMemo.
 */
export function useOrderedForms(mIdx: number): NForm[] {
	const moduleOrder = useBuilderStore((s) => s.moduleOrder);
	const formOrder = useBuilderStore((s) => s.formOrder);
	const forms = useBuilderStore((s) => s.forms);
	return useMemo(() => {
		const moduleId = moduleOrder[mIdx];
		if (!moduleId) return [];
		const formIds = formOrder[moduleId] ?? [];
		return formIds.map((id) => forms[id]).filter((f): f is NForm => !!f);
	}, [moduleOrder, formOrder, forms, mIdx]);
}

/**
 * Assemble a BlueprintForm from normalized entities for FormEngine.
 * Returns a new reference when any entity map or ordering changes.
 * The `prevFormRef` comparison in useFormEngine handles recreation.
 */
export function useAssembledForm(
	mIdx: number,
	fIdx: number,
): BlueprintForm | undefined {
	const moduleOrder = useBuilderStore((s) => s.moduleOrder);
	const formOrder = useBuilderStore((s) => s.formOrder);
	const forms = useBuilderStore((s) => s.forms);
	const questions = useBuilderStore((s) => s.questions);
	const questionOrder = useBuilderStore((s) => s.questionOrder);

	return useMemo(() => {
		const moduleId = moduleOrder[mIdx];
		if (!moduleId) return undefined;
		const formIds = formOrder[moduleId];
		const formId = formIds?.[fIdx];
		if (!formId) return undefined;
		const form = forms[formId];
		if (!form) return undefined;
		return assembleForm(form, formId, questions, questionOrder);
	}, [moduleOrder, formOrder, forms, questions, questionOrder, mIdx, fIdx]);
}

/**
 * Breadcrumb items derived from the current screen + entity names.
 *
 * Selects primitive strings (appName, moduleName, formName) — not entity maps.
 * Renaming an unrelated module doesn't change the string selected, so the
 * component doesn't re-render. No custom equality function needed.
 */
export function useBreadcrumbs(): BreadcrumbItem[] {
	const screen = useBuilderStore((s) => s.screen);
	const appName = useBuilderStore((s) => s.appName);

	/* Extract the specific entity names from the screen's indices.
	 * Each selector returns a primitive string, compared by value. */
	const moduleName = useBuilderStore((s) => {
		if (!("moduleIndex" in screen)) return undefined;
		const mId = s.moduleOrder[screen.moduleIndex];
		return mId ? s.modules[mId]?.name : undefined;
	});

	const formName = useBuilderStore((s) => {
		if (!("formIndex" in screen)) return undefined;
		const mId = s.moduleOrder[(screen as { moduleIndex: number }).moduleIndex];
		const fId = mId
			? s.formOrder[mId]?.[(screen as { formIndex: number }).formIndex]
			: undefined;
		return fId ? s.forms[fId]?.name : undefined;
	});

	/* Resolve case-related data for form screens with case context */
	const moduleCaseType = useBuilderStore((s) => {
		if (!("moduleIndex" in screen)) return undefined;
		const mId = s.moduleOrder[screen.moduleIndex];
		return mId ? s.modules[mId]?.caseType : undefined;
	});

	const caseId =
		screen.type === "form" ? (screen as { caseId?: string }).caseId : undefined;

	return useMemo(
		() =>
			deriveBreadcrumbs(
				screen,
				appName,
				moduleName,
				formName,
				caseId,
				moduleCaseType,
			),
		[screen, appName, moduleName, formName, caseId, moduleCaseType],
	);
}

/**
 * Returns true if the specified question is currently selected.
 *
 * Each EditableQuestionWrapper calls this with its own identity. The selector
 * returns a boolean, so when selection changes from question A to B, only
 * A's wrapper (true→false) and B's wrapper (false→true) re-render. All other
 * wrappers return the same `false` and skip rendering entirely.
 */
export function useIsQuestionSelected(
	moduleIndex: number,
	formIndex: number,
	questionUuid: string,
): boolean {
	return useBuilderStore(
		(s) =>
			s.selected?.type === "question" &&
			s.selected.moduleIndex === moduleIndex &&
			s.selected.formIndex === formIndex &&
			s.selected.questionUuid === questionUuid,
	);
}

// ── Provider ────────────────────────────────────────────────────────────

/**
 * BuilderProvider — owns the BuilderEngine lifecycle for a specific buildId.
 *
 * Creates a fresh engine (with its own Zustand store) when buildId changes
 * using the "adjusting state during rendering" pattern. Provides both
 * the Zustand store and the engine via separate contexts.
 *
 * Lifecycle:
 * - `/` → `/build/{id}`: provider mounts, fresh engine, loads app
 * - `/build/A` → `/build/B`: buildId changes, fresh engine, loads B
 * - `/build/*` → `/`: provider unmounts, engine is garbage collected
 * - `/build/new` generation: buildId stays 'new' (replaceState), no reset
 */
export function BuilderProvider({
	buildId,
	children,
}: {
	buildId: string;
	children: ReactNode;
}) {
	const router = useRouter();

	const isExistingApp = buildId !== "new";

	const [state, setState] = useState(() => ({
		engine: new BuilderEngine(
			isExistingApp ? BuilderPhase.Loading : BuilderPhase.Idle,
		),
		buildId,
	}));

	if (buildId !== state.buildId) {
		setState({
			engine: new BuilderEngine(
				isExistingApp ? BuilderPhase.Loading : BuilderPhase.Idle,
			),
			buildId,
		});
	}

	const { engine } = state;

	/* Fetch the app from Firestore for existing apps. Hydrates the
	 * engine to Ready phase with the saved blueprint via loadApp() —
	 * a single atomic transition with no transient states. */
	useEffect(() => {
		if (!isExistingApp) return;
		if (engine.store.getState().phase !== BuilderPhase.Loading) return;
		const controller = new AbortController();

		fetch(`/api/apps/${buildId}`, { signal: controller.signal })
			.then((res) => {
				if (!res.ok)
					throw new Error(res.status === 404 ? "not-found" : "load-failed");
				return res.json();
			})
			.then((data) => {
				if (data.status !== "complete") {
					showToast(
						"error",
						"App unavailable",
						"This app didn't finish generating.",
					);
					router.replace("/");
					return;
				}
				if (data.blueprint) {
					engine.store.getState().loadApp(buildId, data.blueprint);
					/* Resume undo tracking — the loaded state is the baseline.
					 * Tracking was paused in the engine constructor to prevent
					 * the empty→populated hydration from being undoable. */
					engine.store.temporal.getState().resume();
				}
			})
			.catch((err) => {
				if (err.name === "AbortError") return;
				if (err.message === "not-found") {
					showToast(
						"error",
						"App not found",
						"This app may have been deleted.",
					);
				} else {
					showToast("error", "Failed to load app");
				}
				router.replace("/");
			});

		return () => {
			controller.abort();
		};
	}, [buildId, isExistingApp, engine, router]);

	return (
		<EngineContext value={engine}>
			<StoreContext value={engine.store}>{children}</StoreContext>
		</EngineContext>
	);
}
