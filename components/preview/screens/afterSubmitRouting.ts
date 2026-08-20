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
} from "@/lib/preview/engine/formLinkEvaluation";
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
	  }
	/** A link to a form, with the case it opens with (if it selects one). */
	| {
			readonly kind: "form";
			readonly moduleUuid: Uuid;
			readonly formUuid: Uuid;
			readonly carried: CarriedCase;
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
		return {
			kind: "module",
			moduleUuid: target.moduleUuid,
			landing: moduleLanding({
				isCaseFirst: args.caseFirstModules.has(target.moduleUuid),
				isBareCaseList: mod.caseListOnly === true,
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
	};
}
