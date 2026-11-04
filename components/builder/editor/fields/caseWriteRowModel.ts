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
// A row that saves to this form's case on a follow-up or close form, or to a
// case above it, also carries the Save only if changed switch: whether it is
// on, why it can't be turned on where it can't, and the one destination the
// switch commits. The cases above it a row can save to instead are listed by
// `ancestorCaseWriteChoices`, one per chain of links the catalog reaches.
//
// The preload is a starting value like any other: the question opens with
// the case's value exactly when its `default_value` is the `form-case`
// read of the property it saves (`lib/domain/casePreload.ts::fieldPreload`).
// So the line's action is an ordinary edit of that slot, which the commit
// gate judges like every other. A question that can't open on the values
// its property can hold (`lib/domain/startingValueFit.ts`) is offered no
// such action, and its line says why.

import type { FormCasePlacementView } from "@/lib/doc/casePlacements";
import type { FieldCaseWriteDestination as CaseWriteDestinationChoice } from "@/lib/doc/fieldCaseWriteMutations";
import type { Mutation } from "@/lib/doc/types";
import {
	type CasePropertyDataType,
	type CaseType,
	type CaseWriteVia,
	caseSelectionCardinality,
	type Field,
	type FieldCaseWriteView,
	type FieldCaseWriteViewKey,
	type Form,
	fieldCaseWriteViewKey,
	fieldPreload,
	formOpensWithOneCase,
	humanizeId,
	type Module,
	type RelationStep,
	saveOffersPreload,
} from "@/lib/domain";
import { resolveRelationDestination } from "@/lib/domain/expression/relationDestination";
import {
	STARTING_VALUE_MISFIT_SENTENCES,
	type StartingValueMisfit,
	startingValueMisfitOfType,
} from "@/lib/domain/startingValueFit";
import {
	type CaseWriteGuidance,
	caseWriteGuidance,
} from "./caseWritePresentation";

/** The line that says whether the question opens with the case's value. */
export const OPENS_WITH_CASE_VALUE_LINE =
	"Opens with the case's current value.";
export const STARTS_BLANK_LINE =
	"Starts blank, and saving it blank clears the case's value.";
/** Why a whole-number question on a property that can hold decimal numbers
 *  is offered no starting value from the case. */
export const STARTS_BLANK_ON_DECIMAL_LINE = `${STARTS_BLANK_LINE} ${STARTING_VALUE_MISFIT_SENTENCES["whole-number-on-decimal"]}`;
/** Why a choice question on a property that can hold other values than
 *  choices, such as text, is offered no starting value from the case. */
export const STARTS_BLANK_OUTSIDE_CHOICES_LINE = `${STARTS_BLANK_LINE} ${STARTING_VALUE_MISFIT_SENTENCES["outside-choices"]}`;
/** Why a single-choice question on a multiple-choice property is offered no
 *  starting value from the case. */
export const STARTS_BLANK_ON_SEVERAL_CHOICES_LINE = `${STARTS_BLANK_LINE} ${STARTING_VALUE_MISFIT_SENTENCES["several-choices"]}`;
/** The line for each way a question can't open on its property's value, as
 *  `startingValueMisfitOfType` classifies it. */
const MISFIT_LINES: Record<StartingValueMisfit["kind"], string> = {
	"whole-number-on-decimal": STARTS_BLANK_ON_DECIMAL_LINE,
	"several-choices": STARTS_BLANK_ON_SEVERAL_CHOICES_LINE,
	"outside-choices": STARTS_BLANK_OUTSIDE_CHOICES_LINE,
};

export const SAVE_ONLY_IF_CHANGED_LABEL = "Save only if changed";
export const SAVE_ONLY_IF_CHANGED_LINE =
	"Saves this answer only when the worker changes it.";
/** Why the switch is off on a registration's own case. */
export const NEW_CASE_NO_EARLIER_VALUE_REASON =
	"A new case has no earlier value to compare with.";
/** Why the switch is off while CommCare HQ keeps the own change in Save to
 *  Case, whose block has no such setting. */
export const KEPT_IN_SAVE_TO_CASE_REASON =
	"CommCare HQ saves only changed answers through Case Management or case actions, and this form keeps this change in Save to Case.";

/** The Save only if changed switch of one row. */
export interface CaseWriteOnlyIfChangedSwitch {
	readonly label: string;
	readonly line: string;
	readonly on: boolean;
	/** Why the switch can't be turned on; absent where it can be toggled. */
	readonly disabledReason?: string;
	/** The destination toggling the switch commits, through
	 *  `planFieldCaseWrite` with the row's `viewKey` as `replace`. */
	readonly destination: CaseWriteDestinationChoice;
}

export interface CaseWritePreloadLine {
	readonly line: string;
	/** The ghost button under the line, and the one edit it commits; absent
	 *  where the question can't open on the case's value. */
	readonly action?: {
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
	/** Present on a row that saves to this form's case or to a case above
	 *  it. */
	readonly onlyIfChanged: CaseWriteOnlyIfChangedSwitch | undefined;
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
	/** Where CommCare HQ keeps each case change of the form
	 *  (`lib/doc/casePlacements.ts::formCasePlacementView`). */
	readonly placement?: FormCasePlacementView;
	/** The type the written property's values can be (its declaration, else
	 *  the one its writers agree on); absent where nothing types it. */
	readonly propertyType?: CasePropertyDataType;
	/** The verdict `caseWriteChoiceVerdict` gives the switch's destination
	 *  (`onlyIfChangedDestination`) replacing this row's write. */
	readonly onlyIfChangedVerdict?:
		| { readonly ok: true }
		| { readonly ok: false; readonly reason: string };
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
	// A write through `via` is the own arm's: the validator refuses `via` on
	// every other operation (`CASE_WRITE_VIA_INVALID`, reason `target`), so
	// the row edits it like any write of the form's case.
	const readOnly = view.destination === "other";
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
		onlyIfChanged: onlyIfChangedSwitch(input),
	};
}

/** The destination the row's Save only if changed switch commits: the row's
 *  own, with `onlyIfChanged` turned the other way. */
export function onlyIfChangedDestination(
	view: FieldCaseWriteView,
): CaseWriteDestinationChoice {
	return {
		caseType: view.caseType,
		property: view.property,
		...(view.via !== undefined && { via: view.via }),
		...(!view.onlyIfChanged && { onlyIfChanged: true as const }),
	};
}

/**
 * The switch of a write to this form's case or to a case above it. Turning
 * it off is always admitted; turning it on is refused on a registration,
 * whose new case has nothing to compare with, and while CommCare HQ keeps
 * the own change in Save to Case; otherwise the planner's and the gate's
 * verdict over the switch's destination decides.
 */
function onlyIfChangedSwitch(
	input: CaseWriteRowInput,
): CaseWriteOnlyIfChangedSwitch | undefined {
	const { view, form } = input;
	if (
		view.slot !== "write" ||
		(view.destination !== "own" && view.destination !== "ancestor")
	)
		return undefined;
	const base = {
		label: SAVE_ONLY_IF_CHANGED_LABEL,
		line: SAVE_ONLY_IF_CHANGED_LINE,
		on: view.onlyIfChanged,
		destination: onlyIfChangedDestination(view),
	};
	if (view.onlyIfChanged) return base;
	let disabledReason: string | undefined;
	if (form.type === "registration")
		disabledReason = NEW_CASE_NO_EARLIER_VALUE_REASON;
	else if (input.placement?.own?.home === "save-to-case")
		disabledReason = KEPT_IN_SAVE_TO_CASE_REASON;
	else if (input.onlyIfChangedVerdict?.ok === false)
		disabledReason = input.onlyIfChangedVerdict.reason;
	return disabledReason === undefined ? base : { ...base, disabledReason };
}

/** One case above this form's case a row can save to instead. */
export interface AncestorCaseWriteChoice {
	readonly caseType: string;
	readonly via: CaseWriteVia;
	/** `household (parent)`, or the chain: `household (parent, then host)`. */
	readonly label: string;
}

/** The forms whose own case is loaded, so the cases above it are known. */
const LOADS_ITS_CASE: ReadonlySet<Form["type"]> = new Set([
	"followup",
	"close",
]);

/**
 * Every case above a form's case the catalog reaches from `moduleCaseType`,
 * one choice per chain of links, nearest first. Each catalog link
 * (`CaseType.parent_type`) is walked as `parent`, the index Nova's creates
 * write for a child and an extension alike; an extension link is also
 * walked as `host`, the index CommCare HQ names an extension's host by,
 * with the type it reaches stated on the step. A chain stops where a type
 * repeats. Offered only on a follow-up or close form, the only forms whose
 * own case can save to a case above it.
 */
export function ancestorCaseWriteChoices(
	caseTypes: readonly CaseType[],
	moduleCaseType: string | undefined,
	formType: Form["type"],
): readonly AncestorCaseWriteChoice[] {
	if (moduleCaseType === undefined || !LOADS_ITS_CASE.has(formType)) return [];
	const choices: AncestorCaseWriteChoice[] = [];
	const walk = (
		from: string,
		via: CaseWriteVia | undefined,
		seen: ReadonlySet<string>,
	): void => {
		const declared = caseTypes.find((caseType) => caseType.name === from);
		const above = declared?.parent_type;
		if (above === undefined || seen.has(above)) return;
		const steps: RelationStep[] = [{ identifier: "parent" }];
		if (declared?.relationship === "extension")
			steps.push({ identifier: "host", throughCaseType: above });
		const next = new Set(seen).add(above);
		for (const step of steps) {
			const chain: CaseWriteVia = via === undefined ? [step] : [...via, step];
			const reached = resolveRelationDestination(
				{ kind: "ancestor", via: chain },
				moduleCaseType,
				caseTypes,
			);
			if (!reached.ok || reached.caseType !== above) continue;
			choices.push({
				caseType: above,
				via: chain,
				label: chainLabel(above, chain),
			});
			walk(above, chain, next);
		}
	};
	walk(moduleCaseType, undefined, new Set([moduleCaseType]));
	return choices;
}

function chainLabel(caseType: string, via: CaseWriteVia): string {
	return `${caseType} (${via.map((step) => step.identifier).join(", then ")})`;
}

/**
 * The preload line of a row that writes this form's case on a follow-up or
 * close form that opens one case, by the question's starting value:
 *
 *   - exactly the case's value of the written property: it opens with it,
 *     and "Start blank instead" clears the starting value;
 *   - no starting value and no calculation: it starts blank, and "Open with
 *     the case's current value" sets the starting value to that read, unless
 *     the question can't open on the values the property can hold, where the
 *     line says why and offers nothing;
 *   - any other starting value, or a calculation: no line.
 *
 * A save to the case's owner is offered no starting value from it, so with
 * none it shows no line; one that already opens on the owner shows the first
 * line like any other. Which save is offered one is
 * `casePreload.ts::saveOffersPreload`, the rule the planner reads too.
 */
function preloadLine(
	input: CaseWriteRowInput,
): CaseWritePreloadLine | undefined {
	const { view, field, form, module } = input;
	// The line is about a save to this form's case on a form that opens one.
	if (
		view.destination !== "own" ||
		view.link ||
		module.caseType === undefined ||
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
	if (
		!saveOffersPreload({
			field,
			property: view.property,
			via: view.via,
			formType: form.type,
			module,
		})
	)
		return undefined;
	const misfit = startingValueMisfitOfType(field, input.propertyType);
	if (misfit !== undefined) return { line: MISFIT_LINES[misfit.kind] };
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
