/**
 * The record dialect over the record-rule widenings: a yes or no answer
 * read alone as a case change's condition, `boolean(...)` of any other
 * answer there, and the comparisons CommCare coerces. Each prints and reads back to itself, the law the reader of
 * CommCare HQ's apps holds every record slot to (`recordDialectRoundTrip`),
 * so an app that holds one comes in and an agent can read and edit it. The
 * failure this catches: the printer or the parser refusing a shape the
 * checker admits, which would leave a brought-in app's slot unreadable.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc } from "@/lib/domain";
import {
	eq,
	formField,
	literal,
	not,
	prop,
	term,
} from "@/lib/domain/expression/builders";
import type {
	Expression,
	ExpressionSlotRef,
} from "@/lib/domain/expression/types";
import { proseText } from "@/lib/domain/prose";
import { recordDialectRoundTrip } from "../recordRoundTrip";

const FORM = testUuid("coercion-dialect-form");
const FLAG = testUuid("coercion-dialect-flag");
const REFERRAL = testUuid("coercion-dialect-referral");
const NOTE = testUuid("coercion-dialect-note");

function doc(condition: Expression): BlueprintDoc {
	const built = buildDoc({
		caseTypes: [
			{
				name: "site",
				properties: [
					{ name: "repairs", label: proseText("Repairs"), data_type: "int" },
					{
						name: "cut_water",
						label: proseText("Cut water"),
						data_type: "single_select",
						options: [
							{ value: "1", label: proseText("Yes") },
							{ value: "0", label: proseText("No") },
						],
					},
				],
			},
			{ name: "referral", properties: [] },
		],
		modules: [
			{
				name: "Sites",
				caseType: "site",
				forms: [
					{
						uuid: FORM,
						name: "Inspection",
						type: "followup",
						fields: [
							f({ uuid: NOTE, kind: "text", id: "note", label: "Note" }),
							f({
								uuid: FLAG,
								kind: "hidden",
								id: "create_referral",
								calculate: "#form/note != ''",
							}),
						],
					},
				],
			},
		],
	});
	const form = built.forms[FORM];
	return {
		...built,
		forms: {
			...built.forms,
			[FORM]: {
				...form,
				caseOperations: [
					...(form.caseOperations ?? []),
					{
						uuid: REFERRAL,
						id: "referral",
						action: "create",
						caseType: "referral",
						target: { kind: "new" },
						name: term(literal("Referral")),
						condition,
					},
				],
			},
		},
	};
}

const SLOT: ExpressionSlotRef = {
	entity: "form",
	uuid: FORM,
	slot: "case_operation_condition",
	member: { operationUuid: REFERRAL },
};

describe("the record dialect over the widened record rules", () => {
	it.each([
		["a yes or no read alone", term(formField(FLAG))],
		["its negation", not(term(formField(FLAG)))],
		[
			"an answer read alone as CommCare reads it",
			{
				kind: "call",
				fn: "boolean",
				args: [term(formField(NOTE))],
			} satisfies Expression,
		],
		["a choice against a number", eq(prop("site", "cut_water"), literal(1))],
		[
			"a whole number against its text",
			eq(prop("site", "repairs"), literal("1")),
		],
	])("prints and reads back %s", (_, condition) => {
		expect(
			recordDialectRoundTrip(doc(condition), SLOT, condition, new Map()),
		).toBeUndefined();
	});
});
