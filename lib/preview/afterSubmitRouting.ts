import {
	CASE_LOADING_FORM_TYPES,
	caseSelectionCanFlowBetweenModules,
	type FormType,
} from "@/lib/domain";
import type { PreviewCaseChoice } from "@/lib/session/types";
import { caseRowToFormPreload } from "./engine/caseDataBindingClient";
import type { CaseDatabaseSnapshot } from "./engine/xpathInstances";
/**
 * The form screen's after-submit routing decision, as a pure function.
 *
 * `evaluateAfterSubmit` says WHICH frames the submission pushes; this says
 * what the screen does about one of them: which screen to push, with which
 * case, or that the answer cannot be acted on, and which session path the
 * frame installs (`afterSubmitFrameLanding`), which the stack
 * (`afterSubmitStack.ts`) compares the worker's next submission against.
 * The component performs the effect. No React and no DOM, so the whole
 * routing table is checked directly.
 */

import type {
	BlueprintDoc,
	FormLinkEntry,
	PostSubmitDestination,
	ResolvedFormLinkTarget,
	Uuid,
} from "@/lib/domain";
import {
	type ModuleLanding,
	moduleIsBareCaseList,
	moduleLanding,
	resolveFormLinkTarget,
} from "@/lib/domain";
import { moduleParent } from "@/lib/domain/moduleHierarchy";
import {
	type AfterSubmitFrameChoice,
	type CarriedCase,
	type CarriedSubmission,
	frameChoiceEntry,
	type PostSubmissionCaseData,
	type TargetCaseSelection,
} from "@/lib/preview/engine/formLinkEvaluation";
import {
	type PreviewMenuSource,
	previewCaseDescendantModuleUuids,
	previewMenuCaseContext,
	previewMenuModuleUuids,
} from "@/lib/preview/menuProjection";
import type { PreviewMenuCaseSelection } from "@/lib/session/types";
import {
	type AfterSubmitPathCases,
	type AfterSubmitPathStep,
	afterSubmitPath,
} from "./afterSubmitStack";
import {
	formDisplayVisibility,
	moduleDisplayVisibility,
	type NavigationDeviceCases,
	navigationSelectedCase,
} from "./engine/displayConditionEvaluation";
import { previewExpressionContext } from "./engine/expressionContext";
import type { PreviewSearchSessionValues } from "./engine/identity";
import type { PreviousTask } from "./engine/previousTask";
import type { PreviewLookupStatus } from "./engine/useLookupPreviewData";
import type { PreviewPlatformRules } from "./platform";

export type AfterSubmitRoute =
	| { readonly kind: "previous-task"; readonly task: PreviousTask }
	/** No link fired: the form's own post-submit destination. */
	| {
			readonly kind: "post-submit";
			readonly destination: PostSubmitDestination;
	  }
	/** A link to a module: enter it where the home screen would. */
	| {
			readonly kind: "module";
			readonly moduleUuid: Uuid;
			readonly landing: ModuleLanding;
			readonly caseSelections: readonly TargetCaseSelection[];
	  }
	/** A link to a form, with the case it opens with (if it selects one). */
	| {
			readonly kind: "form";
			readonly moduleUuid: Uuid;
			readonly formUuid: Uuid;
			readonly carried: CarriedCase;
			readonly caseSelections: readonly TargetCaseSelection[];
	  }
	/**
	 * The link fired but its target is not in the document. The gate keeps
	 * links and their targets consistent, so this is a bypass or a race the
	 * screen must report rather than route around.
	 */
	| { readonly kind: "unresolvable"; readonly reason: string }
	/** The target's visibility waits on data still loading (the device's
	 *  cases, a lookup), as the screen's other visibility reads wait. */
	| { readonly kind: "pending" };

/**
 * Where `app_home`, HQ's default after-submit destination, lands: the app's
 * first screen in Web Apps, which has no home inside an app, and the
 * phone's home screen on Android (`postSubmitAppHome`; Formplayer
 * `FormSubmissionHelper.java::doEndOfFormNav`, Android
 * `AndroidSessionWrapper::terminateSession`). The running form and App Tests
 * both land by it.
 */
export function appHomeLanding(
	rules: Pick<PreviewPlatformRules, "postSubmitAppHome">,
): "module-list" | "device-home" {
	return rules.postSubmitAppHome === "device-home"
		? "device-home"
		: "module-list";
}

/** Where a form link's target stands on the worker's menu after submit:
 *  shown; a form off the menu or whose display condition is false; a form
 *  inside a module (or under one) that is off the menu or whose display
 *  condition is false; a module whose display condition is false or that is
 *  off the menu, or under one that is; or waiting on data. A target inside or
 *  under a hidden module names `shownModuleUuid`, the deepest module above the
 *  topmost hidden one (`null` when that is a top-level module): the menu
 *  Formplayer's frame walk stops on. */
export type AfterSubmitTargetVisibility =
	| "shown"
	| "form-hidden"
	| {
			readonly kind: "form-in-hidden-module" | "module-hidden";
			readonly shownModuleUuid: Uuid | null;
	  }
	| "pending";

/**
 * Read a link target's place on the worker's menu over the submitted entry's
 * session: every module up the target's chain through
 * `moduleDisplayVisibility` (off the menu counts as hidden), then a form
 * target's own condition through `formDisplayVisibility`, reading the case
 * the frame selects in the target's module.
 */
export function afterSubmitTargetVisibility(args: {
	readonly doc: BlueprintDoc;
	readonly target: ResolvedFormLinkTarget;
	readonly session: PreviewSearchSessionValues;
	readonly lookup: PreviewLookupStatus;
	readonly deviceCases: NavigationDeviceCases;
	readonly caseSelections: readonly TargetCaseSelection[];
}): AfterSubmitTargetVisibility {
	const { doc, target } = args;
	const lookupData = args.lookup.kind === "data" ? args.lookup.data : undefined;
	/* Walk the menus from the top, as Formplayer's frame walk does: the
	 * first module the menu hides stops it on the module above, so a module
	 * still loading above it leaves where it stops unknown. */
	const chain: Uuid[] = [];
	for (
		let moduleUuid: Uuid | null | undefined = target.moduleUuid;
		moduleUuid && !chain.includes(moduleUuid);
		moduleUuid = moduleParent(doc, moduleUuid)
	) {
		chain.unshift(moduleUuid);
	}
	let shownModuleUuid: Uuid | null = null;
	for (const moduleUuid of chain) {
		const mod = doc.modules[moduleUuid];
		if (mod === undefined) break;
		const visibility = moduleDisplayVisibility({
			condition: mod.displayCondition,
			hiddenFromMenu: mod.hiddenFromMenu === true,
			session: args.session,
			types: previewExpressionContext(
				doc,
				{
					entity: "module",
					uuid: moduleUuid,
					slot: "module_display_condition",
				},
				lookupData,
			),
			lookup: args.lookup,
			deviceCases: args.deviceCases,
		});
		if (visibility === "pending") return "pending";
		if (visibility === "hidden")
			return {
				kind:
					target.type === "form" ? "form-in-hidden-module" : "module-hidden",
				shownModuleUuid,
			};
		shownModuleUuid = moduleUuid;
	}
	if (target.type !== "form") return "shown";
	const form = doc.forms[target.formUuid];
	if (form === undefined) return "shown";
	const chosen = args.caseSelections.filter(
		(selection) =>
			selection.moduleUuid === target.moduleUuid && selection.caseId !== "",
	);
	const selectedCase =
		chosen.length === 1
			? navigationSelectedCase(
					doc,
					target.moduleUuid,
					target.formUuid,
					chosen[0].caseId,
				)
			: undefined;
	const visibility = formDisplayVisibility({
		condition: form.displayCondition,
		hiddenFromMenu: form.hiddenFromMenu === true,
		session: args.session,
		types: previewExpressionContext(
			doc,
			{ entity: "form", uuid: target.formUuid, slot: "form_display_condition" },
			lookupData,
		),
		selectedCase,
		lookup: args.lookup,
		deviceCases: args.deviceCases,
	});
	if (visibility === "pending") return "pending";
	return visibility === "hidden" ? "form-hidden" : "shown";
}

/** One exact ordered multi-case selection carried by an automatic compatible
 * form link. Scalar target datums still travel through `TargetCaseSelection`;
 * this collection is the selected-entities session value that cannot be
 * represented by choosing a first case. */
export interface PreviewTargetCaseCollection {
	readonly moduleUuid: Uuid;
	readonly caseType: string;
	readonly cases: PreviewMenuCaseSelection["cases"];
}

/** A frame Preview's stack holds: its route, and the several-case selection
 *  an automatic link carries beside it (`automaticLinkedCaseCollection`),
 *  both fixed when the frame is pushed, as Core fixes a frame's datums
 *  (`StackFrameStep.defineStep`). */
export interface PreviewAfterSubmitFrame {
	readonly route: AfterSubmitRoute;
	readonly collection?: PreviewTargetCaseCollection;
}

export function afterSubmitRoute(args: {
	readonly previousTask?: () => PreviousTask;
	readonly choice: AfterSubmitFrameChoice;
	/** The submitted form, which `this-form` names. */
	readonly sourceFormUuid: Uuid;
	readonly doc: Pick<BlueprintDoc, "modules" | "forms" | "formOrder">;
	/** Modules whose every form loads a case (`useCaseFirstModuleUuids`). */
	readonly caseFirstModules: ReadonlySet<Uuid>;
	/** Whether the target has a usable case after applying this frame's
	 * projected selections to the running menu session. This admits same-type
	 * structural inheritance and distinguishes an installed blank datum from
	 * an absent datum, matching the device session stack. */
	readonly hasSelectedCase?: (
		moduleUuid: Uuid,
		caseSelections: readonly TargetCaseSelection[],
	) => boolean;
	/** Every case selection the matched target frame installs, already mapped
	 * to the Preview menu-session module that owns it. */
	readonly caseSelections: (
		entry: FormLinkEntry,
	) => readonly TargetCaseSelection[];
	/** Resolves the case a FORM target opens with; called only for a target
	 *  the document holds. */
	readonly carriedCase: (entry: FormLinkEntry) => CarriedCase;
	/** The platform Preview plays: whether a target the worker's menu hides
	 *  opens (Android) or lands where Web Apps' menu walk lands it. */
	readonly rules: Pick<PreviewPlatformRules, "afterSubmitHiddenTarget">;
	/** Whether the link's target is on the worker's menu
	 *  (`afterSubmitTargetVisibility`), read only on Web Apps. */
	readonly targetVisibility: (
		target: ResolvedFormLinkTarget,
	) => AfterSubmitTargetVisibility;
}): AfterSubmitRoute {
	const { choice, doc } = args;
	/* A built-in otherwise is HQ's static fallback frame, the same frame the
	 * form's after-submit destination builds
	 * (`workflow.py::_get_fallback_frame` → `_get_static_stack_frame`). */
	const builtIn =
		choice.kind === "post-submit" || choice.kind === "otherwise"
			? choice.destination
			: undefined;
	if (builtIn !== undefined) {
		if (builtIn === "previous")
			return args.previousTask
				? { kind: "previous-task", task: args.previousTask() }
				: {
						kind: "unresolvable",
						reason:
							"The preceding task was not resolved from the submitted entry.",
					};
		return { kind: "post-submit", destination: builtIn };
	}
	const entry = frameChoiceEntry(choice);
	if (entry === undefined)
		return {
			kind: "unresolvable",
			reason: "The destination names no link.",
		};
	const { link } = entry;
	const target = resolveFormLinkTarget(doc, args.sourceFormUuid, link.target);
	if (target === undefined)
		return {
			kind: "unresolvable",
			reason: `form link ${link.uuid} starts its form again, but the form is in no menu`,
		};
	const mod = doc.modules[target.moduleUuid];
	if (mod === undefined) {
		return {
			kind: "unresolvable",
			reason: `form link ${link.uuid} targets module ${target.moduleUuid}, which is not in the document`,
		};
	}
	/** Enter a module where the home screen would, carrying the frame's
	 *  selections. */
	const moduleRoute = (moduleUuid: Uuid): AfterSubmitRoute => {
		const caseSelections = args.caseSelections(entry);
		return {
			kind: "module",
			moduleUuid,
			caseSelections,
			landing: moduleLanding({
				isCaseFirst: args.caseFirstModules.has(moduleUuid),
				isBareCaseList: moduleIsBareCaseList(doc, moduleUuid),
				hasSelectedCase:
					args.hasSelectedCase?.(moduleUuid, caseSelections) ?? false,
				hasChildren: Object.values(doc.modules).some(
					(candidate) => candidate.parentModuleUuid === moduleUuid,
				),
			}),
		};
	};
	/* Web Apps rebuilds the session by walking the frame through the menus
	 * it would show (Formplayer `MenuSessionFactory.rebuildSessionFromFrame`,
	 * which matches steps only against `MenuScreen.getMenuDisplayables()`):
	 * a form the menu hides lands on its module, and a module the menu
	 * hides stops the walk on the menu above it, the app's first screen for
	 * a top-level module. Android reads the frame's commands as they stand
	 * and opens the target. */
	if (args.rules.afterSubmitHiddenTarget === "landing") {
		const visibility = args.targetVisibility(target);
		if (visibility === "pending") return { kind: "pending" };
		if (typeof visibility === "object")
			return visibility.shownModuleUuid === null
				? { kind: "post-submit", destination: "firstMenu" }
				: moduleRoute(visibility.shownModuleUuid);
		if (visibility === "form-hidden" && target.type === "form")
			return moduleRoute(target.moduleUuid);
	}
	if (target.type === "module") return moduleRoute(target.moduleUuid);
	if (
		doc.forms[target.formUuid] === undefined ||
		!(doc.formOrder[target.moduleUuid] ?? []).includes(target.formUuid)
	) {
		return {
			kind: "unresolvable",
			reason: `form link ${link.uuid} targets form ${target.formUuid}, which is not in module ${target.moduleUuid}`,
		};
	}
	return {
		kind: "form",
		moduleUuid: target.moduleUuid,
		formUuid: target.formUuid,
		carried: args.carriedCase(entry),
		caseSelections: args.caseSelections(entry),
	};
}

/** The cases a menu selection map holds for each menu of `moduleUuid`'s
 *  chain, the selections a static frame keeps. */
function chainSelectionCases(
	doc: Pick<BlueprintDoc, "modules" | "moduleOrder">,
	moduleUuid: Uuid,
	selections: Readonly<Record<string, PreviewMenuCaseSelection>>,
): AfterSubmitPathCases[] {
	const cases: AfterSubmitPathCases[] = [];
	for (
		let current: Uuid | null | undefined = moduleUuid;
		current;
		current = moduleParent(doc, current)
	) {
		const selection = selections[current];
		if (selection !== undefined)
			cases.unshift({
				moduleUuid: current,
				caseIds: selection.cases.map((choice) => choice.caseId),
			});
	}
	return cases;
}

/** The selections of a frame's route, one step per module. */
function routeSelectionCases(
	caseSelections: readonly TargetCaseSelection[],
	collection: PreviewTargetCaseCollection | undefined,
): AfterSubmitPathCases[] {
	const cases: AfterSubmitPathCases[] = caseSelections.map((selection) => ({
		moduleUuid: selection.moduleUuid,
		caseIds: selection.caseId === "" ? [] : [selection.caseId],
	}));
	if (collection !== undefined)
		cases.unshift({
			moduleUuid: collection.moduleUuid,
			caseIds: collection.cases.map((choice) => choice.caseId),
		});
	return cases;
}

/**
 * The steps a frame installs (`afterSubmitStack.ts`, rule 5): a form route
 * its module chain's menus, a case step per selection it carries, and the
 * form; a module route its chain's menus and the selections it carries; a
 * previous-task route the steps of the task it returns to; `firstMenu` and
 * `app_home` none (HQ's empty `root` frame); `module` and `parentMenu` that
 * menu's chain and the selections its static frame keeps.
 */
export function afterSubmitFrameLanding(args: {
	readonly doc: Pick<BlueprintDoc, "modules" | "moduleOrder">;
	readonly route: AfterSubmitRoute;
	readonly collection?: PreviewTargetCaseCollection;
	/** The submitted form's menu, which `module` and `parentMenu` name. */
	readonly sourceModuleUuid: Uuid | undefined;
	/** The menu selections the static frame keeps, after the submission. */
	readonly selections: Readonly<Record<string, PreviewMenuCaseSelection>>;
}): readonly AfterSubmitPathStep[] {
	const { doc, route } = args;
	switch (route.kind) {
		case "form":
			return afterSubmitPath(
				doc,
				{ moduleUuid: route.moduleUuid, formUuid: route.formUuid },
				routeSelectionCases(route.caseSelections, args.collection),
			);
		case "module":
			return afterSubmitPath(
				doc,
				{ moduleUuid: route.moduleUuid },
				routeSelectionCases(route.caseSelections, args.collection),
			);
		case "previous-task": {
			const destination = route.task.destination;
			return destination.kind === "home"
				? []
				: afterSubmitPath(
						doc,
						{ moduleUuid: destination.moduleUuid },
						chainSelectionCases(
							doc,
							destination.moduleUuid,
							route.task.selections,
						),
					);
		}
		case "post-submit": {
			const moduleUuid =
				route.destination === "module"
					? args.sourceModuleUuid
					: route.destination === "parentMenu" &&
							args.sourceModuleUuid !== undefined
						? (doc.modules[args.sourceModuleUuid]?.parentModuleUuid ??
							undefined)
						: undefined;
			return moduleUuid === undefined
				? []
				: afterSubmitPath(
						doc,
						{ moduleUuid },
						chainSelectionCases(doc, moduleUuid, args.selections),
					);
		}
		case "unresolvable":
		case "pending":
			return [];
	}
}

/** Apply a matched target frame to the running menu session without mutating
 * the current snapshot. Root-to-leaf target order is significant: changing a
 * parent first invalidates stale structural/case descendants, and a later
 * matched child selection then installs the exact replacement. A blank datum
 * remains installed: Core considers a defined blank datum satisfied and does
 * not prompt for it, while the empty id still prevents case-backed work. */
export function previewMenuSelectionsAfterTargetCases(
	menuSource: PreviewMenuSource,
	current: Readonly<Record<string, PreviewMenuCaseSelection>>,
	projected: readonly TargetCaseSelection[],
	caseData?: PostSubmissionCaseData,
	collections: readonly PreviewTargetCaseCollection[] = [],
): Readonly<Record<string, PreviewMenuCaseSelection>> {
	const next: Record<string, PreviewMenuCaseSelection> = { ...current };
	for (const selected of projected) {
		const staleModuleUuids = new Set([
			...previewMenuModuleUuids(menuSource, selected.moduleUuid),
			...previewCaseDescendantModuleUuids(menuSource, selected.caseType),
		]);
		for (const staleModuleUuid of staleModuleUuids) {
			delete next[staleModuleUuid];
		}
		const retained = next[selected.moduleUuid];
		const retainedChoice =
			retained?.cases.length === 1 ? retained.cases[0] : undefined;
		const retainedMatches =
			retained?.caseType === selected.caseType &&
			((selected.caseId === "" && retained.cases.length === 0) ||
				retainedChoice?.caseId === selected.caseId);
		const readBackProperties = caseData?.get(selected.caseType);
		const hydratedProperties =
			selected.caseId !== "" &&
			readBackProperties?.get("case_id") === selected.caseId
				? Object.fromEntries(readBackProperties)
				: undefined;
		next[selected.moduleUuid] = {
			caseType: selected.caseType,
			cases:
				selected.caseId === ""
					? []
					: [
							{
								caseId: selected.caseId,
								caseName:
									selected.caseName ??
									hydratedProperties?.case_name ??
									(retainedMatches ? retainedChoice?.caseName : undefined) ??
									"Case",
								...(hydratedProperties !== undefined
									? { caseProperties: hydratedProperties }
									: retainedMatches &&
											retainedChoice?.caseProperties !== undefined
										? { caseProperties: retainedChoice.caseProperties }
										: {}),
							},
						],
		};
	}
	for (const collection of collections) {
		const staleModuleUuids = new Set([
			...previewMenuModuleUuids(menuSource, collection.moduleUuid),
			...previewCaseDescendantModuleUuids(menuSource, collection.caseType),
		]);
		for (const staleModuleUuid of staleModuleUuids) {
			delete next[staleModuleUuid];
		}
		next[collection.moduleUuid] = {
			caseType: collection.caseType,
			cases: collection.cases,
		};
	}
	return next;
}

/** Whether a target module has a usable own/inherited case after its matched
 * frame selections are applied. */
export function previewTargetHasSelectedCase(args: {
	readonly menuSource: PreviewMenuSource;
	readonly current: Readonly<Record<string, PreviewMenuCaseSelection>>;
	readonly targetModuleUuid: Uuid;
	readonly projected: readonly TargetCaseSelection[];
	readonly collections?: readonly PreviewTargetCaseCollection[];
}): boolean {
	const selected = previewMenuCaseContext(
		args.menuSource,
		args.targetModuleUuid,
		previewMenuSelectionsAfterTargetCases(
			args.menuSource,
			args.current,
			args.projected,
			undefined,
			args.collections,
		),
	).selectedCase;
	return selected !== undefined;
}

/** The cases a submission changed, other than the cases it was opened for or
 * registered, read from the transaction-captured patch: every case its
 * operations created or changed, with the type and name it was saved with.
 * A case datum the entry minted reads its name from here once the case
 * exists. A historical receipt with no patch contributes none. */
export function carriedCasesFromPatch(args: {
	readonly caseDatabasePatch:
		| { readonly rows: readonly CaseDatabaseSnapshot["rows"][number][] }
		| undefined;
	readonly primaryCaseIds: readonly string[];
}): CarriedSubmission["childCases"] {
	const primary = new Set(args.primaryCaseIds);
	return (args.caseDatabasePatch?.rows ?? []).flatMap((row) =>
		primary.has(row.case_id)
			? []
			: [
					{
						caseType: row.case_type,
						caseId: row.case_id,
						...(row.case_name === "" ? {} : { caseName: row.case_name }),
					},
				],
	);
}

/** Preserve the selected-entities collection across an automatic compatible
 * several-case link. The ordinary frame projector is scalar by design; using
 * its first value here would lose order and every case after the first. The
 * exact post-submit device snapshot supplies even a case the submission just
 * closed and a fresh restore would omit. */
export function automaticLinkedCaseCollection(args: {
	readonly choice: AfterSubmitFrameChoice;
	readonly doc: BlueprintDoc;
	readonly sourceModuleUuid: Uuid | undefined;
	readonly sourceFormType: FormType | undefined;
	readonly submittedCases: readonly PreviewCaseChoice[] | undefined;
	readonly resultCaseIds: readonly string[];
	readonly caseDatabase: CaseDatabaseSnapshot;
	/** The submitted form, which `this-form` names. */
	readonly sourceFormUuid: Uuid;
}): PreviewTargetCaseCollection | undefined {
	const entry = frameChoiceEntry(args.choice);
	const target =
		entry === undefined
			? undefined
			: resolveFormLinkTarget(args.doc, args.sourceFormUuid, entry.link.target);
	if (
		entry === undefined ||
		/* HQ's flat module frame contains only the module command. It does not
		 * carry a case-selection datum, so entering that module must begin its
		 * ordinary Results journey instead of inheriting Preview's collection. */
		target?.type !== "form" ||
		entry.link.datums !== undefined ||
		args.sourceModuleUuid === undefined ||
		args.sourceFormType === undefined ||
		!CASE_LOADING_FORM_TYPES.has(args.sourceFormType)
	) {
		return undefined;
	}
	const sourceModule = args.doc.modules[args.sourceModuleUuid];
	const targetModule = args.doc.modules[target.moduleUuid];
	if (
		sourceModule?.caseListConfig?.selection?.kind !== "multiple" ||
		targetModule?.caseListConfig?.selection?.kind !== "multiple" ||
		sourceModule.caseType === undefined ||
		!caseSelectionCanFlowBetweenModules(sourceModule, targetModule)
	) {
		return undefined;
	}
	if (
		!CASE_LOADING_FORM_TYPES.has(
			args.doc.forms[target.formUuid]?.type ?? "survey",
		)
	) {
		return undefined;
	}
	if (
		args.resultCaseIds.length === 0 ||
		args.resultCaseIds.length > targetModule.caseListConfig.selection.maximum
	) {
		throw new Error(
			"A compatible several-case link received a selection outside its target limit.",
		);
	}
	const submittedById = new Map(
		(args.submittedCases ?? []).map(
			(choice) => [choice.caseId, choice] as const,
		),
	);
	const rowById = new Map(
		args.caseDatabase.rows.map((row) => [row.case_id, row] as const),
	);
	const cases = args.resultCaseIds.map((caseId) => {
		const row = rowById.get(caseId);
		if (row === undefined || row.case_type !== sourceModule.caseType) {
			throw new Error(
				"A selected case was missing from the carried post-submit device snapshot.",
			);
		}
		const previous = submittedById.get(caseId);
		return {
			caseId,
			caseName: row.case_name || previous?.caseName || "Case",
			caseProperties: Object.fromEntries(caseRowToFormPreload(row)),
		};
	});
	return {
		moduleUuid: target.moduleUuid,
		caseType: sourceModule.caseType,
		cases,
	};
}
