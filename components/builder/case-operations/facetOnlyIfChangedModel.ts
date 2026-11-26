// components/builder/case-operations/facetOnlyIfChangedModel.ts
//
// The Save only if changed switch under a case change's new name or its
// owner, as pure state.
//
// CommCare HQ saves a case's name and owner only when changed as it saves any
// other value (`lib/domain/forms.ts::CaseFacetOnlyIfChanged`): a rename of a
// case the form loaded is compared with the case's name, and an owner with
// nothing, since a case holds its owner apart from its values, so an owner is
// saved whenever the worker gives one. A new case's name has no earlier value
// to compare with, and an owner that is the worker or no one is never blank,
// so neither is offered. The switch commits one whole operation, offered by
// the gate's verdict over it, as the own write menu's switch does.

import {
	KEPT_IN_SAVE_TO_CASE_REASON,
	SAVE_NEW_OWNER_ONLY_IF_ANSWERED_LINE,
	SAVE_ONLY_IF_CHANGED_LABEL,
	SAVE_OWNER_ONLY_IF_ANSWERED_LINE,
} from "@/components/builder/editor/fields/caseWriteRowModel";
import type { CaseOperation, Form } from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression/types";
import type { OwnWriteVerdict } from "./ownWriteMenuModel";

/** The switch's line under a new name: it is compared with the case's name. */
export const SAVE_NAME_ONLY_IF_CHANGED_LINE =
	"Saves the new name only when it differs from the case's name.";

export interface FacetOnlyIfChangedSwitch {
	readonly label: string;
	readonly line: string;
	readonly on: boolean;
	/** Why the switch can't be turned on; absent where it can be toggled. */
	readonly disabledReason?: string;
	/** The whole operation toggling the switch commits. */
	readonly next: CaseOperation;
}

interface FacetSwitchInput {
	readonly facet: "name" | "owner";
	readonly operation: CaseOperation;
	readonly formType: Form["type"];
	/** Whether CommCare HQ keeps this change in Save to Case. */
	readonly inSaveToCase: boolean;
	/** The gate's verdict over one complete operation. */
	readonly verdict: (operation: CaseOperation) => OwnWriteVerdict;
}

/** The flag that saves `facet` of `operation` only when changed, where one
 *  is offered. */
function flagOf(
	facet: "name" | "owner",
	operation: CaseOperation,
	formType: Form["type"],
):
	| "nameOnlyIfChanged"
	| "renameOnlyIfChanged"
	| "ownerOnlyIfChanged"
	| undefined {
	if (facet === "owner") {
		const kind = operation.owner?.kind;
		if (
			operation.action === "close" ||
			operation.owner === undefined ||
			kind === "acting-user" ||
			kind === "unowned"
		)
			return undefined;
		return "ownerOnlyIfChanged";
	}
	if (operation.action === "own")
		return formType === "registration" || operation.name === undefined
			? undefined
			: "nameOnlyIfChanged";
	if (operation.action === "update" && operation.rename !== undefined)
		return "renameOnlyIfChanged";
	return undefined;
}

/**
 * The switch under `facet` of `operation`, or `undefined` where the facet
 * offers none: no such facet, a new case's name, or an owner that is never
 * blank.
 */
export function facetOnlyIfChangedSwitch(
	input: FacetSwitchInput,
): FacetOnlyIfChangedSwitch | undefined {
	const { facet, operation, formType, inSaveToCase, verdict } = input;
	const flag = flagOf(facet, operation, formType);
	if (flag === undefined) return undefined;
	const on = (operation as { readonly [key: string]: unknown })[flag] === true;
	const createsCase =
		operation.action === "create" ||
		(operation.action === "own" && formType === "registration");
	const next = { ...operation } as Record<string, unknown>;
	if (on) delete next[flag];
	else next[flag] = true;
	const base = {
		label: SAVE_ONLY_IF_CHANGED_LABEL,
		line:
			facet === "name"
				? SAVE_NAME_ONLY_IF_CHANGED_LINE
				: createsCase
					? SAVE_NEW_OWNER_ONLY_IF_ANSWERED_LINE
					: SAVE_OWNER_ONLY_IF_ANSWERED_LINE,
		on,
		next: next as unknown as CaseOperation,
	};
	if (on) return base;
	if (inSaveToCase)
		return { ...base, disabledReason: KEPT_IN_SAVE_TO_CASE_REASON };
	const answer = verdict(base.next);
	return answer.ok ? base : { ...base, disabledReason: answer.reason };
}

/**
 * `operation` with `owner` as its owner. An owner that offers no switch (the
 * worker or no one, which is never blank, or none) takes the operation's
 * Save only if changed with it, so choosing it commits an operation the
 * gate holds instead of one it refuses for a switch the canvas no longer
 * shows.
 */
export function withOwner(
	operation: CaseOperation,
	owner: Expression | undefined,
	formType: Form["type"],
): CaseOperation {
	const next = { ...operation, owner } as Record<string, unknown>;
	if (flagOf("owner", next as unknown as CaseOperation, formType) === undefined)
		delete next.ownerOnlyIfChanged;
	return next as unknown as CaseOperation;
}
