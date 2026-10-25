/**
 * Which forms change the case they were opened for: the forms Android
 * refuses to process when an entry point opened them for a case the phone
 * does not hold (Core's `CaseXmlParser.loadCase` throws for an update or a
 * close of a missing case, and for nothing else).
 *
 * Fails when a form that updates or closes the session's case is let
 * through (Preview would write what the phone never sends), or when a form
 * that only reads it, writes a child, or changes a case it creates itself is
 * refused (Preview would refuse what the phone saves).
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, type FieldSpec } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc, CaseOperation, Form } from "@/lib/domain";
import { literal, term } from "@/lib/domain/expression";
import {
	closeConditionHolds,
	formChangesSessionCase,
} from "../unheldCaseSubmit";

const FORM = testUuid("unheld-form");

function visitDoc(
	type: Form["type"],
	fields: FieldSpec[],
	options: {
		readonly closeCondition?: { field: string; answer: string };
		readonly caseOperations?: CaseOperation[];
	} = {},
): BlueprintDoc {
	return buildDoc(
		{
			caseTypes: [
				{
					name: "visit",
					properties: [{ name: "status", label: "Status" }],
				},
				{
					name: "sample",
					parent_type: "visit",
					properties: [{ name: "label", label: "Label" }],
				},
			],
			modules: [
				{
					name: "Visits",
					caseType: "visit",
					forms: [
						{
							uuid: FORM,
							name: "Update visit",
							type,
							fields,
							...(options.closeCondition !== undefined && {
								closeCondition: options.closeCondition,
							}),
						},
					],
				},
			],
		},
		(doc) => {
			if (options.caseOperations !== undefined)
				doc.forms[FORM] = {
					...doc.forms[FORM],
					caseOperations: options.caseOperations,
				};
		},
	);
}

const statusWriter: FieldSpec = {
	kind: "text",
	id: "status",
	label: "Status",
	caseWrite: { caseType: "visit", property: "status" },
};

describe("formChangesSessionCase", () => {
	it("counts a follow-up that updates the module's case", () => {
		expect(
			formChangesSessionCase(visitDoc("followup", [statusWriter]), FORM, false),
		).toBe(true);
	});

	it("counts a close form whose close condition holds, and not one whose condition fails", () => {
		const doc = visitDoc(
			"close",
			[{ kind: "text", id: "outcome", label: "Outcome" }],
			{ closeCondition: { field: "outcome", answer: "done" } },
		);
		const holds = (answer: string) =>
			closeConditionHolds(doc, FORM, (uuid) =>
				uuid === doc.forms[FORM].closeCondition?.field ? answer : "",
			);
		expect(formChangesSessionCase(doc, FORM, holds("done"))).toBe(true);
		expect(formChangesSessionCase(doc, FORM, holds("pending"))).toBe(false);
	});

	it("counts a close form with no close condition, which always closes", () => {
		const doc = visitDoc("close", [
			{ kind: "text", id: "note", label: "Note" },
		]);
		expect(closeConditionHolds(doc, FORM, () => "")).toBe(true);
		expect(
			formChangesSessionCase(
				doc,
				FORM,
				closeConditionHolds(doc, FORM, () => ""),
			),
		).toBe(true);
	});

	it("reads a multiple-choice close condition as one of the answers", () => {
		const doc = visitDoc(
			"close",
			[{ kind: "text", id: "outcome", label: "Outcome" }],
			{ closeCondition: { field: "outcome", answer: "done" } },
		);
		doc.forms[FORM] = {
			...doc.forms[FORM],
			closeCondition: {
				...(doc.forms[FORM].closeCondition as NonNullable<
					Form["closeCondition"]
				>),
				operator: "selected",
			},
		};
		expect(closeConditionHolds(doc, FORM, () => "started done")).toBe(true);
		expect(closeConditionHolds(doc, FORM, () => "started")).toBe(false);
	});

	it("counts an update of the session's case from an authored operation", () => {
		const doc = visitDoc(
			"followup",
			[{ kind: "text", id: "note", label: "Note" }],
			{
				caseOperations: [
					{
						uuid: testUuid("unheld-op-update"),
						id: "mark_seen",
						action: "update",
						caseType: "visit",
						target: { kind: "session" },
						writes: [{ property: "status", value: term(literal("seen")) }],
					},
				],
			},
		);
		expect(formChangesSessionCase(doc, FORM, false)).toBe(true);
	});

	it("does not count a follow-up that writes only a child case", () => {
		const doc = visitDoc("followup", [
			{
				kind: "text",
				id: "label",
				label: "Sample label",
				caseWrite: { caseType: "sample", property: "label" },
			},
		]);
		expect(formChangesSessionCase(doc, FORM, false)).toBe(false);
	});

	it("does not count an update of a case the form creates itself", () => {
		const create = testUuid("unheld-op-create");
		const doc = visitDoc(
			"survey",
			[{ kind: "text", id: "note", label: "Note" }],
			{
				caseOperations: [
					{
						uuid: create,
						id: "open_sample",
						action: "create",
						caseType: "sample",
						target: { kind: "new" },
						name: term(literal("Sample")),
					},
					{
						uuid: testUuid("unheld-op-follow"),
						id: "label_sample",
						action: "update",
						caseType: "sample",
						target: { kind: "op", opUuid: create },
						writes: [{ property: "label", value: term(literal("first")) }],
					},
				],
			},
		);
		expect(formChangesSessionCase(doc, FORM, false)).toBe(false);
	});

	it("does not count a follow-up that only reads its case", () => {
		expect(
			formChangesSessionCase(
				visitDoc("followup", [{ kind: "text", id: "note", label: "Note" }]),
				FORM,
				false,
			),
		).toBe(false);
	});
});
