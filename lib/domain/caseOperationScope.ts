// lib/domain/caseOperationScope.ts
//
// Which of a form's answers one case operation can reach.
//
// This is ONE rule with two callers that must never disagree: the
// validator refuses a reference that breaks it
// (`rules/caseOperations.ts::validateOperationTerm` and the identity-key
// arm of `validateOperation`), and the builder's answer pickers offer
// only references that satisfy it
// (`components/builder/case-operations/formFieldScope.ts`). If the
// editor were stricter it would hide legal authoring; if it were looser
// it would offer a choice the commit gate then rejects — the
// offer-then-reject drift valid-by-construction exists to prevent.
//
// So the rule lives here rather than in either caller, in the domain
// vocabulary both already speak.

import type { CasePropertyDataType } from "./casePropertyTypes";
import type { Uuid } from "./uuid";

/**
 * Whether an operation may read an answer, by repeat scope alone.
 *
 * An answer outside every repeat has one value per submission and is
 * always readable. An answer inside a repeat has one value per
 * iteration, so only an operation running over that exact repeat can
 * mean one of them: a singular operation would have no way to say which
 * iteration, and an operation over a DIFFERENT repeat has no iteration
 * of this one to correlate with.
 */
export function operationCanReadFormField(
	fieldRepeat: Uuid | undefined,
	operationRepeat: Uuid | undefined,
): boolean {
	if (fieldRepeat === undefined) return true;
	return fieldRepeat === operationRepeat;
}

/**
 * Whether an answer can serve as an authored create's identity key.
 *
 * The key becomes part of a case id, so it must be one string: a
 * multi-select answer is an array in Nova and a container holds no
 * answer at all. A hidden field declares no data type but always holds a
 * scalar value, which is exactly what a computed key usually is.
 */
export function formFieldCanKeyCreate(field: {
	readonly kind: string;
	readonly dataType: CasePropertyDataType | undefined;
}): boolean {
	if (field.kind === "hidden") return true;
	return field.dataType === "text" || field.dataType === "single_select";
}
