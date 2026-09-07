/** Lookup admission and emitted instance identity, including dynamic selectors.
 * Native Core collision evidence owns the overwrite behavior; this finite corpus
 * does not infer complete emitter coverage by scanning switch arms. */
import { findAll } from "domutils";
import { parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { blueprintDocSchema } from "@/lib/domain";
import { lookupTagSchema, parseLookupRevision } from "@/lib/lookup/schema";
import { expandDoc } from "../expander";
import { wireTable } from "../lookup/__tests__/lookupWireCorpus";
import { lookupWireNaming } from "../lookup/naming";
import { instanceSourceFor } from "../predicate/instances";
import { runValidation } from "../validator/runner";

const runtimeIds = [
	"casedb",
	"commcaresession",
	"results",
	"locations",
	"selected_cases",
	"search_selected_cases",
	"selected_cases_patient",
	"parent_selected_cases",
	"parent_parent_selected_cases_visit",
];
function scenario(tag = "regions") {
	const table = wireTable("regions", [
		{ name: "value", type: "text" },
		{ name: "label", type: "text" },
	]);
	// Existing persisted definitions can predate today's create/rename admission.
	table.tag = tag;
	const doc = buildDoc({
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					...caseListConfig([{ field: "case_name", header: "Name" }]),
					selection: { kind: "multiple", maximum: 3 },
				},
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "single_select",
								id: "region",
								optionsSource: {
									kind: "lookup",
									tableId: table.id,
									valueColumnId: table.columns[0].id,
									labelColumnId: table.columns[1].id,
								},
							}),
						],
					},
				],
			},
		],
	});
	blueprintDocSchema.parse(toPersistableDoc(doc));
	const context = {
		kind: "available" as const,
		projectId: "p",
		projectRevision: parseLookupRevision("1"),
		definitions: [table],
	};
	return { doc, context, table };
}
describe("lookup and runtime instance names", () => {
	it.each(runtimeIds)(
		"reserves dispatched runtime name %s at authoring and existing-reference gates",
		(id) => {
			expect(instanceSourceFor(id)).toMatch(/^jr:\/\//);
			for (const tag of [id, id.toUpperCase()]) {
				expect(lookupTagSchema.safeParse(tag).success).toBe(false);
				const { doc, context } = scenario(tag);
				const findings = runValidation(doc, context);
				expect(findings.length).toBeGreaterThan(0);
				expect(new Set(findings.map((f) => f.code))).toEqual(
					new Set(["LOOKUP_TAG_RESERVED_BY_RUNTIME"]),
				);
				expect(
					findings.every(
						(f) => f.details?.tag === tag && f.location.fieldUuid !== undefined,
					),
				).toBe(true);
			}
		},
	);
	it("keeps valid fixture and selected-case declarations separate in an admitted form", () => {
		const { doc, context, table } = scenario();
		expect(runValidation(doc, context)).toEqual([]);
		const xml = Object.values(
			expandDoc(doc, { lookupNaming: lookupWireNaming([table]) })._attachments,
		)[0];
		const instances = findAll(
			(e) => e.name === "instance" && e.attribs.id !== undefined,
			parseDocument(xml, { xmlMode: true }).children,
		);
		const ids = instances.map((e) => e.attribs.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(instances.find((e) => e.attribs.id === "regions")?.attribs.src).toBe(
			"jr://fixture/item-list:regions",
		);
		expect(
			instances.find((e) => e.attribs.id === "selected_cases")?.attribs.src,
		).toBe("jr://instance/selected-entities/selected_cases");
	});
	it.each([
		"results:inline",
		"search-input:results",
		"search-input:results:inline",
	])("resolves non-tag wire id %s while tag syntax refuses it", (id) => {
		expect(instanceSourceFor(id)).toMatch(/^jr:\/\//);
		expect(lookupTagSchema.safeParse(id).success).toBe(false);
	});
	it.each([
		"regions",
		"case_types",
		"districts",
		"results_2",
		"selected_casesish",
	])("admits ordinary tag %s and resolves its actual fixture", (tag) => {
		const table = wireTable(tag, [{ name: "value", type: "text" }]);
		expect(instanceSourceFor(tag, lookupWireNaming([table]))).toBe(
			`jr://fixture/item-list:${tag}`,
		);
	});
});
