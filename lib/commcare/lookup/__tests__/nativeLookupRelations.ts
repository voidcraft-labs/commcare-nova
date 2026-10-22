import type { LookupWireNaming } from "@/lib/commcare/lookup/naming";
import { toWire } from "@/lib/commcare/xpath/wire/fromExpression";
import { serializeWire } from "@/lib/commcare/xpath/wire/serialize";
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
} from "@/lib/domain/predicate";

/** Lower-level anchor contracts, executed against native indexed case storage. */
export function nativeLookupRelations(naming: LookupWireNaming) {
	const table = naming.tables[0];
	const [value, label] = table.columns;
	const sameRegion = eq(
		tableColumn(table.tableId, value.id),
		prop("patient", "region"),
	);
	return [
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
	].map(({ name, where }) => ({
		name,
		expression: serializeWire(
			toWire(tableLookup(table.tableId, label.id, where), {
				target: "suite",
				types: { currentCaseType: "patient" },
				bindings: { lookup: { naming, instanceScope: "suite" } },
			}),
			{ target: "suite" },
		).text,
	}));
}
