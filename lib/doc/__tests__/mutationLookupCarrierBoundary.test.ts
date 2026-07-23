import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { applyMutations } from "@/lib/doc/mutations";
import { buildReferenceIndex } from "@/lib/doc/referenceIndex";
import { canonicalMutationSchema, mutationSchema } from "@/lib/doc/types";
import { asUuid, type BlueprintDoc, moduleSchema } from "@/lib/domain";

const MODULE = asUuid("10000000-0000-4000-8000-000000000000");
const FORM = asUuid("20000000-0000-4000-8000-000000000000");
const OPERATION = asUuid("30000000-0000-4000-8000-000000000000");
const COLUMN = asUuid("40000000-0000-4000-8000-000000000000");
const INPUT = asUuid("50000000-0000-4000-8000-000000000000");
const TABLE = "018f3e8a-7b2c-7def-8abc-1234567890ab";
const VALUE_COLUMN = "018f3e8a-7b2c-7def-8abc-1234567890ad";

const SAFE_VALUE = {
	kind: "term",
	term: { kind: "literal", value: "safe" },
} as const;

const TABLE_LOOKUP_VALUE = {
	kind: "coalesce",
	values: [
		{
			kind: "if",
			cond: { kind: "match-all" },
			// biome-ignore lint/suspicious/noThenProperty: this is the canonical non-callable ValueExpression branch slot.
			then: {
				kind: "table-lookup",
				tableId: TABLE,
				resultColumnId: VALUE_COLUMN,
				where: { kind: "match-all" },
			},
			else: SAFE_VALUE,
		},
	],
} as const;

const TABLE_COLUMN_PREDICATE = {
	kind: "not",
	clause: {
		kind: "eq",
		left: {
			kind: "if",
			cond: { kind: "match-all" },
			// biome-ignore lint/suspicious/noThenProperty: this is the canonical non-callable ValueExpression branch slot.
			then: SAFE_VALUE,
			else: {
				kind: "term",
				term: {
					kind: "table-column",
					tableId: TABLE,
					columnId: VALUE_COLUMN,
				},
			},
		},
		right: SAFE_VALUE,
	},
} as const;

const EMPTY_CASE_LIST = {
	columns: [],
	searchInputs: [],
} as const;

function moduleWith(patch: Record<string, unknown>): Record<string, unknown> {
	return {
		uuid: MODULE,
		id: "visits",
		name: "Visits",
		...patch,
	};
}

function formWith(patch: Record<string, unknown>): Record<string, unknown> {
	return {
		uuid: FORM,
		id: "visit",
		name: "Visit",
		type: "survey",
		...patch,
	};
}

function calculatedColumn(expression: unknown): Record<string, unknown> {
	return {
		uuid: COLUMN,
		kind: "calculated",
		header: "Calculated",
		expression,
	};
}

function advancedInput(
	patch: Record<string, unknown>,
): Record<string, unknown> {
	return {
		uuid: INPUT,
		kind: "advanced",
		name: "query",
		label: "Query",
		type: "text",
		predicate: { kind: "match-all" },
		...patch,
	};
}

function simpleInput(patch: Record<string, unknown>): Record<string, unknown> {
	return {
		uuid: INPUT,
		kind: "simple",
		name: "query",
		label: "Query",
		type: "text",
		property: "name",
		...patch,
	};
}

function operationWith(
	patch: Record<string, unknown>,
): Record<string, unknown> {
	return {
		uuid: OPERATION,
		id: "update_aux",
		action: "update",
		caseType: "aux",
		target: { kind: "session" },
		...patch,
	};
}

const legacyCarrierPayloads: ReadonlyArray<readonly [string, unknown]> = [
	[
		"addModule.module.displayCondition",
		{
			kind: "addModule",
			module: moduleWith({ displayCondition: TABLE_COLUMN_PREDICATE }),
		},
	],
	[
		"updateModule.patch.displayCondition",
		{
			kind: "updateModule",
			uuid: MODULE,
			patch: { displayCondition: TABLE_COLUMN_PREDICATE },
		},
	],
	[
		"addModule.module.caseListConfig.filter",
		{
			kind: "addModule",
			module: moduleWith({
				caseListConfig: {
					...EMPTY_CASE_LIST,
					filter: TABLE_COLUMN_PREDICATE,
				},
			}),
		},
	],
	[
		"updateModule.patch.caseListConfig.filter",
		{
			kind: "updateModule",
			uuid: MODULE,
			patch: {
				caseListConfig: {
					...EMPTY_CASE_LIST,
					filter: TABLE_COLUMN_PREDICATE,
				},
			},
		},
	],
	[
		"addModule.module.caseListConfig.columns[].expression",
		{
			kind: "addModule",
			module: moduleWith({
				caseListConfig: {
					columns: [calculatedColumn(TABLE_LOOKUP_VALUE)],
					searchInputs: [],
				},
			}),
		},
	],
	[
		"updateModule.patch.caseListConfig.searchInputs[].default",
		{
			kind: "updateModule",
			uuid: MODULE,
			patch: {
				caseListConfig: {
					columns: [],
					searchInputs: [advancedInput({ default: TABLE_LOOKUP_VALUE })],
				},
			},
		},
	],
	[
		"addModule.module.caseSearchConfig.excludedOwnerIds",
		{
			kind: "addModule",
			module: moduleWith({
				caseSearchConfig: { excludedOwnerIds: TABLE_LOOKUP_VALUE },
			}),
		},
	],
	[
		"updateModule.patch.caseSearchConfig.searchButtonDisplayCondition",
		{
			kind: "updateModule",
			uuid: MODULE,
			patch: {
				caseSearchConfig: {
					searchButtonDisplayCondition: TABLE_COLUMN_PREDICATE,
				},
			},
		},
	],
	[
		"addModule.caseSearchConfigValue",
		{
			kind: "addModule",
			module: moduleWith({
				caseSearchConfig: {
					excludedOwnerIds: TABLE_LOOKUP_VALUE,
					searchButtonDisplayCondition: { kind: "match-none" },
				},
			}),
			caseSearchConfigValue: {
				searchActionEnabled: false,
				excludedOwnerIds: TABLE_LOOKUP_VALUE,
			},
		},
	],
	[
		"updateModule.caseSearchConfigValue",
		{
			kind: "updateModule",
			uuid: MODULE,
			patch: {
				caseSearchConfig: {
					excludedOwnerIds: TABLE_LOOKUP_VALUE,
					searchButtonDisplayCondition: { kind: "match-none" },
				},
			},
			caseSearchConfigOperation: "set-owner-only",
			caseSearchConfigValue: {
				searchActionEnabled: false,
				excludedOwnerIds: TABLE_LOOKUP_VALUE,
			},
		},
	],
	[
		"updateModule.caseSearchConfigPatch",
		{
			kind: "updateModule",
			uuid: MODULE,
			patch: {
				caseSearchConfig: {
					searchButtonDisplayCondition: TABLE_COLUMN_PREDICATE,
				},
			},
			caseSearchConfigPatch: {
				searchButtonDisplayCondition: TABLE_COLUMN_PREDICATE,
			},
		},
	],
	[
		"updateModule.caseSearchConfigPatch.excludedOwnerIds",
		{
			kind: "updateModule",
			uuid: MODULE,
			patch: {
				caseSearchConfig: { excludedOwnerIds: TABLE_LOOKUP_VALUE },
			},
			caseSearchConfigPatch: {
				excludedOwnerIds: TABLE_LOOKUP_VALUE,
			},
		},
	],
	[
		"addForm.form.displayCondition",
		{
			kind: "addForm",
			moduleUuid: MODULE,
			form: formWith({ displayCondition: TABLE_COLUMN_PREDICATE }),
		},
	],
	[
		"updateForm.patch.displayCondition",
		{
			kind: "updateForm",
			uuid: FORM,
			patch: { displayCondition: TABLE_COLUMN_PREDICATE },
		},
	],
	[
		"addForm.form.caseOperations",
		{
			kind: "addForm",
			moduleUuid: MODULE,
			form: formWith({
				caseOperations: [
					operationWith({
						target: { kind: "expression", expr: TABLE_LOOKUP_VALUE },
					}),
				],
			}),
		},
	],
	...[
		[
			"target.expr",
			operationWith({
				target: { kind: "expression", expr: TABLE_LOOKUP_VALUE },
			}),
		],
		["condition", operationWith({ condition: TABLE_COLUMN_PREDICATE })],
		["name", operationWith({ name: TABLE_LOOKUP_VALUE })],
		["owner", operationWith({ owner: TABLE_LOOKUP_VALUE })],
		["rename", operationWith({ rename: TABLE_LOOKUP_VALUE })],
		[
			"writes[].value",
			operationWith({
				writes: [{ property: "status", value: TABLE_LOOKUP_VALUE }],
			}),
		],
		[
			"writes[].condition",
			operationWith({
				writes: [
					{
						property: "status",
						value: SAFE_VALUE,
						condition: TABLE_COLUMN_PREDICATE,
					},
				],
			}),
		],
		[
			"links[].target.expr",
			operationWith({
				links: [
					{
						identifier: "parent",
						targetType: "parent",
						target: { kind: "expression", expr: TABLE_LOOKUP_VALUE },
						relationship: "child",
					},
				],
			}),
		],
	].map(
		([path, value]) =>
			[
				`updateForm.caseOperationChange.value.${path}`,
				{
					kind: "updateForm",
					uuid: FORM,
					patch: {},
					caseOperationChange: { operation: "add", value },
				},
			] as const,
	),
	[
		"addColumn.column.expression",
		{
			kind: "addColumn",
			moduleUuid: MODULE,
			column: calculatedColumn(TABLE_LOOKUP_VALUE),
		},
	],
	[
		"updateColumn.column.expression",
		{
			kind: "updateColumn",
			moduleUuid: MODULE,
			uuid: COLUMN,
			column: calculatedColumn(TABLE_LOOKUP_VALUE),
		},
	],
	[
		"addSearchInput.searchInput.default",
		{
			kind: "addSearchInput",
			moduleUuid: MODULE,
			searchInput: advancedInput({ default: TABLE_LOOKUP_VALUE }),
		},
	],
	[
		"addSearchInput.simpleSearchInput.default",
		{
			kind: "addSearchInput",
			moduleUuid: MODULE,
			searchInput: simpleInput({ default: TABLE_LOOKUP_VALUE }),
		},
	],
	[
		"addSearchInput.searchInput.predicate",
		{
			kind: "addSearchInput",
			moduleUuid: MODULE,
			searchInput: advancedInput({ predicate: TABLE_COLUMN_PREDICATE }),
		},
	],
	[
		"updateSearchInput.searchInput.default",
		{
			kind: "updateSearchInput",
			moduleUuid: MODULE,
			uuid: INPUT,
			searchInput: advancedInput({ default: TABLE_LOOKUP_VALUE }),
		},
	],
	[
		"updateSearchInput.searchInput.predicate",
		{
			kind: "updateSearchInput",
			moduleUuid: MODULE,
			uuid: INPUT,
			searchInput: advancedInput({ predicate: TABLE_COLUMN_PREDICATE }),
		},
	],
	[
		"setCaseListMeta.patch.filter",
		{
			kind: "setCaseListMeta",
			uuid: MODULE,
			patch: { filter: TABLE_COLUMN_PREDICATE },
		},
	],
];

function mutationArm(kind: string): z.ZodType {
	const arm = mutationSchema.options.find(
		(option) =>
			option instanceof z.ZodObject &&
			option.shape.kind instanceof z.ZodLiteral &&
			option.shape.kind.value === kind,
	);
	if (arm === undefined) {
		throw new Error(`Fixture: mutation arm ${kind} was not found`);
	}
	return arm;
}

describe("rolling mutation lookup-carrier boundary", () => {
	it.each(legacyCarrierPayloads)(
		"rejects dormant ASTs in legacy envelope %s",
		(_name, payload) => {
			expect(mutationSchema.safeParse(payload).success).toBe(false);
		},
	);

	it.each(legacyCarrierPayloads)(
		"preserves dormant ASTs in canonical replay envelope %s",
		(_name, payload) => {
			expect(canonicalMutationSchema.safeParse(payload).success).toBe(true);
		},
	);

	it("replays a canonical carrier-bearing mutation without dropping its AST", () => {
		const doc: BlueprintDoc = {
			appId: "canonical-replay",
			appName: "Canonical replay",
			connectType: null,
			caseTypes: null,
			modules: {},
			forms: {},
			fields: {},
			moduleOrder: [],
			formOrder: {},
			fieldOrder: {},
			fieldParent: {},
		};
		doc.refIndex = buildReferenceIndex(doc);

		const parsed = canonicalMutationSchema.parse({
			kind: "addModule",
			module: moduleWith({ displayCondition: TABLE_COLUMN_PREDICATE }),
		});
		const replayed = produce(doc, (draft) => {
			applyMutations(draft, [parsed]);
		});

		expect(replayed.modules[MODULE]?.displayCondition).toEqual(
			TABLE_COLUMN_PREDICATE,
		);
	});

	it.each([
		"addModule",
		"updateModule",
		"addForm",
		"updateForm",
		"addColumn",
		"updateColumn",
		"addSearchInput",
		"updateSearchInput",
		"setCaseListMeta",
	])("omits dormant discriminators from %s's JSON grammar", (kind) => {
		// Some long-standing form compatibility slots use transforms that JSON
		// Schema cannot encode. They are unrelated to the predicate grammar, so
		// render those leaves as unconstrained while inspecting this boundary.
		const grammar = JSON.stringify(
			z.toJSONSchema(mutationArm(kind), { unrepresentable: "any" }),
		);
		expect(grammar).not.toContain("table-column");
		expect(grammar).not.toContain("table-lookup");
	});

	it("retains the whole mutation union in generated input grammars", () => {
		for (const schema of [mutationSchema, canonicalMutationSchema]) {
			const grammar = JSON.stringify(
				z.toJSONSchema(schema, {
					io: "input",
					unrepresentable: "any",
				}),
			);
			expect(grammar).toContain('"oneOf"');
			expect(grammar).toContain('"addModule"');
			expect(grammar).toContain('"updateField"');
			expect(grammar).toContain('"setAppName"');
		}
	});

	it("keeps canonical documents and both envelopes carrier-aware only at the approved top-level field extension", () => {
		expect(
			moduleSchema.safeParse(
				moduleWith({ displayCondition: TABLE_COLUMN_PREDICATE }),
			).success,
		).toBe(true);

		const optionsSource = {
			kind: "lookup-table",
			tableId: TABLE,
			valueColumnId: VALUE_COLUMN,
			labelColumnId: VALUE_COLUMN,
			filter: TABLE_COLUMN_PREDICATE,
		};
		const field = {
			uuid: asUuid("60000000-0000-4000-8000-000000000000"),
			id: "status",
			kind: "single_select",
			label: "Status",
			options: [
				{
					uuid: asUuid("70000000-0000-4000-8000-000000000000"),
					value: "active",
					label: "Active",
				},
				{
					uuid: asUuid("80000000-0000-4000-8000-000000000000"),
					value: "closed",
					label: "Closed",
				},
			],
		};

		const addField = {
			kind: "addField",
			parentUuid: FORM,
			field,
			optionsSource,
		} as const;
		const updateField = {
			kind: "updateField",
			uuid: field.uuid,
			targetKind: "single_select",
			patch: {},
			optionsSource,
		} as const;

		for (const schema of [mutationSchema, canonicalMutationSchema]) {
			expect(schema.safeParse(addField).success).toBe(true);
			expect(schema.safeParse(updateField).success).toBe(true);
		}
	});

	it.each([
		[
			"another discriminator",
			{
				kind: "setAppName",
				name: "App",
				optionsSource: { kind: "lookup-table" },
			},
		],
		[
			"a generic module patch",
			{
				kind: "updateModule",
				uuid: MODULE,
				patch: {
					optionsSource: { kind: "lookup-table" },
				},
			},
		],
		[
			"an addField fallback",
			{
				kind: "addField",
				parentUuid: FORM,
				field: {
					uuid: asUuid("90000000-0000-4000-8000-000000000000"),
					id: "status",
					kind: "single_select",
					label: "Status",
					options: [
						{ value: "yes", label: "Yes" },
						{ value: "no", label: "No" },
					],
					optionsSource: { kind: "lookup-table" },
				},
			},
		],
		[
			"a nested canonical AST",
			{
				kind: "addModule",
				module: moduleWith({
					displayCondition: {
						kind: "match-all",
						optionsSource: { kind: "lookup-table" },
					},
				}),
			},
		],
	])(
		"rejects optionsSource under %s instead of silently stripping it",
		(_name, payload) => {
			for (const schema of [mutationSchema, canonicalMutationSchema]) {
				expect(schema.safeParse(payload).success).toBe(false);
			}
		},
	);

	it("continues stripping unrelated future extensions", () => {
		const payload = {
			kind: "setAppName",
			name: "App",
			futureExtension: { enabled: true },
		};
		for (const schema of [mutationSchema, canonicalMutationSchema]) {
			expect(schema.parse(payload)).toEqual({
				kind: "setAppName",
				name: "App",
			});
		}
	});

	it.each([
		[
			"case-operation replacement identity",
			{
				kind: "updateForm",
				uuid: FORM,
				patch: {},
				caseOperationChange: {
					operation: "update",
					uuid: OPERATION,
					value: operationWith({
						uuid: asUuid("a0000000-0000-4000-8000-000000000000"),
					}),
				},
			},
		],
		[
			"column surface-order membership",
			{
				kind: "addModule",
				module: moduleWith({ caseListConfig: EMPTY_CASE_LIST }),
				columnSurfaceOrders: [
					{
						uuid: COLUMN,
						listOrder: "a0",
					},
				],
			},
		],
	])(
		"keeps rolling and canonical refinements aligned for %s",
		(_name, payload) => {
			for (const schema of [mutationSchema, canonicalMutationSchema]) {
				expect(schema.safeParse(payload).success).toBe(false);
			}
		},
	);
});
