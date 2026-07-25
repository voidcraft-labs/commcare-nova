// components/builder/case-operations/formFieldScope.ts
//
// Which of a form's answers one case operation may read.
//
// This is the editor half of a commit-gate rule, and it exists so the
// two can never disagree. `caseOperations.ts::validateOperationTerm`
// refuses a `field` reference whose repeat scope does not match the
// operation's:
//
//   - a singular operation cannot read an answer that has one value per
//     repeat iteration (which value would it mean?);
//   - a repeated operation may read repeated answers only from the exact
//     repeat it runs over.
//
// So the picker is handed exactly the admissible answers rather than the
// whole form, and no sequence of choices can author a reference the gate
// would bounce. The same walk feeds the identity-key picker, which is
// narrower still: an authored create id must be a scalar string.

import type { EditorFormFieldDecl } from "@/components/builder/shared/formFieldPresentation";
import type { BlueprintDoc } from "@/lib/domain";
import {
	type CaseOperation,
	caseDataTypeForFieldKind,
	type Field,
	type Uuid,
} from "@/lib/domain";
import {
	type Predicate,
	type Term,
	type ValueExpression,
	walkExpressionTerms,
	walkTerms,
} from "@/lib/domain/predicate";

interface ScopedField {
	readonly field: Field;
	/** The innermost repeat containing the field, if any. */
	readonly repeat: Uuid | undefined;
}

/** Every field in the form, innermost-repeat-tagged, in canvas order. */
function walkFormFields(
	doc: Pick<BlueprintDoc, "fields" | "fieldOrder">,
	formUuid: Uuid,
): ScopedField[] {
	const found: ScopedField[] = [];
	const walk = (parent: Uuid, repeat: Uuid | undefined) => {
		for (const uuid of doc.fieldOrder[parent] ?? []) {
			const field = doc.fields[uuid];
			if (field === undefined) continue;
			const inner = field.kind === "repeat" ? field.uuid : repeat;
			found.push({ field, repeat: inner });
			walk(uuid, inner);
		}
	};
	walk(formUuid, undefined);
	return found;
}

function fieldLabel(field: Field): string {
	const label = "label" in field ? (field.label ?? "").trim() : "";
	return label.length > 0 ? label : field.id;
}

function declOf(field: Field): EditorFormFieldDecl {
	return {
		uuid: field.uuid,
		label: fieldLabel(field),
		id: field.id,
		dataType: caseDataTypeForFieldKind(field.kind),
	};
}

/** Whether a field carries an answer an expression can read at all. */
function carriesAnswer(field: Field): boolean {
	// A hidden field has no data type of its own but always holds a value —
	// the same admission `expressionContext` gives the validator's checker.
	return (
		caseDataTypeForFieldKind(field.kind) !== undefined ||
		field.kind === "hidden"
	);
}

/**
 * The answers an operation running over `repeat` (or `undefined` for a
 * singular operation) may read, in canvas order.
 */
export function operationFormFieldDecls(
	doc: Pick<BlueprintDoc, "fields" | "fieldOrder">,
	formUuid: Uuid,
	repeat: Uuid | undefined,
): readonly EditorFormFieldDecl[] {
	return walkFormFields(doc, formUuid)
		.filter(
			(scoped) =>
				carriesAnswer(scoped.field) &&
				(scoped.repeat === undefined || scoped.repeat === repeat),
		)
		.map((scoped) => declOf(scoped.field));
}

/**
 * The answers that can key an authored create — a scalar string the
 * author already collects, correlated to the operation's own repeat.
 * A multi-select answer is an array in Nova and cannot be an identity.
 */
export function identityKeyFieldDecls(
	doc: Pick<BlueprintDoc, "fields" | "fieldOrder">,
	formUuid: Uuid,
	repeat: Uuid | undefined,
): readonly EditorFormFieldDecl[] {
	return walkFormFields(doc, formUuid)
		.filter((scoped) => {
			if (scoped.repeat !== repeat) return false;
			const dataType = caseDataTypeForFieldKind(scoped.field.kind);
			if (scoped.field.kind === "hidden") return true;
			return dataType === "text" || dataType === "single_select";
		})
		.map((scoped) => declOf(scoped.field));
}

/** Every repeat in the form, for the multiplicity picker. */
export function repeatFieldDecls(
	doc: Pick<BlueprintDoc, "fields" | "fieldOrder">,
	formUuid: Uuid,
): readonly EditorFormFieldDecl[] {
	return walkFormFields(doc, formUuid)
		.filter((scoped) => scoped.field.kind === "repeat")
		.map((scoped) => declOf(scoped.field));
}

/** Whether an operation's saved reads survive a change of multiplicity. */
export function operationReadsOutsideRepeat(
	doc: Pick<BlueprintDoc, "fields" | "fieldOrder">,
	formUuid: Uuid,
	operation: CaseOperation,
	nextRepeat: Uuid | undefined,
): boolean {
	const admissible = new Set(
		operationFormFieldDecls(doc, formUuid, nextRepeat).map((decl) => decl.uuid),
	);
	return referencedFieldUuids(operation).some((uuid) => !admissible.has(uuid));
}

/**
 * Every form answer this operation reads, in no particular order.
 *
 * Walks the typed ASTs rather than the object graph, and counts a
 * `new` target's identity key: `idFrom` is a field reference the same
 * repeat-correlation rule governs, even though it is not a `field` term.
 */
export function referencedFieldUuids(
	operation: CaseOperation,
): readonly Uuid[] {
	const found = new Set<Uuid>();
	const visitTerm = (term: Term) => {
		if (term.kind === "field") found.add(term.uuid);
	};
	const expression = (value: ValueExpression | undefined) => {
		if (value !== undefined) walkExpressionTerms(value, visitTerm);
	};
	const predicate = (value: Predicate | undefined) => {
		if (value !== undefined) walkTerms(value, visitTerm);
	};
	const target = (value: CaseOperation["target"] | null) => {
		if (value === null) return;
		if (value.kind === "expression") expression(value.expr);
		if (value.kind === "new" && value.idFrom !== undefined) {
			found.add(value.idFrom);
		}
	};

	target(operation.target);
	predicate(operation.condition);
	expression(operation.name);
	expression(operation.owner);
	expression(operation.rename);
	for (const write of operation.writes ?? []) {
		expression(write.value);
		predicate(write.condition);
	}
	for (const link of operation.links ?? []) target(link.target);
	return [...found];
}
