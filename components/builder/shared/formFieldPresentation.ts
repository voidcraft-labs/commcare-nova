// components/builder/shared/formFieldPresentation.ts
//
// How a form answer reads inside an expression editor.
//
// A `field` term stores only a uuid — identity, so a rename never
// rewrites the expression — and every surface that offers one has to
// resolve that identity back to the words the author typed on the
// canvas. This is that resolution, shared so the picker, the summary,
// and the row sentence cannot disagree about what a field is called.
//
// The decl list is also the ADMISSION list: a surface offers exactly
// the fields its slot may read, so the picker cannot produce a
// reference the commit gate would refuse. Case operations narrow it by
// repeat scope — a singular operation cannot read an answer that has
// one value per iteration — and pass the narrowed list here.

import type { CasePropertyDataType, Uuid } from "@/lib/domain";

/** One form answer an expression slot may read. */
export interface EditorFormFieldDecl {
	readonly uuid: Uuid;
	/** The author's own words for the field — its label, else its id. */
	readonly label: string;
	/** The field's id, shown to separate two identically labelled answers. */
	readonly id: string;
	/** Resolved case data type; `undefined` reads as text (a hidden field). */
	readonly dataType: CasePropertyDataType | undefined;
}

/** The label a picker shows, falling back to the id for an unlabelled field. */
export function formFieldDisplayLabel(
	uuid: Uuid,
	fields: readonly EditorFormFieldDecl[],
): string | undefined {
	const field = fields.find((candidate) => candidate.uuid === uuid);
	if (field === undefined) return undefined;
	return field.label.trim().length > 0 ? field.label : field.id;
}

/** Distinguishes two answers a person would otherwise read as the same. */
export function formFieldDisambiguator(
	field: EditorFormFieldDecl,
	fields: readonly EditorFormFieldDecl[],
): string | undefined {
	const label = field.label.trim();
	if (label.length === 0) return undefined;
	const collides = fields.some(
		(candidate) =>
			candidate.uuid !== field.uuid && candidate.label.trim() === label,
	);
	return collides ? field.id : undefined;
}
