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
import { formChangesSessionCase } from "../unheldCaseSubmit";

const FORM = testUuid("unheld-form");

function visitDoc(
	type: Form["type"],
	fields: FieldSpec[],
	options: {
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

	it("counts a close form whose close holds, and not one whose close does not", () => {
		// Whether the close holds is the form's close condition over the
		// submitted answers (`FormEngine.ownCloseHolds`).
		const doc = visitDoc("close", [
			{ kind: "text", id: "outcome", label: "Outcome" },
		]);
		expect(formChangesSessionCase(doc, FORM, true)).toBe(true);
		expect(formChangesSessionCase(doc, FORM, false)).toBe(false);
	});

	it("does not count a follow-up whose own case saves only to the case above it", () => {
		const doc = visitDoc("followup", [
			{ kind: "text", id: "note", label: "Note" },
		]);
		const form = doc.forms[FORM];
		doc.forms[FORM] = {
			...form,
			caseOperations: form.caseOperations?.map((operation) =>
				operation.action === "own"
					? {
							...operation,
							writes: [
								{
									property: "status",
									value: term(literal("seen")),
									via: [{ identifier: "parent" }],
								},
							],
						}
					: operation,
			),
		};
		expect(formChangesSessionCase(doc, FORM, false)).toBe(false);
	});

	it("counts a follow-up whose own case renames the case it loaded", () => {
		const doc = visitDoc("followup", [
			{ kind: "text", id: "note", label: "Note" },
		]);
		const form = doc.forms[FORM];
		doc.forms[FORM] = {
			...form,
			caseOperations: form.caseOperations?.map((operation) =>
				operation.action === "own"
					? { ...operation, name: term(literal("Renamed")) }
					: operation,
			),
		};
		expect(formChangesSessionCase(doc, FORM, false)).toBe(true);
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
