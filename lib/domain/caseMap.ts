import {
	type CaseListConfig,
	type CaseMapLayerKind,
	orderedColumns,
} from "./modules";
import type { Uuid } from "./uuid";

/** The location used by an Android map is the first usable location on the
 * case. Web Apps reads the first one. Geometry and color are each per list. */
export function caseMapSources(
	config: CaseListConfig,
	surface: "list" | "detail",
) {
	const locations: Uuid[] = [];
	const layers: Partial<Record<CaseMapLayerKind, Uuid[]>> = {};
	for (const column of orderedColumns(config, surface)) {
		if (
			surface === "list"
				? column.visibleInList === false || column.notOnList
				: column.visibleInDetail === false
		)
			continue;
		if (column.kind === "map-location") locations.push(column.uuid);
		if (column.kind === "map-layer") {
			const values = layers[column.layer] ?? [];
			values.push(column.uuid);
			layers[column.layer] = values;
		}
	}
	return { locations, layers };
}

export function hasSeveralCaseMapLocations(config: CaseListConfig | undefined) {
	return (
		config !== undefined &&
		(caseMapSources(config, "list").locations.length > 1 ||
			caseMapSources(config, "detail").locations.length > 1)
	);
}
