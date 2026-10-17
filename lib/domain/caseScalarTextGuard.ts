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
import { deriveCaseWriteInventory } from "./caseWriteInventory";
import { type FieldKind, fieldKindCarriesValidation } from "./fields";
import { moduleUuidOfForm } from "./postSubmit";
import type { Uuid } from "./uuid";

/**
 * How a question's value is checked: a case name may not be blank
 * (`reject`), an external id may (`allow`). Both are refused past 255.
 */
export type CaseScalarTextGuard = "reject" | "allow";

type GuardDoc = Pick<
	BlueprintDoc,
	| "forms"
	| "modules"
	| "formOrder"
	| "fields"
	| "fieldOrder"
	| "caseTypes"
	| "userProperties"
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
 * Every question of `formUuid` a case name or an external id reads, mapped to
 * its check. It covers the form's own case (a create, a rename or an update,
 * a several-case update included) and every child case it creates; the
 * worker's own record keeps neither value. A Hidden Value is among them: it
 * takes the trimmed sibling, and no runtime checks a constraint on it.
 */
export function caseScalarTextGuards(
	doc: GuardDoc,
	formUuid: Uuid,
): ReadonlyMap<Uuid, CaseScalarTextGuard> {
	return formCaseScalarText(doc, formUuid).guards;
}

/**
 * The questions of `formUuid` that name a case the form creates: its own on
 * a registration form, and each child case. CommCare requires an answer to
 * each.
 */
export function caseCreateNameFields(
	doc: GuardDoc,
	formUuid: Uuid,
): ReadonlySet<Uuid> {
	return formCaseScalarText(doc, formUuid).createNames;
}

/** Both sets, derived in one pass once per document object. */
function formCaseScalarText(doc: GuardDoc, formUuid: Uuid): FormCaseScalarText {
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
): FormCaseScalarText {
	const guards = new Map<Uuid, CaseScalarTextGuard>();
	const createNames = new Set<Uuid>();
	const form = doc.forms[formUuid];
	if (form === undefined) return { guards, createNames };
	const moduleUuid = moduleUuidOfForm(doc, formUuid);
	const module = moduleUuid === undefined ? undefined : doc.modules[moduleUuid];
	const inventory = deriveCaseWriteInventory(
		doc,
		formUuid,
		{ caseType: module?.caseType },
		form.type,
	);
	for (const bucket of inventory.buckets) {
		if (bucket.kind === "usercase") continue;
		for (const writer of bucket.writers) {
			if (!isCaseScalarTextProperty(writer.property)) continue;
			if (writer.property === "case_name") {
				guards.set(writer.fieldUuid, "reject");
				if (bucket.action === "create") createNames.add(writer.fieldUuid);
			} else if (!guards.has(writer.fieldUuid)) {
				guards.set(writer.fieldUuid, "allow");
			}
		}
	}
	return { guards, createNames };
}
