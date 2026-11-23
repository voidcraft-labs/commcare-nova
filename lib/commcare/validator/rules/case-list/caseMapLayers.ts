import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
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
		let message: string | undefined;
		if (
			column.kind === "map-location" &&
			hasSeveralCaseMapLocations(config) &&
			!menuEmittedAdvanced(doc, moduleUuid)
		)
			message =
				"This menu can use one map location per screen. You can keep one location or move the other to a separate screen.";
		if (column.kind === "map-layer") {
			if (
				column.visibleInDetail !== false ||
				column.visibleInList === false ||
				column.notOnList
			)
				message =
					"A map layer belongs on Results. You can show its saved value as a separate item in Details.";
			else if (map.locations.length === 0)
				message =
					"This map layer needs a map location in Results. You can add a location or remove the layer.";
			else if ((map.layers[column.layer]?.length ?? 0) > 1)
				message =
					"A map can use one layer of each kind. You can choose which layer to keep.";
			else if (
				column.layer === "boundary-color" &&
				!map.layers.boundary?.length
			)
				message =
					"This color needs a boundary on the map. You can add a boundary or remove its color.";
			else if (column.layer === "point-colors" && !map.layers.points?.length)
				message =
					"These colors need points on the map. You can add points or remove their colors.";
		}
		if (message)
			errors.push(
				validationError(
					"CASE_MAP_SOURCE_INVALID",
					"module",
					message,
					{ moduleUuid, moduleName: mod.name },
					{ columnUuid: column.uuid, columnLabel: column.header },
				),
			);
	}
	return errors;
}
