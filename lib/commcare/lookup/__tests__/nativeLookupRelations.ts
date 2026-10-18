import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { moduleExpressionContexts } from "@/lib/commcare/expressionContext";
import type { LookupWireNaming } from "@/lib/commcare/lookup/naming";
import { toWire } from "@/lib/commcare/xpath/wire/fromExpression";
import { serializeWire } from "@/lib/commcare/xpath/wire/serialize";
import { calculatedColumn } from "@/lib/domain";
import {
	ancestorPath,
	and,
	count,
	eq,
	exists,
	literal,
	prop,
	relationStep,
	subcasePath,
	tableColumn,
	tableLookup,
} from "@/lib/domain/expression";

/** Lower-level anchor contracts, executed against native indexed case storage. */
export function nativeLookupRelations(naming: LookupWireNaming) {
	const table = naming.tables[0];
	const [value, label] = table.columns;
	const sameRegion = eq(
		tableColumn(table.tableId, value.id),
		prop("patient", "region"),
	);
	const scenarios = [
		{
			name: "subcase-correlation",
			where: and(
				sameRegion,
				exists(
					subcasePath("parent", "visit"),
					eq(prop("visit", "outcome"), literal("open")),
				),
			),
		},
		{
			name: "ancestor-presence",
			where: and(
				sameRegion,
				eq(
					count(ancestorPath(relationStep("parent", "household"))),
					literal(1),
				),
			),
		},
	];
	const moduleUuid = testUuid("native-lookup-relations");
	const columns = scenarios.map(({ name, where }) =>
		calculatedColumn(
			testUuid(`native-lookup-${name}`),
			name,
			tableLookup(table.tableId, label.id, where),
		),
	);
	const doc = buildDoc({
		caseTypes: [
			{ name: "household", properties: [] },
			{
				name: "patient",
				parent_type: "household",
				properties: [{ name: "region", label: "Region", data_type: "text" }],
			},
			{
				name: "visit",
				parent_type: "patient",
				properties: [{ name: "outcome", label: "Outcome", data_type: "text" }],
			},
		],
		modules: [
			{
				uuid: moduleUuid,
				name: "Lookup relations",
				caseType: "patient",
				caseListOnly: true,
				caseListConfig: { columns, searchInputs: [] },
			},
		],
	});
	const contexts = moduleExpressionContexts(doc, moduleUuid, naming);
	return columns.map((column) => ({
		name: column.header,
		expression: serializeWire(
			toWire(column.expression, {
				target: "suite",
				types: contexts({
					slot: "case_list_column_expression",
					member: { columnUuid: column.uuid },
				}),
				bindings: { lookup: { naming, instanceScope: "suite" } },
			}),
			{ target: "suite" },
		).text,
	}));
}
