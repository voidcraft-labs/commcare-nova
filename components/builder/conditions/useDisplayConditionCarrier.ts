// components/builder/conditions/useDisplayConditionCarrier.ts
//
// The one derivation both display-condition surfaces read: which item
// the condition belongs to, what it currently says, and how to write it.
// The settings row and the centre-canvas editor must agree about the
// evaluation scope: the row seeds a condition the editor then has to
// accept, so they resolve it once, here, rather than each rebuilding
// the carrier from the doc.

"use client";

import { useCallback, useMemo } from "react";
import {
	setFormDisplayConditionMutation,
	setModuleDisplayConditionMutation,
} from "@/lib/doc/displayConditionMutations";
import {
	type CommitOutcome,
	useBlueprintMutations,
} from "@/lib/doc/hooks/useBlueprintMutations";
import { useEffectiveCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import { useForm, useModule } from "@/lib/doc/hooks/useEntity";
import {
	useIsBareCaseListModule,
	useIsCaseFirstModule,
	useOrderedForms,
} from "@/lib/doc/hooks/useModuleIds";
import type { Uuid } from "@/lib/doc/types";
import type { CaseType } from "@/lib/domain";
import type { Predicate } from "@/lib/domain/predicate";
import {
	type DisplayConditionCarrier,
	type DisplayConditionCopy,
	displayConditionCopy,
} from "./displayConditionCopy";

/** Which item's display condition a surface is showing. */
export type DisplayConditionTarget =
	| { readonly kind: "module"; readonly moduleUuid: Uuid }
	| {
			readonly kind: "form";
			readonly moduleUuid: Uuid;
			readonly formUuid: Uuid;
	  };

export interface ResolvedDisplayCondition {
	readonly copy: DisplayConditionCopy;
	/** The stored condition, or `undefined` when the item always appears. */
	readonly condition: Predicate | undefined;
	/**
	 * Set the condition, or remove it with `undefined`. Returns the
	 * gate's verdict rather than announcing it: a condition surface has
	 * somewhere to put the refusal, beside the rule it is about.
	 */
	readonly commit: (next: Predicate | undefined) => CommitOutcome;
	readonly caseTypes: readonly CaseType[];
	/** The owning module's case type, or `""` when it declares none. */
	readonly currentCaseType: string;
}

/**
 * Resolve a target against the live document. Returns `null` while the
 * item is absent: a stale deep link the recovery effect is about to
 * scrub, or a peer's deletion landing under an open surface.
 */
export function useDisplayConditionCarrier(
	target: DisplayConditionTarget,
): ResolvedDisplayCondition | null {
	const mod = useModule(target.moduleUuid);
	const parentModule = useModule(mod?.parentModuleUuid);
	const form = useForm(target.kind === "form" ? target.formUuid : undefined);
	const forms = useOrderedForms(target.moduleUuid);
	const caseFirst = useIsCaseFirstModule(target.moduleUuid);
	const moduleIsBareCaseList = useIsBareCaseListModule(target.moduleUuid);
	const caseTypes = useEffectiveCaseTypes();
	const mutations = useBlueprintMutations();

	const carrier = useMemo<DisplayConditionCarrier | null>(() => {
		if (mod === undefined) return null;
		if (target.kind === "module") {
			return {
				kind: "module",
				moduleName: mod.name,
				parentModuleName: parentModule?.name,
				moduleIsBareCaseList,
			};
		}
		if (form === undefined) return null;
		return {
			kind: "form",
			formName: form.name,
			moduleName: mod.name,
			caseFirst,
			caseType: mod.caseType,
			formCount: forms.length,
		};
	}, [
		mod,
		parentModule,
		form,
		forms,
		caseFirst,
		moduleIsBareCaseList,
		target.kind,
	]);

	const targetKind = target.kind;
	const moduleUuid = target.moduleUuid;
	const formUuid = target.kind === "form" ? target.formUuid : undefined;
	const commit = useCallback(
		(next: Predicate | undefined): CommitOutcome => {
			if (targetKind === "form" && formUuid === undefined) {
				// Unreachable through the target union; failing loudly beats
				// silently writing the MODULE's condition instead.
				throw new Error(
					"A form display-condition target reached the writer without its form.",
				);
			}
			return mutations.inline.commitMany([
				formUuid === undefined
					? setModuleDisplayConditionMutation(moduleUuid, next)
					: setFormDisplayConditionMutation(formUuid, next),
			]);
		},
		[mutations, targetKind, moduleUuid, formUuid],
	);

	return useMemo(() => {
		if (carrier === null || mod === undefined) return null;
		return {
			copy: displayConditionCopy(carrier),
			condition:
				carrier.kind === "module"
					? mod.displayCondition
					: form?.displayCondition,
			commit,
			caseTypes,
			currentCaseType: mod.caseType ?? "",
		};
	}, [carrier, mod, form, commit, caseTypes]);
}
