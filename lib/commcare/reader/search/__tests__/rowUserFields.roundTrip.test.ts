/**
 * Contract: a worker property that only a search filter row reads reads back to the document it
 * was emitted from, with no finding: the searches' first pass names the worker's own data each
 * row reads (`search/index.ts::searchRowUserFields`), the reading mints a worker property for it
 * as it does for every other slot's read, and the row binds to that property.
 *
 * The failure it catches: a row read after the worker properties are minted, so its read of
 * `region` stays the name-backed `session-user` leaf and the read document holds no worker
 * property, a different document with no finding.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import {
	advancedSearchInputDef,
	type BlueprintDoc,
	plainColumn,
} from "@/lib/domain";
import {
	eq,
	input,
	prop,
	sessionUserProperty,
	whenInput,
} from "@/lib/domain/expression/builders";
import { proseText } from "@/lib/domain/prose";
import { DERIVED_WIRE_IDENTITY } from "../../../wireIdentity";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { readLists } from "../../caseList/__tests__/listReading";
import { matchingResolver } from "../../identity";
import { externalIdentityMap } from "../../identityMap";
import { readHqApp } from "../../index";
import { searchRowUserFields } from "../index";

const REGION = testUuid("row-user-region");
const NOTES = testUuid("row-user-notes");

/** A search whose one advanced field matches a patient's notes against the worker's `region`,
 *  which nothing else of the app reads. */
function regionSearch(): BlueprintDoc {
	const built = buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name"), data_type: "text" },
					{ name: "notes", label: proseText("Notes"), data_type: "text" },
				],
			},
		],
		modules: [
			{
				uuid: testUuid("row-user-menu"),
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					columns: [
						plainColumn(testUuid("row-user-column"), "case_name", "Name"),
					],
					searchInputs: [
						advancedSearchInputDef(
							NOTES,
							"notes",
							"Notes",
							"text",
							whenInput(
								input(NOTES),
								eq(prop("patient", "notes"), sessionUserProperty(REGION)),
							),
						),
					],
				},
				caseSearchConfig: {},
				forms: [
					{
						uuid: testUuid("row-user-form"),
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
					},
				],
			},
		],
	});
	return {
		...built,
		userProperties: {
			[REGION]: { uuid: REGION, slug: "region", label: "region" },
		},
		userPropertyOrder: [REGION],
	};
}

describe("a worker property only a search filter row reads", () => {
	it("is named by the searches' first pass", async () => {
		const reading = await readLists(regionSearch(), { firstPassOnly: true });
		expect(searchRowUserFields(reading.ctx)).toEqual(["region"]);
	});

	it("reads back to the property, and the row to a read of it", async () => {
		const doc = regionSearch();
		const outcome = readHqApp(
			await inputFor(exportedBody(doc), {
				resolver: matchingResolver(
					"app-1",
					externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
				),
				recordDialect: recordDialectRoundTrip,
			}),
		);
		expect(outcome.defects).toEqual([]);
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
		if (outcome.kind !== "read") return;
		const read = outcome.draft.doc;
		expect(read.userProperties).toEqual(doc.userProperties);
		const inputs = (d: BlueprintDoc) =>
			d.modules[d.moduleOrder[0] ?? ""]?.caseListConfig?.searchInputs.map(
				(one) => (one.kind === "advanced" ? one.predicate : undefined),
			);
		expect(inputs(read)).toEqual(inputs(doc));
	});
});
