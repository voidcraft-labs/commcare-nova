/** A list of values in a record expression, written the way a client writes
 * it: `list(...)` through the published grammar, production's one call body
 * and the commit gate, and read back through the same projection. */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { BlueprintDoc, SearchInputDef } from "@/lib/domain";
import { AuthoringInputError } from "../authoring/errors";
import { AUTHORING_REFERENCE } from "../authoring/reference";
import { makeAuthoringHarness } from "./authoringHarness";
import { namedFormFixture } from "./namedFormFixture";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

/** How the commit gate opens a refusal of a batch that would add a finding. */
const GATE_REFUSAL =
	"This change wasn't applied because the resulting app has a problem";

type Outcome =
	| { readonly saved: true }
	| { readonly refused: "gate" | "input"; readonly message: string };

async function outcomeOf(call: Promise<unknown>): Promise<Outcome> {
	let result: unknown;
	try {
		result = await call;
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
	throw new Error(`The call returned ${JSON.stringify(result)}.`);
}

function clients(doc: BlueprintDoc) {
	const found = Object.values(doc.modules).find(
		(module) => module.name === "Clients",
	);
	if (found === undefined) throw new Error("Missing module Clients.");
	return found;
}

function searchInputNamed(doc: BlueprintDoc, name: string): SearchInputDef {
	const found = clients(doc).caseListConfig?.searchInputs.find(
		(input) => input.name === name,
	);
	if (found === undefined) throw new Error(`Missing search input ${name}.`);
	return found;
}

async function fixture() {
	const h = makeAuthoringHarness(
		{},
		namedFormFixture([
			{
				name: "Clients",
				caseType: "client",
				forms: [{ name: "Visit", type: "followup" }],
			},
		]),
	);
	expect(
		await h.call("generateSchema", {
			caseTypes: [
				{
					name: "client",
					properties: [
						{ name: "case_name", label: "Client name", data_type: "text" },
						{ name: "region", label: "Region", data_type: "text" },
						{ name: "age", label: "Age", data_type: "int" },
					],
				},
			],
		}),
	).toMatchObject({ ok: true });
	const region = (predicate: string) => ({
		name: "region",
		kind: "advanced",
		type: "text",
		label: "Region",
		predicate,
	});
	const addRegion = (predicate: string) =>
		h.call("addSearchInputs", {
			moduleUuid: "Clients",
			searchInputs: [region(predicate)],
		});
	return { h, region, addRegion };
}

/** The condition a Search field reads its own answer under, as the guide
 *  teaches it. */
const WHEN_ANSWERED = (clause: string) =>
	`when-provided(#search/region, ${clause})`;

describe("a list of values in a Search field's condition", () => {
	it("stores the guide's list(...) as equality with the values its arguments name", async () => {
		const { h, addRegion } = await fixture();
		const example = WHEN_ANSWERED(
			"#case/region = list('north', #search/region)",
		);
		expect(AUTHORING_REFERENCE.expressions()).toContain(example);
		expect(await outcomeOf(addRegion(example))).toEqual({ saved: true });
		const input = searchInputNamed(h.currentDoc(), "region");
		if (input.kind !== "advanced") throw new Error("Expected advanced.");
		const answer = { kind: "input", searchInputUuid: input.uuid };
		expect(input.predicate).toEqual({
			kind: "when-input-present",
			input: answer,
			clause: {
				kind: "eq",
				left: {
					kind: "term",
					term: { kind: "prop", caseType: "client", property: "region" },
				},
				right: {
					kind: "value-list",
					items: [
						{ kind: "term", term: { kind: "literal", value: "north" } },
						{ kind: "term", term: answer },
					],
				},
			},
		});
	});

	it("reads a stored list back as list(...) and takes the read again with one value changed", async () => {
		const { h, region, addRegion } = await fixture();
		await addRegion(
			WHEN_ANSWERED("#case/region != list('north', #search/region)"),
		);
		const read = z
			.object({
				case_list_config: z.object({
					searchInputs: z.array(
						z.object({ name: z.string(), predicate: z.string().optional() }),
					),
				}),
			})
			.parse(await h.call("getModule", { moduleUuid: "Clients" }));
		const printed = read.case_list_config.searchInputs.find(
			(input) => input.name === "region",
		)?.predicate;
		expect(printed).toContain("list('north', #search/region)");
		const stored = searchInputNamed(h.currentDoc(), "region");
		const sent = await outcomeOf(
			h.call("updateSearchInput", {
				moduleUuid: "Clients",
				searchInputUuid: stored.uuid,
				searchInput: region(
					(printed ?? "").replace("list('north',", "list('south',"),
				),
			}),
		);
		expect(sent).toEqual({ saved: true });
		const after = searchInputNamed(h.currentDoc(), "region");
		if (after.kind !== "advanced") throw new Error("Expected advanced.");
		expect(after.predicate).toMatchObject({
			kind: "when-input-present",
			clause: {
				kind: "neq",
				right: {
					kind: "value-list",
					items: [
						{ kind: "term", term: { kind: "literal", value: "south" } },
						{ kind: "term", term: { kind: "input" } },
					],
				},
			},
		});
	});

	it("refuses a list compared by an ordering, in the words of CommCare's search", async () => {
		const { addRegion } = await fixture();
		expect(await outcomeOf(addRegion("#case/age > list('1')"))).toEqual({
			refused: "gate",
			message: expect.stringContaining(
				"A list of values can be compared only as equal or not equal to a case value.",
			),
		});
	});

	it("refuses list() with no value", async () => {
		const { addRegion } = await fixture();
		expect(await outcomeOf(addRegion("#case/region = list()"))).toEqual({
			refused: "input",
			message: "list() needs 1 or more arguments; received 0.",
		});
	});
});

describe("a list of values outside a Search field's condition", () => {
	it("refuses list(...) in a case list filter with the sentence that names in()", async () => {
		const { h } = await fixture();
		expect(
			await outcomeOf(
				h.call("setCaseListFilter", {
					moduleUuid: "Clients",
					filter: "#case/region = list('north', 'south')",
				}),
			),
		).toEqual({
			refused: "gate",
			message: expect.stringContaining(
				"A list of values works only in a Search field's condition, where CommCare's search compares a case value with each value of the list. To match any of several fixed values here, you can use in(value, 'a', 'b').",
			),
		});
	});

	it("binds list(...) in form logic to nothing", async () => {
		const { h } = await fixture();
		const outcome = await outcomeOf(
			h.call("addFields", {
				formUuid: "Visit",
				fields: [
					{
						kind: "hidden",
						id: "regions",
						calculate: "list('north', 'south')",
					},
				],
			}),
		);
		expect(outcome).toMatchObject({ refused: "input" });
		const visit = Object.values(h.currentDoc().fields).find(
			(field) => field.id === "regions",
		);
		expect(visit).toBeUndefined();
	});
});
