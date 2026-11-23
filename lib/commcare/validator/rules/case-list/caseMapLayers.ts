import type {
	BlueprintDoc,
	CaseListConfig,
	Column,
	Module,
	Uuid,
} from "@/lib/domain";
import { menuEmittedAdvanced } from "@/lib/domain/advancedEntryDatums";
import {
	caseMapSources,
	hasSeveralCaseMapLocations,
} from "@/lib/domain/caseMap";
import { type ValidationError, validationError } from "../../errors";

export function caseMapLayers(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	const config = mod.caseListConfig;
	if (!config) return [];
	const map = caseMapSources(config, "list");
	const errors: ValidationError[] = [];
	for (const column of config.columns) {
		const reason = mapSourceReason(column, config, map, doc, moduleUuid);
		if (reason)
			errors.push(
				validationError(
					"CASE_MAP_SOURCE_INVALID",
					"module",
					`In the case list of "${mod.name}", ${REASON_SENTENCE[reason](column.header)}`,
					{ moduleUuid, moduleName: mod.name },
					{ columnUuid: column.uuid, columnLabel: column.header, reason },
				),
			);
	}
	return errors;
}

export type CaseMapSourceReason =
	| "several-locations"
	| "layer-off-results"
	| "layer-without-location"
	| "several-layers"
	| "color-without-boundary"
	| "colors-without-points";

function mapSourceReason(
	column: Column,
	config: CaseListConfig,
	map: ReturnType<typeof caseMapSources>,
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): CaseMapSourceReason | undefined {
	if (column.kind === "map-location")
		return hasSeveralCaseMapLocations(config) &&
			!menuEmittedAdvanced(doc, moduleUuid)
			? "several-locations"
			: undefined;
	if (column.kind !== "map-layer") return undefined;
	if (
		column.visibleInDetail !== false ||
		column.visibleInList === false ||
		column.notOnList
	)
		return "layer-off-results";
	if (map.locations.length === 0) return "layer-without-location";
	if ((map.layers[column.layer]?.length ?? 0) > 1) return "several-layers";
	if (column.layer === "boundary-color" && !map.layers.boundary?.length)
		return "color-without-boundary";
	if (column.layer === "point-colors" && !map.layers.points?.length)
		return "colors-without-points";
	return undefined;
}

/** The finding's sentence, the column named by its header. */
const REASON_SENTENCE: Record<CaseMapSourceReason, (column: string) => string> =
	{
		"several-locations": (column) =>
			`"${column}" is a second map location on one screen, and this menu can use one. You can keep one location or move the other to a separate screen.`,
		"layer-off-results": (column) =>
			`"${column}" is a map layer outside Results. You can keep the layer on Results and show its saved value as a separate item in Details.`,
		"layer-without-location": (column) =>
			`"${column}" is a map layer, and Results holds no map location for it. You can add a location or remove the layer.`,
		"several-layers": (column) =>
			`"${column}" is a second map layer of its kind, and a map can use one of each. You can choose which layer to keep.`,
		"color-without-boundary": (column) =>
			`"${column}" colors a boundary the map doesn't have. You can add a boundary or remove its color.`,
		"colors-without-points": (column) =>
			`"${column}" colors points the map doesn't have. You can add points or remove their colors.`,
	};
