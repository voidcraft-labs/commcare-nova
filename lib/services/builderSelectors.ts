/**
 * builderSelectors — pure derived selectors and derivation functions for BuilderState.
 *
 * Two kinds of exports:
 * - **Selectors** return primitives or stable references (booleans, strings,
 *   Immer-managed objects). Safe to pass directly to `useBuilderStore(selector)`.
 * - **Derivation functions** construct new object trees (TreeData, breadcrumbs).
 *   These MUST be wrapped in `useMemo` by their consuming hooks — never passed
 *   directly to `useBuilderStore`, because `Object.is` comparison on a new
 *   object every call triggers infinite re-render loops.
 *
 * Breadcrumb derivation lives in the `useBreadcrumbs` hook in useBuilder.tsx —
 * it selects primitive strings (appName, moduleName, formName) not entity maps.
 */

import { getCaseData } from "@/lib/preview/engine/dummyData";
import { type PreviewScreen, screenKey } from "@/lib/preview/engine/types";
import type { ConnectType, Scaffold } from "@/lib/schemas/blueprint";
import { BuilderPhase, type TreeData } from "./builder";
import type {
	BuilderState,
	GenerationData,
	PartialModule,
} from "./builderStore";
import type { NForm, NModule, NQuestion } from "./normalizedState";
import { assembleQuestions } from "./normalizedState";

// ── TreeData derivation ──────────────────────────────────────────────────

/**
 * Subset of BuilderState needed by `deriveTreeData`. Decoupled from the full
 * store type so the consuming hook can pass exactly the fields it subscribes to.
 */
export interface TreeDataSource {
	phase: BuilderPhase;
	appName: string;
	connectType: ConnectType | undefined;
	modules: Record<string, NModule>;
	forms: Record<string, NForm>;
	questions: Record<string, NQuestion>;
	moduleOrder: string[];
	formOrder: Record<string, string[]>;
	questionOrder: Record<string, string[]>;
	generationData: GenerationData | undefined;
}

/**
 * Derive treeData from store state. Pure function, no side effects.
 *
 * **Not a Zustand selector** — returns new objects via `.map()` on every call.
 * Must be wrapped in `useMemo` by the consuming hook (`useBuilderTreeData`).
 *
 * Precedence:
 * 1. Normalized entities (Ready/Completed) — derived from flat maps
 * 2. Scaffold + partials (during generation) — merged overlay
 * 3. Scaffold alone (Structure stage) — just names
 * 4. Partial scaffold (early Structure) — streaming
 * 5. Undefined — no data yet
 */
export function deriveTreeData(s: TreeDataSource): TreeData | undefined {
	/* Ready/Completed: derive from normalized entities */
	if (s.moduleOrder.length > 0 && s.phase !== BuilderPhase.Generating) {
		return {
			app_name: s.appName,
			connect_type: s.connectType,
			modules: s.moduleOrder.map((moduleId) => {
				const mod = s.modules[moduleId];
				const formIds = s.formOrder[moduleId] ?? [];
				return {
					name: mod.name,
					case_type: mod.caseType,
					purpose: mod.purpose,
					case_list_columns: mod.caseListColumns,
					case_detail_columns: mod.caseDetailColumns,
					forms: formIds.map((formId) => {
						const form = s.forms[formId];
						return {
							name: form.name,
							type: form.type,
							purpose: form.purpose,
							questions: assembleQuestions(
								s.questions,
								s.questionOrder,
								formId,
							),
							connect: form.connect ?? undefined,
						};
					}),
				};
			}),
		};
	}

	/* Generation phase: use generationData */
	const gen = s.generationData;
	if (!gen) return undefined;

	if (gen.scaffold && Object.keys(gen.partialModules).length > 0) {
		return mergeScaffoldWithPartials(gen.scaffold, gen.partialModules);
	}

	if (gen.scaffold) return gen.scaffold;

	if (gen.partialScaffold && gen.partialScaffold.modules.length > 0) {
		return {
			app_name: gen.partialScaffold.appName ?? "",
			modules: gen.partialScaffold.modules,
		};
	}

	return undefined;
}

/** True when the builder has entity data and is interactive (Ready or Completed). */
export function selectIsReady(s: BuilderState): boolean {
	return s.phase === BuilderPhase.Ready || s.phase === BuilderPhase.Completed;
}

/** True when entity data is populated — replaces `!!s.blueprint` guards. */
export function selectHasData(s: BuilderState): boolean {
	return s.moduleOrder.length > 0;
}

/** Derive edit mode from cursor mode. Pointer = test (live form), all others = edit (design). */
export function selectEditMode(s: BuilderState): "edit" | "test" {
	return s.cursorMode === "pointer" ? "test" : "edit";
}

// ── Replay selectors ──────────────────────────────────────────────────

/** True when the builder is in replay mode (replay stages loaded in store). */
export function selectInReplayMode(s: BuilderState): boolean {
	return s.replayStages !== undefined;
}

// ── Navigation selectors ───────────────────────────────────────────────

/** True when the user can navigate back in preview history. */
export function selectCanGoBack(s: BuilderState): boolean {
	return s.navCursor > 0;
}

/** True when the current screen has a parent (i.e. not home). */
export function selectCanGoUp(s: BuilderState): boolean {
	return s.screen.type !== "home";
}

// ── Breadcrumb types (used by useBreadcrumbs hook) ────────────────────

/** Breadcrumb item with a stable identity key derived from the navigation screen. */
export interface BreadcrumbItem {
	/** Stable React key from `screenKey()` — encodes screen type + hierarchy indices. */
	key: string;
	/** Display label for this breadcrumb level. */
	label: string;
	/** The PreviewScreen this breadcrumb represents — used for navigation on click. */
	screen: PreviewScreen;
}

/**
 * Derive breadcrumb items from screen + resolved entity names.
 * Pure function — called by the useBreadcrumbs hook with primitive string inputs.
 */
export function deriveBreadcrumbs(
	screen: PreviewScreen,
	appName: string,
	moduleName: string | undefined,
	formName: string | undefined,
	caseId?: string,
	moduleCaseType?: string,
): BreadcrumbItem[] {
	if (!appName) return [];

	const items: BreadcrumbItem[] = [
		{
			key: screenKey({ type: "home" }),
			label: appName,
			screen: { type: "home" },
		},
	];

	if (screen.type === "home") return items;

	const moduleScreen: PreviewScreen = {
		type: "module",
		moduleIndex: screen.moduleIndex,
	};
	items.push({
		key: screenKey(moduleScreen),
		label: moduleName ?? "Module",
		screen: moduleScreen,
	});

	if (screen.type === "module") return items;

	if (screen.type === "caseList") {
		items.push({
			key: screenKey(screen),
			label: formName ?? "Form",
			screen,
		});
		return items;
	}

	if (screen.type === "form") {
		/* If this form is a follow-up with a case, show the case list + case name breadcrumbs */
		const caseName =
			caseId && moduleCaseType
				? getCaseData(moduleCaseType, caseId)?.get("case_name")
				: undefined;

		if (caseName) {
			const caseListScreen: PreviewScreen = {
				type: "caseList",
				moduleIndex: screen.moduleIndex,
				formIndex: screen.formIndex,
			};
			items.push({
				key: screenKey(caseListScreen),
				label: formName ?? "Form",
				screen: caseListScreen,
			});
			items.push({
				key: screenKey(screen),
				label: caseName,
				screen,
			});
		} else {
			items.push({
				key: screenKey(screen),
				label: formName ?? "Form",
				screen,
			});
		}
	}

	return items;
}

// ── Internal helpers ────────────────────────────────────────────────────

/** Merge a complete scaffold with partial module data during generation.
 *  Creates a TreeData view that overlays received form content onto the
 *  scaffold skeleton. */
function mergeScaffoldWithPartials(
	scaffold: Scaffold,
	partialModules: Record<number, PartialModule>,
): TreeData {
	return {
		app_name: scaffold.app_name,
		modules: scaffold.modules.map((sm, mIdx) => {
			const partial = partialModules[mIdx];
			return {
				name: sm.name,
				case_type: sm.case_type,
				purpose: sm.purpose,
				case_list_columns:
					partial?.caseListColumns !== undefined
						? partial.caseListColumns
						: undefined,
				forms: sm.forms.map((sf, fIdx) => {
					const assembledForm = partial?.forms[fIdx];
					if (assembledForm) {
						return { ...assembledForm, purpose: sf.purpose };
					}
					return {
						name: sf.name,
						type: sf.type,
						purpose: sf.purpose,
					};
				}),
			};
		}),
	};
}
