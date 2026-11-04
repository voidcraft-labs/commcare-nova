/**
 * A held model iteration at the commit gate. A published app sets a query
 * repeat's rows once, when the form opens, and keeps each row's record id
 * where model iteration writes it; a document that holds that placement over
 * a repeat model iteration can no longer run is refused, naming the first
 * thing that needs its rows to follow the query. The plausible failure is a
 * held model iteration exported over a shape whose rows would take the wrong
 * records, or stay empty.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, type FieldSpec } from "@/lib/__tests__/docHelpers";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import type { BlueprintDoc } from "@/lib/domain";
import {
	eq,
	formField,
	literal,
	prop,
	term,
} from "@/lib/domain/expression/builders";
import type { Expression } from "@/lib/domain/expression/types";
import type { ValidationError } from "../errors";
import { runValidation } from "../runner";

const REPEAT = testUuid("held-iteration-repeat");
const OUTER = testUuid("held-iteration-outer");
const GROUP = testUuid("held-iteration-group");
const ANSWER = testUuid("held-iteration-answer");

const openCases: Expression = {
	kind: "project",
	of: {
		kind: "cases",
		source: "casedb",
		where: [eq(prop("visit", "status"), literal("open"))],
	},
	value: { kind: "literal", value: "@case_id" },
};
const readsAnswer = eq(term(formField(ANSWER)), literal(1));

function queryRepeat(extra: Record<string, unknown> = {}): FieldSpec {
	return {
		kind: "repeat",
		id: "visits",
		uuid: REPEAT,
		label: "Visits to review",
		repeat_mode: "query_bound",
		data_source: { ids_query: openCases },
		placement: "model-iteration",
		children: [{ kind: "text", id: "note" }],
		...extra,
	};
}

function docWith(fields: FieldSpec[]): BlueprintDoc {
	return buildDoc({
		modules: [
			{
				name: "Visits",
				caseType: "visit",
				forms: [
					{
						name: "Review",
						type: "followup",
						fields: [{ kind: "int", id: "size", uuid: ANSWER }, ...fields],
					},
				],
			},
		],
	});
}

function finding(doc: BlueprintDoc): ValidationError | undefined {
	const found = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
		(error) => error.code === "QUERY_REPEAT_MODEL_ITERATION_SHAPE",
	);
	expect(found.length).toBeLessThanOrEqual(1);
	return found[0];
}

const FOLLOW =
	"You can let its rows follow its query as the form is filled in, which moves where CommCare HQ keeps each row's record id";

describe("QUERY_REPEAT_MODEL_ITERATION_SHAPE", () => {
	it("admits a held model iteration its repeat still fits", () => {
		expect(finding(docWith([queryRepeat()]))).toBeUndefined();
	});

	it("admits a held count placement in any shape", () => {
		const doc = docWith([
			queryRepeat({ placement: "count", relevant: readsAnswer }),
		]);
		expect(finding(doc)).toBeUndefined();
	});

	it("refuses one inside another repeat, naming it", () => {
		const doc = docWith([
			{
				kind: "repeat",
				id: "households",
				uuid: OUTER,
				label: "Households",
				repeat_mode: "user_controlled",
				children: [queryRepeat()],
			},
		]);
		const found = finding(doc);
		expect(found?.details).toMatchObject({
			reason: "nested",
			repeatUuid: OUTER,
		});
		expect(found?.location.fieldUuid).toBe(REPEAT);
		expect(found?.message).toBe(
			`"Visits to review" takes its rows once, when the form opens, as your published app does, and inside "Households" that would give its rows the wrong records. ${FOLLOW}, or keep it outside "Households".`,
		);
		expect(found && userFacingError(found)).toBe(found?.message);
	});

	it("refuses one whose query reads an answer", () => {
		const found = finding(
			docWith([queryRepeat({ data_source: { ids_query: readsAnswer } })]),
		);
		expect(found?.details?.reason).toBe("query-reads-answers");
		expect(found?.message).toBe(
			`"Visits to review" takes its rows once, when the form opens, as your published app does, so its query would run before any answer it reads is given. ${FOLLOW}, or have its query read no answers.`,
		);
		expect(found && userFacingError(found)).toBe(found?.message);
	});

	it("refuses one with a condition of its own, and names its id where it has no label", () => {
		const found = finding(
			docWith([queryRepeat({ label: "", relevant: readsAnswer })]),
		);
		expect(found?.details?.reason).toBe("row-condition");
		expect(found?.message).toBe(
			`"visits" takes its rows once, when the form opens, as your published app does, and a row made while its condition hides an earlier one would take that row's record. ${FOLLOW}, or show every row.`,
		);
		expect(found && userFacingError(found)).toBe(found?.message);
	});

	it("refuses one under a group whose condition can change, naming the group", () => {
		const found = finding(
			docWith([
				{
					kind: "group",
					id: "follow_up",
					uuid: GROUP,
					label: "Follow-up",
					relevant: readsAnswer,
					children: [queryRepeat()],
				},
			]),
		);
		expect(found?.details).toMatchObject({
			reason: "ancestor-condition-changes",
			groupUuid: GROUP,
			groupId: "follow_up",
		});
		expect(found?.message).toBe(
			`"Visits to review" takes its rows once, when the form opens, as your published app does, and "Follow-up" around it shows on a condition that can change while the form is filled in, so its rows could stay empty. ${FOLLOW}, or show "Follow-up" on a condition that doesn't change.`,
		);
		expect(found && userFacingError(found)).toBe(found?.message);
	});
});
