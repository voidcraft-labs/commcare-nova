// lib/doc/formFieldEntries.ts
//
// Pure projection behind `useFormFieldEntries`.
//
// `fieldOrder[parent]` is both membership and sequence. Walk every hierarchy
// level in that stored order so every answer/repeat picker follows the same
// visual order as the form canvas.

import {
	type CasePropertyDataType,
	caseDataTypeForFieldKind,
	type Field,
	type FieldKind,
	type Uuid,
} from "@/lib/domain";

export interface FormFieldEntry {
	readonly uuid: Uuid;
	readonly id: string;
	/** The author's own words for the field — its label, else its id. */
	readonly label: string;
	readonly kind: FieldKind;
	/** The case data type the answer holds; `undefined` for a container
	 *  and for `hidden`, which always holds a value but declares no type. */
	readonly dataType: CasePropertyDataType | undefined;
	/** The innermost repeat containing this field, if any. */
	readonly repeat: Uuid | undefined;
	/** Every repeat containing this field, outermost first.
	 *
	 * The full chain is required by lookup-row filters: an answer is in scope
	 * only when its chain is a prefix of the current question's chain (root,
	 * current repeat, or an enclosing repeat). Keeping the derivation here
	 * means the builder and commit validator cannot disagree about repeat
	 * ancestry after a move. */
	readonly repeatAncestors: readonly Uuid[];
}

function labelOf(field: Field): string {
	const label = "label" in field ? (field.label ?? "").trim() : "";
	return label.length > 0 ? label : field.id;
}

/**
 * Every field under a form in canonical pre-order, tagged with its innermost
 * repeat. Each sibling level follows its `fieldOrder` sequence.
 */
export function formFieldEntriesFor(
	fields: Readonly<Record<Uuid, Field | undefined>>,
	fieldOrder: Readonly<Record<Uuid, readonly Uuid[] | undefined>>,
	formUuid: Uuid,
): readonly FormFieldEntry[] {
	const found: FormFieldEntry[] = [];
	const walk = (parent: Uuid, repeats: readonly Uuid[]) => {
		const children = [...(fieldOrder[parent] ?? [])];
		for (const uuid of children) {
			const field = fields[uuid];
			if (field === undefined) continue;
			const childRepeats =
				field.kind === "repeat" ? [...repeats, field.uuid] : repeats;
			found.push({
				uuid: field.uuid,
				id: field.id,
				label: labelOf(field),
				kind: field.kind,
				dataType: caseDataTypeForFieldKind(field.kind),
				repeat: childRepeats.at(-1),
				repeatAncestors: repeats,
			});
			walk(uuid, childRepeats);
		}
	};
	walk(formUuid, []);
	return found;
}

export type LookupFilterFormFieldAdmission =
	| { readonly admitted: true }
	| {
			readonly admitted: false;
			readonly reason:
				| "current-field-unavailable"
				| "field-unavailable"
				| "field-not-earlier"
				| "field-repeat-scope";
	  };

/** Whether a field has one answer value an expression can read. */
export function formFieldCarriesAnswer(entry: FormFieldEntry): boolean {
	return entry.dataType !== undefined || entry.kind === "hidden";
}

function repeatChainIsPrefix(
	prefix: readonly Uuid[],
	value: readonly Uuid[],
): boolean {
	return (
		prefix.length <= value.length &&
		prefix.every((repeatUuid, index) => value[index] === repeatUuid)
	);
}

/**
 * The one admission rule for a form answer inside a lookup-row filter.
 *
 * The array order is canonical form DFS order. An eligible answer must carry
 * a value, occur before the question whose options are being filtered, and
 * live at root or in the current/enclosing repeat. Child, sibling, and
 * unrelated repeat answers are excluded even when they happen to occur
 * earlier in the flattened array.
 */
export function lookupFilterFormFieldAdmission(
	entries: readonly FormFieldEntry[],
	currentFieldUuid: Uuid,
	candidateFieldUuid: Uuid,
): LookupFilterFormFieldAdmission {
	const currentIndex = entries.findIndex(
		(entry) => entry.uuid === currentFieldUuid,
	);
	if (currentIndex < 0) {
		return { admitted: false, reason: "current-field-unavailable" };
	}
	const candidateIndex = entries.findIndex(
		(entry) => entry.uuid === candidateFieldUuid,
	);
	const candidate = entries[candidateIndex];
	if (candidate === undefined || !formFieldCarriesAnswer(candidate)) {
		return { admitted: false, reason: "field-unavailable" };
	}
	const current = entries[currentIndex];
	if (
		current === undefined ||
		!repeatChainIsPrefix(candidate.repeatAncestors, current.repeatAncestors)
	) {
		return { admitted: false, reason: "field-repeat-scope" };
	}
	if (candidateIndex >= currentIndex) {
		return { admitted: false, reason: "field-not-earlier" };
	}
	return { admitted: true };
}

/** Exact answer catalog a lookup-row filter may offer in the builder. */
export function lookupFilterEligibleFormFields(
	entries: readonly FormFieldEntry[],
	currentFieldUuid: Uuid,
): readonly FormFieldEntry[] {
	return entries.filter(
		(entry) =>
			lookupFilterFormFieldAdmission(entries, currentFieldUuid, entry.uuid)
				.admitted,
	);
}
