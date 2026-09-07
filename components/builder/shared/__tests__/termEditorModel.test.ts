import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { lookupColumnIdSchema, lookupTableIdSchema } from "@/lib/domain";
import {
	ANY_CONSTRAINT,
	absenceSubjectConstraint,
	ancestorPath,
	checkValueExpression,
	dateLiteral,
	formField,
	input,
	literal,
	prop,
	relationStep,
	sessionUserProperty,
	tableColumn,
	term,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { buildEditorTypeContext } from "../editorTypeContext";
import {
	buildTermDefault,
	classifyLiteralShape,
	computeModeAdmission,
	describeTermModeReplacement,
	type TermAdmissionContext,
	termHasMeaningfulContent,
} from "../termEditorModel";

const numberOnly = { accepts: new Set(["int"] as const) };
const tableId = lookupTableIdSchema.parse(
	"00000000-0000-7000-8000-000000000001",
);
const columnId = lookupColumnIdSchema.parse(
	"00000000-0000-7000-8000-000000000002",
);
const ctx: TermAdmissionContext = {
	caseTypes: [
		{
			name: "patient",
			properties: [
				{ name: "name", label: proseText("Name"), data_type: "text" },
				{ name: "age", label: proseText("Age"), data_type: "int" },
			],
		},
	],
	currentCaseType: "patient",
	knownInputs: [
		{ uuid: testUuid("query-text"), name: "query", data_type: "text" },
		{ uuid: testUuid("query-age"), name: "age", data_type: "int" },
	],
	formFields: [
		{
			uuid: testUuid("field-text"),
			label: "Name",
			id: "name",
			dataType: "text",
		},
		{ uuid: testUuid("field-age"), label: "Age", id: "age", dataType: "int" },
	],
	userProperties: [
		{
			uuid: testUuid("worker-region"),
			slug: "assigned_region",
			label: "Region",
		},
	],
	tableScope: {
		tableId,
		columns: [
			{
				id: columnId,
				wireName: "age",
				label: "Age",
				dataType: "int",
			},
		],
	},
};
describe("term editor source decisions", () => {
	it("selects the first compatible real identity for each scoped source", () => {
		expect(buildTermDefault("property", ctx, numberOnly)).toEqual(
			prop("patient", "age"),
		);
		expect(buildTermDefault("field", ctx, numberOnly)).toEqual(
			formField(testUuid("field-age")),
		);
		expect(buildTermDefault("input", ctx, numberOnly)).toEqual(
			input(testUuid("query-age")),
		);
		expect(buildTermDefault("table-column", ctx, numberOnly)).toEqual(
			tableColumn(tableId, columnId),
		);
		expect(
			buildTermDefault("session-user-property", ctx, ANY_CONSTRAINT),
		).toEqual(sessionUserProperty(testUuid("worker-region")));
	});
	it("refuses unavailable sources with no schema-valid invented fallback", () => {
		const empty = {
			caseTypes: [],
			currentCaseType: "patient",
			knownInputs: [],
			userProperties: [],
		};
		const admitted = computeModeAdmission(empty, ANY_CONSTRAINT, []);
		for (const mode of [
			"property",
			"field",
			"input",
			"table-column",
			"session-user-property",
		] as const) {
			expect(admitted[mode].admitted).toBe(false);
			expect(admitted[mode].reason).toBeTruthy();
			expect(() => buildTermDefault(mode, empty, ANY_CONSTRAINT)).toThrow();
		}
		expect(() => buildTermDefault("session-user", ctx, ANY_CONSTRAINT)).toThrow(
			"field name",
		);
	});
	it("applies type admission before probing whole-rule carrier admission", () => {
		const admitted = computeModeAdmission(ctx, numberOnly, []);
		expect(admitted.property.admitted).toBe(true);
		expect(admitted.input.admitted).toBe(true);
		expect(admitted["session-context"].admitted).toBe(false);
		expect(admitted["session-user"].admitted).toBe(false);
		expect(admitted["session-user-property"].admitted).toBe(false);
		const seed = buildTermDefault("literal", ctx, numberOnly);
		expect(
			checkValueExpression(term(seed), buildEditorTypeContext(ctx)),
		).toEqual({ ok: true });
	});
	it("withholds a direct constant only where absence-check subjects forbid it", () => {
		expect(
			computeModeAdmission(ctx, absenceSubjectConstraint(), []).literal
				.admitted,
		).toBe(false);
		expect(computeModeAdmission(ctx, ANY_CONSTRAINT, []).literal.admitted).toBe(
			true,
		);
	});
	it("treats zero, false, null and a saved connection as authored content", () => {
		for (const value of [
			literal(0),
			literal(false),
			literal(null),
			prop("patient", "", ancestorPath(relationStep("parent", "household"))),
		])
			expect(termHasMeaningfulContent(value)).toBe(true);
		expect(termHasMeaningfulContent(literal(""))).toBe(false);
		expect(termHasMeaningfulContent(dateLiteral(""))).toBe(false);
	});
	it("identifies temporal qualifiers before string shape and names connection loss", () => {
		expect(classifyLiteralShape(dateLiteral("2026-01-01"))).toBe("date");
		expect(classifyLiteralShape(literal("2026-01-01"))).toBe("text");
		expect(
			describeTermModeReplacement(
				prop(
					"patient",
					"region",
					ancestorPath(relationStep("parent", "household")),
				),
				"A value",
			).description,
		).toContain("and its connection");
	});
});
