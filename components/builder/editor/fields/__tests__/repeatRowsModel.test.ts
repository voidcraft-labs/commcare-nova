/**
 * The Rows editor's model over real documents and the production gate,
 * printer, parser and checker. The plausible failures: a mode switch that
 * leaves the previous mode's slot behind or names a slot the gate refuses;
 * a seed whose printed text means another tree than the one stored (so the
 * editor would show one query and the app run another); a whole-number fix
 * that edits text rather than wrapping the stored tree; and a placement line
 * that disagrees with the placement every export reads.
 */

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	caseListConfig,
	type FieldSpec,
} from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import {
	parseFormExpressionForSlot,
	projectFormExpression,
} from "@/lib/doc/expressionText";
import { FIELD_PLACEMENT_MESSAGES } from "@/lib/doc/formSectionVerdicts";
import { withIdentityMoves } from "@/lib/doc/identityMoves";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import { readPlacementHolds } from "@/lib/doc/placementHolds";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import { eq, formField, literal, term } from "@/lib/domain/expression/builders";
import { expressionFacts, slotContext } from "@/lib/domain/expression/context";
import { checkExpression } from "@/lib/domain/expression/typeChecker";
import type {
	Expression,
	ExpressionSlotRef,
} from "@/lib/domain/expression/types";
import type { RepeatField } from "@/lib/domain/fields/repeat";
import {
	openCasesQuery,
	PAST_THE_END_LINE,
	QUERY_MODE_NO_CASE_TYPE,
	queryRepeatPlacementLines,
	repeatRowsModeOptions,
	repeatRowsModeSwitch,
	wholeNumberCountFix,
	wholeNumberCountFixMutation,
	wholeNumberCountRefusal,
} from "../repeatRowsModel";

const REPEAT = testUuid("rows-repeat");
const SIZE = testUuid("rows-size");
const WEIGHT = testUuid("rows-weight");
const GROUP = testUuid("rows-group");

const SET_WHEN_OPENED =
	"Rows are set when the form opens and don't change while it's filled in.";
const FOLLOW =
	"Rows follow the cases found as answers change. Each row keeps its place, so its answers stay with that place when the cases found change.";

function repeatSpec(extra: Record<string, unknown> = {}): FieldSpec {
	return {
		kind: "repeat",
		id: "visits",
		uuid: REPEAT,
		label: "Visits",
		repeat_mode: "user_controlled",
		children: [{ kind: "text", id: "note", label: "Note" }],
		...extra,
	};
}

function docWith(
	fields: FieldSpec[],
	options: { caseType?: string } = { caseType: "visit" },
): BlueprintDoc {
	const answers: FieldSpec[] = [
		{ kind: "int", id: "size", uuid: SIZE, label: "Size" },
		{ kind: "decimal", id: "weight", uuid: WEIGHT, label: "Weight" },
	];
	return buildDoc({
		...(options.caseType === undefined
			? {}
			: { caseTypes: [{ name: options.caseType, properties: [] }] }),
		modules: [
			options.caseType === undefined
				? {
						name: "Survey",
						forms: [
							{ name: "Ask", type: "survey", fields: [...answers, ...fields] },
						],
					}
				: {
						name: "Visits",
						caseType: options.caseType,
						caseListConfig: caseListConfig([
							{ field: "case_name", header: "Name" },
						]),
						forms: [
							{
								name: "Review",
								type: "followup",
								fields: [...answers, ...fields],
							},
						],
					},
		],
	});
}

function repeatOf(doc: BlueprintDoc): RepeatField {
	const field = doc.fields[REPEAT];
	if (field?.kind !== "repeat") throw new Error("The fixture has no repeat.");
	return field;
}

function gateFindings(doc: BlueprintDoc, mutation: Mutation): string[] {
	const verdict = mutationCommitVerdict(
		doc,
		[mutation],
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	return verdict.ok
		? []
		: verdict.findings.map((finding) => `${finding.code}: ${finding.message}`);
}

function applied(doc: BlueprintDoc, mutation: Mutation): BlueprintDoc {
	return produce(doc, (draft) => {
		applyMutations(draft, [mutation]);
	});
}

function commitOf(doc: BlueprintDoc, next: RepeatField["repeat_mode"]) {
	const result = repeatRowsModeSwitch(doc, repeatOf(doc), next);
	if (result.kind !== "commit")
		throw new Error(`Expected a write, got ${result.kind}.`);
	return result.mutation;
}

/** Print `tree` in `slot` through the form printer, then parse that text
 * back for the same slot. */
function roundTrip(
	doc: BlueprintDoc,
	slot: ExpressionSlotRef,
	tree: Expression,
): Expression | undefined {
	const printed = projectFormExpression(doc, slot, tree, "unavailable");
	expect(printed.unresolved).toEqual([]);
	const parsed = parseFormExpressionForSlot(
		doc,
		slot,
		printed.text,
		"unavailable",
	);
	if (!parsed.ok)
		throw new Error(parsed.issues.map((issue) => issue.message).join("\n"));
	return parsed.expression;
}

describe("each mode switch is one write with only that mode's slot", () => {
	it("seeds a set number of rows at 1, and the gate admits it", () => {
		const doc = docWith([repeatSpec()]);
		const mutation = commitOf(doc, "count_bound");
		expect(mutation).toEqual({
			kind: "updateField",
			uuid: REPEAT,
			targetKind: "repeat",
			patch: { repeat_mode: "count_bound", repeat_count: term(literal(1)) },
		});
		expect(gateFindings(doc, mutation)).toEqual([]);
		const after = repeatOf(applied(doc, mutation));
		expect(after).toMatchObject({
			repeat_mode: "count_bound",
			repeat_count: term(literal(1)),
		});
	});

	it("seeds one row per case found with the menu's open cases, and the gate admits it", () => {
		const doc = docWith([repeatSpec()]);
		const mutation = commitOf(doc, "query_bound");
		expect(mutation.patch).toEqual({
			repeat_mode: "query_bound",
			data_source: { ids_query: openCasesQuery("visit") },
		});
		expect(gateFindings(doc, mutation)).toEqual([]);
	});

	it("drops the previous mode's slot when the worker adds rows again", () => {
		const doc = docWith([
			repeatSpec({
				repeat_mode: "count_bound",
				repeat_count: term(literal(3)),
			}),
		]);
		const mutation = commitOf(doc, "user_controlled");
		expect(mutation.patch).toEqual({ repeat_mode: "user_controlled" });
		expect(gateFindings(doc, mutation)).toEqual([]);
		const after = repeatOf(applied(doc, mutation));
		expect(after.repeat_mode).toBe("user_controlled");
		expect("repeat_count" in after).toBe(false);
	});

	it("drops the count when moving to a query, and the query when moving to a count", () => {
		const counted = docWith([
			repeatSpec({
				repeat_mode: "count_bound",
				repeat_count: term(literal(3)),
			}),
		]);
		const toQuery = commitOf(counted, "query_bound");
		expect(gateFindings(counted, toQuery)).toEqual([]);
		const queried = applied(counted, toQuery);
		expect("repeat_count" in repeatOf(queried)).toBe(false);

		const toCount = commitOf(queried, "count_bound");
		expect(gateFindings(queried, toCount)).toEqual([]);
		expect("data_source" in repeatOf(applied(queried, toCount))).toBe(false);
	});

	it("lets a held query repeat's placement leave with the query, stating no move", () => {
		// The conversion edge: the hold belongs to the query variant,
		// so a switch to another mode takes it along, and the data path's
		// change is the existing conversion's, which no identity move states.
		const doc = docWith([
			repeatSpec({
				repeat_mode: "query_bound",
				data_source: { ids_query: openCasesQuery("visit") },
				placement: "model-iteration",
			}),
		]);
		expect(readPlacementHolds(doc).size).toBe(1);
		for (const next of ["count_bound", "user_controlled"] as const) {
			const mutation = commitOf(doc, next);
			const plan = withIdentityMoves(doc, [mutation]);
			expect(plan.moves).toEqual([]);
			expect(plan.batch).toEqual([mutation]);
			expect(gateFindings(doc, mutation)).toEqual([]);
			const after = applied(doc, mutation);
			expect(readPlacementHolds(after).size).toBe(0);
			expect(repeatOf(after)).not.toHaveProperty("placement");
		}
	});

	it("writes nothing when the mode is already chosen", () => {
		const doc = docWith([repeatSpec()]);
		expect(repeatRowsModeSwitch(doc, repeatOf(doc), "user_controlled")).toEqual(
			{ kind: "unchanged" },
		);
	});
});

describe("modes that can't be chosen here", () => {
	it("refuses one row per case found on a menu with no case type", () => {
		const doc = docWith([repeatSpec()], {});
		const options = repeatRowsModeOptions(doc, repeatOf(doc));
		expect(options.map((option) => [option.label, option.disabled])).toEqual([
			["Workers add rows", undefined],
			["A set number of rows", undefined],
			["One row per case found", QUERY_MODE_NO_CASE_TYPE],
		]);
		expect(repeatRowsModeSwitch(doc, repeatOf(doc), "query_bound")).toEqual({
			kind: "refused",
			reason: QUERY_MODE_NO_CASE_TYPE,
		});
	});

	it("refuses workers adding rows inside a group shown on one screen, with the placement verdict's sentence, which the gate agrees with", () => {
		const doc = docWith([
			{
				kind: "group",
				id: "household",
				uuid: GROUP,
				label: "Household",
				fieldList: true,
				children: [
					repeatSpec({
						repeat_mode: "count_bound",
						repeat_count: term(literal(2)),
					}),
				],
			},
		]);
		const reason = FIELD_PLACEMENT_MESSAGES["user-repeat-in-field-list"];
		const userOption = repeatRowsModeOptions(doc, repeatOf(doc)).find(
			(option) => option.value === "user_controlled",
		);
		expect(userOption?.disabled).toBe(reason);
		expect(repeatRowsModeSwitch(doc, repeatOf(doc), "user_controlled")).toEqual(
			{ kind: "refused", reason },
		);
		// The refusal is the gate's own: the write it withholds is refused.
		expect(
			gateFindings(doc, {
				kind: "updateField",
				uuid: REPEAT,
				targetKind: "repeat",
				patch: { repeat_mode: "user_controlled" },
			}),
		).not.toEqual([]);
	});

	it("never disables the mode the repeat already has", () => {
		const doc = docWith([repeatSpec()], {});
		const current = repeatRowsModeOptions(doc, repeatOf(doc)).find(
			(option) => option.value === "user_controlled",
		);
		expect(current?.disabled).toBeUndefined();
	});
});

describe("the query seed", () => {
	it("prints as the open cases of the menu's type and parses back to the same tree, which the checker admits", () => {
		const doc = docWith([repeatSpec()]);
		const queried = applied(doc, commitOf(doc, "query_bound"));
		const slot = { entity: "field", uuid: REPEAT, slot: "ids_query" } as const;
		const seed = openCasesQuery("visit");
		expect(projectFormExpression(queried, slot, seed, "unavailable").text).toBe(
			"instance('casedb')/casedb/case[@case_type = 'visit'][@status = 'open']/@case_id",
		);
		expect(roundTrip(queried, slot, seed)).toEqual(seed);
		const ctx = slotContext(queried, slot, new Map(), {
			facts: expressionFacts(queried),
		});
		if (ctx === undefined) throw new Error("The query slot has no context.");
		expect(checkExpression(seed, ctx).errors).toEqual([]);
	});
});

describe("Use a whole number", () => {
	it("wraps the stored count in int(...) as a call node, which the printer and parser give back and the gate admits", () => {
		const count: Expression = term(formField(WEIGHT));
		const doc = docWith([
			repeatSpec({ repeat_mode: "count_bound", repeat_count: count }),
		]);
		const refusal = wholeNumberCountRefusal(doc, REPEAT, count);
		expect(refusal?.reason).toBe("whole-number-count");

		const fixed = wholeNumberCountFix(count);
		expect(fixed).toEqual({ kind: "call", fn: "int", args: [count] });
		// The stored tree itself sits inside the call, untouched.
		expect(fixed.kind === "call" && fixed.args[0]).toBe(count);

		const slot = {
			entity: "field",
			uuid: REPEAT,
			slot: "repeat_count",
		} as const;
		expect(projectFormExpression(doc, slot, fixed, "unavailable").text).toBe(
			"int(#form/weight)",
		);
		expect(roundTrip(doc, slot, fixed)).toEqual(fixed);
		expect(wholeNumberCountRefusal(doc, REPEAT, fixed)).toBeUndefined();

		const mutation = wholeNumberCountFixMutation(REPEAT, count);
		expect(mutation.patch).toEqual({ repeat_count: fixed });
		expect(gateFindings(doc, mutation)).toEqual([]);
	});

	it("finds nothing to fix in a whole-number count", () => {
		const doc = docWith([
			repeatSpec({
				repeat_mode: "count_bound",
				repeat_count: term(formField(SIZE)),
			}),
		]);
		expect(
			wholeNumberCountRefusal(doc, REPEAT, term(formField(SIZE))),
		).toBeUndefined();
	});
});

describe("the placement line", () => {
	const query = openCasesQuery("visit");

	it("says rows are set when the form opens for a query that reads no answer", () => {
		const doc = docWith([
			repeatSpec({
				repeat_mode: "query_bound",
				data_source: { ids_query: query },
			}),
		]);
		expect(queryRepeatPlacementLines(doc, REPEAT)).toEqual({
			placement: "model-iteration",
			held: false,
			line: SET_WHEN_OPENED,
		});
	});

	it("follows a query that reads an answer, says why, and says what a row past the end does", () => {
		const readsAnswer: Expression = {
			kind: "project",
			of: {
				kind: "cases",
				source: "casedb",
				where: [eq(term(formField(SIZE)), literal(1))],
			},
			value: { kind: "prop", caseType: "visit", property: "case_id" },
		};
		const doc = docWith([
			repeatSpec({
				repeat_mode: "query_bound",
				data_source: { ids_query: readsAnswer },
			}),
		]);
		expect(queryRepeatPlacementLines(doc, REPEAT)).toEqual({
			placement: "count",
			held: false,
			line: FOLLOW,
			because: "Because its query reads an answer.",
			pastTheEnd: PAST_THE_END_LINE,
		});
	});

	it("says a held placement is kept where the published app has it", () => {
		const doc = docWith([
			repeatSpec({
				repeat_mode: "query_bound",
				data_source: { ids_query: query },
				placement: "count",
			}),
		]);
		const lines = queryRepeatPlacementLines(doc, REPEAT);
		expect(lines?.line).toBe(
			`${FOLLOW} · Kept where your published app has it`,
		);
		expect(lines?.held).toBe(true);
		expect(lines?.because).toBeUndefined();
	});

	it("is absent for a repeat that isn't a query repeat", () => {
		const doc = docWith([repeatSpec()]);
		expect(queryRepeatPlacementLines(doc, REPEAT)).toBeUndefined();
	});
});
