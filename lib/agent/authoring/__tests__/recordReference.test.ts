/**
 * The Solutions Architect reads a form's record types as reference text and
 * sends that same text back. A form whose selected record is a `visit` and
 * whose ancestors are named `case`, `form`, `user` and `row` (each a word
 * reference text fixes) reads each ancestor as `#record/<type>/…`, and every
 * spelling a read hands out binds back to the record it named: never the
 * selected record, never an answer, never a table column.
 */
import { expect, it } from "vitest";
import { z } from "zod";
import { makeAuthoringHarness } from "@/lib/agent/__tests__/authoringHarness";
import { echoLookupDefinitions } from "@/lib/agent/__tests__/fixtures";
import { namedFormFixture } from "@/lib/agent/__tests__/namedFormFixture";
import { wireTable } from "@/lib/commcare/lookup/__tests__/lookupWireCorpus";
import type { Field } from "@/lib/domain";
import { parseLookupRevision } from "@/lib/lookup/schema";

const ANCESTORS = ["case", "form", "user", "row"] as const;

/** Every form-case term a stored tree holds, in document order. */
function formCaseTerms(value: unknown): unknown[] {
	if (Array.isArray(value)) return value.flatMap(formCaseTerms);
	if (value === null || typeof value !== "object") return [];
	if ((value as { kind?: unknown }).kind === "form-case") return [value];
	return Object.values(value).flatMap(formCaseTerms);
}

const facilities = wireTable("facilities", [
	{ name: "facility-name", type: "text" },
	{ name: "region", type: "text" },
]);

async function visitForm() {
	const h = makeAuthoringHarness(
		{
			lookupCatalog: async () => ({
				projectId: "project-test",
				projectRevision: parseLookupRevision("1"),
				definitions: [facilities],
			}),
			lookupDefinitions: echoLookupDefinitions([facilities]),
		},
		namedFormFixture([
			{
				name: "Visits",
				caseType: "visit",
				forms: [{ name: "Record visit", type: "followup" }],
			},
		]),
	);
	const call = async (name: string, input: unknown) => {
		const result = await h.call(name, input);
		expect(result).not.toHaveProperty("error");
		return result;
	};
	const region = [{ name: "region", label: "Region" }];
	await call("generateSchema", {
		caseTypes: [
			{ name: "visit", parent_type: "case", properties: region },
			{ name: "case", parent_type: "form", properties: region },
			{ name: "form", parent_type: "user", properties: region },
			{ name: "user", parent_type: "row", properties: region },
			{ name: "row", properties: region },
		],
	});
	const fieldNamed = (id: string): Field => {
		const field = Object.values(h.currentDoc().fields).find(
			(each) => each.id === id,
		);
		if (field === undefined) throw new Error(`no field ${id}`);
		return field;
	};
	return { h, call, fieldNamed };
}

it("hands out an ancestor reference that, sent back, reads that ancestor", async () => {
	const { call, fieldNamed } = await visitForm();
	const read = z
		.object({
			recordContext: z.object({
				selectedCaseType: z.string().nullable(),
				readableRecords: z.array(
					z.object({
						caseType: z.string(),
						propertyReference: z.string(),
						identityReference: z.string(),
					}),
				),
			}),
		})
		.parse(await call("getForm", { formUuid: "Record visit" }));
	expect(read.recordContext.selectedCaseType).toBe("visit");
	const references = new Map(
		read.recordContext.readableRecords.map((row) => [
			row.caseType,
			row.propertyReference,
		]),
	);
	expect(references.get("visit")).toBe("#visit/property");
	for (const ancestor of ANCESTORS) {
		expect(references.get(ancestor)).toBe(`#record/${ancestor}/property`);
		await call("addFields", {
			formUuid: "Record visit",
			fields: [
				{
					kind: "hidden",
					id: `from_${ancestor}`,
					calculate: references.get(ancestor)?.replace("/property", "/region"),
				},
			],
		});
		expect(fieldNamed(`from_${ancestor}`)).toMatchObject({
			calculate: {
				kind: "term",
				term: { kind: "form-case", caseType: ancestor, property: "region" },
			},
		});
	}
});

it("reads a label's record named form as #record/form and stores the same part when sent back", async () => {
	const { h, call, fieldNamed } = await visitForm();
	await call("addFields", {
		formUuid: "Record visit",
		fields: [
			{
				kind: "text",
				id: "notes",
				label: "Region {{#record/form/region}}",
			},
		],
	});
	const stored = fieldNamed("notes");
	expect(stored).toMatchObject({
		label: {
			parts: [
				{ kind: "text", text: "Region " },
				{ kind: "case-ref", caseType: "form", property: "region" },
			],
		},
	});
	const read = z
		.object({ field: z.object({ label: z.string() }) })
		.parse(await call("getField", { fieldUuid: "notes" }));
	expect(read.field.label).toBe("Region {{#record/form/region}}");
	const before = structuredClone(h.currentDoc());
	await call("editField", {
		formUuid: "Record visit",
		fieldUuid: "notes",
		updates: { label: read.field.label },
	});
	expect(h.currentDoc()).toEqual(before);
});

it("round-trips a record named for a fixed word and a hyphenated table column through the record dialect", async () => {
	const { h, call, fieldNamed } = await visitForm();
	await call("addFields", {
		formUuid: "Record visit",
		fields: [
			{
				kind: "single_select",
				id: "nearby",
				label: "Nearby visit",
				optionsSource: {
					kind: "cases",
					caseType: "visit",
					filter:
						"#row/region = #record/case/region and #row/region = lookup('facilities', 'region', #row/facility-name = #record/row/region) and #row/region = lookup('facilities', 'region', #row/facility-name = #record/visit/region)",
				},
			},
		],
	});
	const filter = (
		fieldNamed("nearby") as { optionsSource: { filter: unknown } }
	).optionsSource.filter;
	// Inside the table's scope `#record/visit/` is the form's own visit.
	expect(formCaseTerms(filter)).toEqual([
		{ kind: "form-case", caseType: "case", property: "region" },
		{ kind: "form-case", caseType: "row", property: "region" },
		{ kind: "form-case", caseType: "visit", property: "region" },
	]);
	const read = z
		.object({
			field: z.object({
				optionsSource: z.object({ filter: z.string() }).passthrough(),
			}),
		})
		.parse(await call("getField", { fieldUuid: "nearby" }));
	expect(read.field.optionsSource.filter).toContain("#record/case/region");
	expect(read.field.optionsSource.filter).toContain("#record/row/region");
	expect(read.field.optionsSource.filter).toContain("#row/facility-name");
	const before = structuredClone(h.currentDoc());
	await call("setFieldOptionsSource", {
		fieldUuid: "nearby",
		source: read.field.optionsSource,
	});
	expect(h.currentDoc()).toEqual(before);
});
