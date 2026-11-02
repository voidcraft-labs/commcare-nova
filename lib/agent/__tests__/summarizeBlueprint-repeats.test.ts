import { expect, it } from "vitest";
import type { BlueprintDoc } from "@/lib/domain";
import { summarizeBlueprint } from "../summarizeBlueprint";
import { makeAuthoringHarness } from "./authoringHarness";
import { namedFormFixture } from "./namedFormFixture";

// How a query repeat's rows come is a fact the model reads twice: in the app
// snapshot as a marker on the repeat's line, and in getField as `rows`. Both
// come from the placement every export runs (`effectiveQueryRepeatPlacement`),
// so each is asserted here from a document the shared tools built.

const OPEN_VISITS =
	"instance('casedb')/casedb/case[@case_type = 'visit'][@status = 'open']/@case_id";
const VISITS_IN_REGION =
	"instance('casedb')/casedb/case[@case_type = 'visit'][region = #form/region]/@case_id";

async function queryRepeats() {
	const h = makeAuthoringHarness(
		{},
		namedFormFixture([
			{
				name: "Visits",
				caseType: "visit",
				forms: [{ name: "Review", type: "survey" }],
			},
		]),
	);
	await h.call("generateSchema", {
		caseTypes: [
			{
				name: "visit",
				properties: [{ name: "region", label: "Region", data_type: "text" }],
			},
		],
	});
	expect(
		await h.call("addFields", {
			formUuid: "Review",
			fields: [
				{ kind: "text", id: "region", label: "Region" },
				{
					kind: "repeat",
					id: "open_visits",
					label: "Open visits",
					repeat: { mode: "query_bound", ids_query: OPEN_VISITS },
				},
				{
					kind: "repeat",
					id: "region_visits",
					label: "Visits in the region",
					repeat: { mode: "query_bound", ids_query: VISITS_IN_REGION },
				},
			],
		}),
	).toMatchObject({ ok: true });
	await h.call("removeField", {
		formUuid: "Review",
		fieldUuid: "fixture_placeholder",
	});
	const doc = h.currentDoc();
	const uuidOf = (id: string) => {
		const field = Object.values(doc.fields).find(
			(candidate) => candidate.id === id,
		);
		if (!field) throw new Error(`The fixture has no field "${id}".`);
		return field.uuid;
	};
	return {
		h,
		doc,
		openVisits: uuidOf("open_visits"),
		regionVisits: uuidOf("region_visits"),
	};
}

function repeatLine(doc: BlueprintDoc, id: string): string | undefined {
	return summarizeBlueprint(doc)
		.split("\n")
		.find((line) => line.trimStart().startsWith(`- ${id} [uuid`));
}

it("marks a query repeat whose query reads no answer as set when opened, and one reading an answer as following its query", async () => {
	const { doc } = await queryRepeats();
	expect(repeatLine(doc, "open_visits")).toMatch(
		/\(repeat\): "Open visits" \[rows set when opened\]$/,
	);
	expect(repeatLine(doc, "region_visits")).toMatch(
		/\(repeat\): "Visits in the region" \[rows follow query\]$/,
	);
	// No other field carries a rows marker.
	expect(repeatLine(doc, "region")).not.toMatch(/\[rows/);
});

it("reads the same two facts through getField", async () => {
	const { h, openVisits, regionVisits } = await queryRepeats();
	expect(await h.call("getField", { fieldUuid: openVisits })).toMatchObject({
		field: {
			repeat: { mode: "query_bound", ids_query: OPEN_VISITS },
			rows: "set-when-opened",
		},
	});
	expect(await h.call("getField", { fieldUuid: regionVisits })).toMatchObject({
		field: { rows: "follow-query" },
	});
});

it("reads a held placement as its rows and never as the stored placement", async () => {
	const { doc, openVisits } = await queryRepeats();
	// A publish or a migration holds the count placement on a repeat the rule
	// would place by model iteration; the held one wins.
	const held = structuredClone(doc);
	const field = held.fields[openVisits];
	if (field?.kind !== "repeat" || field.repeat_mode !== "query_bound")
		throw new Error("The fixture's query repeat is missing.");
	held.fields[openVisits] = { ...field, placement: "count" };
	expect(repeatLine(held, "open_visits")).toMatch(/\[rows follow query\]$/);
	const read = await makeAuthoringHarness({}, held).call("getField", {
		fieldUuid: openVisits,
	});
	expect(read).toMatchObject({ field: { rows: "follow-query" } });
	expect(read).not.toMatchObject({ field: { placement: expect.anything() } });
});
