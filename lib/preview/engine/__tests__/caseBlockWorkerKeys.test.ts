// A case block's owner, values, name and conditions are binds of the form,
// which Core calculates as soon as their node exists, so a bare read of a
// worker-data key the session lacks (a place key of a worker assigned
// nowhere, `models.py::get_user_session_data`) stops the form there on a
// device. Preview evaluates those slots in SQL at submission, so the engine
// refuses at the same points: when the form opens for the form's own
// operations, and when a row exists for an operation inside a repeat.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { runValidation } from "@/lib/commcare/validator/runner";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { sessionUser, term } from "@/lib/domain/expression";
import {
	caseBlocksReadAbsentWorkerKey,
	previewDataRefusalOf,
	previewDataRefusalSubject,
} from "../dataRefusal";
import { buildEngineInput } from "../engineInput";
import { FormEngine } from "../formEngine";

const FORM = testUuid("case-block-form");
const REPEAT = testUuid("case-block-repeat");

/** A follow-up whose own operation, or one inside a repeat, moves the case to
 *  the worker's case-sharing group by its session key. */
function ownerReadsPlace(
	field: string,
	placement: "form" | "repeat",
): BlueprintDoc {
	const doc = buildDoc({
		appName: "Case block worker keys",
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: FORM,
						name: "Transfer",
						type: "followup",
						fields: [
							f({ kind: "text", id: "note" }),
							f({
								uuid: REPEAT,
								kind: "repeat",
								id: "moves",
								repeat_mode: "user_controlled",
								children: [f({ kind: "text", id: "reason" })],
							}),
						],
					},
				],
			},
		],
	});
	doc.forms[FORM].caseOperations = [
		...(doc.forms[FORM].caseOperations ?? []),
		{
			uuid: testUuid("case-block-transfer"),
			id: "transfer",
			action: "update",
			caseType: "patient",
			target: { kind: "session" },
			...(placement === "repeat" ? { forEach: { repeat: REPEAT } } : {}),
			owner: term(sessionUser(field)),
		},
	];
	const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
	if (findings.length) throw new Error(JSON.stringify(findings));
	return doc;
}

const PLACED = {
	commcare_location_id: "place-north",
	commcare_location_ids: "place-north",
	commcare_primary_case_sharing_id: "place-north",
};

function formOf(doc: BlueprintDoc) {
	const form = doc.forms[FORM];
	if (form === undefined) throw new Error("The fixture form is missing.");
	return form;
}

describe("a case block that reads a worker key the session lacks", () => {
	it("refuses the form's own operation at open, and a repeat's per row, only for a worker assigned nowhere", () => {
		const own = ownerReadsPlace("commcare_primary_case_sharing_id", "form");
		expect(caseBlocksReadAbsentWorkerKey(own, formOf(own), {})).toEqual({
			form: true,
			repeats: new Set(),
		});
		expect(
			caseBlocksReadAbsentWorkerKey(own, formOf(own), PLACED),
		).toBeUndefined();
		const perRow = ownerReadsPlace(
			"commcare_primary_case_sharing_id",
			"repeat",
		);
		expect(caseBlocksReadAbsentWorkerKey(perRow, formOf(perRow), {})).toEqual({
			form: false,
			repeats: new Set<Uuid>([REPEAT]),
		});
	});

	it("reads the project space blank, which every device holds", () => {
		const doc = ownerReadsPlace("commcare_project", "form");
		expect(caseBlocksReadAbsentWorkerKey(doc, formOf(doc), {})).toBeUndefined();
	});

	it("stops the form at open in the engine, as the worker-information refusal", () => {
		const doc = ownerReadsPlace("commcare_primary_case_sharing_id", "form");
		const input = buildEngineInput(doc, FORM, null);
		if (input === undefined) throw new Error("The fixture form is missing.");
		let caught: unknown;
		try {
			// No identity: the session holds no worker data at all.
			new FormEngine(input, "patient", undefined, null, null, {
				rows: [],
				indices: [],
			});
		} catch (error) {
			caught = error;
		}
		const refusal = previewDataRefusalOf(caught);
		expect(refusal?.stage).toBe("form");
		expect(refusal && previewDataRefusalSubject(refusal.reason, null)).toEqual({
			kind: "worker-information",
		});
	});
});
