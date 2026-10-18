// A calculated column hidden from both screens, in a list with no tile
// layout, is still a field of the short detail: every runtime evaluates it
// for every row, so what its expression reads must be declared where the
// list is opened, on the form's entry and on the search's remote request, or
// the list fails to open on a device (`XPathMissingInstanceException`). Read
// from the parsed suite of a local archive, as an export writes it.

import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f, resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import {
	wireRow,
	wireTable,
} from "@/lib/commcare/lookup/__tests__/lookupWireCorpus";
import { buildLookupFixtures } from "@/lib/commcare/lookup/fixtures";
import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
import { runValidation } from "@/lib/commcare/validator/runner";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	type Column,
	calculatedColumn,
	plainColumn,
	proseText,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	ancestorPath,
	eq,
	prop,
	relationStep,
	tableColumn,
	tableLookup,
	term,
} from "@/lib/domain/expression";
import { parseLookupRevision } from "@/lib/lookup/schema";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";
import {
	onlyXml,
	readXmlEvidence,
	type XmlEvidence,
	xmlChildren,
} from "./xmlEvidence";

const FULLY_HIDDEN = { visibleInList: false, visibleInDetail: false } as const;

/** A searching menu of clients whose list shows the name and holds `hidden`,
 *  hidden from both screens with no order rule. */
function clientsDoc(hidden: Column): BlueprintDoc {
	return buildDoc({
		appName: "Clients",
		caseTypes: [
			{
				name: "client",
				parent_type: "household",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "region", label: proseText("Region") },
				],
			},
			{
				name: "household",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
		modules: [
			{
				name: "Clients",
				caseType: "client",
				caseListConfig: resolveCaseListConfig({
					columns: [
						plainColumn(testUuid("hidden-calc-name"), "case_name", "Name"),
						hidden,
					],
					searchInputs: [
						simpleSearchInputDef(
							testUuid("hidden-calc-search"),
							"case_name",
							"Name",
							"text",
							"case_name",
						),
					],
				}),
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({ kind: "text", id: "notes", label: proseText("Notes") }),
						],
					},
				],
			},
		],
	});
}

function declared(consumer: XmlEvidence): Record<string, string> {
	return Object.fromEntries(
		xmlChildren(consumer, "instance").map((instance) => [
			instance.attributes.id,
			instance.attributes.src,
		]),
	);
}

describe("a calculated column hidden from both screens", () => {
	it("declares the lookup table it reads on the entry and on the remote request", () => {
		const table = wireTable("regions", [
			{ name: "value", type: "text" },
			{ name: "label", type: "text" },
		]);
		const [value, label] = table.columns;
		const doc = clientsDoc(
			calculatedColumn(
				testUuid("hidden-calc-region"),
				"Region",
				tableLookup(
					table.id,
					label.id,
					eq(tableColumn(table.id, value.id), prop("client", "region")),
				),
				FULLY_HIDDEN,
			),
		);
		expect(
			runValidation(doc, {
				kind: "available",
				projectId: "project-hidden-calc",
				projectRevision: parseLookupRevision("1"),
				definitions: [table],
			}),
		).toEqual([]);
		const naming = lookupWireNaming([table]);
		const fixtures = buildLookupFixtures(
			naming,
			new Map([
				[
					table.id,
					[wireRow(table, "north", { value: "north", label: "Northland" })],
				],
			]),
		);
		const hq = expandDoc(doc, { lookupNaming: naming });
		const suite = readXmlEvidence(
			new AdmZip(
				compileCcz(hq, doc.appName, doc, {
					runtimeTarget: TEST_RUNTIME_TARGET,
					lookup: { naming, fixtures },
				}),
			).readAsText("suite.xml"),
		);
		const entry = xmlChildren(suite, "entry").find(
			(candidate) =>
				onlyXml(xmlChildren(candidate, "command")).attributes.id === "m0-f0",
		);
		if (entry === undefined) throw new Error("Missing the Visit entry");
		const remote = onlyXml(xmlChildren(suite, "remote-request"));
		for (const consumer of [entry, remote])
			expect(declared(consumer)["item-list:regions"]).toBe(
				"jr://fixture/item-list:regions",
			);
	});

	it("brings the parent case it reads into the search results", () => {
		const doc = clientsDoc(
			calculatedColumn(
				testUuid("hidden-calc-household"),
				"Household",
				term(
					prop(
						"client",
						"case_name",
						ancestorPath(relationStep("parent", "household")),
					),
				),
				FULLY_HIDDEN,
			),
		);
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const hq = expandDoc(doc);
		expect(hq.modules[0].search_config.include_all_related_cases).toBe(true);
		const suite = readXmlEvidence(
			new AdmZip(
				compileCcz(hq, doc.appName, doc, {
					runtimeTarget: TEST_RUNTIME_TARGET,
				}),
			).readAsText("suite.xml"),
		);
		const remote = onlyXml(xmlChildren(suite, "remote-request"));
		expect(declared(remote)).toMatchObject({
			casedb: "jr://instance/casedb",
			results: "jr://instance/remote/results",
		});
		const query = onlyXml(
			xmlChildren(onlyXml(xmlChildren(remote, "session")), "query"),
		);
		expect(
			xmlChildren(query, "data")
				.filter(
					(data) =>
						data.attributes.key === "x_commcare_include_all_related_cases",
				)
				.map((data) => data.attributes.ref),
		).toEqual(["'true'"]);
	});
});
