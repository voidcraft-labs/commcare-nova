/**
 * The case properties an app's CommCare HQ searches measure distance on.
 *
 * HQ's case search answers `within-distance` with an Elasticsearch
 * `geo_distance` on `case_properties.geopoint_value`
 * (`corehq/apps/es/case_search.py::case_property_geo_distance`). Its case
 * search pillow fills that field only for the project's own case location
 * property and, where the project has the `DATA_DICTIONARY` privilege, for
 * the properties its data dictionary types GPS
 * (`corehq/pillows/case_search.py::_add_smart_types`, reading
 * `geospatial/utils.py::get_geo_case_property` and
 * `data_dictionary/util.py::get_gps_properties`). Nova cannot set that type:
 * the data dictionary takes changes only from a signed-in person
 * (`data_dictionary/views.py::update_case_property`), and Nova cannot read
 * the project's geospatial settings either. So every property a search
 * measures distance on is named for a person to type, read from the same
 * clauses the wire sends (`composeXPathQueryClauses`), on every read.
 */

import {
	type BlueprintDoc,
	effectiveCaseSearchConfig,
	type Uuid,
} from "@/lib/domain";
import { relationDestinationCaseType } from "@/lib/domain/expression/rewrite";
import { walkConditionArms } from "@/lib/domain/expression/walk";
import type { DistanceSearchSetupProperty } from "@/lib/publish/distanceSearchSetup";
import { moduleExpressionContexts } from "./expressionContext";
import { moduleCaseTypeForActions } from "./formLinkProjection";
import { composeXPathQueryClauses } from "./suite/case-search/xpathQuery";

/**
 * Every `(case type, property)` a `within-distance` in a CommCare HQ search
 * reads, in the order the menus and their clauses first read it. A search
 * HQ runs is a module's effective Search on a module whose cases land
 * (`moduleCaseTypeForActions`, the gate `expandDoc` reads), and its
 * clauses are the case list filter, each advanced input's predicate and
 * each simple input's derived clause, after boolean identities fold away.
 * A property read through a relation names the case type the relation
 * lands on.
 */
export function distanceSearchProperties(
	doc: BlueprintDoc,
): DistanceSearchSetupProperty[] {
	const byKey = new Map<
		string,
		{ caseType: string; property: string; modules: Map<Uuid, string> }
	>();
	for (const moduleUuid of doc.moduleOrder) {
		const mod = doc.modules[moduleUuid];
		if (mod?.caseListConfig === undefined) continue;
		if (effectiveCaseSearchConfig(mod) === undefined) continue;
		if (moduleCaseTypeForActions(doc, moduleUuid) === "") continue;
		const clauses =
			composeXPathQueryClauses(
				mod.caseListConfig,
				mod.caseType,
				moduleExpressionContexts(doc, moduleUuid),
			) ?? [];
		for (const clause of clauses) {
			walkConditionArms(clause.expression, (arm) => {
				if (arm.kind !== "within-distance") return;
				/* The reference names the scope it reads from; through a
				 * relation, the case that holds the property is where the
				 * relation lands. A standard property names no type, and the
				 * Data Dictionary types none of them. */
				const caseType = relationDestinationCaseType(
					arm.property.via,
					arm.property.caseType,
					doc.caseTypes ?? [],
				);
				if (caseType === undefined) return;
				const key = JSON.stringify([caseType, arm.property.property]);
				const entry = byKey.get(key) ?? {
					caseType,
					property: arm.property.property,
					modules: new Map<Uuid, string>(),
				};
				entry.modules.set(moduleUuid, mod.name.trim() || mod.id);
				byKey.set(key, entry);
			});
		}
	}
	return [...byKey.values()].map((entry) => ({
		caseType: entry.caseType,
		property: entry.property,
		moduleNames: [...entry.modules.values()],
	}));
}
