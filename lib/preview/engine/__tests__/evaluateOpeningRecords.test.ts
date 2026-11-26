/**
 * A form check of a form that keeps its own opening choices opens the form
 * as a worker does: each choice the worker makes from a list holds the
 * record named for it, and the form's own record is the case it opens on.
 * The failure: the check binds `caseIds` to nothing the form reads, stops at
 * the first choice and still runs the form, reporting every opening-record
 * read blank as though it were the form's behaviour.
 */
import { describe, expect, it } from "vitest";
import { independentChoicesBlueprint } from "@/proof/targeted/documents/independentFormChoices";
import type { CaseRow } from "../caseDataBindingTypes";
import { evaluateFormSnapshot } from "../evaluateFormSnapshot";
import {
	type FormEvaluationContext,
	FormEvaluationInputError,
} from "../formEvaluationTypes";
import { previewAsMe } from "../identity";
import { webAppsDevice } from "./fixtures/previewDevices";

function person(caseId: string, name: string): CaseRow {
	return {
		case_id: caseId,
		app_id: "eval",
		case_type: "person",
		owner_id: "member",
		status: "open",
		opened_on: null,
		modified_on: null,
		closed_on: null,
		case_name: name,
		external_id: null,
		parent_case_id: null,
		properties: {},
	};
}

function fixture() {
	const doc = independentChoicesBlueprint("eval");
	const form = Object.values(doc.forms).find(
		(candidate) => candidate.name === "Visit with assigned contact",
	);
	const identity = previewAsMe({ id: "member", name: "Member" }, doc);
	if (!form || !identity) throw new Error("The fixture has the quick visit.");
	const context: FormEvaluationContext = {
		identity,
		device: webAppsDevice(),
		cases: {
			rows: [person("p-1", "Bo"), person("p-2", "Ada")],
			indices: [],
		},
		lookup: { projectRevision: "0", definitions: [], rowsByTable: new Map() },
		session: { appId: "eval", menuSelections: {} },
	};
	return { doc, formUuid: form.uuid, context };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof FormEvaluationInputError) return error.message;
		throw error;
	}
	throw new Error("The check ran the form.");
}

describe("a form check of a form that keeps its own opening choices", () => {
	it("opens on the records named for its choices, its own record the one it opens on", async () => {
		const { doc, formUuid, context } = fixture();
		const result = await evaluateFormSnapshot(
			doc,
			{
				formUuid,
				answers: [{ path: "quick_note", value: "Seen" }],
				openingRecords: [
					{ name: "Person to visit", caseId: "p-1" },
					{ name: "Assigned contact", caseId: "p-2" },
				],
			},
			context,
		);
		expect(result.valid).toBe(true);
		expect(result.submission).toMatchObject({
			kind: "followup",
			caseIds: ["p-2"],
		});
	});

	it("refuses a choice left without a record, naming it", async () => {
		const { doc, formUuid, context } = fixture();
		expect(
			await refusal(
				evaluateFormSnapshot(
					doc,
					{
						formUuid,
						answers: [],
						openingRecords: [{ name: "Person to visit", caseId: "p-1" }],
					},
					context,
				),
			),
		).toBe(
			"This form opens with “Assigned contact”, a record the worker chooses from a list. Name a record for it in openingRecords.",
		);
	});

	it("refuses caseIds, which bind no choice the form makes", async () => {
		const { doc, formUuid, context } = fixture();
		expect(
			await refusal(
				evaluateFormSnapshot(
					doc,
					{ formUuid, answers: [], caseIds: ["p-2"] },
					context,
				),
			),
		).toBe(
			"This form chooses its own opening records. Name each one in openingRecords instead of caseIds.",
		);
	});

	it("refuses a name that is no choice of the form, and a record of another type", async () => {
		const { doc, formUuid, context } = fixture();
		const run = (openingRecords: { name: string; caseId: string }[]) =>
			refusal(
				evaluateFormSnapshot(
					doc,
					{ formUuid, answers: [], openingRecords },
					{
						...context,
						cases: {
							...context.cases,
							rows: [
								...context.cases.rows,
								{ ...person("v-1", "Visit"), case_type: "visit" },
							],
						},
					},
				),
			);
		expect(await run([{ name: "Someone", caseId: "p-1" }])).toBe(
			"“Someone” isn’t an opening record this form chooses from a list. Get the form to see its opening records.",
		);
		expect(await run([{ name: "Person to visit", caseId: "v-1" }])).toBe(
			"The record named for “Person to visit” is unavailable to this worker or isn’t a person record.",
		);
	});
});
