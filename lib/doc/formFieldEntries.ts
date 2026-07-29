// lib/doc/formFieldEntries.ts
//
// Pure projection behind `useFormFieldEntries`.
//
// A field membership array is a set, not a sequence: a reorder changes the
// field's absolute `order` key and deliberately leaves `fieldOrder[parent]`
// untouched. Walk every hierarchy level through the canonical
// `(order, uuid)` comparator before flattening so every answer/repeat picker
// follows the same visual order as the form canvas.

import {
	type CasePropertyDataType,
	caseDataTypeForFieldKind,
	fallbackProseProjection,
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
}

function labelOf(field: Field): string {
	const label =
		"label" in field && field.label
			? fallbackProseProjection(field.label).trim()
			: "";
	return label.length > 0 ? label : field.id;
}

/**
 * Every field under a form in canonical pre-order, tagged with its innermost
 * repeat. Each sibling level sorts independently by `(order, uuid)`.
 */
export function formFieldEntriesFor(
	fields: Readonly<Record<Uuid, Field | undefined>>,
	fieldOrder: Readonly<Record<Uuid, readonly Uuid[] | undefined>>,
	formUuid: Uuid,
): readonly FormFieldEntry[] {
	const found: FormFieldEntry[] = [];
	const walk = (parent: Uuid, repeat: Uuid | undefined) => {
		const children = [...(fieldOrder[parent] ?? [])];
		for (const uuid of children) {
			const field = fields[uuid];
			if (field === undefined) continue;
			const inner = field.kind === "repeat" ? field.uuid : repeat;
			found.push({
				uuid: field.uuid,
				id: field.id,
				label: labelOf(field),
				kind: field.kind,
				dataType: caseDataTypeForFieldKind(field.kind),
				repeat: inner,
			});
			walk(uuid, inner);
		}
	};
	walk(formUuid, undefined);
	return found;
}
