// components/builder/editor/fields/caseWriteRowModel.ts
//
// One row of a question's "Saves to", as pure state.
//
// A question holds no destination of its own: what it saves to is a view of
// the writes of its form's case operations (`lib/domain/caseWriteViews.ts`).
// Each row here is one of those writes, and this model says what the row
// reads, whether the row edits its write or only points at the case change
// that holds it, what the write means on submission, and, on a form that
// opens one case, whether the question opens with the case's current value
// and the one `updateField` that changes that.
//
// The preload is a starting value like any other: the question opens with
// the case's value exactly when its `default_value` is the `form-case`
// read of the property it saves (`lib/domain/casePreload.ts::fieldPreload`).
// So the line's action is an ordinary edit of that slot, which the commit
// gate judges like every other.

import type { Mutation } from "@/lib/doc/types";
import {
	type CaseWriteVia,
	caseSelectionCardinality,
	type Field,
	type FieldCaseWriteView,
	type FieldCaseWriteViewKey,
	type Form,
	fieldCaseWriteViewKey,
	fieldKindDeclaresKey,
	fieldPreload,
	formOpensWithOneCase,
	humanizeId,
	isCaptureField,
	type Module,
} from "@/lib/domain";
import {
	type CaseWriteGuidance,
	caseWriteGuidance,
} from "./caseWritePresentation";

/** The line that says whether the question opens with the case's value. */
export const OPENS_WITH_CASE_VALUE_LINE =
	"Opens with the case's current value.";
export const STARTS_BLANK_LINE =
	"Starts blank, and saving it blank clears the case's value.";

export interface CaseWritePreloadLine {
	readonly line: string;
	/** The ghost button under the line, and the one edit it commits. */
	readonly action: {
		readonly label: string;
		readonly mutation: Mutation;
	};
}

export interface CaseWriteRowModel {
	/** The write this row shows, for the planner's `replace`. */
	readonly viewKey: FieldCaseWriteViewKey;
	/** Where the answer lands, as the row reads it. */
	readonly destination: string;
	/** The row points at a change the question's own planner did not write:
	 *  it is edited on the case changes screen, never here. */
	readonly readOnly: boolean;
	readonly guidance: CaseWriteGuidance;
	readonly preload: CaseWritePreloadLine | undefined;
}

export interface CaseWriteRowInput {
	readonly view: FieldCaseWriteView;
	readonly field: Field;
	readonly form: Pick<Form, "type">;
	readonly module: Pick<Module, "caseType" | "caseListConfig">;
	/** A property's name as the author reads it. */
	readonly propertyLabel: (caseType: string, property: string) => string;
	/** The case change that holds a write the row does not edit, as its
	 *  sentence reads ("Update the case this form opened"). */
	readonly operationDescription: (operationUuid: string) => string | undefined;
}

/** A case type folded into a sentence: "the new household". */
function caseTypeWords(caseType: string): string {
	const label = humanizeId(caseType) || caseType;
	return `${label.charAt(0).toLowerCase()}${label.slice(1)}`;
}

/** The case a `via` reaches, as the row names it. */
function aboveWords(caseType: string, via: CaseWriteVia): string {
	const label = humanizeId(caseType) || caseType;
	return via.length === 1 ? `${label} it belongs to` : `${label} above it`;
}

/** What one row of the field's "Saves to" reads, offers and means. */
export function caseWriteRowModel(input: CaseWriteRowInput): CaseWriteRowModel {
	const { view, field, form, module } = input;
	const property = input.propertyLabel(view.caseType, view.property);
	const readOnly =
		view.destination === "other" || view.destination === "ancestor";
	let destination: string;
	if (view.link) {
		destination = `Saves a link to the file in ${property}`;
	} else {
		switch (view.destination) {
			case "own":
				destination =
					form.type === "registration"
						? `The new ${caseTypeWords(view.caseType)} · ${property}`
						: `This form's case · ${property}`;
				break;
			case "child":
				destination = `A new ${caseTypeWords(view.caseType)} · ${property}`;
				break;
			case "worker-record":
				destination = `The worker's record · ${property}`;
				break;
			case "ancestor":
				destination =
					view.via === undefined
						? `${humanizeId(view.caseType)} · ${property}`
						: `${aboveWords(view.caseType, view.via)} · ${property}`;
				break;
			case "other":
				destination = `${
					input.operationDescription(view.operationUuid) ?? "Another case"
				} · ${property}`;
				break;
		}
	}
	return {
		viewKey: fieldCaseWriteViewKey(view),
		destination,
		readOnly,
		guidance: caseWriteGuidance(field, { module, form }, view),
		preload: preloadLine(input),
	};
}

/**
 * The preload line of a row that writes this form's case on a follow-up or
 * close form that opens one case, by the question's starting value:
 *
 *   - exactly the case's value of the written property: it opens with it,
 *     and "Start blank instead" clears the starting value;
 *   - no starting value and no calculation: it starts blank, and "Open with
 *     the case's current value" sets the starting value to that read;
 *   - any other starting value, or a calculation: no line.
 */
function preloadLine(
	input: CaseWriteRowInput,
): CaseWritePreloadLine | undefined {
	const { view, field, form, module } = input;
	if (
		view.destination !== "own" ||
		view.slot === "owner" ||
		view.via !== undefined ||
		view.link ||
		module.caseType === undefined ||
		isCaptureField(field) ||
		!fieldKindDeclaresKey(field.kind, "default_value") ||
		!formOpensWithOneCase(form.type, caseSelectionCardinality(module))
	)
		return undefined;
	const preload = fieldPreload(field);
	if (
		preload !== undefined &&
		preload.caseType === module.caseType &&
		preload.property === view.property
	) {
		return {
			line: OPENS_WITH_CASE_VALUE_LINE,
			action: {
				label: "Start blank instead",
				mutation: {
					kind: "updateField",
					uuid: field.uuid,
					targetKind: field.kind,
					patch: { default_value: null },
				} as Mutation,
			},
		};
	}
	const hasDefault =
		"default_value" in field && field.default_value !== undefined;
	const hasCalculation = "calculate" in field && field.calculate !== undefined;
	if (hasDefault || hasCalculation) return undefined;
	return {
		line: STARTS_BLANK_LINE,
		action: {
			label: "Open with the case's current value",
			mutation: {
				kind: "updateField",
				uuid: field.uuid,
				targetKind: field.kind,
				patch: {
					default_value: {
						kind: "term",
						term: {
							kind: "form-case",
							caseType: module.caseType,
							property: view.property,
						},
					},
				},
			} as Mutation,
		},
	};
}
