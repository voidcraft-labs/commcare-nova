import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { updateColumnMutation } from "@/lib/agent/blueprintHelpers";
import {
	addModuleMutation,
	updateModuleMutation,
} from "@/lib/doc/addModuleMutation";
import {
	columnAddMutation,
	columnSnapshotMutations,
} from "@/lib/doc/caseListColumnMutations";
import {
	cleanupCaseSearchAfterFinalInputMutation,
	disableUnusedCaseSearchMutation,
	enableCaseSearchMutation,
	removeCaseSearchConfigIfNoAuthoredSettingsMutation,
	setOwnerOnlyCaseSearchMutation,
} from "@/lib/doc/caseSearchConfigMutations";
import { caseSearchConfigPatchMutations } from "@/lib/doc/caseSearchConfigPatchMutations";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { applyMutations } from "@/lib/doc/mutations";
import { columnSurfaceOrderMutation } from "@/lib/doc/order/columnSurface";
import { searchInputUpdateMutation } from "@/lib/doc/searchInputMutations";
import {
	asUuid,
	type BlueprintDoc,
	type Column,
	type Field,
	type LookupOptionsSource,
	type Module,
	mediaSchema,
	type SearchInputDef,
	selectOptionSchema,
	uuidSchema,
	xpathExpressionSchema,
} from "@/lib/domain";
import { predicateSchema, valueExpressionSchema } from "@/lib/domain/predicate";
import { type Mutation, mutationSchema } from "../types";

const MODULE = asUuid("10000000-0000-4000-8000-000000000000");
const COLUMN = asUuid("20000000-0000-4000-8000-000000000000");
const ADDED_COLUMN = asUuid("30000000-0000-4000-8000-000000000000");
const INPUT = asUuid("35000000-0000-4000-8000-000000000000");
const FORM = asUuid("60000000-0000-4000-8000-000000000000");
const FIELD = asUuid("70000000-0000-4000-8000-000000000000");
const OPTION_A = asUuid("80000000-0000-4000-8000-000000000000");
const OPTION_B = asUuid("90000000-0000-4000-8000-000000000000");
const TABLE_A = "018f3e8a-7b2c-7def-8abc-1234567890ab";
const TABLE_B = "018f3e8a-7b2c-7def-8abc-1234567890ac";
const VALUE_COLUMN = "018f3e8a-7b2c-7def-8abc-1234567890ad";
const LABEL_COLUMN = "018f3e8a-7b2c-7def-8abc-1234567890ae";
const OWNER_RULE = {
	kind: "term" as const,
	term: { kind: "literal" as const, value: "owner-a" },
};
const SOURCE_A = {
	kind: "lookup-table",
	tableId: TABLE_A,
	valueColumnId: VALUE_COLUMN,
	labelColumnId: LABEL_COLUMN,
} as LookupOptionsSource;
const SOURCE_B = {
	...SOURCE_A,
	tableId: TABLE_B,
	filter: {
		kind: "eq",
		left: {
			kind: "term",
			term: { kind: "literal", value: "enabled" },
		},
		right: {
			kind: "term",
			term: { kind: "literal", value: "enabled" },
		},
	},
} as LookupOptionsSource;

/**
 * Frozen origin/main-compatible subset used by every payload in this matrix.
 * The important constraint is nested strictness: Results/Details order keys
 * are unknown inside an origin column and therefore fail instead of stripping.
 */
const legacyColumnSchema = z
	.object({
		uuid: z.string(),
		order: z.string().optional(),
		sort: z
			.object({
				direction: z.enum(["asc", "desc"]),
				priority: z.number().int().nonnegative(),
			})
			.strict()
			.optional(),
		visibleInList: z.boolean().optional(),
		visibleInDetail: z.boolean().optional(),
		kind: z.literal("plain"),
		field: z.string(),
		header: z.string(),
	})
	.strict();

const legacyCaseListConfigSchema = z
	.object({
		columns: z.array(legacyColumnSchema),
		searchInputs: z.array(z.unknown()),
	})
	.strict();

const legacySearchInputSchema = z
	.object({
		uuid: z.string(),
		order: z.string().optional(),
		kind: z.literal("simple"),
		name: z.string(),
		label: z.string(),
		type: z.literal("text"),
		property: z.string(),
	})
	.strict();

const legacyCaseSearchConfigSchema = z
	.object({
		excludedOwnerIds: valueExpressionSchema.optional(),
		searchScreenTitle: z.string().min(1).optional(),
		searchScreenSubtitle: z.string().min(1).optional(),
		searchButtonLabel: z.string().min(1).optional(),
		searchButtonDisplayCondition: predicateSchema.optional(),
	})
	.strict();

const legacyModuleSchema = z
	.object({
		uuid: z.string(),
		id: z.string().optional(),
		name: z.string(),
		order: z.string().optional(),
		caseType: z.string().optional(),
		caseListOnly: z.boolean().optional(),
		caseListConfig: legacyCaseListConfigSchema.optional(),
		caseSearchConfig: legacyCaseSearchConfigSchema.optional(),
	})
	.strict();

/**
 * Exact single- and multi-select arms from the last pre-S05 commit
 * (`83de483f`). Keeping the full input base matters: a reduced proxy can
 * accidentally certify a payload that the deployed parser would reject (or
 * reject a valid field slot that parser accepted).
 */
const legacyStructuralFieldBase = z
	.object({
		uuid: uuidSchema,
		id: z.string(),
		order: z.string().optional(),
	})
	.strict();
const legacyFieldBaseSchema = legacyStructuralFieldBase.extend({
	label: z.string(),
	label_media: mediaSchema.optional(),
});
const legacyInputFieldBaseSchema = legacyFieldBaseSchema.extend({
	hint: z.string().optional(),
	hint_media: mediaSchema.optional(),
	help: z.string().optional(),
	help_media: mediaSchema.optional(),
	required: xpathExpressionSchema.optional(),
	relevant: xpathExpressionSchema.optional(),
	case_property_on: z.string().optional(),
});
const legacySingleSelectFieldSchema = legacyInputFieldBaseSchema.extend({
	kind: z.literal("single_select"),
	options: z.array(selectOptionSchema).min(2),
	validate: xpathExpressionSchema.optional(),
	validate_msg: z.string().optional(),
	validate_msg_media: mediaSchema.optional(),
	default_value: xpathExpressionSchema.optional(),
});
const legacyMultiSelectFieldSchema = legacyInputFieldBaseSchema.extend({
	kind: z.literal("multi_select"),
	options: z.array(selectOptionSchema).min(2),
	validate: xpathExpressionSchema.optional(),
	validate_msg: z.string().optional(),
	validate_msg_media: mediaSchema.optional(),
	default_value: xpathExpressionSchema.optional(),
});
const legacySelectFieldSchema = z.discriminatedUnion("kind", [
	legacySingleSelectFieldSchema,
	legacyMultiSelectFieldSchema,
]);

/**
 * Frozen copy of pre-S05 `partialOf`: mutation patches omit immutable
 * identity/discriminant slots, accept any subset of the remaining exact field
 * schema, and represent a clear as explicit JSON-stable null.
 */
function legacyPartialOf<
	S extends { uuid: z.ZodTypeAny; kind: z.ZodTypeAny } & z.ZodRawShape,
>(
	schema: z.ZodObject<S>,
): z.ZodObject<{
	[K in Exclude<keyof S, "uuid" | "kind">]: z.ZodOptional<z.ZodNullable<S[K]>>;
}> {
	const omitted = schema.omit({
		uuid: true,
		kind: true,
	} as unknown as Parameters<typeof schema.omit>[0]);
	const nullableShape = Object.fromEntries(
		Object.entries(omitted.shape).map(([key, value]) => [
			key,
			(value as z.ZodTypeAny).nullable(),
		]),
	);
	return z.object(nullableShape).partial() as unknown as z.ZodObject<{
		[K in Exclude<keyof S, "uuid" | "kind">]: z.ZodOptional<
			z.ZodNullable<S[K]>
		>;
	}>;
}

const legacyUpdateFieldSchema = z.discriminatedUnion("targetKind", [
	z.object({
		kind: z.literal("updateField"),
		uuid: uuidSchema,
		targetKind: z.literal("single_select"),
		patch: legacyPartialOf(legacySingleSelectFieldSchema).default(() => ({})),
	}),
	z.object({
		kind: z.literal("updateField"),
		uuid: uuidSchema,
		targetKind: z.literal("multi_select"),
		patch: legacyPartialOf(legacyMultiSelectFieldSchema).default(() => ({})),
	}),
]);

const legacyMutationSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("addModule"),
		module: legacyModuleSchema,
		index: z.number().int().nonnegative().optional(),
	}),
	z.object({
		kind: z.literal("updateModule"),
		uuid: z.string(),
		patch: z
			.object({
				caseListConfig: legacyCaseListConfigSchema.nullable().optional(),
				caseSearchConfig: legacyCaseSearchConfigSchema.nullable().optional(),
			})
			.partial(),
	}),
	z.object({
		kind: z.literal("addColumn"),
		moduleUuid: z.string(),
		column: legacyColumnSchema,
	}),
	z.object({
		kind: z.literal("updateColumn"),
		moduleUuid: z.string(),
		uuid: z.string(),
		column: legacyColumnSchema,
	}),
	z.object({
		kind: z.literal("moveColumn"),
		moduleUuid: z.string(),
		uuid: z.string(),
		order: z.string(),
	}),
	z.object({
		kind: z.literal("updateSearchInput"),
		moduleUuid: z.string(),
		uuid: z.string(),
		searchInput: legacySearchInputSchema,
	}),
	z.object({
		kind: z.literal("addField"),
		parentUuid: uuidSchema,
		field: legacySelectFieldSchema,
		index: z.number().int().nonnegative().optional(),
	}),
	legacyUpdateFieldSchema,
]);

type LegacyMutation = z.infer<typeof legacyMutationSchema>;

function baseColumn(extra: Partial<Column> = {}): Column {
	return {
		uuid: COLUMN,
		kind: "plain",
		field: "case_name",
		header: "Name",
		order: "generic-a",
		listOrder: "list-a",
		detailOrder: "detail-z",
		...extra,
	} as Column;
}

function docWithConfig(columns: Column[] | undefined): BlueprintDoc {
	const module: Module = {
		uuid: MODULE,
		id: "patients",
		name: "Patients",
		order: "module-a",
		caseType: "patient",
		...(columns !== undefined && {
			caseListConfig: { columns, searchInputs: [] },
		}),
	};
	return {
		appId: "rolling-compat",
		appName: "Rolling compatibility",
		connectType: null,
		caseTypes: null,
		modules: { [MODULE]: module },
		forms: {},
		fields: {},
		moduleOrder: [MODULE],
		formOrder: { [MODULE]: [] },
		fieldOrder: {},
		fieldParent: {},
	};
}

function docWithInput(): BlueprintDoc {
	return produce(docWithConfig([baseColumn()]), (draft) => {
		draft.modules[MODULE].caseListConfig?.searchInputs.push({
			uuid: INPUT,
			kind: "simple",
			name: "old_name",
			label: "Name",
			type: "text",
			property: "case_name",
		});
	});
}

type LookupSelectField = Extract<Field, { kind: "single_select" }>;

function lookupSelectField(
	optionsSource?: LookupOptionsSource,
): LookupSelectField {
	return {
		uuid: FIELD,
		id: "status",
		kind: "single_select",
		label: "Status",
		order: "field-a",
		options: [
			{
				uuid: OPTION_A,
				order: "option-a",
				value: "active",
				label: "Active",
			},
			{
				uuid: OPTION_B,
				order: "option-b",
				value: "closed",
				label: "Closed",
			},
		],
		...(optionsSource !== undefined && { optionsSource }),
	};
}

function docWithLookupSelect(
	optionsSource?: LookupOptionsSource,
): BlueprintDoc {
	return {
		appId: "rolling-compat",
		appName: "Rolling compatibility",
		connectType: null,
		caseTypes: null,
		modules: {
			[MODULE]: {
				uuid: MODULE,
				id: "patients",
				name: "Patients",
				order: "module-a",
			},
		},
		forms: {
			[FORM]: {
				uuid: FORM,
				id: "intake",
				name: "Intake",
				type: "survey",
				order: "form-a",
			},
		},
		fields: { [FIELD]: lookupSelectField(optionsSource) },
		moduleOrder: [MODULE],
		formOrder: { [MODULE]: [FORM] },
		fieldOrder: { [FORM]: [FIELD] },
		fieldParent: { [FIELD]: FORM },
	};
}

function docWithoutLookupSelect(): BlueprintDoc {
	const doc = docWithLookupSelect();
	return {
		...doc,
		fields: {},
		fieldOrder: { [FORM]: [] },
		fieldParent: {},
	};
}

function applyCurrent(
	doc: BlueprintDoc,
	batch: readonly Mutation[],
): BlueprintDoc {
	return produce(doc, (draft) => {
		applyMutations(draft, [...batch]);
	});
}

/**
 * Exact origin reducer behavior for the established matrix kinds. The field
 * cases mirror `83de483f` for the select arms exercised here; their
 * case-property catalog branch is inert because these frozen fixtures have no
 * `case_property_on`.
 */
function applyLegacy(
	doc: BlueprintDoc,
	batch: readonly LegacyMutation[],
): BlueprintDoc {
	return produce(doc, (draft) => {
		for (const mutation of batch) {
			switch (mutation.kind) {
				case "addModule": {
					const module = mutation.module as unknown as Module;
					draft.modules[module.uuid] = module;
					draft.formOrder[module.uuid] = [];
					const index = mutation.index ?? draft.moduleOrder.length;
					draft.moduleOrder.splice(index, 0, module.uuid);
					break;
				}
				case "updateModule": {
					const module = draft.modules[asUuid(mutation.uuid)];
					if (!module) break;
					for (const [key, value] of Object.entries(mutation.patch)) {
						const target = module as unknown as Record<string, unknown>;
						if (value === null || value === undefined) delete target[key];
						else target[key] = value;
					}
					break;
				}
				case "addColumn": {
					const config =
						draft.modules[asUuid(mutation.moduleUuid)]?.caseListConfig;
					config?.columns.push(mutation.column as unknown as Column);
					break;
				}
				case "updateColumn": {
					const config =
						draft.modules[asUuid(mutation.moduleUuid)]?.caseListConfig;
					const index = config?.columns.findIndex(
						(column) => column.uuid === mutation.uuid,
					);
					if (!config || index === undefined || index < 0) break;
					const order = config.columns[index]?.order;
					config.columns[index] = {
						...(mutation.column as unknown as Column),
						uuid: asUuid(mutation.uuid),
						...(order !== undefined && { order }),
					};
					break;
				}
				case "moveColumn": {
					const column = draft.modules[
						asUuid(mutation.moduleUuid)
					]?.caseListConfig?.columns.find(
						(candidate) => candidate.uuid === mutation.uuid,
					);
					if (column) column.order = mutation.order;
					break;
				}
				case "updateSearchInput": {
					const config =
						draft.modules[asUuid(mutation.moduleUuid)]?.caseListConfig;
					const index = config?.searchInputs.findIndex(
						(input) => input.uuid === mutation.uuid,
					);
					if (!config || index === undefined || index < 0) break;
					const order = config.searchInputs[index]?.order;
					config.searchInputs[index] = {
						...(mutation.searchInput as unknown as SearchInputDef),
						uuid: asUuid(mutation.uuid),
						...(order !== undefined && { order }),
					};
					break;
				}
				case "addField": {
					const parentUuid = asUuid(mutation.parentUuid);
					const parentExists =
						draft.forms[parentUuid] !== undefined ||
						draft.fields[parentUuid] !== undefined;
					if (!parentExists) break;
					const field = mutation.field as unknown as Field;
					const order = draft.fieldOrder[parentUuid] ?? [];
					const index = mutation.index ?? order.length;
					const clamped = Math.max(0, Math.min(index, order.length));
					order.splice(clamped, 0, field.uuid);
					draft.fieldOrder[parentUuid] = order;
					draft.fields[field.uuid] = field;
					break;
				}
				case "updateField": {
					const uuid = asUuid(mutation.uuid);
					const field = draft.fields[uuid];
					if (!field || field.kind !== mutation.targetKind) break;
					const spread: Record<string, unknown> = { ...field };
					for (const [key, value] of Object.entries(mutation.patch)) {
						if (value === null || value === undefined) delete spread[key];
						else spread[key] = value;
					}
					const result = legacySelectFieldSchema.safeParse(spread);
					if (!result.success) break;
					draft.fields[uuid] = result.data;
					break;
				}
			}
		}
	});
}

function onlyMutation(
	result: ReturnType<typeof updateColumnMutation>,
): Mutation {
	if ("error" in result) throw new Error(result.error);
	if (result.mutations.length !== 1) {
		throw new Error(`Expected one mutation, got ${result.mutations.length}.`);
	}
	return result.mutations[0] as Mutation;
}

function onlyBatchMutation(batch: readonly Mutation[]): Mutation {
	if (batch.length !== 1) {
		throw new Error(`Expected one mutation, got ${batch.length}.`);
	}
	return batch[0] as Mutation;
}

function onlyLookupCarrierMutation(
	before: BlueprintDoc,
	after: BlueprintDoc,
): Mutation {
	const mutations = diffDocsToMutations(before, after).filter(
		(mutation) =>
			mutation.kind === "addField" || mutation.kind === "updateField",
	);
	return onlyBatchMutation(mutations);
}

function payloads(): {
	ensure: Mutation;
	add: Mutation;
	content: Mutation;
	visibility: Mutation;
	sort: Mutation;
	move: Mutation;
	clear: Mutation;
	replaceConfig: Mutation;
	addModule: Mutation;
	searchEnable: Mutation;
	searchDisable: Mutation;
	searchRemoveIfEmpty: Mutation;
	searchCleanup: Mutation;
	ownerOnly: Mutation;
	addModuleOwnerOnly: Mutation;
	searchSetting: Mutation;
	renameInput: Mutation;
	lookupAdd: Mutation;
	lookupSet: Mutation;
	lookupReplace: Mutation;
	lookupClear: Mutation;
} {
	const current = baseColumn();
	const module = docWithConfig([current]).modules[MODULE];
	const withoutConfig = docWithConfig(undefined);
	const withEmptyConfig = produce(withoutConfig, (draft) => {
		draft.modules[MODULE].caseListConfig = { columns: [], searchInputs: [] };
	});
	const ensure = diffDocsToMutations(withoutConfig, withEmptyConfig).find(
		(mutation) =>
			mutation.kind === "updateModule" && mutation.ensureCaseListConfig,
	);
	if (ensure === undefined)
		throw new Error("Expected semantic ensure payload.");

	const added = {
		...baseColumn({ uuid: ADDED_COLUMN, order: "generic-b" }),
		listOrder: "list-b",
		detailOrder: "detail-a",
	};
	return {
		ensure,
		add: columnAddMutation(MODULE, added),
		content: onlyMutation(
			updateColumnMutation(module, COLUMN, { ...current, header: "Patient" }),
		),
		visibility: onlyMutation(
			updateColumnMutation(module, COLUMN, {
				...current,
				visibleInList: false,
			}),
		),
		sort: onlyBatchMutation(
			columnSnapshotMutations(MODULE, current, {
				...current,
				sort: { direction: "desc", priority: 0 },
			}),
		),
		move: columnSurfaceOrderMutation({
			moduleUuid: MODULE,
			column: current,
			surface: "list",
			order: "list-z",
		}),
		clear: columnSurfaceOrderMutation({
			moduleUuid: MODULE,
			column: current,
			surface: "list",
			order: null,
		}),
		replaceConfig: updateModuleMutation(MODULE, {
			caseListConfig: { columns: [current], searchInputs: [] },
		}),
		addModule: addModuleMutation(
			{
				uuid: asUuid("40000000-0000-4000-8000-000000000000"),
				id: "new_patients",
				name: "New patients",
				order: "module-b",
				caseType: "patient",
				caseListOnly: true,
				caseListConfig: { columns: [added], searchInputs: [] },
			},
			1,
		),
		searchEnable: enableCaseSearchMutation(MODULE, undefined),
		searchDisable: disableUnusedCaseSearchMutation(MODULE),
		searchRemoveIfEmpty:
			removeCaseSearchConfigIfNoAuthoredSettingsMutation(MODULE),
		searchCleanup: cleanupCaseSearchAfterFinalInputMutation({
			uuid: MODULE,
			config: {
				searchScreenTitle: "Find a patient",
				excludedOwnerIds: OWNER_RULE,
			},
			hasCasesAvailableCondition: false,
		}),
		ownerOnly: setOwnerOnlyCaseSearchMutation(MODULE, {
			searchActionEnabled: false,
			excludedOwnerIds: OWNER_RULE,
		}),
		addModuleOwnerOnly: addModuleMutation(
			{
				uuid: asUuid("50000000-0000-4000-8000-000000000000"),
				id: "assigned_cases",
				name: "Assigned cases",
				order: "module-c",
				caseSearchConfig: {
					searchActionEnabled: false,
					excludedOwnerIds: OWNER_RULE,
				},
			},
			2,
		),
		searchSetting: onlyBatchMutation(
			caseSearchConfigPatchMutations(
				MODULE,
				{},
				{
					searchScreenTitle: "Find a patient",
				},
			),
		),
		renameInput: searchInputUpdateMutation(
			MODULE,
			docWithInput().modules[MODULE].caseListConfig
				?.searchInputs[0] as SearchInputDef,
			{
				uuid: INPUT,
				kind: "simple",
				name: "new_name",
				label: "Renamed name",
				type: "text",
				property: "case_name",
			},
		),
		lookupAdd: onlyLookupCarrierMutation(
			docWithoutLookupSelect(),
			docWithLookupSelect(SOURCE_A),
		),
		lookupSet: onlyLookupCarrierMutation(
			docWithLookupSelect(),
			docWithLookupSelect(SOURCE_A),
		),
		lookupReplace: onlyLookupCarrierMutation(
			docWithLookupSelect(SOURCE_A),
			docWithLookupSelect(SOURCE_B),
		),
		lookupClear: onlyLookupCarrierMutation(
			docWithLookupSelect(SOURCE_A),
			docWithLookupSelect(),
		),
	};
}

function legacyStartFor(name: keyof ReturnType<typeof payloads>): BlueprintDoc {
	if (name === "lookupAdd") return docWithoutLookupSelect();
	if (
		name === "lookupSet" ||
		name === "lookupReplace" ||
		name === "lookupClear"
	) {
		// A pre-S05 client hydrates the inline fallback, not the carrier.
		return docWithLookupSelect();
	}
	if (name === "ensure") return docWithConfig(undefined);
	if (name === "addModule" || name === "addModuleOwnerOnly") {
		return docWithConfig([baseColumn()]);
	}
	if (name === "renameInput") return docWithInput();
	// An origin client has no surface-order keys in its hydrated column shape.
	return docWithConfig([
		baseColumn({ listOrder: undefined, detailOrder: undefined }),
	]);
}

describe("mutation rolling compatibility", () => {
	it("all emitters use origin-known discriminators and strict old-shape nested fallbacks", () => {
		for (const [name, payload] of Object.entries(payloads())) {
			expect(mutationSchema.safeParse(payload).success, name).toBe(true);
			expect([
				"addModule",
				"updateModule",
				"addColumn",
				"updateColumn",
				"moveColumn",
				"updateSearchInput",
				"addField",
				"updateField",
			]).toContain(payload.kind);
			expect(legacyMutationSchema.safeParse(payload).success, name).toBe(true);
		}

		const {
			add,
			content,
			visibility,
			sort,
			replaceConfig,
			addModule,
			ownerOnly,
			addModuleOwnerOnly,
			searchSetting,
			renameInput,
			lookupAdd,
			lookupSet,
			lookupReplace,
			lookupClear,
		} = payloads();
		expect(add).not.toHaveProperty("column.listOrder");
		expect(add).not.toHaveProperty("column.detailOrder");
		expect(content).not.toHaveProperty("column.listOrder");
		expect(content).not.toHaveProperty("column.detailOrder");
		expect(visibility).not.toHaveProperty("column.listOrder");
		expect(visibility).not.toHaveProperty("column.detailOrder");
		expect(content).toHaveProperty("preserveSort", true);
		expect(sort).toHaveProperty("sortPatch", {
			direction: "desc",
			priority: 0,
		});
		expect(replaceConfig).not.toHaveProperty(
			"patch.caseListConfig.columns.0.listOrder",
		);
		expect(replaceConfig).not.toHaveProperty(
			"patch.caseListConfig.columns.0.detailOrder",
		);
		expect(replaceConfig).toHaveProperty(
			"columnSurfaceOrders.0.listOrder",
			"list-a",
		);
		expect(addModule).not.toHaveProperty(
			"module.caseListConfig.columns.0.listOrder",
		);
		expect(addModule).not.toHaveProperty(
			"module.caseListConfig.columns.0.detailOrder",
		);
		expect(ownerOnly).not.toHaveProperty(
			"patch.caseSearchConfig.searchActionEnabled",
		);
		expect(ownerOnly).toHaveProperty(
			"patch.caseSearchConfig.searchButtonDisplayCondition.kind",
			"match-none",
		);
		expect(addModuleOwnerOnly).not.toHaveProperty(
			"module.caseSearchConfig.searchActionEnabled",
		);
		expect(addModuleOwnerOnly).toHaveProperty(
			"module.caseSearchConfig.searchButtonDisplayCondition.kind",
			"match-none",
		);
		expect(searchSetting).toHaveProperty(
			"caseSearchConfigPatch.searchScreenTitle",
			"Find a patient",
		);
		expect(renameInput).toHaveProperty("searchInput.name", "old_name");
		expect(renameInput).toHaveProperty("renamedTo", "new_name");
		expect(lookupAdd).toMatchObject({
			kind: "addField",
			field: lookupSelectField(),
			optionsSource: SOURCE_A,
		});
		expect(lookupAdd).not.toHaveProperty("field.optionsSource");
		for (const [payload, expected] of [
			[lookupSet, SOURCE_A],
			[lookupReplace, SOURCE_B],
			[lookupClear, null],
		] as const) {
			expect(payload).toMatchObject({
				kind: "updateField",
				uuid: FIELD,
				targetKind: "single_select",
				patch: {},
				optionsSource: expected,
			});
			expect(payload).not.toHaveProperty("patch.optionsSource");
		}

		const roundTrippedClear = mutationSchema.parse(
			JSON.parse(JSON.stringify(lookupClear)),
		);
		expect(roundTrippedClear).toHaveProperty("optionsSource", null);
	});

	it("new payload -> frozen origin parser strips extensions and the legacy reducer applies a safe fallback", () => {
		for (const [name, payload] of Object.entries(payloads()) as Array<
			[keyof ReturnType<typeof payloads>, Mutation]
		>) {
			const parsed = legacyMutationSchema.parse(payload);
			expect(parsed).not.toHaveProperty("ensureCaseListConfig");
			expect(parsed).not.toHaveProperty("surfaceOrders");
			expect(parsed).not.toHaveProperty("surfaceOrderPatch");
			expect(parsed).not.toHaveProperty("columnSurfaceOrders");
			expect(parsed).not.toHaveProperty("caseSearchConfigOperation");
			expect(parsed).not.toHaveProperty("caseSearchConfigValue");
			expect(parsed).not.toHaveProperty("caseSearchConfigPatch");
			expect(parsed).not.toHaveProperty("preserveSort");
			expect(parsed).not.toHaveProperty("sortPatch");
			expect(parsed).not.toHaveProperty("renamedTo");
			expect(parsed).not.toHaveProperty("optionsSource");
			expect(() => applyLegacy(legacyStartFor(name), [parsed])).not.toThrow();
		}

		const parsedEnsure = legacyMutationSchema.parse(payloads().ensure);
		expect(
			applyLegacy(docWithConfig(undefined), [parsedEnsure]).modules[MODULE]
				.caseListConfig,
		).toEqual({ columns: [], searchInputs: [] });

		const parsedAdd = legacyMutationSchema.parse(payloads().add);
		const legacyAdded = applyLegacy(legacyStartFor("add"), [parsedAdd]).modules[
			MODULE
		].caseListConfig?.columns.find((column) => column.uuid === ADDED_COLUMN);
		expect(legacyAdded).toMatchObject({ order: "generic-b" });
		expect(legacyAdded?.listOrder).toBeUndefined();
		expect(legacyAdded?.detailOrder).toBeUndefined();

		const parsedMove = legacyMutationSchema.parse(payloads().move);
		expect(
			applyLegacy(legacyStartFor("move"), [parsedMove]).modules[MODULE]
				.caseListConfig?.columns[0]?.order,
		).toBe("list-z");
		const parsedClear = legacyMutationSchema.parse(payloads().clear);
		expect(
			applyLegacy(legacyStartFor("clear"), [parsedClear]).modules[MODULE]
				.caseListConfig?.columns[0]?.order,
		).toBe("generic-a");
		const parsedReplacement = legacyMutationSchema.parse(
			payloads().replaceConfig,
		);
		const legacyReplacement = applyLegacy(legacyStartFor("replaceConfig"), [
			parsedReplacement,
		]).modules[MODULE].caseListConfig?.columns[0];
		expect(legacyReplacement).toMatchObject({ order: "generic-a" });
		expect(legacyReplacement?.listOrder).toBeUndefined();
		expect(legacyReplacement?.detailOrder).toBeUndefined();

		const parsedSort = legacyMutationSchema.parse(payloads().sort);
		expect(
			applyLegacy(legacyStartFor("sort"), [parsedSort]).modules[MODULE]
				.caseListConfig?.columns[0]?.sort,
		).toEqual({ direction: "desc", priority: 0 });

		const parsedSearchSetting = legacyMutationSchema.parse(
			payloads().searchSetting,
		);
		expect(
			applyLegacy(legacyStartFor("searchSetting"), [parsedSearchSetting])
				.modules[MODULE].caseSearchConfig,
		).toEqual({ searchScreenTitle: "Find a patient" });

		const parsedRename = legacyMutationSchema.parse(payloads().renameInput);
		expect(
			applyLegacy(legacyStartFor("renameInput"), [parsedRename]).modules[MODULE]
				.caseListConfig?.searchInputs[0]?.name,
		).toBe("old_name");

		for (const name of ["searchCleanup", "ownerOnly"] as const) {
			const parsed = legacyMutationSchema.parse(payloads()[name]);
			const fallback = applyLegacy(legacyStartFor(name), [parsed]).modules[
				MODULE
			].caseSearchConfig;
			expect(fallback?.searchActionEnabled).toBeUndefined();
			expect(fallback?.searchButtonDisplayCondition).toEqual({
				kind: "match-none",
			});
		}
		const parsedOwnerModule = legacyMutationSchema.parse(
			payloads().addModuleOwnerOnly,
		);
		const legacyOwnerModule = applyLegacy(
			legacyStartFor("addModuleOwnerOnly"),
			[parsedOwnerModule],
		).modules[asUuid("50000000-0000-4000-8000-000000000000")];
		expect(
			legacyOwnerModule.caseSearchConfig?.searchActionEnabled,
		).toBeUndefined();
		expect(
			legacyOwnerModule.caseSearchConfig?.searchButtonDisplayCondition,
		).toEqual({ kind: "match-none" });

		const parsedLookupAdd = legacyMutationSchema.parse(payloads().lookupAdd);
		expect(
			applyLegacy(docWithoutLookupSelect(), [parsedLookupAdd]).fields[FIELD],
		).toEqual(lookupSelectField());

		for (const name of ["lookupSet", "lookupReplace", "lookupClear"] as const) {
			const parsed = legacyMutationSchema.parse(payloads()[name]);
			expect(parsed).toEqual({
				kind: "updateField",
				uuid: FIELD,
				targetKind: "single_select",
				patch: {},
			});
			const fallback = applyLegacy(docWithLookupSelect(), [parsed]).fields[
				FIELD
			];
			expect(fallback).toEqual(lookupSelectField());
			expect(
				fallback && "options" in fallback ? fallback.options : undefined,
			).toEqual(lookupSelectField().options);
		}
	});

	it("raw new-server events dispatch through legacy reducers without an unknown-kind failure", () => {
		for (const [name, payload] of Object.entries(payloads()) as Array<
			[keyof ReturnType<typeof payloads>, Mutation]
		>) {
			const parsedFallback = legacyMutationSchema.parse(payload);
			const fromParsed = applyLegacy(legacyStartFor(name), [parsedFallback]);
			const fromRaw = applyLegacy(legacyStartFor(name), [
				payload as unknown as LegacyMutation,
			]);
			expect(fromRaw, name).toEqual(fromParsed);
		}
	});

	it("current reducers use semantic extensions and preserve fresh peer state", () => {
		const all = payloads();
		const peerColumn = baseColumn({
			header: "Peer label",
			sort: { direction: "asc", priority: 2 },
			listOrder: "peer-list",
			detailOrder: "peer-detail",
		});

		const peerConfig = docWithConfig([peerColumn]);
		const ensured = applyCurrent(peerConfig, [all.ensure]);
		expect(ensured.modules[MODULE].caseListConfig?.columns).toEqual([
			peerColumn,
		]);

		const added = applyCurrent(peerConfig, [all.add]).modules[
			MODULE
		].caseListConfig?.columns.find((column) => column.uuid === ADDED_COLUMN);
		expect(added).toMatchObject({
			listOrder: "list-b",
			detailOrder: "detail-a",
		});

		const content = applyCurrent(peerConfig, [all.content]).modules[MODULE]
			.caseListConfig?.columns[0];
		expect(content).toMatchObject({
			header: "Patient",
			sort: { direction: "asc", priority: 2 },
			listOrder: "peer-list",
			detailOrder: "peer-detail",
		});

		const visibility = applyCurrent(peerConfig, [all.visibility]).modules[
			MODULE
		].caseListConfig?.columns[0];
		expect(visibility).toMatchObject({
			header: "Peer label",
			sort: { direction: "asc", priority: 2 },
			visibleInList: false,
			listOrder: "peer-list",
			detailOrder: "peer-detail",
		});

		const sorted = applyCurrent(peerConfig, [all.sort]).modules[MODULE]
			.caseListConfig?.columns[0];
		expect(sorted).toMatchObject({
			header: "Peer label",
			sort: { direction: "desc", priority: 0 },
			listOrder: "peer-list",
			detailOrder: "peer-detail",
		});

		const moved = applyCurrent(peerConfig, [all.move]).modules[MODULE]
			.caseListConfig?.columns[0];
		expect(moved).toMatchObject({
			order: "generic-a",
			listOrder: "list-z",
			detailOrder: "peer-detail",
		});

		const cleared = applyCurrent(peerConfig, [all.clear]).modules[MODULE]
			.caseListConfig?.columns[0];
		expect(cleared?.listOrder).toBeUndefined();
		expect(cleared).toMatchObject({
			order: "generic-a",
			detailOrder: "peer-detail",
		});

		const replaced = applyCurrent(peerConfig, [all.replaceConfig]).modules[
			MODULE
		].caseListConfig?.columns[0];
		expect(replaced).toMatchObject({
			order: "generic-a",
			listOrder: "list-a",
			detailOrder: "detail-z",
		});

		const moduleAdded = applyCurrent(docWithConfig([baseColumn()]), [
			all.addModule,
		]);
		const newModule =
			moduleAdded.modules[asUuid("40000000-0000-4000-8000-000000000000")];
		expect(newModule.caseListConfig?.columns[0]).toMatchObject({
			listOrder: "list-b",
			detailOrder: "detail-a",
		});

		const peerSearch = produce(docWithConfig([]), (draft) => {
			draft.modules[MODULE].caseSearchConfig = {
				searchScreenTitle: "Peer title",
				searchButtonLabel: "Peer action",
			};
		});
		const mergedOwner = applyCurrent(peerSearch, [all.ownerOnly]).modules[
			MODULE
		].caseSearchConfig;
		expect(mergedOwner).toEqual({
			searchScreenTitle: "Peer title",
			searchButtonLabel: "Peer action",
			excludedOwnerIds: OWNER_RULE,
		});
		const mergedSearchSetting = applyCurrent(peerSearch, [all.searchSetting])
			.modules[MODULE].caseSearchConfig;
		expect(mergedSearchSetting).toEqual({
			searchScreenTitle: "Find a patient",
			searchButtonLabel: "Peer action",
		});
		expect(
			applyCurrent(peerSearch, [all.searchRemoveIfEmpty]).modules[MODULE]
				.caseSearchConfig,
		).toEqual(peerSearch.modules[MODULE].caseSearchConfig);
		const emptyMarker = produce(docWithConfig([]), (draft) => {
			draft.modules[MODULE].caseSearchConfig = {};
		});
		expect(
			applyCurrent(emptyMarker, [all.searchRemoveIfEmpty]).modules[MODULE]
				.caseSearchConfig,
		).toBeUndefined();

		const peerInput = produce(peerSearch, (draft) => {
			draft.modules[MODULE].caseListConfig?.searchInputs.push({
				uuid: asUuid("60000000-0000-4000-8000-000000000000"),
				kind: "simple",
				name: "name",
				label: "Name",
				type: "text",
				property: "case_name",
			});
		});
		expect(
			applyCurrent(peerInput, [all.searchCleanup]).modules[MODULE]
				.caseSearchConfig,
		).toEqual(peerInput.modules[MODULE].caseSearchConfig);

		const ownerModuleAdded = applyCurrent(docWithConfig([baseColumn()]), [
			all.addModuleOwnerOnly,
		]).modules[asUuid("50000000-0000-4000-8000-000000000000")];
		expect(ownerModuleAdded.caseSearchConfig).toEqual({
			searchActionEnabled: false,
			excludedOwnerIds: OWNER_RULE,
		});

		const renamedInput = applyCurrent(docWithInput(), [all.renameInput])
			.modules[MODULE].caseListConfig?.searchInputs[0];
		expect(renamedInput).toMatchObject({
			name: "new_name",
			label: "Renamed name",
		});

		expect(
			applyCurrent(docWithoutLookupSelect(), [all.lookupAdd]).fields[FIELD],
		).toEqual(lookupSelectField(SOURCE_A));
		expect(
			applyCurrent(docWithLookupSelect(), [all.lookupSet]).fields[FIELD],
		).toEqual(lookupSelectField(SOURCE_A));
		expect(
			applyCurrent(docWithLookupSelect(SOURCE_A), [all.lookupReplace]).fields[
				FIELD
			],
		).toEqual(lookupSelectField(SOURCE_B));
		expect(
			applyCurrent(docWithLookupSelect(SOURCE_A), [all.lookupClear]).fields[
				FIELD
			],
		).toEqual(lookupSelectField());
	});

	it("the frozen origin parser rejects current-only keys when nested by mistake", () => {
		const add = payloads().add;
		if (add.kind !== "addColumn")
			throw new Error("Expected addColumn payload.");
		expect(
			legacyMutationSchema.safeParse({
				...add,
				column: { ...add.column, listOrder: "nested-new-key" },
			}).success,
		).toBe(false);

		const addModule = payloads().addModule;
		if (addModule.kind !== "addModule") {
			throw new Error("Expected addModule payload.");
		}
		const first = addModule.module.caseListConfig?.columns[0];
		if (first === undefined)
			throw new Error("Expected module fallback column.");
		expect(
			legacyMutationSchema.safeParse({
				...addModule,
				module: {
					...addModule.module,
					caseListConfig: {
						...addModule.module.caseListConfig,
						columns: [{ ...first, detailOrder: "nested-new-key" }],
					},
				},
			}).success,
		).toBe(false);

		expect(
			legacyMutationSchema.safeParse({
				kind: "updateModule",
				uuid: MODULE,
				patch: {
					caseSearchConfig: {
						searchActionEnabled: false,
						excludedOwnerIds: OWNER_RULE,
					},
				},
			}).success,
		).toBe(false);

		const addOwner = payloads().addModuleOwnerOnly;
		if (addOwner.kind !== "addModule") {
			throw new Error("Expected owner-only addModule payload.");
		}
		expect(
			legacyMutationSchema.safeParse({
				...addOwner,
				module: {
					...addOwner.module,
					caseSearchConfig: {
						searchActionEnabled: false,
						excludedOwnerIds: OWNER_RULE,
					},
				},
			}).success,
		).toBe(false);
	});
});
