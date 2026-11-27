/** One exact inline-own-row projection and the remaining scoped result-query holds. */
import AdmZip from "adm-zip";
import { isTag } from "domhandler";
import { findAll } from "domutils";
import { parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { calculatedColumnTypeCheck } from "@/lib/commcare/validator/rules/case-list/calculatedColumnTypeCheck";
import { assertAdmittedDoc } from "@/lib/doc/__tests__/admittedDoc";
import type { BlueprintDoc, Module } from "@/lib/domain";
import { simpleSearchInputDef } from "@/lib/domain/modules";
import { proseText } from "@/lib/domain/prose";
import type { Uuid } from "@/lib/domain/uuid";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { readHqApp } from "../../index";

type JsonObject = Record<string, unknown>;

const VILLAGE = "00000000-0000-4000-8000-0000000c2a01" as Uuid;
const INLINE_OWN_PROPERTY =
	"instance('results:inline')/results/case[not(commcare_is_related_case = true())][@case_id = current()/@case_id]/village";
const COLUMN =
	"menus-and-case-lists/usexpathexpression-field-xpath-outside-valueexpression";
const SEARCH_DETAIL =
	"expressions-and-data/results-results-inline-results-name-in-search-details";

/** A menu of clients that searches by village, its forms reading the search where `inline`. */
function app(inline: boolean): BlueprintDoc {
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	config.searchInputs = [
		simpleSearchInputDef(VILLAGE, "village", "Village", "text", "village"),
	];
	return buildDoc({
		appName: "Clients",
		caseTypes: [
			{
				name: "client",
				properties: [
					{ name: "village", label: proseText("Village"), data_type: "text" },
				],
			},
		],
		modules: [
			{
				name: "Clients",
				caseType: "client",
				caseListConfig: config,
				caseSearchConfig: inline ? { formsReadSearch: true } : {},
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: "Note" })],
					},
				],
			},
		],
	});
}

/** The export of `doc` with its list's first column calculated as `field`. */
function withColumn(
	doc: BlueprintDoc,
	field: string,
	screen: "short" | "long" = "short",
): JsonObject {
	return exportedBody(doc, {
		modules: (modules) => {
			const menu = modules[0] as JsonObject & {
				case_details: Record<"short" | "long", { columns: JsonObject[] }>;
			};
			const column = menu.case_details[screen].columns[0] as JsonObject;
			menu.case_details[screen].columns[0] = {
				...column,
				field,
				useXpathExpression: true,
				header: { en: "Found in" },
			};
			return modules;
		},
	});
}

async function read(body: JsonObject) {
	const outcome = readHqApp(await inputFor(body));
	expect(outcome.defects).toEqual([]);
	if (outcome.kind !== "account")
		throw new Error("The column read to a document, with no finding.");
	return outcome;
}

describe("a list column that reads a search's results", () => {
	it("keeps an inline primary result row matched by its own ID as a typed text property", async () => {
		const outcome = readHqApp(
			await inputFor(withColumn(app(true), INLINE_OWN_PROPERTY)),
		);
		expect(outcome.defects).toEqual([]);
		if (outcome.kind !== "read")
			throw new Error(JSON.stringify(outcome.findings));
		const doc: BlueprintDoc = {
			...outcome.draft.doc,
			appSettings: { ...outcome.draft.doc.appSettings, runsOnlyOn: "web-apps" },
		};
		assertAdmittedDoc(doc);
		const menu = doc.modules[doc.moduleOrder[0]];
		expect(menu.caseListConfig?.columns[0]).toMatchObject({
			kind: "calculated",
			inlineResultProperty: true,
			expression: {
				kind: "term",
				term: { kind: "prop", caseType: "client", property: "village" },
			},
		});
		const wire = exportedBody(doc);
		const menuWire = (
			wire.modules as Array<{
				case_details: { short: { columns: Array<{ field: string }> } };
			}>
		)[0];
		expect(menuWire.case_details.short.columns[0].field).toBe(
			INLINE_OWN_PROPERTY,
		);

		const options = {
			runtimeTarget: {
				server: "production",
				domain: "inline-result-test",
				appId: "inline-result-test",
			},
		} as const;
		const archive = new AdmZip(
			compileCcz(expandDoc(doc, options), doc.appName, doc, options),
		);
		const suite = parseDocument(archive.readAsText("suite.xml"), {
			xmlMode: true,
		});
		const detail = findAll(
			(node) => node.name === "detail" && node.attribs.id === "m0_case_short",
			suite.children,
		);
		expect(detail).toHaveLength(1);
		expect(
			findAll((node) => node.name === "xpath", detail[0].children).map(
				(variable) => variable.attribs.function,
			),
		).toContain(INLINE_OWN_PROPERTY);
		const selector = findAll(
			(node) =>
				node.name === "datum" &&
				node.attribs["detail-select"] === "m0_case_short",
			suite.children,
		);
		expect(selector).toHaveLength(1);
		let previous = selector[0].prev;
		while (previous !== null && !isTag(previous)) previous = previous.prev;
		expect(previous).toMatchObject({
			name: "query",
			attribs: { "storage-instance": "results:inline" },
		});

		const config = menu.caseListConfig;
		if (!config) throw new Error("The case list did not read.");
		const cases: Array<Partial<Module>> = [
			{ caseSearchConfig: {} },
			{ searchResultsName: "another" },
			{
				caseListConfig: {
					...config,
					columns: config.columns.map((column) =>
						column.kind === "calculated"
							? { ...column, visibleInDetail: true }
							: column,
					),
				},
			},
		];
		for (const change of cases) {
			const changed = { ...menu, ...change };
			const candidate = {
				...doc,
				modules: { ...doc.modules, [menu.uuid]: changed },
			};
			expect(
				calculatedColumnTypeCheck(changed, menu.uuid, candidate),
			).toContainEqual(
				expect.objectContaining({
					code: "CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR",
				}),
			);
		}
	});

	it("refuses a broader listed-case query under the column's entry", async () => {
		const outcome = await read(
			withColumn(
				app(true),
				"instance('results:inline')/results/case[not(commcare_is_related_case = true())][@case_id = current()/@case_id][@status = 'open']/village",
			),
		);
		expect(
			outcome.findings.map((finding) => [finding.code, finding.detail?.reason]),
		).toEqual([[COLUMN, "listed-case-in-query"]]);
		expect(outcome.claims.counts[SEARCH_DETAIL]).toBeGreaterThan(0);
	});

	it("reports a wrapped standalone Search answer under its instance's finding alone", async () => {
		const outcome = await read(
			withColumn(
				app(false),
				"string(instance('search-input:results')/input/field[@name = 'village'])",
			),
		);
		expect(
			outcome.findings.map(({ code, place }) => ({ code, place })),
		).toEqual([
			{
				code: "expressions-and-data/search-input-results-read-in-the-search-results-detail",
				place: { kind: "case-list", menu: 0, name: "Clients" },
			},
		]);
	});

	it("keeps the calculated-column refusal when the same call wraps ordinary text", async () => {
		const outcome = await read(withColumn(app(false), "string(village)"));
		expect(
			outcome.findings.map(({ code, detail }) => [code, detail?.reason]),
		).toEqual([[COLUMN, "call:string"]]);
	});

	it("keeps a Long expression held because an ordinary Details route can open without Search", async () => {
		const outcome = await read(
			withColumn(app(true), INLINE_OWN_PROPERTY, "long"),
		);
		expect(
			outcome.findings.map((finding) => [finding.code, finding.detail?.reason]),
		).toEqual([[COLUMN, "listed-case-in-query"]]);
	});

	it("refuses a read of a search that is not inline under the column's entry, never a form's", async () => {
		const outcome = await read(
			withColumn(
				app(false),
				"instance('results')/results/case[@case_id = current()/@case_id]/village",
			),
		);
		expect(
			outcome.findings.map((finding) => [finding.code, finding.detail?.reason]),
		).toEqual([[COLUMN, "parse:search-results-remote"]]);
		expect(outcome.claims.counts[SEARCH_DETAIL]).toBeGreaterThan(0);
	});
});
