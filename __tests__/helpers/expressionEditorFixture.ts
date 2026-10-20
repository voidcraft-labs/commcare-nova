import { editorAxesOf } from "@/components/builder/shared/editorAxes";
import type { PredicateEditContext } from "@/components/builder/shared/editorSchemas";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	advancedSearchInputDef,
	type CaseOperation,
	calculatedColumn,
	type FieldKind,
	type SearchInputDef,
} from "@/lib/domain";
import {
	type ExpressionSlotRef,
	literal,
	matchAll,
	slotContext,
	term,
} from "@/lib/domain/expression";
import { testUuid } from "./uuid";

/** The catalogs a surface supplies. The menu axes are never supplied: they are
 * read from the carrier's slot (`shared/editorAxes.ts`), as every mount reads
 * them. `tableScope` here only names the table a table-filter carrier reads. */
type FixtureVocabulary = Omit<
	PredicateEditContext,
	| "expressionContext"
	| "caseDataScope"
	| "evaluationTarget"
	| "ownerValues"
	| "patternMatching"
> & {
	readonly caseDataScope?: never;
	readonly evaluationTarget?: never;
	readonly ownerValues?: never;
	readonly patternMatching?: never;
};
export type EditorFixtureCarrier =
	| "case-filter"
	| "search-case-filter"
	| "search-predicate"
	| "calculated-column"
	| "global-condition"
	| "selected-case-condition"
	| "global-value"
	| "table-filter"
	| "operation-owner"
	| "operation-condition"
	| "operation-write"
	| "search-required";

const MODULE = testUuid("editor-fixture-module");
const FORM = testUuid("editor-fixture-form");
const FIELD = testUuid("editor-fixture-choice");
const COLUMN = testUuid("editor-fixture-column");
const INPUT = testUuid("editor-fixture-input");
const OPERATION = testUuid("editor-fixture-operation");

/** A normalized app with an actual named carrier. The selected document slot,
 * never the editor's presentation flags, determines its checker profile. */
export function expressionEditorFixture<T extends FixtureVocabulary>(
	carrier: EditorFixtureCarrier,
	vocabulary: T,
) {
	const caseType = vocabulary.currentCaseType || "fixture_record";
	const caseTypes = [...vocabulary.caseTypes];
	if (!caseTypes.some((type) => type.name === caseType))
		caseTypes.push({ name: caseType, properties: [] });
	const inputs: SearchInputDef[] = vocabulary.knownInputs.map((input) =>
		advancedSearchInputDef(
			input.uuid,
			input.name,
			input.name,
			input.data_type === "date" ? "date" : "text",
			matchAll(),
		),
	);
	if (
		(carrier === "search-predicate" || carrier === "search-required") &&
		!inputs.some((input) => input.uuid === INPUT)
	)
		inputs.push(
			advancedSearchInputDef(
				INPUT,
				"fixture_answer",
				"Answer",
				"text",
				matchAll(),
			),
		);
	const config = {
		...caseListConfig([]),
		columns: [calculatedColumn(COLUMN, "Value", term(literal("")))],
		listColumnOrder: [COLUMN],
		detailColumnOrder: [COLUMN],
		searchInputs: inputs,
	};
	const fields = (vocabulary.formFields ?? []).map((field) => {
		const kind: FieldKind =
			field.dataType === "int" ||
			field.dataType === "decimal" ||
			field.dataType === "date" ||
			field.dataType === "datetime" ||
			field.dataType === "time" ||
			field.dataType === "geopoint"
				? field.dataType
				: "text";
		return f({ uuid: field.uuid, id: field.id, label: field.label, kind });
	});
	if (carrier === "table-filter") {
		const table = vocabulary.tableScope;
		const column = table?.columns[0];
		if (table === undefined || column === undefined)
			throw new Error("A table-filter fixture needs a real table and column.");
		fields.push(
			f({
				uuid: FIELD,
				id: "fixture_choice",
				kind: "single_select",
				optionsSource: {
					kind: "lookup",
					tableId: table.tableId,
					valueColumnId: column.id,
					labelColumnId: column.id,
				},
			}),
		);
	}
	let doc = buildDoc({
		caseTypes,
		modules: [
			{
				uuid: MODULE,
				name: "Records",
				caseType,
				caseListConfig: config,
				...(carrier === "search-case-filter" ||
				carrier === "search-predicate" ||
				carrier === "global-value" ||
				carrier === "search-required"
					? { caseSearchConfig: {} }
					: {}),
				forms: [
					{ uuid: FORM, name: "Update record", type: "followup", fields },
				],
			},
		],
	});
	const creates: CaseOperation[] = (
		vocabulary.operationScope?.creates ?? []
	).map((operation) => ({
		uuid: operation.uuid,
		id: operation.label,
		action: "create",
		caseType,
		target: { kind: "new" },
		name: term(literal("Record")),
	}));
	doc = {
		...doc,
		forms: {
			...doc.forms,
			[FORM]: {
				...doc.forms[FORM],
				caseOperations: [
					...creates,
					{
						uuid: OPERATION,
						id: "save_record",
						action: "update",
						caseType,
						target: { kind: "session" },
						writes: [{ property: "fixture_result", value: term(literal("")) }],
					},
				],
			},
		},
		...(vocabulary.userProperties === undefined
			? {}
			: {
					userProperties: Object.fromEntries(
						vocabulary.userProperties.map((property) => [
							property.uuid,
							property,
						]),
					),
					userPropertyOrder: vocabulary.userProperties.map(
						(property) => property.uuid,
					),
				}),
	};
	const slot: ExpressionSlotRef =
		carrier === "selected-case-condition"
			? { entity: "form", uuid: FORM, slot: "form_display_condition" }
			: carrier === "operation-owner" ||
					carrier === "operation-condition" ||
					carrier === "operation-write"
				? carrier === "operation-write"
					? {
							entity: "form",
							uuid: FORM,
							slot: "case_operation_write_value",
							member: { operationUuid: OPERATION, property: "fixture_result" },
						}
					: {
							entity: "form",
							uuid: FORM,
							slot:
								carrier === "operation-owner"
									? "case_operation_owner"
									: "case_operation_condition",
							member: { operationUuid: OPERATION },
						}
				: carrier === "table-filter"
					? { entity: "field", uuid: FIELD, slot: "lookup_options_source" }
					: carrier === "search-predicate" || carrier === "search-required"
						? {
								entity: "module",
								uuid: MODULE,
								slot:
									carrier === "search-predicate"
										? "search_input_predicate"
										: "search_input_required_when",
								member: { searchInputUuid: INPUT },
							}
						: carrier === "calculated-column"
							? {
									entity: "module",
									uuid: MODULE,
									slot: "case_list_column_expression",
									member: { columnUuid: COLUMN },
								}
							: {
									entity: "module",
									uuid: MODULE,
									slot:
										carrier === "global-condition"
											? "module_display_condition"
											: carrier === "global-value"
												? "excluded_owner_ids"
												: "case_list_filter",
								};
	const lookupTables = new Map(
		(vocabulary.lookupTables ?? []).map((table) => [
			table.id,
			new Map(table.columns.map((column) => [column.id, column.dataType])),
		]),
	);
	if (
		vocabulary.tableScope !== undefined &&
		!lookupTables.has(vocabulary.tableScope.tableId)
	)
		lookupTables.set(
			vocabulary.tableScope.tableId,
			new Map(
				vocabulary.tableScope.columns.map((column) => [
					column.id,
					column.dataType,
				]),
			),
		);
	const expressionContext = slotContext(doc, slot, lookupTables);
	if (expressionContext === undefined)
		throw new Error(`The ${carrier} fixture has no owning expression slot.`);
	const tableDecls = [
		...(vocabulary.lookupTables ?? []),
		...(vocabulary.tableScope === undefined
			? []
			: [
					{
						id: vocabulary.tableScope.tableId,
						name: "Fixture table",
						columns: vocabulary.tableScope.columns,
					},
				]),
	];
	const { tableScope: _named, ...catalogs } = vocabulary;
	return {
		doc,
		slot,
		lookupTables,
		context: {
			...catalogs,
			...editorAxesOf(expressionContext, tableDecls),
			expressionContext,
		},
	};
}
