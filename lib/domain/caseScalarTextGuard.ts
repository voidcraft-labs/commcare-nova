// lib/domain/caseScalarTextGuard.ts
//
// The questions a form's case names and external ids come from. CommCare
// stores both in fixed-width text columns (`caseScalarText.ts`): Core and HQ
// trim them and refuse one past 255 code units, and a case name may not be
// blank. Each such question gets one trimmed sibling in the form's source,
// which every write of the value names, and a visible question carries the
// check itself, so a worker meets the refusal at the question rather than at
// the submission. The emitter and Preview's form engine both read this one
// derivation.

import type { BlueprintDoc } from "./blueprint";
import { formCaseWriteViews } from "./caseWriteViews";
import { type FieldKind, fieldKindCarriesValidation } from "./fields";
import type { Uuid } from "./uuid";

/**
 * How a question's value is checked: a case name may not be blank
 * (`reject`), an external id may (`allow`). Both are refused past 255.
 */
export type CaseScalarTextGuard = "reject" | "allow";

type GuardDoc = Pick<
	BlueprintDoc,
	"forms" | "modules" | "formOrder" | "caseTypes" | "fieldParent" | "refIndex"
>;

/** A property CommCare keeps in a fixed-width text column, trimmed. */
export function isCaseScalarTextProperty(property: string): boolean {
	return property === "case_name" || property === "external_id";
}

/**
 * Whether a guarded question of this kind carries the guard as its
 * constraint: exactly the kinds that carry a validation. A Hidden Value is
 * not among them: HQ's form builder refuses a validation condition on one,
 * and no runtime checks it. The XForm emitter writes the constraint by this
 * and Preview's form engine checks the answer by it.
 */
export function caseScalarTextGuardIsChecked(kind: FieldKind): boolean {
	return fieldKindCarriesValidation(kind);
}

/** One form's guarded questions and its create-name questions. */
interface FormCaseScalarText {
	readonly guards: ReadonlyMap<Uuid, CaseScalarTextGuard>;
	readonly createNames: ReadonlySet<Uuid>;
}

const derived = new WeakMap<GuardDoc, Map<Uuid, FormCaseScalarText>>();

/**
 * Which of a form's operations a basic action carries, where the caller knows
 * (`lib/commcare/placement.ts::placedBasic`). Without it, every save to the
 * form's own case or to a child case under it counts, the candidates a basic
 * action may carry, as the generated-node names are reserved.
 */
export interface CaseScalarTextOptions {
	readonly placedBasic?: (operationUuid: Uuid) => boolean;
}

/**
 * Every question of `formUuid` a case name or an external id reads through a
 * basic action, mapped to its check. It covers the form's own case (a create,
 * a rename or an update, a several-case update included) and every child case
 * it creates beneath it; the worker's own record keeps neither value. A Hidden
 * Value is among them: it takes the trimmed sibling, and no runtime checks a
 * constraint on it.
 */
export function caseScalarTextGuards(
	doc: GuardDoc,
	formUuid: Uuid,
	options: CaseScalarTextOptions = {},
): ReadonlyMap<Uuid, CaseScalarTextGuard> {
	return formCaseScalarText(doc, formUuid, options).guards;
}

/**
 * The questions of `formUuid` that name a case the form creates: its own on
 * a registration form, and each child case. CommCare requires an answer to
 * each.
 */
export function caseCreateNameFields(
	doc: GuardDoc,
	formUuid: Uuid,
	options: CaseScalarTextOptions = {},
): ReadonlySet<Uuid> {
	return formCaseScalarText(doc, formUuid, options).createNames;
}

/** Both sets, derived in one pass; the candidates once per document object. */
function formCaseScalarText(
	doc: GuardDoc,
	formUuid: Uuid,
	options: CaseScalarTextOptions,
): FormCaseScalarText {
	if (options.placedBasic !== undefined)
		return deriveFormCaseScalarText(doc, formUuid, options.placedBasic);
	let forms = derived.get(doc);
	if (forms === undefined) {
		forms = new Map();
		derived.set(doc, forms);
	}
	let result = forms.get(formUuid);
	if (result === undefined) {
		result = deriveFormCaseScalarText(doc, formUuid);
		forms.set(formUuid, result);
	}
	return result;
}

function deriveFormCaseScalarText(
	doc: GuardDoc,
	formUuid: Uuid,
	placedBasic?: (operationUuid: Uuid) => boolean,
): FormCaseScalarText {
	const guards = new Map<Uuid, CaseScalarTextGuard>();
	const createNames = new Set<Uuid>();
	const form = doc.forms[formUuid];
	if (form === undefined) return { guards, createNames };
	const creates = new Set(
		(form.caseOperations ?? [])
			.filter(
				(operation) =>
					operation.action === "create" ||
					(operation.action === "own" && form.type === "registration"),
			)
			.map((operation) => operation.uuid),
	);
	for (const [fieldUuid, views] of formCaseWriteViews(doc, formUuid)) {
		for (const view of views) {
			// Only a basic action reads the trimmed sibling: the form's own case
			// and a child case under it. Any other operation is a Save to Case
			// block, which trims and checks its own values
			// (`nova_guard_<operation id>_text`). The worker's record keeps
			// neither value, and a capture's link is refused as either
			// (`CAPTURE_CASE_WRITE_STANDARD_PROPERTY`).
			if (view.destination !== "own" && view.destination !== "child") continue;
			if (placedBasic !== undefined && !placedBasic(view.operationUuid))
				continue;
			if (view.link) continue;
			if (!isCaseScalarTextProperty(view.property)) continue;
			if (view.property === "case_name") {
				guards.set(fieldUuid, "reject");
				if (creates.has(view.operationUuid)) createNames.add(fieldUuid);
			} else if (!guards.has(fieldUuid)) {
				guards.set(fieldUuid, "allow");
			}
		}
	}
	return { guards, createNames };
}
