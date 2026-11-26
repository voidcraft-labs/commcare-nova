/** Lookup admission and emitted instance identity, including dynamic selectors.
 * Native Core collision evidence owns the overwrite behavior; this finite corpus
 * does not infer complete emitter coverage by scanning switch arms. */
import { findAll } from "domutils";
import { parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import { blueprintDocSchema } from "@/lib/domain";
import { FORM_BUILDER_COLLIDING_TAGS } from "@/lib/lookup/constants";
import {
	lookupStoredTagSchema,
	lookupTagSchema,
	parseLookupRevision,
} from "@/lib/lookup/schema";
import { expandDoc } from "../expander";
import { wireTable } from "../lookup/__tests__/lookupWireCorpus";
import { lookupWireNaming } from "../lookup/naming";
import { runValidation } from "../validator/runner";
import { lookupInstance } from "../xpath/wire/instances";

// A table Nova manages can't take an id CommCare HQ's form builder holds
// (`lib/lookup/constants.ts::FORM_BUILDER_COLLIDING_TAGS`); one CommCare HQ
// manages can, and Nova's forms read it under its own alias.
const runtimeIds = [
	"CaseDB",
	"LedgerDB",
	"groups",
	"search-input",
	"commcaresession",
	"results",
	"locations",
	"selected_cases",
	"search_selected_cases",
	"selected_cases_patient",
	"parent_selected_cases",
	"parent_parent_selected_cases_a",
];
function scenario(tag = "regions", managedBy?: "commcare-hq") {
	const table = wireTable("regions", [
		{ name: "value", type: "text" },
		{ name: "label", type: "text" },
	]);
	// Existing persisted definitions can predate today's create/rename admission.
	table.tag = tag;
	if (managedBy !== undefined)
		table.hq = {
			server: "production",
			domain: "clinic",
			remoteId: "5c1e0f4a9b8d4c7e8f6a5b4c3d2e1f00",
			managedBy,
			broughtInAt: "2026-11-01T00:00:00.000Z",
			takenOverAt: null,
			takenOverBy: null,
			refreshedAt: "2026-11-01T00:00:00.000Z",
			goneColumnIds: [],
		};
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
		"emits a distinct local alias for the fixture tagged %s",
		(tag) => {
			const colliding = FORM_BUILDER_COLLIDING_TAGS.has(tag);
			expect(lookupTagSchema.safeParse(tag).success).toBe(!colliding);
			expect(lookupStoredTagSchema.parse(tag)).toBe(tag);
			const { doc, table, context } = scenario(
				tag,
				colliding ? "commcare-hq" : undefined,
			);
			expect(runValidation(doc, context)).toEqual([]);
			const [xml] = Object.values(
				expandDoc(doc, { lookupNaming: lookupWireNaming([table]) })
					._attachments,
			);
			const nodes = parseDocument(xml, { xmlMode: true }).children;
			const fixture = findAll(
				(e) =>
					e.name === "instance" &&
					e.attribs.src === `jr://fixture/item-list:${tag}`,
				nodes,
			);
			expect(fixture.map((node) => node.attribs.id)).toEqual([
				`item-list:${tag}`,
			]);
			expect(
				findAll((e) => e.name === "itemset", nodes)[0]?.attribs.nodeset,
			).toBe(`instance('item-list:${tag}')/${tag}_list/${tag}`);
		},
	);
	it.each(
		[...FORM_BUILDER_COLLIDING_TAGS.keys()].filter(
			(tag) => tag !== "hasOwnProperty",
		),
	)(
		"refuses publishing a table Nova manages tagged %s, offering a rename",
		(tag) => {
			const { doc, context } = scenario(tag);
			const findings = runValidation(doc, context);
			expect(new Set(findings.map((finding) => finding.code))).toEqual(
				new Set(["LOOKUP_TAG_RESERVED_BY_RUNTIME"]),
			);
			expect(findings[0]?.message).toContain(
				"Nova would put it into CommCare HQ on a publish.",
			);
			expect(findings[0]?.message).toContain(
				`You can rename the export tag in Project data, to ${tag.replaceAll("-", "_")}_table for example`,
			);
		},
	);
	it.each([
		["clinic_casedb_codes", "casedb"],
		["stock_ledgerdb_codes", "ledgerdb"],
		["casedb_ledgerdb", "ledgerdb"],
	] as const)(
		"refuses a referenced table whose tag %s contains %s, naming the word",
		(tag, word) => {
			const { doc, context } = scenario(tag);
			const findings = runValidation(doc, context);
			expect(new Set(findings.map((finding) => finding.code))).toEqual(
				new Set(["LOOKUP_TAG_RESERVED_BY_RUNTIME"]),
			);
			const [finding] = findings;
			expect(finding.message).toBe(
				`The lookup table regions uses the export tag ${tag}, which contains ${word}, and CommCare reads any tag containing ${word} as its own data. Rename the export tag in Project data, then try again.`,
			);
			expect(finding.details).toMatchObject({ tag, reservedWord: word });
			expect(userFacingError(finding)).toBe(
				`The export tag for "regions" contains ${word}, which CommCare reads as its own data. You can rename the export tag in Project data, then try again.`,
			);
		},
	);
	it("keeps the whole-name sentence for a reserved name, with no reserved word", () => {
		const { doc, context } = scenario("casedb");
		const [finding] = runValidation(doc, context);
		expect(finding.message).toBe(
			"The lookup table regions uses the export tag casedb, which CommCare reserves for its own data. Rename the export tag in Project data, then try again.",
		);
		expect(finding.details?.reservedWord).toBeUndefined();
		expect(userFacingError(finding)).toBe(
			'The export tag for "regions" is reserved by CommCare. You can rename the export tag in Project data, then try again.',
		);
	});
	it.each([
		"clinic_CaseDB_codes",
		"stock_LedgerDB_codes",
		"clinic_case_db_codes",
	])(
		"admits a referenced table tagged %s, which the runtime reads as its table",
		(tag) => {
			const { doc, context } = scenario(tag);
			expect(runValidation(doc, context)).toEqual([]);
		},
	);
	it("declares the used fixture without an unread selected-case instance", () => {
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
		expect(instances.some((e) => e.attribs.id === "selected_cases")).toBe(
			false,
		);
	});
	it.each([
		"results:inline",
		"search-input:results",
		"search-input:results:inline",
	])("refuses the non-tag wire id %s as a lookup tag", (id) => {
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
		expect(
			lookupInstance(table.id, lookupWireNaming([table]), "xform").src,
		).toBe(`jr://fixture/item-list:${tag}`);
	});
});
