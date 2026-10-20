// components/builder/shared/__tests__/editorProfileParity.test.ts
//
// The editor reads every menu axis from its slot (`editorAxes.ts`), never
// from a surface. For every record slot of one document that holds them all,
// this holds two things against the deep validator:
//
//   1. The editor's context IS the validator's: `editorAxesForSlot` builds
//      the same `ExpressionContext` the validator's `slotContext` call does.
//   2. Each axis says what that context admits: a case read, a data-table
//      column, an owner value and a pattern match are each offered exactly
//      where the slot's own verdict admits them. Which runtime a rule runs
//      on is read off the profile's targets; `runtimeMatchModes.test.ts`
//      holds what each runtime admits.
//
// A record slot added to the reference tables without a row here fails the
// totality check at the bottom.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { expressionEditVerdict } from "@/lib/doc/hooks/predicateVerdicts";
import {
	advancedSearchInputDef,
	type BlueprintDoc,
	CASE_LOADING_FORM_TYPES,
	type CaseOperation,
	calculatedColumn,
	hiddenSearchInputDef,
	type LookupColumnId,
	type LookupTableId,
	lookupColumnIdSchema,
	lookupTableIdSchema,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	actingUser,
	activeRowScope,
	type Expression,
	type ExpressionContext,
	type ExpressionSlotRef,
	eq,
	type LookupTypeIndex,
	literal,
	matchAll,
	matchesPattern,
	prop,
	sessionContext,
	slotContext,
	tableColumn,
	term,
} from "@/lib/domain/expression";
import { proseText } from "@/lib/domain/prose";
import {
	FIELD_REFERENCE_SLOTS,
	FORM_REFERENCE_SLOTS,
	MODULE_REFERENCE_SLOTS,
} from "@/lib/domain/referenceSlots";
import { editorAxesForSlot } from "../editorAxes";
import { caseDataInScope } from "../editorSchemas";
import type { EditorLookupTableDecl } from "../lookupTablePresentation";

const TABLE: LookupTableId = lookupTableIdSchema.parse(
	"00000000-0000-7000-8000-0000000000b1",
);
const COLUMN: LookupColumnId = lookupColumnIdSchema.parse(
	"00000000-0000-7000-8000-0000000000b2",
);
const TABLES: readonly EditorLookupTableDecl[] = [
	{
		id: TABLE,
		name: "Clinics",
		columns: [
			{ id: COLUMN, wireName: "name", label: "Name", dataType: "text" },
		],
	},
];
const LOOKUP_TYPES: LookupTypeIndex = new Map([
	[TABLE, new Map([[COLUMN, "text" as const]])],
]);
const LOOKUP_OPTIONS = {
	kind: "lookup" as const,
	tableId: TABLE,
	valueColumnId: COLUMN,
	labelColumnId: COLUMN,
};

const CASE_FIRST = testUuid("parity-case-first");
const MIXED = testUuid("parity-mixed");
const FOLLOWUP = testUuid("parity-followup");
const REGISTER = testUuid("parity-register");
const CASE_PICK = testUuid("parity-case-pick");
const TABLE_PICK = testUuid("parity-table-pick");
const COLUMN_UUID = testUuid("parity-column");
const TEXT_INPUT = testUuid("parity-text-input");
const ADVANCED_INPUT = testUuid("parity-advanced-input");
const HIDDEN_INPUT = testUuid("parity-hidden-input");
const SELECT_INPUT = testUuid("parity-select-input");
const UPDATE = testUuid("parity-update");
const RUNTIME = testUuid("parity-runtime");
const CREATE = testUuid("parity-create");

function updateOperation(uuid: typeof UPDATE): CaseOperation {
	return {
		uuid,
		id: "update_patient",
		action: "update",
		caseType: "patient",
		target: { kind: "session" },
		writes: [{ property: "visit_note", value: term(literal("seen")) }],
		owner: term(literal("owner-id")),
		links: [
			{
				identifier: "household",
				targetType: "household",
				target: { kind: "expression", expr: term(literal("case-id")) },
				relationship: "child",
			},
		],
	};
}

/** Two modules: one whose every form opens a case (so a form's display
 * condition reads the chosen case), and one that also registers (so it reads
 * none). Every record slot has a real owner in one of them. */
function fixture(): BlueprintDoc {
	const doc = buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [
					{
						name: "visit_note",
						label: proseText("Visit note"),
						data_type: "text",
					},
				],
			},
			{
				name: "household",
				properties: [
					{
						name: "visit_note",
						label: proseText("Visit note"),
						data_type: "text",
					},
				],
			},
		],
		modules: [
			{
				uuid: CASE_FIRST,
				name: "Patients",
				caseType: "patient",
				caseSearchConfig: {},
				caseListConfig: {
					columns: [calculatedColumn(COLUMN_UUID, "Value", term(literal("")))],
					listColumnOrder: [COLUMN_UUID],
					detailColumnOrder: [COLUMN_UUID],
					searchInputs: [
						simpleSearchInputDef(
							TEXT_INPUT,
							"name",
							"Name",
							"text",
							"visit_note",
						),
						advancedSearchInputDef(
							ADVANCED_INPUT,
							"status_rule",
							"Status",
							"text",
							matchAll(),
						),
						hiddenSearchInputDef(
							HIDDEN_INPUT,
							"site",
							"Site",
							term(literal("site")),
						),
						simpleSearchInputDef(
							SELECT_INPUT,
							"clinic",
							"Clinic",
							"select",
							"visit_note",
							{ options: LOOKUP_OPTIONS },
						),
					],
				},
				forms: [
					{
						uuid: FOLLOWUP,
						name: "Visit",
						type: "followup",
						fields: [
							f({
								uuid: CASE_PICK,
								id: "household",
								kind: "single_select",
								optionsSource: {
									kind: "cases",
									caseType: "household",
									labelProperty: "visit_note",
								},
							}),
							f({
								uuid: TABLE_PICK,
								id: "clinic",
								kind: "single_select",
								optionsSource: LOOKUP_OPTIONS,
							}),
						],
					},
				],
			},
			{
				uuid: MIXED,
				name: "Households",
				caseType: "household",
				forms: [{ uuid: REGISTER, name: "Register", type: "registration" }],
			},
		],
	});
	doc.forms[FOLLOWUP].caseOperations = [
		updateOperation(UPDATE),
		{
			uuid: RUNTIME,
			id: "update_other",
			action: "update",
			caseType: "patient",
			target: { kind: "expression", expr: term(literal("case-id")) },
		},
	];
	doc.forms[REGISTER].caseOperations = [
		{
			uuid: CREATE,
			id: "create_household",
			action: "create",
			caseType: "household",
			target: { kind: "new" },
			name: term(literal("Household")),
			writes: [{ property: "visit_note", value: term(literal("new")) }],
			owner: term(literal("owner-id")),
		},
	];
	return doc;
}

function operationSlots(
	form: typeof FOLLOWUP,
	operationUuid: typeof UPDATE,
): ExpressionSlotRef[] {
	const member = { operationUuid };
	return [
		{ entity: "form", uuid: form, slot: "case_operation_condition", member },
		{ entity: "form", uuid: form, slot: "case_operation_name", member },
		{ entity: "form", uuid: form, slot: "case_operation_rename", member },
		{ entity: "form", uuid: form, slot: "case_operation_owner", member },
		{
			entity: "form",
			uuid: form,
			slot: "case_operation_write_value",
			member: { operationUuid, property: "visit_note" },
		},
		{
			entity: "form",
			uuid: form,
			slot: "case_operation_write_condition",
			member: { operationUuid, property: "visit_note" },
		},
	];
}

/** Every record slot of the fixture, by its owner's identity. */
const SLOTS: readonly ExpressionSlotRef[] = [
	{ entity: "field", uuid: CASE_PICK, slot: "lookup_options_source" },
	{ entity: "field", uuid: TABLE_PICK, slot: "lookup_options_source" },
	{ entity: "form", uuid: FOLLOWUP, slot: "form_display_condition" },
	{ entity: "form", uuid: REGISTER, slot: "form_display_condition" },
	...operationSlots(FOLLOWUP, UPDATE),
	...operationSlots(REGISTER, CREATE),
	{
		entity: "form",
		uuid: FOLLOWUP,
		slot: "case_operation_target_expression",
		member: { operationUuid: RUNTIME },
	},
	{
		entity: "form",
		uuid: FOLLOWUP,
		slot: "case_operation_link_target_expression",
		member: { operationUuid: UPDATE, identifier: "household" },
	},
	{ entity: "module", uuid: CASE_FIRST, slot: "module_display_condition" },
	{ entity: "module", uuid: CASE_FIRST, slot: "case_list_filter" },
	{ entity: "module", uuid: MIXED, slot: "case_list_filter" },
	{
		entity: "module",
		uuid: CASE_FIRST,
		slot: "case_list_column_expression",
		member: { columnUuid: COLUMN_UUID },
	},
	{
		entity: "module",
		uuid: CASE_FIRST,
		slot: "search_button_display_condition",
	},
	{ entity: "module", uuid: CASE_FIRST, slot: "excluded_owner_ids" },
	...(
		[
			["search_input_default", TEXT_INPUT],
			["search_input_required_when", TEXT_INPUT],
			["search_input_validation_rule", TEXT_INPUT],
			["search_input_predicate", ADVANCED_INPUT],
			["search_input_hidden_value", HIDDEN_INPUT],
			["search_input_options", SELECT_INPUT],
		] as const
	).map(
		([slot, searchInputUuid]): ExpressionSlotRef => ({
			entity: "module",
			uuid: CASE_FIRST,
			slot,
			member: { searchInputUuid },
		}),
	),
];

function label(ref: ExpressionSlotRef): string {
	return `${ref.slot} of ${ref.uuid}`;
}

/** A probe in the shape the slot expects: a condition is compared, a value is
 * the read itself. */
function probe(context: ExpressionContext, read: Expression): Expression {
	return context.profile.expectation.kind === "condition"
		? eq(read, term(literal("x")))
		: read;
}

function admits(context: ExpressionContext, candidate: Expression): boolean {
	return expressionEditVerdict(candidate, context).ok;
}

describe("the editor's axes are the slot's profile", () => {
	const doc = fixture();

	it.each(SLOTS.map((ref) => [label(ref), ref] as const))(
		"%s",
		(_name, ref) => {
			const built = editorAxesForSlot(doc, ref, LOOKUP_TYPES, TABLES);
			expect(built, "the fixture owns this slot").toBeDefined();
			if (built === undefined) return;
			const { context, axes } = built;
			expect(context.ruleSet).toBe("record");

			// 1. The validator's own context for the slot.
			expect(context).toEqual(slotContext(doc, ref, LOOKUP_TYPES));

			const condition = context.profile.expectation.kind === "condition";
			const row = activeRowScope(context);

			// A case read: offered exactly where admitted. A case change's case
			// reads follow whether this exact form opens with a case, which the
			// operation rule decides; the checker alone admits them in every
			// operation slot.
			if (context.profile.scope === "submission") {
				const form = doc.forms[ref.uuid];
				const module = Object.values(doc.modules).find((candidate) =>
					doc.formOrder[candidate.uuid]?.includes(ref.uuid),
				);
				const opensWithCase =
					form !== undefined &&
					module?.caseType !== undefined &&
					CASE_LOADING_FORM_TYPES.has(form.type);
				expect(axes.caseDataScope).toBe(opensWithCase ? "per-case" : "global");
			} else {
				const caseType =
					row?.kind === "case" ? (row.caseType ?? "patient") : "patient";
				expect(
					admits(context, probe(context, term(prop(caseType, "visit_note")))),
					"a case read",
				).toBe(caseDataInScope(axes));
			}

			// A data-table column: only in a data-table row's rule, and the
			// editor knows that table's columns.
			expect(axes.caseDataScope === "table-row").toBe(row?.kind === "table");
			expect(axes.tableScope !== undefined).toBe(row?.kind === "table");
			if (axes.tableScope !== undefined)
				expect(
					admits(context, probe(context, term(tableColumn(TABLE, COLUMN)))),
				).toBe(true);

			// The owner values: only a case change's owner.
			if (!condition)
				expect(admits(context, actingUser()), "an owner value").toBe(
					axes.ownerValues,
				);
			else expect(axes.ownerValues).toBe(false);

			if (condition) {
				// A pattern match: only where the device's Pattern engine runs it.
				expect(
					admits(context, matchesPattern(sessionContext("username"), "^a")),
					"a pattern match",
				).toBe(axes.patternMatching === true);
			}
		},
	);

	it("reads the chosen case only where the form's menu picks it first", () => {
		const scope = (ref: ExpressionSlotRef) =>
			editorAxesForSlot(doc, ref, LOOKUP_TYPES)?.axes.caseDataScope;
		expect(SLOTS.map(scope)).not.toContain(undefined);
		expect(
			scope({ entity: "form", uuid: FOLLOWUP, slot: "form_display_condition" }),
		).toBe("selected-case");
		expect(
			scope({ entity: "form", uuid: REGISTER, slot: "form_display_condition" }),
		).toBe("global");
	});

	it("names a runtime for every target set", () => {
		const target = (ref: ExpressionSlotRef) =>
			editorAxesForSlot(doc, ref, LOOKUP_TYPES)?.axes.evaluationTarget;
		const module = (slot: ExpressionSlotRef["slot"], uuid = CASE_FIRST) =>
			({ entity: "module", uuid, slot }) as ExpressionSlotRef;
		expect(target(module("case_list_filter"))).toBe(
			"on-device-and-case-search",
		);
		expect(target(module("case_list_filter", MIXED))).toBe("on-device");
		expect(
			target({
				entity: "module",
				uuid: CASE_FIRST,
				slot: "search_input_predicate",
				member: { searchInputUuid: ADVANCED_INPUT },
			}),
		).toBe("case-search");
		expect(target(module("module_display_condition"))).toBe("on-device");
	});

	it("covers every record slot the reference tables declare", () => {
		const declared = new Set<string>(
			[
				...FIELD_REFERENCE_SLOTS,
				...FORM_REFERENCE_SLOTS,
				...MODULE_REFERENCE_SLOTS,
			]
				.filter((entry) => entry.kind === "expression")
				.map((entry) => entry.slot),
		);
		const record = new Set<string>(
			SLOTS.filter(
				(ref) =>
					editorAxesForSlot(doc, ref, LOOKUP_TYPES)?.context.ruleSet ===
					"record",
			).map((ref) => ref.slot),
		);
		// The form-logic slots: the text editor's, never the card editor's.
		const formLogic = new Set<string>([
			"relevant",
			"validate",
			"calculate",
			"default_value",
			"required",
			"repeat_count",
			"ids_query",
			"form_link_condition",
			"form_link_datum_xpath",
			"assessment_user_score",
			"deliver_entity_id",
			"deliver_entity_name",
		]);
		for (const slot of declared)
			expect(
				record.has(slot) || formLogic.has(slot),
				`${slot} is neither a covered record slot nor a form-logic slot`,
			).toBe(true);
	});
});
