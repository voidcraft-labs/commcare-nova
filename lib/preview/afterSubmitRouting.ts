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
 * `evaluateFormLinks` says WHICH link fires (or that none does); this says
 * what the screen does about it: which screen to push, with which case, or
 * that the answer cannot be acted on. The component performs the effect. No
 * React and no DOM, so the whole routing table is checked directly.
 */

import type {
	BlueprintDoc,
	FormLink,
	PostSubmitDestination,
	Uuid,
} from "@/lib/domain";
import { type ModuleLanding, moduleLanding } from "@/lib/domain";
import { moduleParent } from "@/lib/domain/moduleHierarchy";
import type { CreatedChildCaseReceipt } from "@/lib/preview/engine/caseDataBindingTypes";
import type {
	AfterSubmitChoice,
	CarriedCase,
	CarriedSubmission,
	PostSubmissionCaseData,
	TargetCaseSelection,
} from "@/lib/preview/engine/formLinkEvaluation";
import {
	type PreviewMenuSource,
	previewCaseDescendantModuleUuids,
	previewMenuCaseContext,
	previewMenuModuleUuids,
} from "@/lib/preview/menuProjection";
import type { PreviewMenuCaseSelection } from "@/lib/session/types";
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
	readonly link: FormLink;
	readonly session: PreviewSearchSessionValues;
	readonly lookup: PreviewLookupStatus;
	readonly deviceCases: NavigationDeviceCases;
	readonly caseSelections: readonly TargetCaseSelection[];
}): AfterSubmitTargetVisibility {
	const { doc, link } = args;
	const target = link.target;
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

export function afterSubmitRoute(args: {
	readonly previousTask?: () => PreviousTask;
	readonly choice: AfterSubmitChoice;
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
	readonly caseSelections: (link: FormLink) => readonly TargetCaseSelection[];
	/** Resolves the case a FORM target opens with; called only for a target
	 *  the document holds. */
	readonly carriedCase: (link: FormLink) => CarriedCase;
	/** The platform Preview plays: whether a target the worker's menu hides
	 *  opens (Android) or lands where Web Apps' menu walk lands it. */
	readonly rules: Pick<PreviewPlatformRules, "afterSubmitHiddenTarget">;
	/** Whether the link's target is on the worker's menu
	 *  (`afterSubmitTargetVisibility`), read only on Web Apps. */
	readonly targetVisibility: (link: FormLink) => AfterSubmitTargetVisibility;
}): AfterSubmitRoute {
	const { choice, doc } = args;
	if (choice.kind === "fallback") {
		if (choice.destination === "previous")
			return args.previousTask
				? { kind: "previous-task", task: args.previousTask() }
				: {
						kind: "unresolvable",
						reason:
							"The preceding task was not resolved from the submitted entry.",
					};
		return { kind: "post-submit", destination: choice.destination };
	}
	const { link } = choice;
	const target = link.target;
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
		const caseSelections = args.caseSelections(link);
		return {
			kind: "module",
			moduleUuid,
			caseSelections,
			landing: moduleLanding({
				isCaseFirst: args.caseFirstModules.has(moduleUuid),
				isBareCaseList: doc.modules[moduleUuid]?.caseListOnly === true,
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
		const visibility = args.targetVisibility(link);
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
		carried: args.carriedCase(link),
		caseSelections: args.caseSelections(link),
	};
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

/** Join concrete created-child ids to their authored metadata through the
 * durable receipt's explicit authored-child index. `undefined` is the
 * deliberate historical-receipt path: the old flat ids are replayable but do
 * not prove metadata, so they contribute no carried child cases. */
export function carriedChildCasesFromReceipt(args: {
	readonly createdChildren: readonly CreatedChildCaseReceipt[] | undefined;
	readonly authoredChildren: readonly {
		readonly caseType: string;
		readonly caseName?: string;
	}[];
	readonly parentCaseIds: readonly string[];
}): CarriedSubmission["childCases"] {
	if (args.createdChildren === undefined) return [];
	const expectedCount =
		args.authoredChildren.length * args.parentCaseIds.length;
	if (args.createdChildren.length !== expectedCount) {
		throw new Error(
			"The accepted submission returned an incomplete created-child receipt.",
		);
	}
	const expectedPairs = new Set(
		args.authoredChildren.flatMap((_child, authoredChildIndex) =>
			args.parentCaseIds.map(
				(parentCaseId) => `${authoredChildIndex}\u0000${parentCaseId}`,
			),
		),
	);
	const seenPairs = new Set<string>();
	return args.createdChildren.map((createdChild) => {
		const child = args.authoredChildren[createdChild.authoredChildIndex];
		const pair = `${createdChild.authoredChildIndex}\u0000${createdChild.parentCaseId}`;
		if (
			child === undefined ||
			!expectedPairs.has(pair) ||
			seenPairs.has(pair)
		) {
			throw new Error(
				"The accepted submission returned an invalid created-child receipt.",
			);
		}
		seenPairs.add(pair);
		return {
			caseType: child.caseType,
			caseId: createdChild.caseId,
			...(child.caseName !== undefined && { caseName: child.caseName }),
		};
	});
}

/** Preserve the selected-entities collection across an automatic compatible
 * several-case link. The ordinary frame projector is scalar by design; using
 * its first value here would lose order and every case after the first. The
 * exact post-submit device snapshot supplies even a case the submission just
 * closed and a fresh restore would omit. */
export function automaticLinkedCaseCollection(args: {
	readonly choice: AfterSubmitChoice;
	readonly doc: BlueprintDoc;
	readonly sourceModuleUuid: Uuid | undefined;
	readonly sourceFormType: FormType | undefined;
	readonly submittedCases: readonly PreviewCaseChoice[] | undefined;
	readonly resultCaseIds: readonly string[];
	readonly caseDatabase: CaseDatabaseSnapshot;
}): PreviewTargetCaseCollection | undefined {
	if (
		args.choice.kind !== "link" ||
		/* HQ's flat module frame contains only the module command. It does not
		 * carry a case-selection datum, so entering that module must begin its
		 * ordinary Results journey instead of inheriting Preview's collection. */
		args.choice.link.target.type !== "form" ||
		args.choice.link.datums !== undefined ||
		args.sourceModuleUuid === undefined ||
		args.sourceFormType === undefined ||
		!CASE_LOADING_FORM_TYPES.has(args.sourceFormType)
	) {
		return undefined;
	}
	const sourceModule = args.doc.modules[args.sourceModuleUuid];
	const targetModule = args.doc.modules[args.choice.link.target.moduleUuid];
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
			args.doc.forms[args.choice.link.target.formUuid]?.type ?? "survey",
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
		moduleUuid: args.choice.link.target.moduleUuid,
		caseType: sourceModule.caseType,
		cases,
	};
}
