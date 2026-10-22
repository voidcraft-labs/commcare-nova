import { describe, expect, it } from "vitest";
import { expressionEditorFixture } from "@/__tests__/helpers/expressionEditorFixture";
import { testUuid } from "@/__tests__/helpers/uuid";
import { caseListConfig } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	lookupColumnIdSchema,
	lookupTableIdSchema,
	type Uuid,
} from "@/lib/domain";
import {
	chosen,
	chosenCaseDoc,
} from "@/lib/domain/__tests__/chosenCaseFixture";
import {
	ANY_CONSTRAINT,
	ancestorPath,
	checkExpression,
	comparisonObjectConstraint,
	dateLiteral,
	type Expression,
	type ExpressionSlotRef,
	eq,
	formField,
	input,
	literal,
	prop,
	relationStep,
	sessionUserProperty,
	slotContext,
	tableColumn,
	term,
} from "@/lib/domain/expression";
import {
	chosenCaseId,
	chosenCaseProperty,
} from "@/lib/domain/expression/chosenCase";
import { proseText } from "@/lib/domain/prose";
import { editorExpressionContext } from "../editorTypeContext";
import {
	buildTermDefault,
	chosenCaseReadOf,
	chosenCaseSourceLabel,
	chosenCaseSources,
	chosenCaseValueChoices,
	classifyLiteralShape,
	computeModeAdmission,
	describeChosenCaseRead,
	describeTermModeReplacement,
	searchOnlyPropertyChoices,
	type TermAdmissionContext,
	termHasMeaningfulContent,
} from "../termEditorModel";
import { workbenchExpressionAdmission } from "../workbenchAdmission";

const numberOnly = { accepts: new Set(["int"] as const) };
const tableId = lookupTableIdSchema.parse(
	"00000000-0000-7000-8000-000000000001",
);
const columnId = lookupColumnIdSchema.parse(
	"00000000-0000-7000-8000-000000000002",
);
const vocabulary = {
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
		{ uuid: testUuid("query-date"), name: "seen_on", data_type: "date" },
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
} satisfies Parameters<typeof expressionEditorFixture>[1];
const ctx: TermAdmissionContext = expressionEditorFixture(
	"operation-condition",
	vocabulary,
).context;
const tableCtx = expressionEditorFixture("table-filter", {
	...vocabulary,
	caseDataScope: "table-row" as const,
}).context;
const searchCtx = expressionEditorFixture(
	"search-predicate",
	vocabulary,
).context;
describe("term editor source decisions", () => {
	it("selects the first compatible real identity for each scoped source", () => {
		expect(buildTermDefault("property", ctx, numberOnly)).toEqual(
			prop("patient", "age"),
		);
		expect(buildTermDefault("field", ctx, numberOnly)).toEqual(
			formField(testUuid("field-age")),
		);
		expect(
			buildTermDefault("input", searchCtx, { accepts: new Set(["date"]) }),
		).toEqual(input(testUuid("query-date")));
		expect(buildTermDefault("table-column", tableCtx, numberOnly)).toEqual(
			tableColumn(tableId, columnId),
		);
		expect(
			buildTermDefault("session-user-property", ctx, ANY_CONSTRAINT),
		).toEqual(sessionUserProperty(testUuid("worker-region")));
	});
	it("refuses unavailable sources with no schema-valid invented fallback", () => {
		const empty = expressionEditorFixture("case-filter", {
			caseTypes: [],
			currentCaseType: "patient",
			knownInputs: [],
			userProperties: [],
		}).context;
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
		expect(admitted.input.admitted).toBe(false);
		expect(admitted["session-context"].admitted).toBe(false);
		expect(admitted["session-user"].admitted).toBe(false);
		expect(admitted["session-user-property"].admitted).toBe(false);
		const seed = buildTermDefault("literal", ctx, numberOnly);
		expect(
			checkExpression(eq(term(seed), literal(0)), editorExpressionContext(ctx)),
		).toMatchObject({ errors: [] });
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

// ── The case chosen in an earlier menu ──────────────────────────────────
//
// Villages → Households → Members (lib/domain/__tests__/chosenCaseFixture.ts):
// the source menu lists exactly the menus whose case the entry chose, one at
// a time, before the slot runs, and nothing else.

function chosenContext(
	doc: BlueprintDoc,
	slot: ExpressionSlotRef,
	root: Expression,
): TermAdmissionContext {
	const expressionContext = slotContext(doc, slot, new Map());
	if (expressionContext === undefined)
		throw new Error("The chosen-case fixture has no such slot.");
	return {
		expressionContext,
		caseTypes: expressionContext.facts.caseTypes,
		currentCaseType: doc.modules[slot.uuid]?.caseType ?? "",
		knownInputs: [],
		userProperties: [],
		admitExpressionChange: (path, next) =>
			workbenchExpressionAdmission(root, path, next, expressionContext),
	};
}

const MEMBER_FILTER_ROOT = eq(
	term(prop("member", "village_name")),
	term(literal("")),
);
const filterOf = (module: Uuid): ExpressionSlotRef => ({
	entity: "module",
	uuid: module,
	slot: "case_list_filter",
});

describe("the case chosen in an earlier menu", () => {
	it("lists exactly the menus chosen one at a time before the case list", () => {
		const doc = chosenCaseDoc();
		const sources = (module: Uuid) =>
			chosenCaseSources(
				chosenContext(doc, filterOf(module), MEMBER_FILTER_ROOT)
					.expressionContext,
			);
		expect(sources(chosen.members)).toEqual([
			{ module: chosen.villages, caseType: "village" },
			{ module: chosen.households, caseType: "household" },
		]);
		// Households' list also runs as Members' parent choice, where the
		// village is kept in another place: no one id names it, so it is not
		// offered. Villages' list runs first, so nothing is chosen before it.
		expect(sources(chosen.households)).toEqual([]);
		expect(sources(chosen.villages)).toEqual([]);
	});

	it("never lists a several-case menu or a slot that runs before any choice", () => {
		const doc = chosenCaseDoc();
		doc.modules[chosen.villages].caseListConfig = {
			...caseListConfig([]),
			selection: { kind: "multiple", maximum: 3 },
		};
		expect(
			chosenCaseSources(
				chosenContext(doc, filterOf(chosen.members), MEMBER_FILTER_ROOT)
					.expressionContext,
			).map((source) => source.module),
		).toEqual([chosen.households]);
		expect(
			chosenCaseSources(
				chosenContext(
					chosenCaseDoc(),
					{
						entity: "module",
						uuid: chosen.members,
						slot: "module_display_condition",
					},
					MEMBER_FILTER_ROOT,
				).expressionContext,
			),
		).toEqual([]);
	});

	it("labels each source and stored read by the menu's current name", () => {
		expect(chosenCaseSourceLabel("Households")).toBe(
			"The case chosen in Households",
		);
		expect(describeChosenCaseRead("Households")).toBe(
			"The case chosen in Households",
		);
		expect(describeChosenCaseRead("Households", "Village")).toBe(
			"Village of the case chosen in Households",
		);
	});

	it("offers the case itself, then the menu's properties, as the two stored shapes", () => {
		const ctx = chosenContext(
			chosenCaseDoc(),
			filterOf(chosen.members),
			MEMBER_FILTER_ROOT,
		);
		const household = chosenCaseSources(ctx.expressionContext)[1];
		if (household === undefined) throw new Error("Households is not offered.");
		const choices = chosenCaseValueChoices(
			household,
			ctx,
			comparisonObjectConstraint("eq", "text"),
			["right"],
			(property) => property.name,
		);
		expect(choices[0]).toMatchObject({
			label: "The case itself",
			value: chosenCaseId(chosen.households),
			admission: { admitted: true },
		});
		const village = choices.find(
			(choice) => choice.property === "village_name",
		);
		expect(village).toMatchObject({
			value: chosenCaseProperty(chosen.households, "household", "village_name"),
			admission: { admitted: true },
		});
		expect(choices.some((choice) => choice.property === "case_id")).toBe(false);
		// Each stored shape reads back as the read it was offered as.
		expect(chosenCaseReadOf(chosenCaseId(chosen.households))).toEqual({
			module: chosen.households,
		});
		expect(
			chosenCaseReadOf(
				chosenCaseProperty(chosen.households, "household", "village_name"),
			),
		).toEqual({
			module: chosen.households,
			property: "village_name",
			caseType: "household",
		});
		// The mode is admitted because a choice is.
		expect(
			computeModeAdmission(ctx, comparisonObjectConstraint("eq", "text"), [
				"right",
			])["chosen-case"].admitted,
		).toBe(true);
	});

	it("is unavailable, with a reason, where no menu has chosen a case", () => {
		const admission = computeModeAdmission(searchCtx, ANY_CONSTRAINT, []);
		expect(admission["chosen-case"]).toEqual({
			admitted: false,
			reason: "No earlier menu has chosen a case before this runs",
		});
	});
});

describe("values only CommCare's server search reads", () => {
	it("offers Date closed only where no device evaluates the slot", () => {
		const offered = (
			carrier: "search-predicate" | "search-case-filter" | "case-filter",
		) =>
			searchOnlyPropertyChoices(
				expressionEditorFixture(carrier, vocabulary).context.expressionContext,
			).map((choice) => [choice.property.name, choice.property.data_type]);
		expect(offered("search-predicate")).toEqual([["closed_on", "datetime"]]);
		expect(offered("search-case-filter")).toEqual([]);
		expect(offered("case-filter")).toEqual([]);
	});
});
