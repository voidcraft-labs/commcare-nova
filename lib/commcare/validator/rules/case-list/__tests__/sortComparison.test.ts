import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import {
	type BlueprintDoc,
	type CalculatedSort,
	type CaseProperty,
	type Column,
	plainColumn,
} from "@/lib/domain";
import { prop, term } from "@/lib/domain/expression";
import { proseText } from "@/lib/domain/prose";
import { findings } from "./caseListRuleFixture";

/* A rule's comparison is the author's choice. An edit elsewhere that makes the
 * field's own comparison agree with it, or gives the field a format that
 * orders by its own labels, leaves a document every runtime orders as before,
 * so the gate admits that edit. Distance over a value that holds no location
 * fails on the device, so the gate refuses it wherever it comes from. */

const score = (data_type?: CaseProperty["data_type"]): CaseProperty => ({
	name: "score",
	label: proseText("Score"),
	...(data_type !== undefined && { data_type }),
});

function listDoc(args: {
	property: CaseProperty;
	columns: Column[];
	calculatedSorts?: CalculatedSort[];
}): BlueprintDoc {
	return buildDoc({
		appName: "Comparison",
		caseTypes: [{ name: "patient", properties: [args.property] }],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					columns: [
						...args.columns,
						plainColumn(testUuid("name"), "case_name", "Name"),
					],
					searchInputs: [],
					...(args.calculatedSorts && {
						calculatedSorts: args.calculatedSorts,
					}),
				},
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: "Name",
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
						],
					},
				],
			},
		],
	});
}

const retype = (doc: BlueprintDoc, property: CaseProperty) =>
	mutationCommitVerdict(
		doc,
		[{ kind: "setCaseProperty", caseType: "patient", property }],
		LOOKUP_CONTEXT_UNAVAILABLE,
	);

/** The edit commits, and the whole validator finds nothing in what it left:
 *  an edit the scoped gate let through over a finding would fail the export. */
function expectAdmitted(verdict: ReturnType<typeof retype>) {
	expect(verdict.ok ? [] : verdict.findings).toEqual([]);
	expect(findings(verdict.nextDoc)).toEqual([]);
}

describe("a rule's comparison", () => {
	it("admits a property edit that makes the field's own comparison the chosen one", () => {
		const doc = listDoc({
			property: score("text"),
			columns: [
				plainColumn(testUuid("score"), "score", "Score", {
					sort: { direction: "asc", priority: 0, comparator: "integer" },
				}),
			],
		});
		expect(findings(doc)).toEqual([]);
		const verdict = retype(doc, score("int"));
		expectAdmitted(verdict);
	});

	it("admits options that give the field an order of its own labels", () => {
		const doc = listDoc({
			property: score("text"),
			columns: [
				plainColumn(testUuid("score"), "score", "Score", {
					sort: { direction: "asc", priority: 0, comparator: "decimal" },
				}),
			],
		});
		const verdict = retype(doc, {
			...score("single_select"),
			options: [
				{ value: "low", label: proseText("Low") },
				{ value: "high", label: proseText("High") },
			],
		});
		expectAdmitted(verdict);
	});

	it("admits a property edit that makes a calculation's own comparison the chosen one", () => {
		const doc = listDoc({
			property: score("text"),
			columns: [],
			calculatedSorts: [
				{
					uuid: testUuid("score-sort"),
					expression: term(prop("patient", "score")),
					direction: "asc",
					priority: 0,
					comparator: "integer",
				},
			],
		});
		expect(findings(doc)).toEqual([]);
		const verdict = retype(doc, score("int"));
		expectAdmitted(verdict);
	});
});

describe("distance", () => {
	const distanceOn = (property: CaseProperty) =>
		listDoc({
			property,
			columns: [
				plainColumn(testUuid("score"), "score", "Where", {
					sort: { direction: "asc", priority: 0, comparator: "distance" },
				}),
			],
		});

	it.each([
		["a location", score("geopoint")],
		["text a CommCare HQ app saves a location as", score("text")],
		["a property of no declared type", score()],
	])("orders %s", (_name, property) => {
		expect(findings(distanceOn(property))).toEqual([]);
	});

	it.each([
		["int", "whole numbers"],
		["decimal", "decimal numbers"],
		["date", "dates"],
		["datetime", "dates and times"],
	] as const)("refuses a %s property, naming the column", (type, noun) => {
		const refused = findings(distanceOn(score(type))).filter(
			(finding) => finding.code === "CASE_LIST_DISTANCE_NEEDS_LOCATION",
		);
		expect(refused).toHaveLength(1);
		expect(refused[0].details).toMatchObject({
			columnUuid: testUuid("score"),
			shape: "not-a-location",
			valueType: type,
		});
		expect(userFacingError(refused[0])).toBe(
			`"Where" in "Patients"'s Default order compares by distance, but it holds ${noun} rather than a location. You can choose another comparison, or order by an item that holds a location.`,
		);
	});

	it("refuses a retype that leaves a distance rule without a location", () => {
		const doc = distanceOn(score("geopoint"));
		expect(findings(doc)).toEqual([]);
		const verdict = retype(doc, score("int"));
		expect(verdict.ok).toBe(false);
		expect(
			verdict.ok ? [] : verdict.findings.map((finding) => finding.code),
		).toEqual(["CASE_LIST_DISTANCE_NEEDS_LOCATION"]);
	});
});
