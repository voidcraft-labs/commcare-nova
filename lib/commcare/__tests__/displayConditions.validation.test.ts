import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { blueprintDocSchema } from "@/lib/domain";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import {
	actingUser,
	ancestorPath,
	count,
	dateAdd,
	eq,
	formField,
	gt,
	idOf,
	input,
	literal,
	match,
	matchAll,
	matchNone,
	type Predicate,
	prop,
	relationStep,
	selfPath,
	sessionUser,
	tableColumn,
	tableLookup,
	term,
	unowned,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { parseLookupRevision } from "@/lib/lookup/schema";
import { runValidation } from "../validator/runner";

const TABLE = lookupTableIdSchema.parse("00000000-0000-7000-8000-000000000001");
const VALUE = lookupColumnIdSchema.parse(
		"10000000-0000-7000-8000-000000000001",
	),
	WHEN = lookupColumnIdSchema.parse("10000000-0000-7000-8000-000000000002");
const lookupContext = {
	kind: "available" as const,
	projectId: "p",
	projectRevision: parseLookupRevision("1"),
	definitions: [
		{
			id: TABLE,
			name: "Regions",
			tag: "regions",
			definitionRevision: parseLookupRevision("1"),
			columns: [
				{
					id: VALUE,
					wireName: "value",
					label: "Value",
					dataType: "text" as const,
				},
				{
					id: WHEN,
					wireName: "when",
					label: "When",
					dataType: "datetime" as const,
				},
			],
		},
	],
};
function admitted(doc: Parameters<typeof runValidation>[0]) {
	blueprintDocSchema.parse(toPersistableDoc(doc));
	expect(runValidation(doc, lookupContext)).toEqual([]);
}

function validateModule(condition: Predicate) {
	const doc = buildDoc({
		appName: "Display",
		modules: [
			{
				name: "Visits",
				forms: [
					{
						name: "Survey",
						type: "survey",
						fields: [f({ kind: "text", id: "answer" })],
					},
				],
			},
		],
	});
	const moduleUuid = doc.moduleOrder[0];
	admitted(doc);
	doc.modules[moduleUuid].displayCondition = condition;
	return runValidation(doc, lookupContext).map((error) => error.code);
}

function validateForm(
	condition: Predicate,
	formType: "followup" | "survey" = "followup",
) {
	return validateFormFindings(condition, formType).map((error) => error.code);
}

function validateFormFindings(
	condition: Predicate,
	formType: "followup" | "survey" = "followup",
) {
	const doc = buildDoc({
		appName: "Display",
		modules: [
			{
				name: "Visits",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Visit",
						type: formType,
						fields: [f({ kind: "text", id: "answer" })],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "household",
				properties: [{ name: "family_name", label: proseText("Family name") }],
			},
			{
				name: "patient",
				parent_type: "household",
				properties: [
					{ name: "status", label: proseText("Status") },
					{ name: "age", label: proseText("Age"), data_type: "int" },
					{
						name: "visited_on",
						label: proseText("Visited on"),
						data_type: "date",
					},
					{
						name: "visited_at",
						label: proseText("Visited at"),
						data_type: "datetime",
					},
				],
			},
		],
	});
	const moduleUuid = doc.moduleOrder[0];
	const formUuid = doc.formOrder[moduleUuid][0];
	admitted(doc);
	doc.forms[formUuid].displayCondition = condition;
	return runValidation(doc, lookupContext);
}

const CASE_OPERATION_ONLY_CONDITIONS: readonly (readonly [
	string,
	Predicate,
])[] = [
	[
		"form field",
		eq(
			formField(testUuid("11111111-1111-4111-8111-111111111111")),
			literal("value"),
		),
	],
	[
		"operation id",
		eq(
			idOf(testUuid("22222222-2222-4222-8222-222222222222")),
			literal("case-id"),
		),
	],
	["acting user", eq(actingUser(), literal("user-id"))],
	["unowned owner", eq(unowned(), literal("-"))],
];

describe("module display-condition validation", () => {
	it("allows user/session values and rejects case reads", () => {
		expect(
			validateModule(eq(sessionUser("role"), literal("supervisor"))),
		).toEqual([]);
		expect(
			validateModule(eq(prop("patient", "status"), literal("open"))),
		).toContain("MODULE_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE");
	});

	it("rejects Search answers and conditions that simplify to false", () => {
		expect(
			validateModule(eq(input(testUuid("name")), literal("Ada"))),
		).toContain("DISPLAY_CONDITION_SEARCH_INPUT_UNAVAILABLE");
		expect(validateModule(matchNone())).toContain(
			"DISPLAY_CONDITION_ALWAYS_FALSE",
		);
		expect(validateModule(matchAll())).toEqual([]);
	});
});

describe("case-operation-only display-condition values", () => {
	it.each(CASE_OPERATION_ONLY_CONDITIONS)(
		"rejects %s values on both modules and forms",
		(_label, condition) => {
			expect(validateModule(condition)).toContain(
				"MODULE_DISPLAY_CONDITION_TYPE_ERROR",
			);
			expect(validateForm(condition)).toContain(
				"FORM_DISPLAY_CONDITION_TYPE_ERROR",
			);
		},
	);
});

describe("form display-condition validation", () => {
	it("allows a direct selected-case read in a case-first module", () => {
		expect(
			validateForm(eq(prop("patient", "status"), literal("open"))),
		).toEqual([]);
	});

	it("rejects case reads when the module is forms-first", () => {
		expect(
			validateForm(eq(prop("patient", "status"), literal("open")), "survey"),
		).toContain("FORM_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE");
	});

	it("rejects related reads and counts even in a case-first module", () => {
		const parent = ancestorPath(relationStep("parent", "household"));
		expect(
			validateForm(
				eq(prop("household", "family_name", parent), literal("Smith")),
			),
		).toContain("FORM_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE");
		expect(validateForm(gt(count(selfPath()), literal(0)))).toContain(
			"FORM_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE",
		);
	});

	it("rejects non-portable on-device operators", () => {
		expect(
			validateForm(match(prop("patient", "status"), literal("open"), "fuzzy")),
		).toContain("DISPLAY_CONDITION_NOT_ON_DEVICE");
	});

	it("rejects date arithmetic that would discard a property's time", () => {
		const finding = validateFormFindings(
			eq(
				dateAdd(term(prop("patient", "visited_at")), "days", term(literal(1))),
				term(prop("patient", "visited_at")),
			),
		).find((error) => error.code === "DISPLAY_CONDITION_NOT_ON_DEVICE");
		expect(finding).toEqual(
			expect.objectContaining({
				details: expect.objectContaining({ reason: "datetime-base" }),
			}),
		);
	});

	it("allows fixed-duration arithmetic over a whole-date property", () => {
		expect(
			validateForm(
				eq(
					dateAdd(
						term(prop("patient", "visited_on")),
						"weeks",
						term(literal(1)),
					),
					term(prop("patient", "visited_on")),
				),
			),
		).toEqual([]);
	});

	it("accepts a table lookup as an on-device navigation condition", () => {
		const tableId = "00000000-0000-7000-8000-000000000001" as LookupTableId;
		const columnId = "10000000-0000-7000-8000-000000000001" as LookupColumnId;
		const findings = validateFormFindings(
			eq(tableLookup(tableId, columnId, matchAll()), literal("North")),
		);

		// The actual table/column definitions are provided to the complete gate.
		// Native lookup proof owns scalar first-row execution behavior.
		expect(findings).toEqual([]);
	});

	it("checks date arithmetic inside a lookup row's filter", () => {
		const tableId = "00000000-0000-7000-8000-000000000001" as LookupTableId;
		const resultColumnId =
			"10000000-0000-7000-8000-000000000001" as LookupColumnId;
		const datetimeColumnId =
			"10000000-0000-7000-8000-000000000002" as LookupColumnId;
		const condition = eq(
			tableLookup(
				tableId,
				resultColumnId,
				eq(
					dateAdd(
						term(tableColumn(tableId, datetimeColumnId)),
						"days",
						term(literal(1)),
					),
					term(tableColumn(tableId, datetimeColumnId)),
				),
			),
			literal("North"),
		);

		expect(
			validateFormFindings(condition, "followup").map((error) => error.code),
		).toContain("DISPLAY_CONDITION_NOT_ON_DEVICE");
	});

	it("reports type errors independently of context availability", () => {
		expect(
			validateForm(eq(prop("patient", "age"), literal("not a number"))),
		).toContain("FORM_DISPLAY_CONDITION_TYPE_ERROR");
	});
});
