/**
 * The state model behind a repeat's Rows editor.
 *
 * A repeat's rows come one of three ways, its `repeat_mode`: the worker adds
 * them (`user_controlled`), a set number of them (`count_bound`, over
 * `repeat_count`), or one per case a query finds (`query_bound`, over
 * `data_source.ids_query`). Every mode change is one `updateField` carrying
 * the new mode and only that mode's slot; the reducer
 * (`lib/doc/mutations/fields.ts`) picks the destination variant's keys, so
 * the previous mode's slot is dropped in the same write. A new slot starts
 * from a seed built as an `Expression` tree, never as text: a count of 1, and
 * the menu's open cases.
 *
 * Everything here is pure over the document, so the choices, the reasons a
 * choice is unavailable, the exact patch each gesture dispatches and every
 * line the editor shows are pinned without mounting CodeMirror.
 */

import { fieldPlacementVerdict } from "@/lib/doc/formSectionVerdicts";
import type { BlueprintDoc, Mutation, Uuid } from "@/lib/doc/types";
import { eq, literal, prop, term } from "@/lib/domain/expression/builders";
import {
	expressionFacts,
	type LookupTypeIndex,
	slotContext,
} from "@/lib/domain/expression/context";
import { formStructure } from "@/lib/domain/expression/formStructure";
import {
	type CheckError,
	checkExpression,
} from "@/lib/domain/expression/typeChecker";
import type { Expression } from "@/lib/domain/expression/types";
import { formOfField } from "@/lib/domain/fieldForm";
import type { RepeatField, RepeatMode } from "@/lib/domain/fields/repeat";
import { HELD_PLACEMENT_SUFFIX } from "@/lib/domain/placementCopy";
import { moduleUuidOfForm } from "@/lib/domain/postSubmit";
import {
	effectiveQueryRepeatPlacement,
	type QueryRepeatNeed,
	type QueryRepeatPlacement,
	queryRepeatPlacementNeeds,
} from "@/lib/domain/queryRepeatPlacement";

/** The three ways a repeat's rows come, in the order the editor offers them. */
export const REPEAT_ROWS_MODES: ReadonlyArray<{
	readonly value: RepeatMode;
	readonly label: string;
}> = [
	{ value: "user_controlled", label: "Workers add rows" },
	{ value: "count_bound", label: "A set number of rows" },
	{ value: "query_bound", label: "One row per case found" },
];

/** The count editor's label, over slot `repeat_count`. */
export const REPEAT_COUNT_EDITOR_LABEL = "How many rows";
/** The query editor's label, over slot `ids_query`. */
export const REPEAT_QUERY_EDITOR_LABEL = "Cases to show";
/** The count refusal's lint action. */
export const WHOLE_NUMBER_FIX_LABEL = "Use a whole number";

/** The line under a count: what a changing count does to the rows. Core
 * makes rows up to the count and never removes one when it drops
 * (`FormEntryModel.createModelForGroup`, `FormDef.canCreateRepeat`). */
export const REPEAT_COUNT_LINE =
	"Raising the number adds rows; lowering it keeps the rows already made, with their answers.";

/** Why `One row per case found` can't be chosen on a menu with no case type. */
export const QUERY_MODE_NO_CASE_TYPE =
	"This menu has no case type, so there are no cases to find. You can give it one in module settings.";

/** The one write a Rows gesture dispatches. */
export type RepeatRowsMutation = Extract<
	Mutation,
	{ kind: "updateField"; targetKind: "repeat" }
>;

/** One mode as the editor offers it: `disabled` holds the sentence that says
 * why it can't be chosen here. */
export interface RepeatRowsModeOption {
	readonly value: RepeatMode;
	readonly label: string;
	readonly disabled?: string;
}

/** The case type of the menu `repeatUuid`'s form sits in, or `undefined`
 * where the menu has none. */
export function repeatMenuCaseType(
	doc: BlueprintDoc,
	repeatUuid: Uuid,
): string | undefined {
	const formUuid = formOfField(doc, repeatUuid);
	if (formUuid === undefined) return undefined;
	const moduleUuid = moduleUuidOfForm(doc, formUuid);
	if (moduleUuid === undefined) return undefined;
	const caseType = doc.modules[moduleUuid]?.caseType;
	return caseType === undefined || caseType === "" ? undefined : caseType;
}

/**
 * The open cases of `caseType`, as a list of their ids:
 * `instance('casedb')/casedb/case[@case_type = '<type>'][@status = 'open']/@case_id`,
 * built as the tree the form parser reads that text to.
 */
export function openCasesQuery(caseType: string): Expression {
	return {
		kind: "project",
		of: {
			kind: "cases",
			source: "casedb",
			where: [
				eq(
					term({ kind: "case-row-type" }),
					term({ kind: "case-type", caseType }),
				),
				eq(prop(caseType, "status"), literal("open")),
			],
		},
		value: prop(caseType, "case_id"),
	};
}

/** The count a new `A set number of rows` starts with. */
export function seedRepeatCount(): Expression {
	return term(literal(1));
}

/**
 * Why `Workers add rows` can't be chosen for the repeat where it sits, or
 * `undefined` where it can: a section or a group shown on one screen holds no
 * repeat the worker grows by hand, and the sentence is the placement
 * verdict's for that place (`fieldPlacementVerdict`).
 */
export function workersAddRowsRefusal(
	doc: BlueprintDoc,
	repeatUuid: Uuid,
): string | undefined {
	const parent = doc.fieldParent[repeatUuid];
	if (parent === undefined) return undefined;
	// Asked as for a repeat landing here that the worker grows: the question is
	// the place, not a move, so no expression is re-read.
	const verdict = fieldPlacementVerdict(doc, {
		kind: "repeat",
		toParentUuid: parent,
		subtreeHasUserRepeat: true,
	});
	return verdict.ok ? undefined : verdict.message;
}

/** The three modes for the repeat, each with the reason it can't be chosen
 * where one holds. The repeat's current mode is never disabled: it is what
 * the repeat already is. */
export function repeatRowsModeOptions(
	doc: BlueprintDoc,
	field: RepeatField,
): readonly RepeatRowsModeOption[] {
	return REPEAT_ROWS_MODES.map((mode) => {
		const disabled =
			mode.value === field.repeat_mode
				? undefined
				: modeRefusal(doc, field.uuid, mode.value);
		return disabled === undefined ? mode : { ...mode, disabled };
	});
}

function modeRefusal(
	doc: BlueprintDoc,
	repeatUuid: Uuid,
	mode: RepeatMode,
): string | undefined {
	switch (mode) {
		case "user_controlled":
			return workersAddRowsRefusal(doc, repeatUuid);
		case "count_bound":
			return undefined;
		case "query_bound":
			return repeatMenuCaseType(doc, repeatUuid) === undefined
				? QUERY_MODE_NO_CASE_TYPE
				: undefined;
		default: {
			const _exhaustive: never = mode;
			return _exhaustive;
		}
	}
}

export type RepeatRowsModeSwitch =
	/** `next` is already the repeat's mode: nothing to write. */
	| { readonly kind: "unchanged" }
	/** `next` can't be chosen here, for the reason the option shows. */
	| { readonly kind: "refused"; readonly reason: string }
	/** One write: the new mode and its seeded slot. */
	| { readonly kind: "commit"; readonly mutation: RepeatRowsMutation };

/**
 * What choosing `next` does: one `updateField` with the new mode and only
 * that mode's slot, seeded. A count starts at 1, a query at the menu's open
 * cases; `Workers add rows` carries no slot.
 */
export function repeatRowsModeSwitch(
	doc: BlueprintDoc,
	field: RepeatField,
	next: RepeatMode,
): RepeatRowsModeSwitch {
	if (field.repeat_mode === next) return { kind: "unchanged" };
	const refusal = modeRefusal(doc, field.uuid, next);
	if (refusal !== undefined) return { kind: "refused", reason: refusal };
	const write = (patch: RepeatRowsMutation["patch"]): RepeatRowsModeSwitch => ({
		kind: "commit",
		mutation: {
			kind: "updateField",
			uuid: field.uuid,
			targetKind: "repeat",
			patch,
		},
	});
	switch (next) {
		case "user_controlled":
			return write({ repeat_mode: "user_controlled" });
		case "count_bound":
			return write({
				repeat_mode: "count_bound",
				repeat_count: seedRepeatCount(),
			});
		case "query_bound": {
			const caseType = repeatMenuCaseType(doc, field.uuid);
			if (caseType === undefined)
				return { kind: "refused", reason: QUERY_MODE_NO_CASE_TYPE };
			return write({
				repeat_mode: "query_bound",
				data_source: { ids_query: openCasesQuery(caseType) },
			});
		}
		default: {
			const _exhaustive: never = next;
			return _exhaustive;
		}
	}
}

/** The checker's reasons for a count that isn't a whole number
 * (`typeChecker.ts::repeatCountRefusal`). Each one's message offers
 * `int(...)`, so each one offers the fix. */
const NOT_WHOLE_REASONS: ReadonlySet<string> = new Set([
	"whole-number-count",
	"count-choice-not-whole",
	"count-choices-unknown",
]);

/** Whether a checker error refuses a count as not a whole number, the error
 * the count editor offers `Use a whole number` on. */
export function isWholeNumberCountRefusal(error: CheckError): boolean {
	return (
		error.code === "expected-value" &&
		error.reason !== undefined &&
		NOT_WHOLE_REASONS.has(error.reason)
	);
}

/** The checker's refusal of `count` as the repeat's count for not being a
 * whole number, or `undefined` where it is one (or where an earlier error
 * leaves its type unknown, which is the author's first thing to fix). */
export function wholeNumberCountRefusal(
	doc: BlueprintDoc,
	repeatUuid: Uuid,
	count: Expression,
	lookupTables: LookupTypeIndex = new Map(),
): CheckError | undefined {
	const ctx = slotContext(
		doc,
		{ entity: "field", uuid: repeatUuid, slot: "repeat_count" },
		lookupTables,
		{ facts: expressionFacts(doc) },
	);
	if (ctx === undefined) return undefined;
	return checkExpression(count, ctx).errors.find(isWholeNumberCountRefusal);
}

/** `Use a whole number`: the stored count inside `int(...)`, a call node
 * around the tree, so the whole part is kept (`FunctionUtils.toInt`
 * truncates toward zero) and the checker types it `int`. */
export function wholeNumberCountFix(count: Expression): Expression {
	return { kind: "call", fn: "int", args: [count] };
}

/** The one write `Use a whole number` dispatches. */
export function wholeNumberCountFixMutation(
	repeatUuid: Uuid,
	count: Expression,
): RepeatRowsMutation {
	return {
		kind: "updateField",
		uuid: repeatUuid,
		targetKind: "repeat",
		patch: { repeat_count: wholeNumberCountFix(count) },
	};
}

/** The lines under a query repeat's query: how its rows are made, why they
 * follow the cases found where they do, and what happens to a row past the
 * end of the cases found. */
export interface QueryRepeatPlacementLines {
	readonly placement: QueryRepeatPlacement;
	readonly held: boolean;
	/** How the rows are made, with the held suffix where a publish keeps it. */
	readonly line: string;
	/** The first need's reason, where the rows follow the cases found
	 * because of one. */
	readonly because?: string;
	/** Rows that follow the cases found: what a row past their end does. */
	readonly pastTheEnd?: string;
}

const PLACEMENT_LINE: Readonly<Record<QueryRepeatPlacement, string>> = {
	"model-iteration":
		"Rows are set when the form opens and don't change while it's filled in.",
	count:
		"Rows follow the cases found as answers change. Each row keeps its place, so its answers stay with that place when the cases found change.",
};

/** A row past the end of the cases found is not relevant: hidden, and left
 * out of the submission with the case blocks inside it
 * (`FormDef.isRepeatRelevant`); its answers stay in the form. */
export const PAST_THE_END_LINE =
	"A row past the end of the cases found is hidden and saves nothing, and its answers come back if the cases found grow back to it.";

/** Why a query repeat's rows follow the cases found, for its first need. */
export function queryRepeatNeedSentence(need: QueryRepeatNeed): string {
	switch (need.kind) {
		case "query-reads-answers":
			return "Because its query reads an answer.";
		case "row-condition":
			return "Because it shows on a condition of its own.";
		case "nested":
			return "Because it sits inside another repeat.";
		case "ancestor-condition-changes":
			return "Because a group around it shows on a condition that can change while the form is filled in.";
		default: {
			const _exhaustive: never = need;
			return _exhaustive;
		}
	}
}

/** The placement lines for a query repeat, from the placement every export
 * reads (`effectiveQueryRepeatPlacement`) and its needs
 * (`queryRepeatPlacementNeeds`). `undefined` for a repeat that isn't a query
 * repeat or that no form holds. */
export function queryRepeatPlacementLines(
	doc: BlueprintDoc,
	repeatUuid: Uuid,
): QueryRepeatPlacementLines | undefined {
	const field = doc.fields[repeatUuid];
	if (field?.kind !== "repeat" || field.repeat_mode !== "query_bound")
		return undefined;
	const formUuid = formOfField(doc, repeatUuid);
	const structure =
		formUuid === undefined ? undefined : formStructure(doc, formUuid);
	if (structure === undefined) return undefined;
	const placement = effectiveQueryRepeatPlacement(structure, repeatUuid);
	const held =
		structure.fields.get(repeatUuid)?.heldQueryPlacement !== undefined;
	const line = held
		? `${PLACEMENT_LINE[placement]}${HELD_PLACEMENT_SUFFIX}`
		: PLACEMENT_LINE[placement];
	if (placement === "model-iteration") return { placement, held, line };
	const [need] = queryRepeatPlacementNeeds(structure, repeatUuid);
	return {
		placement,
		held,
		line,
		...(need === undefined ? {} : { because: queryRepeatNeedSentence(need) }),
		pastTheEnd: PAST_THE_END_LINE,
	};
}
