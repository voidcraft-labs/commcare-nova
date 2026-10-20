import { expect, it } from "vitest";
import { makeAuthoringHarness } from "@/lib/agent/__tests__/authoringHarness";
import { namedFormFixture } from "@/lib/agent/__tests__/namedFormFixture";
import { AUTHORING_REFERENCE } from "../reference";

// The guide teaches the model spellings; each one here goes through the
// published grammar, the shared tool body and the commit gate the way a model
// writes it, so a guide sentence the parser or gate contradicts fails here.

const guide = Object.values(AUTHORING_REFERENCE)
	.map((topic) => topic())
	.join("\n");

async function fixture() {
	const h = makeAuthoringHarness(
		{},
		namedFormFixture([
			{
				name: "Visits",
				caseType: "visit",
				forms: [{ name: "Check", type: "followup" }],
			},
		]),
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
	/** The outcome of adding one hidden value: ok, or the refusal's text. */
	const calculate = async (
		id: string,
		expression: string,
		parentUuid?: string,
	): Promise<string> => {
		try {
			const result = await h.call("addFields", {
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
			return result !== null &&
				typeof result === "object" &&
				"error" in result &&
				typeof result.error === "string"
				? result.error
				: "ok";
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	};
	return { h, calculate };
}

it("reads a repeat's own row from inside it and every row from outside", async () => {
	const { calculate } = await fixture();
	for (const example of [
		"../name reads the answer in the same group or repeat row",
		"count(#form/members/age)",
	])
		expect(guide).toContain(example);
	expect(await calculate("next_age", "../age + 1", "members")).toBe("ok");
	expect(await calculate("same_row", "#form/members/age + 1", "members")).toBe(
		"ok",
	);
	expect(await calculate("one_age", "#form/members/age + 1")).toContain(
		'reads an answer from every entry of the repeat "members"',
	);
	expect(await calculate("ages", "count(#form/members/age)")).toBe("ok");
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
	expect(await calculate("row_id", "current()/../@id", "visits")).toBe("ok");
	expect(await calculate("visit_name", nameRead, "visits")).toBe("ok");
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
	).toBe("ok");
	expect(
		await calculate(
			"current_read",
			"count(instance('casedb')/casedb/case[@case_type = 'visit'][region = current()/../region])",
		),
	).toBe("ok");
	// Two record types declare region, so the untyped query can't tell which
	// records it reads.
	expect(
		await calculate(
			"untyped",
			"count(instance('casedb')/casedb/case[region = #form/region])",
		),
	).toContain("so this query knows which records to read");
	// The guide offers no . inside a query's [ ], because it is refused there.
	expect(
		await calculate(
			"dot",
			"count(instance('casedb')/casedb/case[@case_type = 'visit'][. = #form/region])",
		),
	).toContain("needs the name of one property");
});

it("offers here() in a calculated column and nowhere in a form", async () => {
	const { h, calculate } = await fixture();
	expect(guide).toContain("here() is the worker's current location");
	expect(
		await h.call("addCaseListColumns", {
			moduleUuid: "Visits",
			columns: [{ kind: "calculated", header: "Here", expression: "here()" }],
		}),
	).toMatchObject({ ok: true });
	expect(await calculate("where", "here()")).toContain("uses here()");
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
