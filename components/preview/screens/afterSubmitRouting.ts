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
	 * The link fired but its target is not in the document. The gate keeps
	 * links and their targets consistent, so this is a bypass or a race the
	 * screen must report rather than route around.
	 */
	| { readonly kind: "unresolvable"; readonly reason: string };

export function afterSubmitRoute(args: {
	readonly choice: AfterSubmitChoice;
	readonly doc: Pick<BlueprintDoc, "modules" | "forms" | "formOrder">;
	/** Modules whose every form loads a case (`useCaseFirstModuleUuids`). */
	readonly caseFirstModules: ReadonlySet<Uuid>;
	/** Whether the target has a usable case after applying this frame's
	 * projected selections to the running menu session. This admits same-type
	 * structural inheritance while keeping a defined-but-blank datum false. */
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
}): AfterSubmitRoute {
	const { choice, doc } = args;
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
 * clears its owning module rather than becoming a truthy selected-case shell. */
export function previewMenuSelectionsAfterTargetCases(
	menuSource: PreviewMenuSource,
	current: Readonly<Record<string, PreviewMenuCaseSelection>>,
	projected: readonly TargetCaseSelection[],
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
		if (selected.caseId === "") {
			delete next[selected.moduleUuid];
		} else {
			const retained = next[selected.moduleUuid];
			next[selected.moduleUuid] = {
				caseType: selected.caseType,
				caseId: selected.caseId,
				caseName: selected.caseName ?? retained?.caseName ?? "Case",
				...(retained?.caseType === selected.caseType &&
				retained.caseId === selected.caseId &&
				retained.caseProperties !== undefined
					? { caseProperties: retained.caseProperties }
					: {}),
			};
		}
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
}): boolean {
	const selected = previewMenuCaseContext(
		args.menuSource,
		args.targetModuleUuid,
		previewMenuSelectionsAfterTargetCases(
			args.menuSource,
			args.current,
			args.projected,
		),
	).selectedCase;
	return selected !== undefined && selected.caseId !== "";
}
