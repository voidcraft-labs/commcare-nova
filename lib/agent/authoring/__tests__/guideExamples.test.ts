import { expect, it } from "vitest";
import { makeAuthoringHarness } from "@/lib/agent/__tests__/authoringHarness";
import { namedFormFixture } from "@/lib/agent/__tests__/namedFormFixture";
import type { Platform } from "@/lib/domain";
import { evaluateForm } from "@/lib/preview/engine/evaluateForm";
import { evaluationScenarioCases } from "@/lib/preview/engine/evaluationScenario";
import { previewAsMe } from "@/lib/preview/engine/identity";
import { AuthoringInputError } from "../errors";
import { AUTHORING_REFERENCE } from "../reference";

// The guide teaches the model spellings; each one here goes through the
// published grammar, the shared tool body and the commit gate the way a model
// writes it, so a guide sentence the parser or gate contradicts fails here.

const guide = Object.values(AUTHORING_REFERENCE)
	.map((topic) => topic())
	.join("\n");

type CalculateOutcome =
	| { readonly saved: true }
	| { readonly refused: "gate" | "input"; readonly message: string };

/** How the commit gate opens a refusal of a batch that would add a finding. */
const GATE_REFUSAL =
	"This change wasn't applied because the resulting app has a problem";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const saved: CalculateOutcome = { saved: true };

async function fixture(options: { readonly runsOnlyOn?: Platform } = {}) {
	const h = makeAuthoringHarness(
		{},
		namedFormFixture(
			[
				{
					name: "Visits",
					caseType: "visit",
					forms: [{ name: "Check", type: "followup" }],
				},
			],
			options,
		),
	);
	await h.call("generateSchema", {
		caseTypes: [
			{
				name: "household",
				properties: [{ name: "region", label: "Region", data_type: "text" }],
			},
			{
				name: "visit",
				parent_type: "household",
				properties: [{ name: "region", label: "Region", data_type: "text" }],
			},
		],
	});
	await h.call("addFields", {
		formUuid: "Check",
		fields: [
			{ kind: "text", id: "region", label: "Region" },
			{
				kind: "repeat",
				id: "members",
				label: "Members",
				repeat: { mode: "user_controlled" },
			},
			{ kind: "int", id: "age", label: "Age", parentUuid: "members" },
		],
	});
	await h.call("removeField", {
		formUuid: "Check",
		fieldUuid: "fixture_placeholder",
	});
	/** Adding one hidden value: saved, refused by the commit gate (a finding
	 * in the resulting app), or refused as input before it reaches the gate. */
	const calculate = async (
		id: string,
		expression: string,
		parentUuid?: string,
	): Promise<CalculateOutcome> => {
		let result: unknown;
		try {
			result = await h.call("addFields", {
				formUuid: "Check",
				fields: [
					{
						kind: "hidden",
						id,
						calculate: expression,
						...(parentUuid && { parentUuid }),
					},
				],
			});
		} catch (error) {
			if (error instanceof AuthoringInputError)
				return { refused: "input", message: error.message };
			throw error;
		}
		if (isRecord(result) && result.ok === true) return { saved: true };
		if (
			isRecord(result) &&
			typeof result.error === "string" &&
			result.error.startsWith(GATE_REFUSAL)
		)
			return { refused: "gate", message: result.error };
		throw new Error(`addFields returned ${JSON.stringify(result)}.`);
	};
	return { h, calculate };
}

it("reads a repeat's own row from inside it and every row from outside", async () => {
	const { h, calculate } = await fixture();
	for (const example of [
		"../name reads the answer in the same group or repeat row",
		"count(#form/members/age)",
	])
		expect(guide).toContain(example);
	expect(await calculate("next_age", "../age + 1", "members")).toEqual(saved);
	expect(
		await calculate("same_row", "#form/members/age + 1", "members"),
	).toEqual(saved);
	expect(await calculate("one_age", "#form/members/age + 1")).toEqual({
		refused: "gate",
		message: expect.stringContaining(
			'reads an answer from every entry of the repeat "members"',
		),
	});
	expect(await calculate("ages", "count(#form/members/age)")).toEqual(saved);
	// Both spellings inside the repeat store the same field read; what makes
	// #form/members/age that row's age is how it runs, so run the form.
	const doc = h.currentDoc();
	const formUuid = Object.values(doc.forms).find(
		(form) => form.name === "Check",
	)?.uuid;
	const identity = previewAsMe({ id: "worker", name: "Worker" }, doc);
	if (!formUuid || !identity) throw new Error("Missing form or identity.");
	const result = await evaluateForm(
		doc,
		{
			formUuid,
			caseIds: ["visit-1"],
			repeats: [{ path: "members", count: 2 }],
			answers: [
				{ path: "members[0]/age", value: "30" },
				{ path: "members[1]/age", value: "40" },
			],
		},
		{
			identity,
			cases: evaluationScenarioCases(doc, identity.ownerId, {
				records: [{ id: "visit-1", caseType: "visit", name: "Visit" }],
			}),
			lookup: { projectRevision: "0", definitions: [], rowsByTable: new Map() },
		},
	);
	expect(result.fields).toEqual(
		expect.arrayContaining(
			[
				["members[0]/next_age", "31"],
				["members[0]/same_row", "31"],
				["members[1]/next_age", "41"],
				["members[1]/same_row", "41"],
				["ages", "2"],
			].map(([path, value]) => expect.objectContaining({ path, value })),
		),
	);
});

it("reads a query-bound row's record identity through current()/../@id", async () => {
	const { h, calculate } = await fixture();
	const nameRead =
		"instance('casedb')/casedb/case[@case_id = current()/../@id]/case_name";
	for (const example of ["calculate current()/../@id", nameRead])
		expect(guide).toContain(example);
	expect(
		await h.call("addFields", {
			formUuid: "Check",
			fields: [
				{
					kind: "repeat",
					id: "visits",
					label: "Visits",
					repeat: {
						mode: "query_bound",
						ids_query:
							"instance('casedb')/casedb/case[@case_type = 'visit']/@case_id",
					},
				},
			],
		}),
	).toMatchObject({ ok: true });
	expect(await calculate("row_id", "current()/../@id", "visits")).toEqual(
		saved,
	);
	expect(await calculate("visit_name", nameRead, "visits")).toEqual(saved);
});

it("reads a typed query's rows by bare name and the form through #form/ or current()", async () => {
	const { calculate } = await fixture();
	for (const example of [
		"instance('casedb')/casedb/case[@case_type = 'visit']",
		"[region = #form/region]",
		"current()/../name",
	])
		expect(guide).toContain(example);
	expect(
		await calculate(
			"typed",
			"count(instance('casedb')/casedb/case[@case_type = 'visit'][region = #form/region])",
		),
	).toEqual(saved);
	expect(
		await calculate(
			"current_read",
			"count(instance('casedb')/casedb/case[@case_type = 'visit'][region = current()/../region])",
		),
	).toEqual(saved);
	// A query reading only built-in values needs no type.
	expect(guide).toContain(
		"such as @case_id, index/parent or case_name, needs no type",
	);
	expect(
		await calculate(
			"open_names",
			"join(', ', instance('casedb')/casedb/case[@status = 'open'][index/parent != '']/case_name)",
		),
	).toEqual(saved);
	// Two record types declare region, so the untyped query can't tell which
	// records it reads.
	expect(
		await calculate(
			"untyped",
			"count(instance('casedb')/casedb/case[region = #form/region])",
		),
	).toEqual({
		refused: "input",
		message: expect.stringContaining(
			"so this query knows which records to read",
		),
	});
	// The guide offers no . inside a query's [ ], because it is refused there.
	expect(
		await calculate(
			"dot",
			"count(instance('casedb')/casedb/case[@case_type = 'visit'][. = #form/region])",
		),
	).toEqual({
		refused: "input",
		message: expect.stringContaining("needs the name of one property"),
	});
});

it("offers here() in a calculated column and nowhere in a form", async () => {
	// here() in a case list runs on Android alone.
	const { h, calculate } = await fixture({ runsOnlyOn: "android" });
	expect(guide).toContain("here() is the worker's current GPS position");
	expect(
		await h.call("addCaseListColumns", {
			moduleUuid: "Visits",
			columns: [{ kind: "calculated", header: "Here", expression: "here()" }],
		}),
	).toMatchObject({ ok: true });
	expect(await calculate("where", "here()")).toEqual({
		refused: "gate",
		message: expect.stringContaining("uses here()"),
	});
});

it("keeps a select's starting choice through a value change and refuses removing it", async () => {
	const { h } = await fixture();
	expect(guide).toContain(
		"A select's fixed starting value is one of its choices",
	);
	const add = (id: string, default_value: string) =>
		h.call("addFields", {
			formUuid: "Check",
			fields: [
				{
					kind: "single_select",
					id,
					label: "Seen",
					default_value,
					optionsSource: {
						kind: "inline",
						options: [
							{ value: "yes", label: "Yes" },
							{ value: "no", label: "No" },
						],
					},
				},
			],
		});
	expect(await add("not_a_choice", "'maybe'")).toMatchObject({
		error: expect.stringContaining("isn't one of its choices"),
	});
	expect(await add("seen", "'yes'")).toMatchObject({ ok: true });
	const field = Object.values(h.currentDoc().fields).find(
		(candidate) => candidate.id === "seen",
	);
	if (field?.kind !== "single_select" || field.optionsSource.kind !== "inline")
		throw new Error("The fixture's select is missing.");
	const [yes, no] = field.optionsSource.options;
	const replaceOptions = (
		options: readonly { optionUuid?: string; value: string; label: string }[],
	) =>
		h.call("editField", {
			fieldUuid: field.uuid,
			updates: { optionsSource: { kind: "inline", options } },
		});
	expect(
		await replaceOptions([
			{ optionUuid: yes.uuid, value: "y", label: "Yes" },
			{ optionUuid: no.uuid, value: "no", label: "No" },
		]),
	).toMatchObject({ ok: true });
	expect(await h.call("getField", { fieldUuid: field.uuid })).toMatchObject({
		field: { default_value: "'y'" },
	});
	expect(
		await replaceOptions([
			{ optionUuid: no.uuid, value: "no", label: "No" },
			{ value: "maybe", label: "Maybe" },
		]),
	).toMatchObject({ error: expect.stringContaining("in its starting value") });
});

it("holds a multi-select's several starting choices the same way", async () => {
	const { h } = await fixture();
	expect(guide).toContain(
		"a multi-select's can name several, separated by spaces, such as 'red blue'",
	);
	const add = (id: string, default_value: string) =>
		h.call("addFields", {
			formUuid: "Check",
			fields: [
				{
					kind: "multi_select",
					id,
					label: "Colors",
					default_value,
					optionsSource: {
						kind: "inline",
						options: [
							{ value: "red", label: "Red" },
							{ value: "blue", label: "Blue" },
							{ value: "green", label: "Green" },
						],
					},
				},
			],
		});
	expect(await add("not_choices", "'red pink'")).toMatchObject({
		error: expect.stringContaining("isn't one of its choices"),
	});
	expect(await add("colors", "'red blue'")).toMatchObject({ ok: true });
	const field = Object.values(h.currentDoc().fields).find(
		(candidate) => candidate.id === "colors",
	);
	if (field?.kind !== "multi_select" || field.optionsSource.kind !== "inline")
		throw new Error("The fixture's multi-select is missing.");
	const [red, blue, green] = field.optionsSource.options;
	const replaceOptions = (
		options: readonly { optionUuid?: string; value: string; label: string }[],
	) =>
		h.call("editField", {
			fieldUuid: field.uuid,
			updates: { optionsSource: { kind: "inline", options } },
		});
	expect(
		await replaceOptions([
			{ optionUuid: red.uuid, value: "red", label: "Red" },
			{ optionUuid: blue.uuid, value: "navy", label: "Navy" },
			{ optionUuid: green.uuid, value: "green", label: "Green" },
		]),
	).toMatchObject({ ok: true });
	expect(await h.call("getField", { fieldUuid: field.uuid })).toMatchObject({
		field: { default_value: "'red navy'" },
	});
	expect(
		await replaceOptions([
			{ optionUuid: red.uuid, value: "red", label: "Red" },
			{ optionUuid: green.uuid, value: "green", label: "Green" },
		]),
	).toMatchObject({ error: expect.stringContaining("in its starting value") });
});
