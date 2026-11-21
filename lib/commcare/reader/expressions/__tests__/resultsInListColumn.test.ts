/**
 * A case list column that reads a search's results, read whole.
 *
 * Contract: a results read in a menu's slot is the search-details class, held,
 * and the column's expression is one finding under the column's own entry,
 * since Nova's record rule holds no query of cases: a read of the listed case
 * inside that query (`current()/…`, which Core keeps as the listed row through
 * every predicate) has no tree, and a read of `instance('results')` in a list
 * is no form's read of a search that is not inline. The failures it catches:
 * the listed case's read bound as the queried row's own, which prints another
 * expression and leaves the column unrecognized, and a list column's read of
 * `results` refused as a form's.
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

const VILLAGE = "00000000-0000-4000-8000-0000000c2a01" as Uuid;
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
function withColumn(doc: BlueprintDoc, field: string): JsonObject {
	return exportedBody(doc, {
		modules: (modules) => {
			const menu = modules[0] as JsonObject & {
				case_details: { short: { columns: JsonObject[] } };
			};
			const column = menu.case_details.short.columns[0] as JsonObject;
			menu.case_details.short.columns[0] = {
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
	it("refuses the listed case read inside the results query under the column's entry", async () => {
		const outcome = await read(
			withColumn(
				app(true),
				"instance('results:inline')/results/case[not(commcare_is_related_case = true())][@case_id = current()/@case_id]/village",
			),
		);
		expect(
			outcome.findings.map((finding) => [finding.code, finding.detail?.reason]),
		).toEqual([[COLUMN, "listed-case-in-query"]]);
		expect(outcome.claims.counts[SEARCH_DETAIL]).toBeGreaterThan(0);
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
