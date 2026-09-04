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
import type {
	AfterSubmitChoice,
	CarriedCase,
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
import { type ModuleLanding, moduleLanding } from "./moduleLanding";

export type AfterSubmitRoute =
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
	 * A no-matches registration form registered a case: back to the host
	 * module's Results, showing exactly that case (the wire's
	 * `CaseListFormWorkflow` return frame re-keys the inline search to the
	 * new case id). The host lands on its case list whether or not it has
	 * menu forms, because Results IS the screen the search left.
	 */
	| {
			readonly kind: "results-with-registered-case";
			readonly moduleUuid: Uuid;
			readonly caseId: string;
	  }
	/**
	 * The link fired but its target is not in the document. The gate keeps
	 * links and their targets consistent, so this is a bypass or a race the
	 * screen must report rather than route around.
	 */
	| { readonly kind: "unresolvable"; readonly reason: string };

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
	/** Present when a no-matches registration form just registered this
	 * case. The gate keeps such a form free of links, so this decides the
	 * route before any link is consulted. */
	readonly noMatchesRegistration?: {
		readonly moduleUuid: Uuid;
		readonly caseId: string;
	};
}): AfterSubmitRoute {
	const { choice, doc } = args;
	if (args.noMatchesRegistration !== undefined) {
		return {
			kind: "results-with-registered-case",
			moduleUuid: args.noMatchesRegistration.moduleUuid,
			caseId: args.noMatchesRegistration.caseId,
		};
	}
	if (choice.kind === "fallback") {
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
	if (target.type === "module") {
		const caseSelections = args.caseSelections(link);
		return {
			kind: "module",
			moduleUuid: target.moduleUuid,
			caseSelections,
			landing: moduleLanding({
				isCaseFirst: args.caseFirstModules.has(target.moduleUuid),
				isBareCaseList: mod.caseListOnly === true,
				hasSelectedCase:
					args.hasSelectedCase?.(target.moduleUuid, caseSelections) ?? false,
				hasChildren: Object.values(doc.modules).some(
					(candidate) => candidate.parentModuleUuid === target.moduleUuid,
				),
			}),
		};
	}
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
