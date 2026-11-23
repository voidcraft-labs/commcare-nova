import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { CaseRow } from "@/lib/case-store/store";
import { implicitFormSelectionId } from "@/lib/domain/formEntryCases";
import { independentChoicesBlueprint } from "@/proof/targeted/documents/independentFormChoices";
import { sharedVisitsBlueprint } from "@/proof/targeted/documents/sharedVisitEntries";
import { buildEngineInput } from "../engineInput";
import { FormEngine } from "../formEngine";
import { openingCaseAssignments } from "../openingCaseAssignments";

function person(id: string, name: string): CaseRow {
	return {
		app_id: "practice",
		case_id: id,
		case_type: "person",
		case_name: name,
		owner_id: "worker",
		status: "open",
		external_id: null,
		opened_on: null,
		modified_on: null,
		closed_on: null,
		parent_case_id: null,
		properties: {},
	};
}

it("retains the early default, applies two selections to one destination in order, and preserves a resumed entry", () => {
	const doc = independentChoicesBlueprint("practice", true);
	const form = Object.values(doc.forms).find((row) => row.type === "followup");
	if (!form?.caseSelections || !form.openingAssignments)
		throw new Error("Worker fixture lacks its opening instructions");
	const input = buildEngineInput(doc, form.uuid, null);
	if (!input) throw new Error("Worker fixture lacks its form");
	const first = form.caseSelections.find((row) => row.tag === "first");
	const second = form.caseSelections.find((row) => row.tag === "second");
	if (!first || !second) throw new Error("Worker fixture lacks its choices");
	const reached = new Map([
		[first.uuid, "first"],
		[second.uuid, "second"],
	]);
	const opening = openingCaseAssignments(doc, form.uuid, reached, {
		rows: [person("first", "First person"), person("second", "Second person")],
		indices: [],
	});
	const engine = new FormEngine({ ...input, openingAssignments: opening });
	const checkpoint = engine.entryCheckpoint();
	const fields = new Map(checkpoint.instance.values);
	expect(fields.get("/data/earlier_value")).toBe("Before");
	expect(fields.get("/data/first_record")).toBe("First person");
	expect(fields.get("/data/starting_record")).toBe("Second person");
	const changed = openingCaseAssignments(doc, form.uuid, reached, {
		rows: [person("first", "A different person")],
		indices: [],
	});
	const resumed = new FormEngine(
		{ ...input, openingAssignments: changed },
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{ restoredEntry: { checkpoint, preserveAllValues: true } },
	);
	expect(
		new Map(resumed.entryCheckpoint().instance.values).get(
			"/data/starting_record",
		),
	).toBe("Second person");
	// Without a link, Core's read yields an empty nodeset and clears the
	// question even when its earlier authored starting value was nonempty.
	const shared = form.openingAssignments.at(-1);
	if (!shared) throw new Error("Missing last assignment");
	form.openingAssignments = [
		{
			...shared,
			uuid: testUuid("missing-link"),
			via: [{ identifier: "home" }],
		},
	];
	const missing = openingCaseAssignments(doc, form.uuid, reached, {
		rows: [person("second", "Second person")],
		indices: [],
	});
	expect(missing[0]?.value).toBe("");
	expect(
		new Map(
			new FormEngine({
				...input,
				openingAssignments: missing,
			}).entryCheckpoint().instance.values,
		).get("/data/starting_record"),
	).toBe("");
});

it("runs dependent calculations and relevance before the next load, then inserts the requested rows", () => {
	const doc = independentChoicesBlueprint("review", true);
	const menu = doc.moduleOrder[2];
	const form = doc.formOrder[menu][0];
	const input = buildEngineInput(doc, form, null);
	if (!input) throw new Error("Missing review form");
	const opening = openingCaseAssignments(
		doc,
		form,
		new Map([[implicitFormSelectionId(form, menu), "visitor"]]),
		{
			rows: [person("visitor", "First person")],
			indices: [],
		},
	);
	const engine = new FormEngine({ ...input, openingAssignments: opening });
	const checkpoint = engine.entryCheckpoint();
	const values = new Map(checkpoint.instance.values);
	expect(values.get("/data/visitor")).toBe("First person");
	expect(values.get("/data/second_copy")).toBe("Visit First person confirmed");
	expect(values.get("/data/confirmation")).toBe(
		"Checked: Visit First person confirmed",
	);
	expect(values.get("/data/earlier_description")).toBe("Seen: ");
	expect(values.get("/data/details/description")).toBe("Ready");
	expect(engine.getRepeatCount("/data/zero")).toBe(0);
	expect(engine.getRepeatCount("/data/one")).toBe(1);
	expect(values.get("/data/one[0]/copy") ?? "").toBe("");
});

it("gives a second entry its parent's starting values from the record it chose", () => {
	const doc = sharedVisitsBlueprint("shared");
	const visit = Object.values(doc.forms).find((row) => row.name === "Visit");
	const callback = Object.values(doc.forms).find(
		(row) => row.name === "Return a call",
	);
	const patient = visit?.caseSelections?.find((row) => row.tag === "patient");
	if (!visit || !callback?.shadowOf || !patient)
		throw new Error("The shared visits fixture lacks its entries");
	const note = doc.fieldOrder[visit.uuid][0];
	visit.openingAssignments = [
		{
			uuid: testUuid("patient-name"),
			field: note,
			source: { kind: "selection", selection: patient.uuid },
			property: "case_name",
		},
	];
	const opening = openingCaseAssignments(
		doc,
		callback.uuid,
		new Map([[patient.uuid, "second"]]),
		{ rows: [person("second", "Second person")], indices: [] },
	);
	expect(opening.map((row) => [row.field, row.value])).toEqual([
		[note, "Second person"],
	]);
});
