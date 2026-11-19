/**
 * Contract: a menu under a menu whose forms read the search, as CommCare HQ builds one, is read into
 * an account that names each cause once, never into a document the gate refuses.
 *
 * HQ's build compares the child's results instance with its root menu's, and with the menu its parent
 * selection names, whether or not the child searches (`helpers/validators.py`, `validate_search_config`
 * and `validate_parent_select`), so HQ builds the child only under a results instance name of its own,
 * which Nova does not hold yet: its export gives both menus `results:inline`. That name is one finding
 * at the child's search. A read of the parent's Search fields in the child's form is its own cause:
 * where the child chooses its case from the parent's list first, HQ's build writes the parent's query
 * into the child's entry (`suite_xml/sections/entries.py::EntriesHelper.add_remote_query_datums`), the
 * class Nova does not hold yet; where the child takes its own case from its own list
 * (`EntriesHelper.add_parent_datums` keeps the child's selection), no step of the entry loads the
 * answers, and the read is the refusal of a read no search of the form's entry loads.
 *
 * The failure it catches: the child's results instance claimed as an inactive search's key, so the
 * reading proposes a submenu the gate refuses and the bring-in answers `read-back-differs`; and a read of
 * the parent's answers named by the wrong class.
 */
import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc } from "@/lib/domain";
import { simpleSearchInputDef } from "@/lib/domain/modules";
import { proseText } from "@/lib/domain/prose";
import type { Uuid } from "@/lib/domain/uuid";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { readHqApp } from "../../index";

type JsonObject = Record<string, unknown>;

const VILLAGE = "00000000-0000-4000-8000-0000000c1a01" as Uuid;
const INSTANCE_NAME =
	"case-search/instance-name-without-casedb-ledgerdb-fixture-or-session-in-it";
const CHILD_READ =
	"expressions-and-data/search-input-read-in-the-forms-of-a-child-menu-of-an-inline-search-menu";
const UNLOADED_READ =
	"expressions-and-data/search-input-read-in-form-expressions-reached-through-a-search";

/** A menu over `caseType` whose forms read its search over `village`, then a menu over
 *  `childType` with one follow-up form holding the text question `check`. */
function twoMenus(caseType: string, childType: string): BlueprintDoc {
	const searched = caseListConfig([{ field: "case_name", header: "Name" }]);
	searched.searchInputs = [
		simpleSearchInputDef(VILLAGE, "village", "Village", "text", "village"),
	];
	return buildDoc({
		appName: "Visits",
		caseTypes: [
			{
				name: caseType,
				properties: [
					{ name: "village", label: proseText("Village"), data_type: "text" },
				],
			},
			...(childType === caseType
				? []
				: [{ name: childType, parent_type: caseType, properties: [] }]),
		],
		modules: [
			{
				name: "Visits",
				caseType,
				caseListConfig: searched,
				caseSearchConfig: { formsReadSearch: true },
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: "Note" })],
					},
				],
			},
			{
				name: "Checks",
				caseType: childType,
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Check",
						type: "followup",
						fields: [f({ kind: "text", id: "check", label: "Check" })],
					},
				],
			},
		],
	});
}

const READ =
	"instance('search-input:results:inline')/input/field[@name = 'village'] = 'north'";

/** `check` shown where the parent's village answer is `north`, the answers declared. */
function readsParentSearch(xml: string): string {
	if (!xml.includes('nodeset="/data/check"')) return xml;
	return xml
		.replace(
			'nodeset="/data/check"',
			`nodeset="/data/check" relevant="${READ}"`,
		)
		.replace(
			"</instance>",
			'</instance><instance id="search-input:results:inline" src="jr://instance/search-input/results:inline"/>',
		);
}

/** The export of `doc` with Checks made Visits' child menu under a results instance of its own,
 *  choosing its parent case from Visits' list where `selects`. */
function childBody(
	doc: BlueprintDoc,
	options: { readonly selects: boolean; readonly reads: boolean },
): JsonObject {
	return exportedBody(doc, {
		...(options.reads && { xml: readsParentSearch }),
		modules: (modules) => {
			const [visits, checks] = modules;
			if (visits === undefined || checks === undefined)
				throw new Error("The app holds two menus.");
			checks.root_module_id = visits.unique_id;
			(checks.search_config as JsonObject).instance_name = "checks";
			if (options.selects)
				checks.parent_select = {
					active: true,
					relationship: "parent",
					module_id: visits.unique_id,
					doc_type: "ParentSelect",
				};
			return modules;
		},
	});
}

async function findings(body: JsonObject) {
	const outcome = readHqApp(await inputFor(body));
	expect(outcome.defects).toEqual([]);
	if (outcome.kind !== "account")
		throw new Error("The child menu read to a document, with no finding.");
	return outcome.findings.map(
		(finding) =>
			[
				finding.code,
				finding.place.kind,
				"menu" in finding.place ? finding.place.menu : undefined,
			] as const,
	);
}

describe("a menu under a menu whose forms read the search", () => {
	it("is its results instance name's one finding, at its search", async () => {
		const found = await findings(
			childBody(twoMenus("client", "client"), { selects: false, reads: false }),
		);
		expect(found).toEqual([[INSTANCE_NAME, "search", 1]]);
	});

	it("whose form reads the parent's answers, taking its own case, is that read's refusal beside its name", async () => {
		const found = await findings(
			childBody(twoMenus("client", "client"), { selects: false, reads: true }),
		);
		expect(new Set(found)).toEqual(
			new Set([
				[INSTANCE_NAME, "search", 1],
				[UNLOADED_READ, "question", 1],
			]),
		);
		expect(found).toHaveLength(2);
	});

	it("whose form reads the parent's answers, choosing its parent from the parent's list, is the child menu's class beside its name", async () => {
		const found = await findings(
			childBody(twoMenus("household", "member"), {
				selects: true,
				reads: true,
			}),
		);
		expect(new Set(found)).toEqual(
			new Set([
				[INSTANCE_NAME, "search", 1],
				[CHILD_READ, "question", 1],
			]),
		);
		expect(found).toHaveLength(2);
	});
});
