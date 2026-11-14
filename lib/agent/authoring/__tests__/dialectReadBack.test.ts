/**
 * The record dialect's round trip, as the reader of CommCare HQ's apps is
 * handed it. The contract: every record slot Nova itself writes, read back
 * from Nova's own export by the whole reader over the emitter's corpora, is
 * held and prints and reads back to itself under the slot's authoring scope,
 * so the judge refuses nothing Nova wrote, a slot that reads a lookup table
 * among them, judged under the reading's own table catalog; and a tree the
 * dialect has no spelling for is named by its kind, read from the tree. The failures this catches: a held record slot the dialect cannot
 * print or reads back differently (which would fail every agent read of the
 * brought-in app), a judge that loses the reading's catalog or a Search
 * field's table, and a judge that answers an error's text in place of a
 * kind.
 */
import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
import {
	corpusDocs,
	READ_BACK_CORPORA,
	type ReadTables,
	readEmission,
} from "@/lib/commcare/reader/expressions/__tests__/readBackCorpus";
import { eq, literal, tableColumn } from "@/lib/domain/expression/builders";
import { slotContext } from "@/lib/domain/expression/context";
import type { Expression } from "@/lib/domain/expression/types";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import { simpleSearchInputDef } from "@/lib/domain/modules";
import type { Uuid } from "@/lib/domain/uuid";
import { recordDialectRoundTrip } from "../recordRoundTrip";

const TABLE = "01890000-0000-7000-8000-000000000401" as LookupTableId;
const NAME = "01890000-0000-7000-8000-000000000402" as LookupColumnId;
const ZONE = "01890000-0000-7000-8000-000000000403" as LookupColumnId;
const REGION_INPUT = "01890000-0000-7000-8000-000000000404" as Uuid;

const REGIONS = {
	id: TABLE,
	name: "Regions",
	tag: "regions",
	columns: [
		{ id: NAME, wireName: "name", label: "Name", dataType: "text" as const },
		{ id: ZONE, wireName: "zone", label: "Zone", dataType: "text" as const },
	],
};

/** The table, named for the export and held in the project space's catalog. */
const TABLES: ReadTables = {
	naming: lookupWireNaming([REGIONS]),
	catalog: {
		table: (tag) =>
			tag === REGIONS.tag
				? {
						tableId: TABLE,
						column: (name) =>
							REGIONS.columns.find((column) => column.wireName === name)?.id,
					}
				: undefined,
		definitions: new Map([[TABLE, REGIONS]]),
	},
};

/** Documents per corpus; the five corpora take a few seconds on a laptop. */
const DOCS_PER_CORPUS = 30;

describe("the record dialect's round trip over what Nova writes", () => {
	it("holds every record slot the reader reads back from the corpora", {
		timeout: 120_000,
	}, async () => {
		let held = 0;
		for (const corpus of READ_BACK_CORPORA)
			for (const doc of corpusDocs(corpus, DOCS_PER_CORPUS)) {
				const reading = await readEmission(doc, recordDialectRoundTrip);
				const read = reading.doc;
				if (read === undefined) continue;
				for (const { registration, outcome } of reading.slots) {
					expect(
						outcome.claim?.detail.reason ?? "",
						outcome.claim?.entryId,
					).not.toMatch(/^dialect:/u);
					const tree = outcome.expression;
					if (tree === undefined) continue;
					if (
						slotContext(read, registration.ref, new Map())?.ruleSet !== "record"
					)
						continue;
					held++;
					expect(
						recordDialectRoundTrip(
							read,
							registration.ref,
							tree,
							reading.env.lookup,
						),
						registration.ref.slot,
					).toBeUndefined();
				}
			}
		expect(held).toBeGreaterThan(0);
	});

	it("holds a Search field's choices filter over its table's rows, judged under the reading's own catalog", async () => {
		const doc = buildDoc({
			caseTypes: [
				{ name: "patient", properties: [{ name: "region", label: "Region" }] },
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: {
						...caseListConfig([{ field: "case_name", header: "Name" }]),
						searchInputs: [
							simpleSearchInputDef(
								REGION_INPUT,
								"region",
								"Region",
								"select",
								"region",
								{
									options: {
										kind: "lookup",
										tableId: TABLE,
										valueColumnId: NAME,
										labelColumnId: NAME,
										filter: eq(tableColumn(TABLE, ZONE), literal("north")),
									},
								},
							),
						],
					},
					caseSearchConfig: {},
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "q", label: "Q" })],
						},
					],
				},
			],
		});
		const reading = await readEmission(doc, recordDialectRoundTrip, TABLES);
		const read = reading.doc;
		if (read === undefined) throw new Error("No stage reached the document.");
		const slot = reading.slots.find(
			(one) => one.registration.ref.slot === "search_input_options",
		);
		if (slot === undefined) throw new Error("The choices filter was not read.");
		expect(slot.outcome.claim?.detail.reason ?? "").not.toMatch(/^dialect:/u);
		const tree = slot.outcome.expression;
		if (tree === undefined) throw new Error("The choices filter is not held.");
		expect(reading.env.lookup.size).toBe(1);
		expect(
			recordDialectRoundTrip(
				read,
				slot.registration.ref,
				tree,
				reading.env.lookup,
			),
		).toBeUndefined();
	});
});

describe("a tree the dialect has no spelling for", () => {
	it("is named by the kind of its unspelled node", () => {
		const doc = buildDoc({
			caseTypes: [{ name: "patient", properties: [{ name: "p", label: "P" }] }],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "q", label: "Q" })],
						},
					],
				},
			],
		});
		const menu = doc.moduleOrder[0] as Uuid;
		const query: Expression = {
			kind: "count",
			via: {
				kind: "cases",
				source: "casedb",
				where: [
					{
						kind: "eq",
						left: {
							kind: "term",
							term: { kind: "prop", caseType: "patient", property: "p" },
						},
						right: { kind: "term", term: { kind: "literal", value: "x" } },
					},
				],
			},
		};
		expect(
			recordDialectRoundTrip(
				doc,
				{ entity: "module", uuid: menu, slot: "module_display_condition" },
				{
					kind: "gt",
					left: query,
					right: { kind: "term", term: { kind: "literal", value: 0 } },
				},
				new Map(),
			),
		).toBe("cases");
	});
});
