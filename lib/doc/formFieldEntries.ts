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
	type Field,
	type FieldKind,
	type Uuid,
} from "@/lib/domain";
import { projectProseTemplate } from "@/lib/domain/prose";
import type { XPathPrintableDoc } from "@/lib/domain/xpath/print";

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

/**
 * The richer form-order projection lookup-row filters need.
 *
 * Existing operation authoring only needs the innermost repeat, so the base
 * `FormFieldEntry` stays deliberately small. Lookup filters must distinguish
 * an enclosing repeat from a sibling or child repeat and therefore carry the
 * complete chain.
 */
export interface FormFieldEntryWithAncestors extends FormFieldEntry {
	/** Repeats containing this field, outermost first. */
	readonly repeatAncestors: readonly Uuid[];
}

/**
 * The document surface entry building reads: the two maps the walk itself
 * needs, plus what a label's references need to be spelled out. `forms` and
 * `fieldParent` are what terminate a reference's ancestor walk at the right
 * root — passing only the sub-tree being walked would spell a path relative to
 * a group, and `useFormFieldEntries` is called with a group uuid as often as a
 * form's.
 */
export interface FormFieldEntrySource {
	fields: Readonly<Record<Uuid, Field | undefined>>;
	fieldOrder: Readonly<Record<Uuid, readonly Uuid[] | undefined>>;
	forms: XPathPrintableDoc["forms"];
	fieldParent?: XPathPrintableDoc["fieldParent"];
	userProperties?: XPathPrintableDoc["userProperties"];
}

function labelOf(field: Field, doc: XPathPrintableDoc): string {
	const label =
		"label" in field && field.label
			? projectProseTemplate(field.label, doc).text.trim()
			: "";
	return label.length > 0 ? label : field.id;
}

/**
 * Every field under a form in canonical pre-order, tagged with its innermost
 * repeat. Each sibling level sorts independently by `(order, uuid)`.
 */
export function formFieldEntriesFor(
	source: FormFieldEntrySource,
	formUuid: Uuid,
): readonly FormFieldEntryWithAncestors[] {
	const { fields, fieldOrder } = source;
	const found: FormFieldEntryWithAncestors[] = [];
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
				label: labelOf(field, source),
				kind: field.kind,
				dataType: caseDataTypeForFieldKind(field.kind),
				repeat: childRepeats.at(-1),
				/* Match the validator: a repeat is contained by its parents, not
				 * by itself. Descendants receive it when the walk recurses. */
				repeatAncestors: repeats,
			});
			walk(uuid, childRepeats);
		}
	};
	walk(formUuid, []);
	return found;
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

/** Whether one form entry carries an answer expression authors may read. */
export function formFieldCarriesAnswer(entry: FormFieldEntry): boolean {
	/* Hidden fields have no declared data type but always hold a value. */
	return entry.dataType !== undefined || entry.kind === "hidden";
}

/**
 * Exact form-answer catalog admitted inside one lookup-backed select's row
 * filter.
 *
 * `entries` is canonical form DFS order. An answer must precede the receiving
 * select and its repeat chain must be a prefix of the receiver's chain, which
 * admits form-root, current-repeat, and enclosing-repeat answers while
 * excluding later, child, sibling, and unrelated-repeat answers.
 */
export function lookupFilterEligibleFormFields(
	entries: readonly FormFieldEntryWithAncestors[],
	currentFieldUuid: Uuid,
): readonly FormFieldEntryWithAncestors[] {
	const currentIndex = entries.findIndex(
		(entry) => entry.uuid === currentFieldUuid,
	);
	const current = entries[currentIndex];
	if (current === undefined) return [];
	return entries.filter(
		(entry, index) =>
			index < currentIndex &&
			formFieldCarriesAnswer(entry) &&
			repeatChainIsPrefix(entry.repeatAncestors, current.repeatAncestors),
	);
}
