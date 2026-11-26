/**
 * A menu's navigation parent and its parent selection can name different searches.
 * Read the actual queries the child's form entry loads, retain an inactive name
 * for HQ's comparison, and bind same-named prompts to distinct menu identities.
 */
import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { namedParentSearchDoc } from "@/lib/commcare/__tests__/searchEmissionFixture";
import type { BlueprintDoc } from "@/lib/domain";
import { walkInputRefs } from "@/lib/domain/expression/walk";
import { simpleSearchInputDef } from "@/lib/domain/modules";
import { proseText } from "@/lib/domain/prose";
import type { Uuid } from "@/lib/domain/uuid";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { readHqApp } from "../../index";

type JsonObject = Record<string, unknown>;

const VILLAGE = "00000000-0000-4000-8000-0000000c1a01" as Uuid;
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
	it("keeps the child's results name without turning on its search", async () => {
		const body = childBody(twoMenus("client", "client"), {
			selects: false,
			reads: false,
		});
		const result = readHqApp(await inputFor(body));
		expect(result.kind).toBe("read");
		if (result.kind !== "read") return;
		const child = Object.values(result.draft.doc.modules).find(
			(mod) => mod.name === "Checks",
		);
		expect(child?.searchResultsName).toBe("checks");
		expect(child?.caseSearchConfig).toBeUndefined();
	});

	it("round-trips two named searches with the same prompt name and keeps its suppliers when a menu changes its name", async () => {
		const first = readHqApp(
			await inputFor(exportedBody(namedParentSearchDoc())),
		);
		if (first.kind !== "read") throw new Error(JSON.stringify(first.findings));
		const doc = first.draft.doc;
		const child = Object.values(doc.modules).find(
			(menu) => menu.searchResultsName === "MemberLookup",
		);
		const parent = Object.values(doc.modules).find(
			(menu) => menu.searchResultsName === "FamilyLookup",
		);
		if (!child || !parent)
			throw new Error("The app needs the child and its family search.");
		const field = doc.fields[doc.fieldOrder[doc.formOrder[child.uuid][0]][0]];
		if (field.kind !== "text" || field.default_value === undefined)
			throw new Error("The form needs its starting answer.");
		const prompts = [] as { searchInputUuid: string; supplier?: string }[];
		walkInputRefs(field.default_value, (input) => prompts.push(input));
		expect(
			prompts.map(({ searchInputUuid, supplier }) => [
				searchInputUuid,
				supplier,
			]),
		).toEqual([
			[parent.caseListConfig?.searchInputs[0].uuid, parent.uuid],
			[child.caseListConfig?.searchInputs[0].uuid, undefined],
		]);
		const changed = {
			...doc,
			modules: {
				...doc.modules,
				[parent.uuid]: {
					...parent,
					name: "Family directory",
					searchResultsName: "FamilyArchive",
				},
			},
		};
		const emitted = exportedBody(changed);
		const forms = Object.values(
			emitted._attachments as Record<string, string>,
		).join("\n");
		expect(forms).toContain("search-input:results:FamilyArchive");
		expect(forms).toContain("search-input:results:MemberLookup");
		expect(forms).not.toContain("search-input:results:FamilyLookup");
		const again = readHqApp(await inputFor(emitted));
		expect(again.kind === "account" ? again.findings : []).toEqual([]);
		expect(again.kind).toBe("read");
	});

	it("names the unloaded answer when only the navigation parent searches", async () => {
		expect(
			await findings(
				childBody(twoMenus("client", "client"), {
					selects: false,
					reads: true,
				}),
			),
		).toEqual([[UNLOADED_READ, "question", 1]]);
	});

	it("binds the parent's prompt when the child's entry selects its parent from that list", async () => {
		const outcome = readHqApp(
			await inputFor(
				childBody(twoMenus("household", "member"), {
					selects: true,
					reads: true,
				}),
			),
		);
		expect(outcome.defects).toEqual([]);
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
		if (outcome.kind !== "read")
			throw new Error("Expected to bring the app in");
		const doc = outcome.draft.doc;
		const parent = Object.values(doc.modules).find(
			(menu) => menu.name === "Visits",
		);
		const child = Object.values(doc.modules).find(
			(menu) => menu.name === "Checks",
		);
		const field = Object.values(doc.fields).find(
			(question) => question.id === "check",
		);
		if (!parent || !child || field?.kind !== "text")
			throw new Error(
				"The brought-in app needs both menus and the child question.",
			);
		expect(JSON.stringify(field.relevant)).toContain(
			JSON.stringify(parent.uuid),
		);
		expect(JSON.stringify(field.relevant)).toContain(
			JSON.stringify(parent.caseListConfig?.searchInputs[0].uuid),
		);
		expect(child.searchResultsName).toBe("checks");
	});
});
