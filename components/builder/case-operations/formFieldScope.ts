// components/builder/case-operations/formFieldScope.ts
//
// Which of a form's answers one case operation may read.
//
// The rules themselves are NOT here: `operationCanReadFormField` and
// `formFieldCanKeyCreate` live in `lib/domain/caseOperationScope.ts` and
// the validator calls the same two functions
// (`rules/caseOperations.ts::validateOperationTerm` and the identity-key
// arm of `validateOperation`). This module only applies them to a form's
// answers, so the picker offers exactly what the commit gate accepts and
// there is no second implementation to keep in step.
//
// Pure over `FormFieldEntry[]` (`lib/doc/hooks/useFormFieldEntries`), so
// the application is unit-testable without a document or a render.

import type { EditorFormFieldDecl } from "@/components/builder/shared/formFieldPresentation";
import type { FormFieldEntry } from "@/lib/doc/hooks/useFormFieldEntries";
import {
	type CaseOperation,
	formFieldCanKeyCreate,
	operationCanReadFormField,
	type Uuid,
} from "@/lib/domain";
import {
	type Predicate,
	type Term,
	type ValueExpression,
	walkExpressionTerms,
	walkTerms,
} from "@/lib/domain/predicate";

function declOf(entry: FormFieldEntry): EditorFormFieldDecl {
	return {
		uuid: entry.uuid,
		label: entry.label,
		id: entry.id,
		dataType: entry.dataType,
	};
}

/** Whether a field carries an answer an expression can read at all. */
function carriesAnswer(entry: FormFieldEntry): boolean {
	// A hidden field has no data type of its own but always holds a value —
	// the same admission `expressionContext` gives the validator's checker.
	return entry.dataType !== undefined || entry.kind === "hidden";
}

/**
 * The answers an operation running over `repeat` (or `undefined` for a
 * singular operation) may read, in canvas order.
 */
export function operationFormFieldDecls(
	entries: readonly FormFieldEntry[],
	repeat: Uuid | undefined,
): readonly EditorFormFieldDecl[] {
	return entries
		.filter(
			(entry) =>
				carriesAnswer(entry) && operationCanReadFormField(entry.repeat, repeat),
		)
		.map(declOf);
}

/**
 * The answers that can key an authored create — a scalar string the
 * author already collects, correlated to the operation's own repeat.
 * A multi-select answer is an array in Nova and cannot be an identity.
 */
export function identityKeyFieldDecls(
	entries: readonly FormFieldEntry[],
	repeat: Uuid | undefined,
): readonly EditorFormFieldDecl[] {
	return entries
		.filter(
			(entry) =>
				// Stricter than a plain read: the key must come from the create's
				// OWN repeat, so a root answer cannot key a repeated create — two
				// iterations would otherwise share one identity.
				entry.repeat === repeat && formFieldCanKeyCreate(entry),
		)
		.map(declOf);
}

/** Every repeat in the form, for the multiplicity picker. */
export function repeatFieldDecls(
	entries: readonly FormFieldEntry[],
): readonly EditorFormFieldDecl[] {
	return entries.filter((entry) => entry.kind === "repeat").map(declOf);
}

/** Whether an operation's saved reads survive a change of multiplicity. */
export function operationReadsOutsideRepeat(
	entries: readonly FormFieldEntry[],
	operation: CaseOperation,
	nextRepeat: Uuid | undefined,
): boolean {
	const admissible = new Set(
		operationFormFieldDecls(entries, nextRepeat).map((decl) => decl.uuid),
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
