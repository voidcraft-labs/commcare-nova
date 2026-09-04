import { describe, expect, it } from "vitest";
import { proseText } from "@/lib/domain";
import { evaluate } from "../../xpath/evaluator";
import type { XPathInstance } from "../../xpath/runtimeValues";
import { XPathDate } from "../../xpath/types";
import type { CaseRow } from "../caseDataBindingTypes";
import { previewAsMe } from "../identity";
import { previewLookupData } from "../lookupEvaluation";
import {
	caseDatabaseXPathInstance,
	commcareSessionXPathInstance,
	INLINE_SEARCH_INPUT_INSTANCE_ID,
	lookupXPathInstances,
	previewHashtagNodeSet,
	searchInputXPathInstance,
} from "../xpathInstances";

function row(overrides: Partial<CaseRow> = {}): CaseRow {
	return {
		case_id: "case-1",
		app_id: "app-1",
		case_type: "patient",
		owner_id: "worker-1",
		status: "open",
		opened_on: new Date("2026-08-01T00:00:00.000Z"),
		modified_on: new Date("2026-08-02T00:00:00.000Z"),
		closed_on: null,
		case_name: "Ada",
		external_id: null,
		parent_case_id: null,
		properties: { district: "north" },
		...overrides,
	};
}

function context(instances: ReadonlyMap<string, XPathInstance>) {
	const mainInstance = instances.values().next().value as XPathInstance;
	return {
		contextPath: "/data",
		position: undefined,
		getValue: () => undefined,
		resolveHashtag: () => "",
		mainInstance,
		resolveXPathInstance: (id: string) => instances.get(id),
	};
}

describe("Preview structural XPath instances", () => {
	it("keeps an authorized empty casedb as valid empty nodesets", () => {
		const instance = caseDatabaseXPathInstance({ rows: [], indices: [] });
		const ctx = context(new Map([["casedb", instance]]));
		expect(evaluate("count(instance('casedb')/casedb/case)", ctx)).toBe(0);
		expect(
			evaluate(
				"count(instance('casedb')/casedb/case[@case_type='patient'])",
				ctx,
			),
		).toBe(0);
		expect(evaluate("sum(instance('casedb')/casedb/case/score)", ctx)).toBe(0);
		expect(
			evaluate("count(instance('casedb')/casedb/case/@category)", ctx),
		).toBe(0);
		expect(evaluate("count(instance('casedb')/casedb/case/@state)", ctx)).toBe(
			0,
		);
	});

	it("projects the device casedb attributes, properties, and parent index", () => {
		const openedAt = new Date(2026, 7, 1, 12);
		const modifiedAt = new Date(2026, 7, 2, 12);
		const instance = caseDatabaseXPathInstance(
			{
				rows: [
					row({ case_id: "household-1", case_type: "household" }),
					row({
						case_id: "patient-1",
						parent_case_id: "household-1",
						external_id: "ext-1",
						opened_on: openedAt,
						modified_on: modifiedAt,
						properties: {
							district: "north",
							score: 7,
							decimal_zero: 0,
							active: true,
						},
					}),
				],
				indices: [
					{
						case_id: "patient-1",
						ancestor_id: "household-1",
						identifier: "parent",
						relationship: "child",
						depth: 1,
						target_case_type: "household",
					},
					{
						case_id: "patient-1",
						ancestor_id: "host-1",
						identifier: "host_case",
						relationship: "extension",
						depth: 1,
						target_case_type: "host",
					},
				],
			},
			[
				{
					name: "patient",
					properties: [
						{
							name: "decimal_zero",
							label: proseText("Decimal zero"),
							data_type: "decimal",
						},
					],
				},
			],
		);
		const ctx = context(new Map([["casedb", instance]]));
		const patientNode = instance
			.root()
			.children("casedb")[0]
			?.children("case")
			.find((node) => node.attributes("case_id")[0]?.value() === "patient-1");
		const opened = patientNode?.children("date_opened")[0]?.value();
		const modified = patientNode?.children("last_modified")[0]?.value();
		expect(opened).toBeInstanceOf(XPathDate);
		expect((opened as XPathDate).time).toBeNull();
		expect(modified).toBeInstanceOf(XPathDate);
		expect((modified as XPathDate).time).toBeNull();

		expect(
			evaluate(
				"count(instance('casedb')/casedb/case[@case_type='patient'])",
				ctx,
			),
		).toBe(1);
		expect(
			evaluate(
				"string(instance('casedb')/casedb/case[@case_id='patient-1']/decimal_zero)",
				ctx,
			),
		).toBe("0.0");
		expect(
			evaluate(
				"instance('casedb')/casedb/case[@case_id='patient-1']/district",
				ctx,
			),
		).toBe("north");
		expect(
			evaluate(
				"instance('casedb')/casedb/case[@case_id='patient-1']/@external_id",
				ctx,
			),
		).toBe("ext-1");
		expect(
			evaluate(
				"count(instance('casedb')/casedb/case[@case_id='household-1']/@external_id)",
				ctx,
			),
		).toBe(0);
		expect(
			evaluate(
				"count(instance('casedb')/casedb/case[@case_id='patient-1']/@category) + count(instance('casedb')/casedb/case[@case_id='patient-1']/@state)",
				ctx,
			),
		).toBe(0);
		expect(
			evaluate(
				"string(instance('casedb')/casedb/case[@case_id='patient-1']/@category) = '' and string(instance('casedb')/casedb/case[@case_id='patient-1']/@state) = ''",
				ctx,
			),
		).toBe(true);
		expect(
			evaluate(
				"string(instance('casedb')/casedb/case[@case_id='patient-1']/external_id)",
				ctx,
			),
		).toBe("");
		expect(
			evaluate(
				"count(instance('casedb')/casedb/case[@case_id='patient-1']/missing_property)",
				ctx,
			),
		).toBe(0);
		expect(
			evaluate(
				"number(instance('casedb')/casedb/case[@case_id='patient-1']/score) = 7 and instance('casedb')/casedb/case[@case_id='patient-1']/active = true()",
				ctx,
			),
		).toBe(true);
		expect(
			evaluate(
				"index-of(instance('casedb')/casedb/case[@case_id='patient-1']/score, '7')",
				ctx,
			),
		).toBe(0);
		expect(
			evaluate(
				"index-of(instance('casedb')/casedb/case[@case_id='patient-1']/active, 'true')",
				ctx,
			),
		).toBe(0);
		expect(
			evaluate(
				"string(instance('casedb')/casedb/case[@case_id='patient-1']/date_opened)",
				ctx,
			),
		).toBe("2026-08-01");
		expect(
			evaluate(
				"number(instance('casedb')/casedb/case[@case_id='patient-1']/date_opened) = number(date('2026-08-01'))",
				ctx,
			),
		).toBe(true);
		expect(
			evaluate(
				"string(instance('casedb')/casedb/case[@case_id='patient-1']/last_modified)",
				ctx,
			),
		).toBe("2026-08-02");
		expect(
			evaluate(
				"number(instance('casedb')/casedb/case[@case_id='patient-1']/last_modified) = number(date('2026-08-02'))",
				ctx,
			),
		).toBe(true);
		expect(
			evaluate(
				"count(instance('casedb')/casedb/case[@case_id='household-1']/index) + count(instance('casedb')/casedb/case[@case_id='household-1']/attachment)",
				ctx,
			),
		).toBe(2);
		expect(
			evaluate(
				"instance('casedb')/casedb/case[@case_id='patient-1']/index/parent[@case_type='household']",
				ctx,
			),
		).toBe("household-1");
		expect(
			evaluate(
				"instance('casedb')/casedb/case[@case_id='patient-1']/index/host_case[@relationship='extension'][@case_type='host']",
				ctx,
			),
		).toBe("host-1");
		expect(
			evaluate(
				"count(instance('casedb')/casedb/case[@case_id='patient-1']/index/not_yet_written)",
				ctx,
			),
		).toBe(0);
		expect(
			evaluate(
				"count(instance('casedb')/casedb/case[@case_id='patient-1']/index/not_yet_written/@case_type) + count(instance('casedb')/casedb/case[@case_id='patient-1']/index/not_yet_written/@relationship)",
				ctx,
			),
		).toBe(0);
	});

	it("uses retained schema types for case types no longer in the Blueprint", () => {
		const instance = caseDatabaseXPathInstance({
			rows: [
				row({
					case_type: "retired_patient",
					properties: { score: 1e21 },
				}),
			],
			indices: [],
			propertyTypes: { retired_patient: { score: "decimal" } },
		});
		const ctx = context(new Map([["casedb", instance]]));
		expect(
			evaluate(
				"string(instance('casedb')/casedb/case[@case_type='retired_patient']/score)",
				ctx,
			),
		).toBe("1.0E21");
	});

	it("uses the stored schema type while Blueprint schema healing is pending", () => {
		const instance = caseDatabaseXPathInstance(
			{
				rows: [row({ properties: { score: 1e21 } })],
				indices: [],
				propertyTypes: { patient: { score: "decimal" } },
			},
			[
				{
					name: "patient",
					properties: [
						{
							name: "score",
							label: proseText("Score"),
							data_type: "text",
						},
					],
				},
			],
		);
		const ctx = context(new Map([["casedb", instance]]));
		expect(
			evaluate(
				"string(instance('casedb')/casedb/case[@case_type='patient']/score)",
				ctx,
			),
		).toBe("1.0E21");
	});

	it("keeps case and user hashtags as casedb nodesets", () => {
		const casedb = caseDatabaseXPathInstance({
			rows: [
				row({ case_id: "patient-1", properties: { district: "north" } }),
				row({
					case_id: "usercase-1",
					case_type: "commcare-user",
					properties: { hq_user_id: "worker-1", role: "supervisor" },
				}),
			],
			indices: [],
		});
		const caseData = new Map([
			["patient", new Map([["case_id", "patient-1"]])],
		]);
		const ctx = {
			...context(new Map([["casedb", casedb]])),
			resolveHashtagValue: (reference: string) =>
				previewHashtagNodeSet(reference, {
					casedb,
					caseData,
					userId: "worker-1",
				}) ?? "",
		};

		expect(evaluate("count(#patient/district)", ctx)).toBe(1);
		expect(evaluate("count(#patient/missing)", ctx)).toBe(0);
		expect(evaluate("string(#patient/case_id)", ctx)).toBe("patient-1");
		expect(evaluate("count(#user/role)", ctx)).toBe(1);
		expect(evaluate("string(#user/role)", ctx)).toBe("supervisor");
		expect(
			evaluate("count(#patient/district)", {
				...ctx,
				resolveHashtagValue: (reference: string) =>
					previewHashtagNodeSet(reference, {
						casedb,
						caseData: new Map(),
						userId: undefined,
					}) ?? "",
			}),
		).toBe(0);
	});

	it("projects commcaresession context, user data, and entry data", () => {
		const identity = previewAsMe({
			id: "worker-1",
			name: "Ada Lovelace",
			email: "ada@example.test",
		});
		const instance = commcareSessionXPathInstance(identity, {
			case_id: "patient-1",
		});
		const ctx = context(new Map([["commcaresession", instance]]));

		expect(
			evaluate("instance('commcaresession')/session/context/userid", ctx),
		).toBe("worker-1");
		expect(
			evaluate("instance('commcaresession')/session/data/case_id", ctx),
		).toBe("patient-1");
		for (const field of ["drift", "window_width", "applanguage"] as const) {
			expect(
				evaluate(
					`count(instance('commcaresession')/session/context/${field})`,
					ctx,
				),
			).toBe(0);
		}
	});

	it("projects a completed search's answers as the inline search-input instance", () => {
		const instance = searchInputXPathInstance(
			new Map([
				["patient_name", "Zzz"],
				["search_time", "2026-09-04T10:00:00Z"],
			]),
		);
		const ctx = context(new Map([[INLINE_SEARCH_INPUT_INSTANCE_ID, instance]]));

		expect(
			evaluate(
				"instance('search-input:results:inline')/input/field[@name='patient_name']",
				ctx,
			),
		).toBe("Zzz");
		expect(
			evaluate(
				"count(instance('search-input:results:inline')/input/field)",
				ctx,
			),
		).toBe(2);
		expect(
			evaluate(
				"count(instance('search-input:results:inline')/input/field[@name='missing'])",
				ctx,
			),
		).toBe(0);
	});

	it("leaves the #search namespace to the engine's scalar resolver", () => {
		expect(
			previewHashtagNodeSet("#search/patient_name", {
				casedb: undefined,
				caseData: new Map(),
				userId: "worker-1",
			}),
		).toBeUndefined();
	});

	it("projects lookup fixtures under their XForm-local table tag", () => {
		const tableId = "11111111-1111-4111-8111-111111111111" as never;
		const valueId = "22222222-2222-4222-8222-222222222222" as never;
		const nameId = "33333333-3333-4333-8333-333333333333" as never;
		const data = previewLookupData({
			projectRevision: "1",
			definitions: [
				{
					id: tableId,
					name: "Regions",
					tag: "regions",
					definitionRevision: "1" as never,
					columns: [
						{
							id: valueId,
							wireName: "value",
							label: "Value",
							dataType: "text",
						},
						{ id: nameId, wireName: "name", label: "Name", dataType: "text" },
					],
				},
			],
			rowsByTable: new Map([
				[
					tableId,
					[
						{
							id: "44444444-4444-4444-8444-444444444444" as never,
							values: { [valueId]: "north", [nameId]: "Northern" },
						},
					],
				],
			]),
		});
		const instances = lookupXPathInstances(data);

		expect(
			evaluate(
				"instance('regions')/regions_list/regions[value='north']/name",
				context(instances),
			),
		).toBe("Northern");
	});

	it("keeps an empty lookup table row path valid", () => {
		const tableId = "11111111-1111-4111-8111-111111111111" as never;
		const valueId = "22222222-2222-4222-8222-222222222222" as never;
		const data = previewLookupData({
			projectRevision: "1",
			definitions: [
				{
					id: tableId,
					name: "Regions",
					tag: "regions",
					definitionRevision: "1" as never,
					columns: [
						{
							id: valueId,
							wireName: "value",
							label: "Value",
							dataType: "text",
						},
					],
				},
			],
			rowsByTable: new Map([[tableId, []]]),
		});
		const instances = lookupXPathInstances(data);
		const ctx = context(instances);

		expect(
			evaluate("count(instance('regions')/regions_list/regions)", ctx),
		).toBe(0);
		expect(
			evaluate(
				"count(instance('regions')/regions_list/regions[value='north'])",
				ctx,
			),
		).toBe(0);
	});
});
