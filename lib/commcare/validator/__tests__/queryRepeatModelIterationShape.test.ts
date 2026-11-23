/**
 * A held model iteration at the commit gate. A published app sets a query
 * repeat's rows once, when the form opens, and keeps each row's record id
 * where model iteration writes it; a document that holds that placement over
 * a repeat model iteration can no longer run is refused, naming the first
 * failure its opening capture can be shown to have: rows that take the
 * wrong records, a query that needs a record ID no answer holds yet, or a
 * group an earlier starting value hides. A query, a row condition or a group
 * condition that can change after opening is ordinary input to the capture.
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

	it("admits one whose query reads an answer, captured as the answer stands at opening", () => {
		expect(
			finding(
				docWith([queryRepeat({ data_source: { ids_query: readsAnswer } })]),
			),
		).toBeUndefined();
	});

	it("refuses one whose query needs a record ID no answer holds yet", () => {
		const byEnteredId: Expression = {
			kind: "project",
			of: {
				kind: "cases",
				source: "casedb",
				where: [eq(prop("visit", "case_id"), term(formField(ANSWER)))],
			},
			value: { kind: "literal", value: "@case_id" },
		};
		const found = finding(
			docWith([queryRepeat({ data_source: { ids_query: byEnteredId } })]),
		);
		expect(found?.details?.reason).toBe("query-reads-answers");
		expect(found?.message).toBe(
			`"Visits to review" takes its rows once, when the form opens, as your published app does, before the answer its query matches a record ID against is given, so it would find no records. ${FOLLOW}, or give that answer a starting value.`,
		);
		expect(found && userFacingError(found)).toBe(found?.message);
	});

	it("admits one with a condition of its own: each row holds its condition", () => {
		expect(
			finding(docWith([queryRepeat({ label: "", relevant: readsAnswer })])),
		).toBeUndefined();
	});

	it("admits one under a group whose condition can change after opening", () => {
		expect(
			finding(
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
			),
		).toBeUndefined();
	});

	it("refuses one under a group an earlier starting value hides at opening, naming the group", () => {
		const doc = docWith([
			{
				kind: "group",
				id: "follow_up",
				uuid: GROUP,
				label: "Follow-up",
				relevant: readsAnswer,
				children: [queryRepeat()],
			},
		]);
		const size = doc.fields[ANSWER];
		if (size?.kind !== "int") throw new Error("The form holds its size.");
		const hidden: BlueprintDoc = {
			...doc,
			fields: {
				...doc.fields,
				[ANSWER]: { ...size, default_value: term(literal(0)) },
			},
		};
		const found = finding(hidden);
		expect(found?.details).toMatchObject({
			reason: "ancestor-condition-changes",
			groupUuid: GROUP,
			groupId: "follow_up",
		});
		expect(found?.message).toBe(
			`"Visits to review" takes its rows once, when the form opens, as your published app does, while a starting value hides "Follow-up" around it, so its rows would stay empty. ${FOLLOW}, or show "Follow-up" when the form opens.`,
		);
		expect(found && userFacingError(found)).toBe(found?.message);
	});
});
